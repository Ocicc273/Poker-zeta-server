/**
 * Poker Zeta — Macchina a stati della mano
 * Riferimento: SDD Server Authoritative
 *
 * Governa il ciclo di vita di una singola mano: distribuzione,
 * giri di puntata, avanzamento delle street, showdown.
 *
 * PRINCIPIO DI IMMUTABILITÀ
 * Ogni funzione restituisce un nuovo stato invece di modificare
 * quello ricevuto. Il costo è trascurabile (poche decine di oggetti
 * per mano) e i vantaggi sono concreti: lo stato precedente resta
 * disponibile per il replay, i bug di mutazione condivisa sono
 * impossibili, e il Match Server può serializzare qualsiasi
 * istantanea senza rischio di corse.
 *
 * AUTORITÀ
 * Questo modulo è la sola fonte di verità sulla legalità di
 * un'azione. Il client propone, il motore dispone: nessuna
 * validazione lato client è considerata attendibile.
 */

import { Deck, type Card, type RandomSource } from './cards';
import {
  buildPots,
  distributePots,
  awardUncontested,
  type Contribution,
  type Pot,
  type Payout,
} from './pot';
import { evaluateOmahaHand } from './omaha';
import {
  ActionType,
  InvalidActionError,
  PlayerStatus,
  Street,
  type AvailableAction,
  type PlayerAction,
  type PlayerId,
  type PlayerState,
  type TableConfig,
} from './table-types';

/* ────────────────────────────────────────────────────────────
   STATO
   ──────────────────────────────────────────────────────────── */

export interface HandState {
  /** Identificativo della mano. Usato per replay e log. */
  handId: string;
  config: TableConfig;
  street: Street;
  players: readonly PlayerState[];
  communityCards: readonly Card[];
  /** Posizione del dealer button. */
  dealerSeat: number;
  /** Giocatore che deve agire. null se la street è chiusa. */
  toActPlayerId: PlayerId | null;
  /** Puntata più alta della street corrente. */
  currentBet: number;
  /**
   * Entità dell'ultimo aumento. Determina il raise minimo
   * successivo: un raise deve superare il precedente di almeno
   * altrettanto.
   */
  lastRaiseSize: number;
  /**
   * Ultimo giocatore che ha aggredito (bet o raise). Il giro si
   * chiude quando l'azione torna a lui.
   */
  lastAggressorId: PlayerId | null;
  pots: readonly Pot[];
  payouts: readonly Payout[];
  /** Mazzo. Non serializzabile: resta lato server. */
  readonly deck: Deck;
}

/* ────────────────────────────────────────────────────────────
   UTILITÀ SULLE POSIZIONI
   ──────────────────────────────────────────────────────────── */

/** Giocatori che possono ancora compiere azioni. */
function actingPlayers(players: readonly PlayerState[]): PlayerState[] {
  return players.filter((p) => p.status === PlayerStatus.Active);
}

/** Giocatori ancora in gara per il piatto, all-in inclusi. */
function contestingPlayers(players: readonly PlayerState[]): PlayerState[] {
  return players.filter(
    (p) => p.status === PlayerStatus.Active || p.status === PlayerStatus.AllIn
  );
}

/**
 * Prossimo giocatore in senso orario che può agire.
 * @returns null se nessuno può agire.
 */
function nextToAct(
  players: readonly PlayerState[],
  fromSeat: number
): PlayerState | null {
  const candidates = actingPlayers(players);
  if (candidates.length === 0) return null;

  const ordered = [...candidates].sort((a, b) => a.seat - b.seat);

  // Primo con posizione superiore, altrimenti si riparte dal fondo.
  return ordered.find((p) => p.seat > fromSeat) ?? ordered[0]!;
}

/** Ordine dei giocatori a partire dallo small blind. */
function seatOrderFromSmallBlind(state: HandState): PlayerId[] {
  const inHand = contestingPlayers(state.players).sort((a, b) => a.seat - b.seat);
  if (inHand.length === 0) return [];

  const headsUp = inHand.length === 2;
  // Heads-up: il dealer È lo small blind. Con tre o più giocatori
  // lo small blind è il primo dopo il dealer.
  const sbSeat = headsUp
    ? state.dealerSeat
    : (nextToAct(state.players, state.dealerSeat)?.seat ?? state.dealerSeat);

  const before = inHand.filter((p) => p.seat >= sbSeat);
  const after = inHand.filter((p) => p.seat < sbSeat);

  return [...before, ...after].map((p) => p.playerId);
}

