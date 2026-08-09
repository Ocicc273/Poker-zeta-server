/**
 * Poker Zeta — Logica dei bot
 * Riferimento: SDD Server Authoritative
 *
 * Avversari controllati dal sistema.
 *
 * AMBITO E LIMITI
 * Questa è una logica a soglie fisse, non un'intelligenza di poker.
 * Valuta la forza della propria mano e decide in base a soglie
 * statiche, senza modellare gli avversari, la posizione o il bluff.
 *
 * Serve a due scopi: far girare mani complete per verificare il
 * motore, e dare al giocatore un avversario con cui provare
 * l'interfaccia. NON è pensata per il multiplayer, dove gli
 * avversari sono giocatori reali.
 *
 * Modulo puro: nessuno stato, nessun I/O.
 */

import { evaluateHand, HandCategory } from './hand-rank';
import { evaluateOmahaHand } from './omaha';
import type { Card } from './cards';
import { ActionType, Street, type AvailableAction, type PlayerAction, type PlayerId } from './table-types';

/* ────────────────────────────────────────────────────────────
   PROFILI
   ──────────────────────────────────────────────────────────── */

/** Stile di gioco del bot. Modifica le soglie decisionali. */
export type BotProfile = 'tight' | 'balanced' | 'loose';

interface ProfileThresholds {
  /** Forza minima (0-1) per chiamare una puntata. */
  callThreshold: number;
  /** Forza minima per aprire o rilanciare. */
  raiseThreshold: number;
  /** Frazione del piatto usata come puntata standard. */
  betSizing: number;
}

const PROFILES: Record<BotProfile, ProfileThresholds> = {
  tight: { callThreshold: 0.45, raiseThreshold: 0.7, betSizing: 0.6 },
  balanced: { callThreshold: 0.35, raiseThreshold: 0.6, betSizing: 0.5 },
  loose: { callThreshold: 0.22, raiseThreshold: 0.5, betSizing: 0.45 },
};

/**
 * Prezzo sotto il quale la forza della mano smette di contare.
 *
 * Chiamare 2 per un piatto da 100 significa versare il 2% del
 * piatto finale: basta vincere una volta su cinquanta perché sia
 * corretto, e non esistono due carte così brutte. Foldare qui è
 * sempre un errore, quindi la soglia viene scavalcata.
 */
const IRRESISTIBLE_PRICE = 0.12;

/**
 * Forza minima per impegnare l'intero stack quando chiamare
 * significa restare senza fiche.
 *
 * Diverso dal caso precedente: qui il prezzo non è irrisorio e
 * perdere la mano significa uscire dal tavolo, quindi serve un
 * motivo reale — ma non è più un divieto assoluto come prima.
 */
const COMMIT_STRENGTH_BAR = 0.55;

/* ────────────────────────────────────────────────────────────
   VALUTAZIONE DELLA FORZA
   ──────────────────────────────────────────────────────────── */

/**
 * Forza post-flop, normalizzata 0-1.
 * Deriva direttamente dalla categoria della mano formata.
 */
function postflopStrength(holeCards: readonly Card[], community: readonly Card[]): number {
  // A Omaha non si possono impilare nove carte nel valutatore: il
  // vincolo 2+3 va risolto prima, e si valutano le cinque scelte.
  const isOmaha = holeCards.length === 4;

  if (isOmaha && community.length < 3) return preflopStrength(holeCards);

  const all = isOmaha
    ? (() => {
        const best = evaluateOmahaHand(holeCards, community);
        return [...best.usedHoleCards, ...best.usedCommunityCards];
      })()
    : [...holeCards, ...community];

  if (all.length < 5) return preflopStrength(holeCards);

  const rank = evaluateHand(all);

  // Mappa categoria → forza. La progressione non è lineare: la
  // differenza fra coppia e doppia coppia conta più di quella fra
  // poker e scala colore, che sono entrambe mani vincenti.
  const byCategory: Record<HandCategory, number> = {
    [HandCategory.HighCard]: 0.15,
    [HandCategory.Pair]: 0.4,
    [HandCategory.TwoPair]: 0.6,
    [HandCategory.ThreeOfAKind]: 0.75,
    [HandCategory.Straight]: 0.85,
    [HandCategory.Flush]: 0.9,
    [HandCategory.FullHouse]: 0.94,
    [HandCategory.FourOfAKind]: 0.98,
    [HandCategory.StraightFlush]: 0.99,
    [HandCategory.RoyalFlush]: 1,
  };

  let strength = byCategory[rank.category];

  // Con una sola coppia conta molto quale: coppia di assi vale
  // assai più di coppia di due.
  if (rank.category === HandCategory.Pair && rank.strength[1] !== undefined) {
    strength += ((rank.strength[1] - 2) / 12) * 0.15;
  }

  return Math.min(1, strength);
}

/* ────────────────────────────────────────────────────────────
   DECISIONE
   ──────────────────────────────────────────────────────────── */

export interface BotDecisionContext {
  playerId: PlayerId;
  profile: BotProfile;
  holeCards: readonly Card[];
  communityCards: readonly Card[];
  street: Street;
  /** Azioni consentite dal motore. */
  available: readonly AvailableAction[];
  /** Z-Coins da versare per restare in mano. */
  toCall: number;
  /** Totale attualmente nel piatto. */
  potSize: number;
  /** Stack residuo del bot. */
  stack: number;
}

