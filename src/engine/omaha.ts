/**
 * Poker Zeta — Valutazione Omaha
 * Riferimento: SDD Server Authoritative, ZB-001 modalità ufficiali
 *
 * IL VINCOLO DELL'OMAHA
 *
 * In Texas Hold'em la mano migliore è qualsiasi combinazione di 5
 * carte fra le 7 disponibili (2 personali + 5 comuni): il giocatore
 * può anche usare zero carte personali e "giocare il board".
 *
 * In Omaha il giocatore riceve 4 carte personali e la mano DEVE
 * usare esattamente 2 carte personali e 3 comuni. Né una né tre.
 *
 * La conseguenza pratica è controintuitiva e va sottolineata: avere
 * tre carte dello stesso seme in mano NON aiuta a fare colore,
 * perché solo due possono essere usate. Un giocatore con A-A-A-K
 * non ha un tris servito: può usare solo due assi.
 *
 * ARCHITETTURA
 *
 * Si generano tutte le combinazioni legali — 6 coppie di carte
 * personali × 10 terzine di carte comuni = 60 mani da 5 carte — e si
 * valuta ognuna con evaluateHand, tenendo la migliore.
 *
 * 60 valutazioni per giocatore sono trascurabili: il costo è
 * dominato dal fatto che evaluateHand su 5 carte esatte non deve
 * cercare la combinazione migliore, la calcola direttamente.
 *
 * Modulo puro: nessuno stato, nessun I/O.
 */

import type { Card } from './cards';
import { evaluateHand, compareHands, type HandRank } from './hand-rank';
import type { PlayerId } from './table-types';

/** Numero di carte personali in Omaha. */
export const OMAHA_HOLE_CARDS = 4;

/** Carte personali che la mano deve usare. Vincolo di regolamento. */
export const OMAHA_REQUIRED_HOLE = 2;

/** Carte comuni che la mano deve usare. */
export const OMAHA_REQUIRED_COMMUNITY = 3;

/* ────────────────────────────────────────────────────────────
   COMBINAZIONI
   ──────────────────────────────────────────────────────────── */

/**
 * Genera tutte le combinazioni di `size` elementi da un insieme.
 *
 * Implementazione iterativa sugli indici: evita la ricorsione, che
 * su insiemi piccoli non serve e rende il codice meno leggibile.
 */
function combinations<T>(items: readonly T[], size: number): T[][] {
  if (size > items.length || size < 0) return [];
  if (size === 0) return [[]];

  const result: T[][] = [];
  // Indici correnti, inizializzati sulla prima combinazione [0,1,2…].
  const indices = Array.from({ length: size }, (_, i) => i);

  while (true) {
    result.push(indices.map((index) => items[index]!));

    // Si cerca l'indice più a destra che può ancora avanzare.
    let position = size - 1;
    while (position >= 0 && indices[position] === items.length - size + position) {
      position--;
    }

    // Nessun indice può avanzare: tutte le combinazioni sono state
    // generate.
    if (position < 0) break;

    indices[position]!++;
    // Gli indici a destra si riallineano subito dopo quello avanzato.
    for (let i = position + 1; i < size; i++) {
      indices[i] = indices[i - 1]! + 1;
    }
  }

  return result;
}

/* ────────────────────────────────────────────────────────────
   VALUTAZIONE
   ──────────────────────────────────────────────────────────── */

/** Risultato della valutazione Omaha: la mano migliore e le sue carte. */
export interface OmahaHandRank extends HandRank {
  /** Le 2 carte personali effettivamente usate. */
  usedHoleCards: readonly Card[];
  /** Le 3 carte comuni effettivamente usate. */
  usedCommunityCards: readonly Card[];
}

/**
 * Valuta la migliore mano Omaha legale.
 *
 * @param holeCards Le 4 carte personali.
 * @param communityCards Le carte comuni: da 3 (flop) a 5 (river).
 *
 * @throws Se le carte personali non sono esattamente 4, o se le
 *         comuni sono meno di 3: in entrambi i casi non esiste una
 *         mano legale e restituire un risultato sarebbe fuorviante.
 */