/** Sostituisce un giocatore nell'elenco, restituendo un nuovo array. */
function replacePlayer(
  players: readonly PlayerState[],
  updated: PlayerState
): PlayerState[] {
  return players.map((p) => (p.playerId === updated.playerId ? updated : p));
}

function findPlayer(state: HandState, playerId: PlayerId): PlayerState {
  const player = state.players.find((p) => p.playerId === playerId);
  if (!player) {
    throw new Error(`Giocatore non presente nella mano: ${playerId}`);
  }
  return player;
}

/* ────────────────────────────────────────────────────────────
   AVVIO DELLA MANO
   ──────────────────────────────────────────────────────────── */

export interface SeatAssignment {
  playerId: PlayerId;
  seat: number;
  stack: number;
}

/**
 * Inizializza una mano: ante, bui, distribuzione delle carte.
 *
 * @throws Se i giocatori sono meno di due o gli stack non validi.
 */
export function startHand(
  handId: string,
  config: TableConfig,
  seats: readonly SeatAssignment[],
  dealerSeat: number,
  random?: RandomSource
): HandState {
  if (seats.length < 2) {
    throw new Error(`Servono almeno 2 giocatori, ricevuti ${seats.length}.`);
  }

  for (const seat of seats) {
    if (!Number.isInteger(seat.stack) || seat.stack <= 0) {
      throw new Error(
        `Stack non valido per ${seat.playerId}: ${seat.stack}`
      );
    }
  }

  const deck = new Deck(random);

  let players: PlayerState[] = seats
    .map((seat) => ({
      playerId: seat.playerId,
      seat: seat.seat,
      stack: seat.stack,
      committedThisStreet: 0,
      committedTotal: 0,
      status: PlayerStatus.Active,
      holeCards: [] as readonly Card[],
      hasActedThisStreet: false,
    }))
    .sort((a, b) => a.seat - b.seat);

  /** Preleva un importo dallo stack, limitato a quanto disponibile. */
  const commit = (player: PlayerState, requested: number): PlayerState => {
    const actual = Math.min(requested, player.stack);
    return {
      ...player,
      stack: player.stack - actual,
      committedThisStreet: player.committedThisStreet + actual,
      committedTotal: player.committedTotal + actual,
      // Chi esaurisce lo stack sui bui è già all-in prima di agire.
      status: player.stack - actual === 0 ? PlayerStatus.AllIn : player.status,
    };
  };

  // Ante da tutti i partecipanti.
  if (config.blinds.ante > 0) {
    players = players.map((p) => commit(p, config.blinds.ante));
  }

  const headsUp = players.length === 2;
  const dealerIndex = players.findIndex((p) => p.seat === dealerSeat);

  if (dealerIndex === -1) {
    throw new Error(`Nessun giocatore alla posizione dealer ${dealerSeat}.`);
  }

  // Heads-up: dealer = small blind, l'altro è big blind.
  // Tre o più: small blind subito dopo il dealer.
  const sbIndex = headsUp
    ? dealerIndex
    : (dealerIndex + 1) % players.length;
  const bbIndex = (sbIndex + 1) % players.length;

  players[sbIndex] = commit(players[sbIndex]!, config.blinds.smallBlind);
  players[bbIndex] = commit(players[bbIndex]!, config.blinds.bigBlind);

  // Distribuzione: due carte a testa, quattro in Omaha, una alla
  // volta per giro come al tavolo fisico.
  const holeCardCount = config.variant === 'omaha' ? 4 : 2;

  for (let round = 0; round < holeCardCount; round++) {
    for (let i = 0; i < players.length; i++) {
      const index = (sbIndex + i) % players.length;
      const player = players[index]!;
      players[index] = {
        ...player,
        holeCards: [...player.holeCards, deck.draw()],
      };
    }
  }

  // Preflop l'azione parte dopo il big blind. Heads-up parte dal
  // dealer/small blind.
  const firstToActIndex = headsUp ? sbIndex : (bbIndex + 1) % players.length;
  const firstToAct = players[firstToActIndex]!;

  /**
   * CHI TOCCA DAVVERO, SALTANDO CHI È GIÀ ALL-IN.
   *
   * Prima qui si guardava SOLO il primo di parola: se non era
   * attivo, il turno restava null e la mano si piantava senza che
   * nessuno potesse agire.
   *
   * Non è un caso di scuola. Basta uno stack più corto del buio —
   * un giocatore rimasto con 43.000 a un tavolo da 100.000/200.000 —
   * perché chi posta il buio finisca all-in prima ancora di parlare.
   * Se quello è anche il primo di parola, il tavolo si blocca.
   *
   * `nextToAct` fa già il giro saltando chi non può agire; qui si
   * riparte dal posto PRECEDENTE al primo, così se il primo è attivo
   * resta lui e non si salta il suo turno.
   */
  const attivi = actingPlayers(players);
  const primoDavvero =
    attivi.length === 0
      ? null
      : firstToAct.status === PlayerStatus.Active
        ? firstToAct
        : nextToAct(players, firstToAct.seat);

  return {
    handId,
    config,
    street: Street.Preflop,
    players,
    communityCards: [],
    dealerSeat,
    toActPlayerId: primoDavvero?.playerId ?? null,
    currentBet: config.blinds.bigBlind,
    // Il big blind conta come primo "raise": il minimo successivo
    // è di pari entità.
    lastRaiseSize: config.blinds.bigBlind,
    lastAggressorId: players[bbIndex]!.playerId,
    pots: [],
    payouts: [],
    deck,
  };
}
/**
 * Importo massimo a cui un giocatore può portarsi in Pot Limit.
 *
 * La regola: si chiama, e poi si rilancia di quanto vale il piatto
 * dopo quella chiamata. Quindi il tetto è la puntata corrente più
 * il piatto attuale più l'importo da chiamare — il chiamato conta
 * due volte, ed è la parte che quasi tutte le implementazioni
 * sbagliano.
 *
 * Verifica con bui 5/10 heads-up: piatto 15, da chiamare 5, tetto
 * 10 + 15 + 5 = 30.
 */