/**
 * Sceglie l'azione del bot.
 *
 * L'azione restituita è sempre una fra quelle dichiarate legali dal
 * motore: il bot non può proporre mosse illegali. In caso di dubbio
 * ricade sull'azione più conservativa disponibile.
 */
export function decideBotAction(context: BotDecisionContext): PlayerAction {
  const thresholds = PROFILES[context.profile];
  const { playerId, available, toCall, potSize, stack } = context;

  const can = (type: ActionType): AvailableAction | undefined =>
    available.find((a) => a.type === type);

  const strength =
    context.street === Street.Preflop
      ? preflopStrength(context.holeCards)
      : postflopStrength(context.holeCards, context.communityCards);

  const checkAction = can(ActionType.Check);
  const callAction = can(ActionType.Call);
  const allInAction = can(ActionType.AllIn);
  const raiseAction = can(ActionType.Raise) ?? can(ActionType.Bet);
  const foldAction = can(ActionType.Fold);

  /**
   * Resta in mano con l'azione giusta.
   *
   * Quando la puntata supera lo stack il motore può offrire All-in
   * al posto di Call: qui si prende quella che esiste, invece di
   * pretenderne una e ripiegare sul fold.
   */
  const commit = (): PlayerAction | null => {
    if (callAction) return { type: ActionType.Call, playerId };
    if (allInAction) return { type: ActionType.AllIn, playerId };
    return null;
  };

  /* ── Nessuna puntata da affrontare ──────────────────────── */
  if (toCall === 0) {
    // Mano forte: si punta per costruire il piatto.
    if (strength >= thresholds.raiseThreshold && raiseAction) {
      const target = computeBetTarget(raiseAction, potSize, thresholds.betSizing);
      return { type: raiseAction.type, playerId, amount: target };
    }

    // Altrimenti si controlla: mai foldare quando è gratis.
    if (checkAction) {
      return { type: ActionType.Check, playerId };
    }
  }

  /* ── C'è una puntata da affrontare ──────────────────────── */

  // Nessuno può pagare più del proprio stack: un all-in avversario
  // da 100 contro 2 fiche residue costa 2, non 100. Ragionare sul
  // valore nominale faceva sembrare proibitivo ciò che era regalato,
  // e il bot foldava mani che nessuno folderebbe mai.
  const effectiveCall = Math.min(toCall, stack);

  // Prezzo reale: quale frazione del piatto finale si sta versando.
  const price =
    effectiveCall > 0 ? effectiveCall / (potSize + effectiveCall) : 0;

  // Chiamare significa restare senza fiche?
  const wouldBeAllIn = effectiveCall >= stack;

  /* ── Prezzo irrisorio: si entra a prescindere ───────────── */
  if (price <= IRRESISTIBLE_PRICE) {
    const action = commit();
    if (action) return action;
  }

  /* ── Mano molto forte: si rilancia ──────────────────────── */
  if (strength >= thresholds.raiseThreshold && raiseAction) {
    const target = computeBetTarget(raiseAction, potSize + toCall, thresholds.betSizing);
    return { type: raiseAction.type, playerId, amount: target };
  }

  /* ── Mano sufficiente: si chiama ────────────────────────── */

  // Più il prezzo è alto, più forza serve. Con un prezzo basso la
  // soglia scende, senza mai azzerarsi.
  const adjustedThreshold = Math.max(
    thresholds.callThreshold * 0.5,
    thresholds.callThreshold * (0.5 + price)
  );

  if (strength >= adjustedThreshold) {
    // Impegnare tutto lo stack richiede un motivo in più: qui il
    // prezzo non è irrisorio e perdere significa uscire dal tavolo.
    if (!wouldBeAllIn || strength >= COMMIT_STRENGTH_BAR) {
      const action = commit();
      if (action) return action;
    }
  }

  /* ── Mano eccellente: si va all-in comunque ─────────────── */
  if (strength >= 0.8) {
    if (allInAction) return { type: ActionType.AllIn, playerId };
    const action = commit();
    if (action) return action;
  }

  /* ── Ripiego ─────────────────────────────────────────────── */
  if (foldAction) {
    return { type: ActionType.Fold, playerId };
  }
  if (checkAction) {
    return { type: ActionType.Check, playerId };
  }
  if (callAction) {
    return { type: ActionType.Call, playerId };
  }

  // Nessuna azione riconosciuta: si prende la prima legale.
  const fallback = available[0];
  if (!fallback) {
    throw new Error(`Nessuna azione disponibile per il bot ${playerId}.`);
  }
  return { type: fallback.type, playerId, amount: fallback.minAmount };
}

/**
 * Calcola l'importo di una puntata come frazione del piatto,
 * vincolato ai limiti dichiarati dal motore.
 */
function computeBetTarget(
  action: AvailableAction,
  potSize: number,
  sizing: number
): number {
  const min = action.minAmount ?? 0;
  const max = action.maxAmount ?? min;

  const desired = Math.round(potSize * sizing);
  // Il clamp garantisce che l'importo resti sempre legale.
  return Math.max(min, Math.min(max, Math.max(desired, min)));
}