export function evaluateOmahaHand(
  holeCards: readonly Card[],
  communityCards: readonly Card[]
): OmahaHandRank {
  if (holeCards.length !== OMAHA_HOLE_CARDS) {
    throw new Error(
      `Omaha richiede esattamente ${OMAHA_HOLE_CARDS} carte personali, ricevute ${holeCards.length}.`
    );
  }

  if (communityCards.length < OMAHA_REQUIRED_COMMUNITY) {
    throw new Error(
      `Servono almeno ${OMAHA_REQUIRED_COMMUNITY} carte comuni, ricevute ${communityCards.length}.`
    );
  }

  const holePairs = combinations(holeCards, OMAHA_REQUIRED_HOLE);
  const communityTriples = combinations(
    communityCards,
    OMAHA_REQUIRED_COMMUNITY
  );

  let best: OmahaHandRank | null = null;

  for (const hole of holePairs) {
    for (const community of communityTriples) {
      const rank = evaluateHand([...hole, ...community]);

      if (best === null || compareHands(rank, best) > 0) {
        best = {
          ...rank,
          usedHoleCards: hole,
          usedCommunityCards: community,
        };
      }
    }
  }

  // Impossibile con gli input validati sopra: la guardia protegge da
  // future modifiche alle costanti.
  if (best === null) {
    throw new Error('Nessuna combinazione Omaha valida generata.');
  }

  return best;
}

/* ────────────────────────────────────────────────────────────
   CLASSIFICA
   ──────────────────────────────────────────────────────────── */

/** Mano Omaha valutata associata a un giocatore. */
export interface RankedOmahaPlayer {
  playerId: PlayerId;
  rank: OmahaHandRank;
  /**
   * Posizione nello showdown a partire da 1. I giocatori in parità
   * condividono la posizione, così lo split pot si individua allo
   * stesso modo del Texas Hold'em.
   */
  position: number;
}

/**
 * Ordina i giocatori Omaha dal più forte al più debole.
 *
 * Rispecchia il comportamento di rankPlayers per il Texas Hold'em:
 * l'orchestrazione dei pot resta identica fra le due varianti.
 */
export function rankOmahaPlayers(
  entries: readonly {
    playerId: PlayerId;
    holeCards: readonly Card[];
    communityCards: readonly Card[];
  }[]
): RankedOmahaPlayer[] {
  const evaluated = entries.map((entry) => ({
    playerId: entry.playerId,
    rank: evaluateOmahaHand(entry.holeCards, entry.communityCards),
  }));

  evaluated.sort((a, b) => compareHands(b.rank, a.rank));

  const result: RankedOmahaPlayer[] = [];
  let currentPosition = 1;

  for (let i = 0; i < evaluated.length; i++) {
    const current = evaluated[i]!;

    if (i > 0) {
      const previous = evaluated[i - 1]!;
      if (compareHands(current.rank, previous.rank) !== 0) {
        currentPosition = i + 1;
      }
    }

    result.push({
      playerId: current.playerId,
      rank: current.rank,
      position: currentPosition,
    });
  }

  return result;
}

/* ────────────────────────────────────────────────────────────
   POT LIMIT
   ──────────────────────────────────────────────────────────── */

/**
 * Calcola il rilancio massimo consentito in Pot Limit.
 *
 * LA REGOLA
 * Il massimo è: piatto attuale + tutte le puntate sul tavolo + la
 * somma che il giocatore deve chiamare. In pratica il giocatore
 * prima chiama, poi rilancia dell'importo del piatto così formato.
 *
 * Esempio: piatto 100, avversario punta 50, tocca a noi.
 *   chiamata = 50
 *   piatto dopo la chiamata = 100 + 50 + 50 = 200
 *   rilancio massimo = portare la propria puntata a 50 + 200 = 250
 *
 * È il calcolo che i giocatori sbagliano più spesso a mente, e per
 * questo l'interfaccia deve sempre mostrarlo (cap. 12.8).
 *
 * @param potBeforeStreet Piatto accumulato nelle street precedenti.
 * @param committedThisStreet Puntate già sul tavolo in questa street,
 *        di tutti i giocatori, escluso il chiamante.
 * @param currentBet Puntata più alta della street.
 * @param playerCommitted Quanto ha già impegnato il giocatore.
 * @param playerStack Stack residuo del giocatore.
 *
 * @returns Importo TOTALE massimo a cui il giocatore può portare la
 *          propria puntata, coerente con la convenzione di
 *          PlayerAction.amount.
 */
export function maxPotLimitRaise(
  potBeforeStreet: number,
  committedThisStreet: number,
  currentBet: number,
  playerCommitted: number,
  playerStack: number
): number {
  const toCall = Math.max(0, currentBet - playerCommitted);

  // Piatto come sarebbe dopo che il giocatore ha chiamato.
  const potAfterCall = potBeforeStreet + committedThisStreet + toCall;

  // Il rilancio massimo porta la puntata a: chiamata + piatto.
  const maxTotal = playerCommitted + toCall + potAfterCall;

  // Lo stack resta il limite invalicabile: non si può puntare più di
  // quanto si possiede, nemmeno in Pot Limit.
  const stackLimit = playerCommitted + playerStack;

  return Math.min(maxTotal, stackLimit);
}