function potLimitMaxTo(state: HandState, player: PlayerState): number {
  const toCall = Math.max(0, state.currentBet - player.committedThisStreet);
  return state.currentBet + currentPotTotal(state) + toCall;
}
/* ────────────────────────────────────────────────────────────
   AZIONI DISPONIBILI
   ──────────────────────────────────────────────────────────── */

/**
 * Calcola le azioni legali per il giocatore di turno.
 * Il client usa questa lista per abilitare i pulsanti; il motore
 * la riapplica comunque in fase di validazione.
 */
export function getAvailableActions(state: HandState): AvailableAction[] {
  if (state.toActPlayerId === null) return [];

  const player = findPlayer(state, state.toActPlayerId);
  if (player.status !== PlayerStatus.Active) return [];

  const toCall = state.currentBet - player.committedThisStreet;
  const actions: AvailableAction[] = [];

  // Fold sempre disponibile, tranne quando si può checkare
  // gratuitamente: foldare senza costo è solo un errore del client.
  if (toCall > 0) {
    actions.push({ type: ActionType.Fold });
  }

  if (toCall === 0) {
    actions.push({ type: ActionType.Check });
  } else if (player.stack > toCall) {
    actions.push({ type: ActionType.Call });
  }
   
// Raise minimo: la puntata corrente più l'ultimo aumento.
  const minRaiseTo = state.currentBet + state.lastRaiseSize;
  const maxTo = player.committedThisStreet + player.stack;

  // In Pot Limit il tetto è il piatto, in No Limit è lo stack.
  const cap =
    state.config.structure === 'pot-limit'
      ? Math.min(maxTo, potLimitMaxTo(state, player))
      : maxTo;

  if (state.currentBet === 0) {
    // Nessuna puntata: si può aprire.
    if (cap > 0) {
      actions.push({
        type: ActionType.Bet,
        minAmount: Math.min(state.config.blinds.bigBlind, cap),
        maxAmount: cap,
      });
    }
  } else if (cap > state.currentBet) {
    // C'è una puntata: si può rilanciare, purché si superi.
    actions.push({
      type: ActionType.Raise,
      minAmount: Math.min(minRaiseTo, cap),
      maxAmount: cap,
    });
  }

  // All-in: sempre in No Limit. In Pot Limit solo se lo stack sta
  // sotto il tetto, oppure se non basta nemmeno a chiamare — quello
  // è un call corto, non un rilancio, e resta sempre legale.
  if (player.stack > 0 && (maxTo <= cap || maxTo <= state.currentBet)) {
    actions.push({ type: ActionType.AllIn, minAmount: maxTo, maxAmount: maxTo });
  }

  return actions;
}

/* ────────────────────────────────────────────────────────────
   APPLICAZIONE DI UN'AZIONE
   ──────────────────────────────────────────────────────────── */

/**
 * Applica l'azione di un giocatore e restituisce il nuovo stato.
 *
 * @throws InvalidActionError se l'azione è illegale. Il Match
 *         Server deve intercettarla e rifiutare la richiesta senza
 *         alterare lo stato della mano.
 */
export function applyAction(state: HandState, action: PlayerAction): HandState {
  if (state.street === Street.Complete || state.street === Street.Showdown) {
    throw new InvalidActionError('La mano è già conclusa.', action);
  }

  if (state.toActPlayerId !== action.playerId) {
    throw new InvalidActionError(
      `Non è il turno di ${action.playerId}.`,
      action
    );
  }

  const player = findPlayer(state, action.playerId);

  if (player.status !== PlayerStatus.Active) {
    throw new InvalidActionError(
      `${action.playerId} non può agire (stato: ${player.status}).`,
      action
    );
  }

  const toCall = state.currentBet - player.committedThisStreet;

  let updated: PlayerState;
  let nextCurrentBet = state.currentBet;
  let nextLastRaiseSize = state.lastRaiseSize;
  let nextAggressorId = state.lastAggressorId;

  switch (action.type) {
    case ActionType.Fold: {
      updated = {
        ...player,
        status: PlayerStatus.Folded,
        hasActedThisStreet: true,
      };
      break;
    }

    case ActionType.Check: {
      if (toCall > 0) {
        throw new InvalidActionError(
          `Check non consentito: mancano ${toCall} Z-Coins.`,
          action
        );
      }
      updated = { ...player, hasActedThisStreet: true };
      break;
    }

    case ActionType.Call: {
      if (toCall <= 0) {
        throw new InvalidActionError(
          'Call non consentito: nessuna puntata da chiamare.',
          action
        );
      }
      // Un call che esaurisce lo stack è di fatto un all-in.
      const paid = Math.min(toCall, player.stack);
      updated = {
        ...player,
        stack: player.stack - paid,
        committedThisStreet: player.committedThisStreet + paid,
        committedTotal: player.committedTotal + paid,
        status:
          player.stack - paid === 0 ? PlayerStatus.AllIn : PlayerStatus.Active,
        hasActedThisStreet: true,
      };
      break;
    }

    case ActionType.Bet:
    case ActionType.Raise:
    case ActionType.AllIn: {
      const isAllIn = action.type === ActionType.AllIn;
      const maxTo = player.committedThisStreet + player.stack;
      const targetTo = isAllIn ? maxTo : (action.amount ?? 0);

      if (!Number.isInteger(targetTo)) {
        throw new InvalidActionError(
          `Importo non intero: ${targetTo}`,
          action
        );
      }

      if (targetTo > maxTo) {
        throw new InvalidActionError(
          `Importo ${targetTo} superiore allo stack disponibile (${maxTo}).`,
          action
        );
      }
      // Tetto del Pot Limit, controllato anche qui e non solo nelle
      // azioni disponibili: il client propone, il motore dispone.
      if (
        state.config.structure === 'pot-limit' &&
        targetTo > state.currentBet
      ) {
        const cap = potLimitMaxTo(state, player);
        if (targetTo > cap) {
          throw new InvalidActionError(
            `Importo ${targetTo} oltre il tetto del piatto (${cap}).`,
            action
          );
        }
      }

      if (targetTo <= state.currentBet && targetTo < maxTo) {
        throw new InvalidActionError(
          `L'importo ${targetTo} non supera la puntata corrente (${state.currentBet}).`,
          action
        );
      }

      // Il raise minimo non si applica a un all-in insufficiente:
      // un giocatore può sempre impegnare tutto lo stack anche se
      // non raggiunge il minimo. In quel caso però il giro NON si
      // riapre per chi ha già agito.
      const raiseSize = targetTo - state.currentBet;
      const isFullRaise = raiseSize >= state.lastRaiseSize;
      const isAllInShort = targetTo === maxTo && !isFullRaise;

      if (!isAllInShort && !isFullRaise && state.currentBet > 0) {
        throw new InvalidActionError(
          `Raise insufficiente: minimo ${state.currentBet + state.lastRaiseSize}, ricevuto ${targetTo}.`,
          action
        );
      }

      const paid = targetTo - player.committedThisStreet;

      updated = {
        ...player,
        stack: player.stack - paid,
        committedThisStreet: targetTo,
        committedTotal: player.committedTotal + paid,
        status:
          player.stack - paid === 0 ? PlayerStatus.AllIn : PlayerStatus.Active,
        hasActedThisStreet: true,
      };

      nextCurrentBet = Math.max(state.currentBet, targetTo);

      if (isFullRaise) {
        nextLastRaiseSize = raiseSize;
        nextAggressorId = player.playerId;
        // Un raise completo riapre il giro: tutti devono riparlare.
        break;
      }
      break;
    }

    default: {
      throw new InvalidActionError(
        `Tipo di azione sconosciuto: ${String(action.type)}`,
        action
      );
    }
  }

  let players = replacePlayer(state.players, updated);

  // Un raise completo azzera hasActed per gli altri: devono
  // rispondere al nuovo importo.
  const wasFullRaise =
    nextAggressorId === player.playerId &&
    nextAggressorId !== state.lastAggressorId;

  if (wasFullRaise) {
    players = players.map((p) =>
      p.playerId === player.playerId || p.status !== PlayerStatus.Active
        ? p
        : { ...p, hasActedThisStreet: false }
    );
  }

  const nextState: HandState = {
    ...state,
    players,
    currentBet: nextCurrentBet,
    lastRaiseSize: nextLastRaiseSize,
    lastAggressorId: nextAggressorId,
  };

  return advance(nextState, player.seat);
}

/* ────────────────────────────────────────────────────────────
   AVANZAMENTO
   ──────────────────────────────────────────────────────────── */

/** True se il giro di puntate della street corrente è chiuso. */
function isBettingRoundComplete(state: HandState): boolean {
  const acting = actingPlayers(state.players);

  // Nessuno può più agire: il giro è chiuso per esaurimento.
  if (acting.length === 0) return true;

  // Un solo giocatore attivo e nessuno all-in da pareggiare.
  const contesting = contestingPlayers(state.players);
  if (contesting.length === 1) return true;

  // Tutti devono aver agito e pareggiato la puntata corrente.
  return acting.every(
    (p) => p.hasActedThisStreet && p.committedThisStreet === state.currentBet
  );
}

/** Fase successiva nella sequenza. */
function nextStreet(current: Street): Street {
  switch (current) {
    case Street.Preflop:
      return Street.Flop;
    case Street.Flop:
      return Street.Turn;
    case Street.Turn:
      return Street.River;
    case Street.River:
      return Street.Showdown;
    default:
      return Street.Complete;
  }
}

/**
 * Fa progredire la mano dopo un'azione: passa il turno, apre la
 * street successiva o conclude la mano.
 */
function advance(state: HandState, lastActorSeat: number): HandState {
  const contesting = contestingPlayers(state.players);

  // Un solo giocatore rimasto: vince senza showdown.
  if (contesting.length === 1) {
    return concludeUncontested(state, contesting[0]!.playerId);
  }

  if (!isBettingRoundComplete(state)) {
    const next = nextToAct(state.players, lastActorSeat);
    return { ...state, toActPlayerId: next?.playerId ?? null };
  }

  return openNextStreet(state);
}

/**
 * Chiude la street corrente e apre la successiva, scoprendo le
 * carte comuni previste.
 */
function openNextStreet(state: HandState): HandState {
  const upcoming = nextStreet(state.street);

  if (upcoming === Street.Showdown) {
    return concludeShowdown(state);
  }

  // Azzera gli impegni di street; i totali di mano restano.
  const players = state.players.map((p) => ({
    ...p,
    committedThisStreet: 0,
    hasActedThisStreet: false,
  }));

  // Carte comuni da scoprire in questa fase.
  const targetCount =
    upcoming === Street.Flop ? 3 : upcoming === Street.Turn ? 4 : 5;
  const toReveal = targetCount - state.communityCards.length;

  const community = [...state.communityCards];
  if (toReveal > 0) {
    // Burn card prima di ogni scoperta, come al tavolo fisico.
    state.deck.burn();
    for (let i = 0; i < toReveal; i++) {
      community.push(state.deck.draw());
    }
  }

  const withCommunity: HandState = {
    ...state,
    street: upcoming,
    players,
    communityCards: community,
    currentBet: 0,
    lastRaiseSize: state.config.blinds.bigBlind,
    lastAggressorId: null,
  };

  // Se resta un solo giocatore in grado di agire, non c'è altro da
  // puntare: si procede diritti allo showdown scoprendo il resto.
  if (actingPlayers(withCommunity.players).length <= 1) {
    return openNextStreet({ ...withCommunity, toActPlayerId: null });
  }

  // Post-flop l'azione riparte dal primo attivo dopo il dealer.
  const first = nextToAct(withCommunity.players, state.dealerSeat);

  return { ...withCommunity, toActPlayerId: first?.playerId ?? null };
}

/* ────────────────────────────────────────────────────────────
   CONCLUSIONE
   ──────────────────────────────────────────────────────────── */

/** Contributi di tutti i giocatori, per la costruzione dei pot. */
function collectContributions(state: HandState): Contribution[] {
  return state.players.map((p) => ({
    playerId: p.playerId,
    amount: p.committedTotal,
    // Chi ha foldato alimenta i pot ma non può vincerli.
    eligible: p.status !== PlayerStatus.Folded,
  }));
}

/** Conclude la mano senza showdown: tutti gli altri hanno foldato. */
function concludeUncontested(state: HandState, winnerId: PlayerId): HandState {
  const pots = buildPots(collectContributions(state));
  const payouts = awardUncontested(pots, winnerId);

  return {
    ...state,
    street: Street.Complete,
    toActPlayerId: null,
    pots,
    payouts,
    players: applyPayouts(state.players, payouts),
  };
}

/**
 * Carte da consegnare ai pot per la valutazione dello showdown.
 *
 * In Omaha la mano legale è vincolata a 2 carte personali + 3
 * comuni: si risolve qui e si passano ai pot le sole 5 carte
 * effettivamente usate. Così pot.ts continua a valutare una
 * normale mano di cinque carte e non deve sapere nulla della
 * variante.
 */
function showdownCards(state: HandState, player: PlayerState): Card[] {
  if (state.config.variant !== 'omaha') {
    return [...player.holeCards, ...state.communityCards];
  }

  const best = evaluateOmahaHand(player.holeCards, state.communityCards);
  return [...best.usedHoleCards, ...best.usedCommunityCards];
}

/** Conclude la mano con showdown e distribuzione dei pot. */
function concludeShowdown(state: HandState): HandState {
  const pots = buildPots(collectContributions(state));

  const showdown = contestingPlayers(state.players).map((p) => ({
    playerId: p.playerId,
    cards: showdownCards(state, p),
  }));

  const payouts = distributePots(
    pots,
    showdown,
    seatOrderFromSmallBlind(state)
  );

  return {
    ...state,
    street: Street.Complete,
    toActPlayerId: null,
    communityCards: state.communityCards,
    pots,
    payouts,
    players: applyPayouts(state.players, payouts),
  };
}

/** Accredita le vincite agli stack. */
function applyPayouts(
  players: readonly PlayerState[],
  payouts: readonly Payout[]
): PlayerState[] {
  const byPlayer = new Map(payouts.map((p) => [p.playerId, p.amount]));

  return players.map((p) => {
    const won = byPlayer.get(p.playerId) ?? 0;
    return won > 0 ? { ...p, stack: p.stack + won } : p;
  });
}

/* ────────────────────────────────────────────────────────────
   INTERROGAZIONE
   ──────────────────────────────────────────────────────────── */

/** True se la mano è conclusa. */
export function isHandComplete(state: HandState): boolean {
  return state.street === Street.Complete;
}

/** Totale attualmente nel piatto, incluse le puntate della street. */
export function currentPotTotal(state: HandState): number {
  return state.players.reduce((sum, p) => sum + p.committedTotal, 0);
}

/**
 * Vista dello stato destinata a un singolo giocatore: nasconde le
 * carte degli avversari.
 *
 * Il Match Server deve inviare QUESTA, mai lo stato completo: se le
 * carte altrui raggiungono il client, nessuna misura lato interfaccia
 * può impedire di leggerle.
 */
export function toPlayerView(
  state: HandState,
  viewerId: PlayerId
): Omit<HandState, 'deck'> {
  const revealAll = state.street === Street.Complete;

  const players = state.players.map((p) => {
    const visible = revealAll || p.playerId === viewerId;
    return visible ? p : { ...p, holeCards: [] as readonly Card[] };
  });

  const { deck: _deck, ...rest } = state;
  return { ...rest, players };
  }
