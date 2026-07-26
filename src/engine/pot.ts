/**
 * Poker Zeta — Costruzione e distribuzione dei pot
 * Riferimento: SDD Server Authoritative
 *
 * IL PROBLEMA DEI SIDE POT
 *
 * Quando i giocatori vanno all-in con stack diversi, il piatto non
 * è più unico. Ogni giocatore può vincere solo la parte di piatto
 * a cui ha contribuito con pari importo degli altri.
 *
 * Esempio. Tre giocatori all-in:
 *   A impegna   50
 *   B impegna  200
 *   C impegna  500
 *
 * Si formano tre pot:
 *   Pot 1:  50 x 3 = 150   contendibile da A, B, C
 *   Pot 2: 150 x 2 = 300   contendibile da B, C   (200-50 ciascuno)
 *   Pot 3: 300 x 1 = 300   contendibile da C sola (500-200)
 *
 * Se A ha la mano migliore vince 150, ma non può toccare gli altri
 * due pot: non ha messo abbastanza. Il Pot 2 va al migliore fra B e
 * C; il Pot 3 torna a C, che era l'unica a poterlo vincere.
 *
 * L'ALGORITMO
 *
 * Si ordinano i contributi crescenti e si "affetta" orizzontalmente:
 * ogni livello di contributo genera un pot, alimentato da tutti i
 * giocatori che hanno raggiunto almeno quel livello.
 *
 * IMPORTANTE: i contributi dei giocatori che hanno foldato entrano
 * nei pot ma non danno diritto a vincerli. Chi folda dopo aver
 * puntato lascia i suoi Z-Coins sul tavolo.
 *
 * Modulo puro: nessuno stato, nessun I/O.
 */

import type { Card } from './cards';
import { rankPlayers, type RankedPlayer } from './hand-rank';
import type { PlayerId } from './table-types';

/* ────────────────────────────────────────────────────────────
   TIPI
   ──────────────────────────────────────────────────────────── */

/** Contributo di un giocatore alla mano. */
export interface Contribution {
  playerId: PlayerId;
  /** Z-Coins totali impegnati nella mano. */
  amount: number;
  /**
   * False se il giocatore ha foldato: il suo contributo alimenta
   * i pot ma non gli dà diritto a vincerli.
   */
  eligible: boolean;
}

/** Un pot con l'elenco di chi può vincerlo. */
export interface Pot {
  /** Z-Coins contenuti. */
  amount: number;
  /** Giocatori che possono contenderlo. */
  eligiblePlayers: readonly PlayerId[];
  /**
   * Indice progressivo: 0 è il pot principale, 1+ i side pot.
   * Serve alla UI per etichettarli ("Side Pot 1").
   */
  index: number;
}

/** Assegnazione di Z-Coins a un giocatore al termine della mano. */
export interface Payout {
  playerId: PlayerId;
  amount: number;
  /** Indici dei pot da cui provengono i Z-Coins. */
  fromPots: readonly number[];
}

/* ────────────────────────────────────────────────────────────
   COSTRUZIONE DEI POT
   ──────────────────────────────────────────────────────────── */

/**
 * Costruisce i pot a partire dai contributi dei giocatori.
 *
 * @param contributions Contributi totali della mano.
 * @returns Pot ordinati: indice 0 principale, poi i side pot.
 *
 * @throws Se un contributo è negativo o non intero: indicherebbe
 *         una corruzione dello stato, non una condizione di gioco.
 */
export function buildPots(contributions: readonly Contribution[]): Pot[] {
  for (const contribution of contributions) {
    if (!Number.isInteger(contribution.amount) || contribution.amount < 0) {
      throw new Error(
        `Contributo non valido per ${contribution.playerId}: ${contribution.amount}`
      );
    }
  }

  // Solo i contributi non nulli partecipano alla stratificazione.
  const active = contributions.filter((c) => c.amount > 0);
  if (active.length === 0) {
    return [];
  }

  // Livelli distinti di contribuzione, in ordine crescente.
  // Ogni livello segna il confine di un pot.
  const levels = [...new Set(active.map((c) => c.amount))].sort((a, b) => a - b);

  const pots: Pot[] = [];
  let previousLevel = 0;

  for (const level of levels) {
    // Spessore della fetta corrente.
    const sliceHeight = level - previousLevel;

    // Chi ha raggiunto almeno questo livello contribuisce alla fetta.
    const contributors = active.filter((c) => c.amount >= level);
    const potAmount = sliceHeight * contributors.length;

    // Solo i non-foldati possono vincere questa fetta.
    const eligible = contributors
      .filter((c) => c.eligible)
      .map((c) => c.playerId);

    // Un pot senza aventi diritto non può esistere in una mano
    // valida: significherebbe che tutti i contributori hanno
    // foldato, e allora la mano sarebbe già finita.
    if (potAmount > 0 && eligible.length > 0) {
      pots.push({
        amount: potAmount,
        eligiblePlayers: eligible,
        index: pots.length,
      });
    } else if (potAmount > 0 && pots.length > 0) {
      // Caso limite: la fetta esiste ma nessuno può vincerla
      // (tutti i suoi contributori hanno foldato). I Z-Coins
      // confluiscono nel pot precedente anziché sparire.
      pots[pots.length - 1]!.amount += potAmount;
    }

    previousLevel = level;
  }

  return pots;
}

/** Totale complessivo di tutti i pot. Usato per le verifiche. */
export function totalPotAmount(pots: readonly Pot[]): number {
  return pots.reduce((sum, pot) => sum + pot.amount, 0);
}

/* ────────────────────────────────────────────────────────────
   DISTRIBUZIONE
   ──────────────────────────────────────────────────────────── */

/** Mano di un giocatore allo showdown. */
export interface ShowdownEntry {
  playerId: PlayerId;
  /** Le 7 carte: 2 personali + 5 comuni. */
  cards: readonly Card[];
}

/**
 * Assegna i pot ai vincitori.
 *
 * REGOLA DEL RESTO: quando un pot non è divisibile esattamente fra
 * più vincitori, l'avanzo (odd chip) va al primo giocatore in ordine
 * di posizione a partire dallo small blind. È la convenzione dei
 * tavoli fisici. Il resto non viene mai scartato: la somma dei
 * payout è sempre esattamente uguale al totale dei pot.
 *
 * @param pots I pot da distribuire.
 * @param showdown Le mani dei giocatori ancora in gara.
 * @param seatOrder Ordine di posizione dallo small blind, per il resto.
 */
export function distributePots(
  pots: readonly Pot[],
  showdown: readonly ShowdownEntry[],
  seatOrder: readonly PlayerId[]
): Payout[] {
  // Valuta una sola volta ogni mano: rankPlayers è la parte più
  // costosa e i pot condividono gli stessi giocatori.
  const rankedAll = rankPlayers(
    showdown.map((entry) => ({
      playerId: entry.playerId,
      cards: entry.cards,
    }))
  );

  const rankById = new Map<PlayerId, RankedPlayer<PlayerId>>(
    rankedAll.map((entry) => [entry.playerId, entry])
  );

  // Accumulatore: playerId → importo e pot di provenienza.
  const payouts = new Map<PlayerId, { amount: number; fromPots: number[] }>();

  const credit = (playerId: PlayerId, amount: number, potIndex: number): void => {
    const existing = payouts.get(playerId);
    if (existing) {
      existing.amount += amount;
      if (!existing.fromPots.includes(potIndex)) {
        existing.fromPots.push(potIndex);
      }
    } else {
      payouts.set(playerId, { amount, fromPots: [potIndex] });
    }
  };

  for (const pot of pots) {
    // Fra gli aventi diritto a QUESTO pot, si cercano i migliori.
    // Un giocatore può essere il migliore in assoluto ma non avere
    // diritto a un side pot: va escluso prima del confronto.
    const contenders = pot.eligiblePlayers
      .map((id) => rankById.get(id))
      .filter((entry): entry is RankedPlayer<PlayerId> => entry !== undefined);

    if (contenders.length === 0) {
      // Nessun avente diritto è arrivato allo showdown: il pot va
      // all'unico rimasto in gara. Condizione anomala, gestita per
      // non perdere Z-Coins.
      continue;
    }

    // La posizione migliore fra i contendenti di questo pot.
    const bestPosition = Math.min(...contenders.map((c) => c.position));
    const winners = contenders.filter((c) => c.position === bestPosition);

    const share = Math.floor(pot.amount / winners.length);
    const remainder = pot.amount - share * winners.length;

    for (const winner of winners) {
      credit(winner.playerId, share, pot.index);
    }

    // Il resto va ai primi vincitori in ordine di posizione al tavolo.
    if (remainder > 0) {
      const orderedWinners = [...winners].sort(
        (a, b) =>
          seatOrder.indexOf(a.playerId) - seatOrder.indexOf(b.playerId)
      );

      for (let i = 0; i < remainder; i++) {
        const recipient = orderedWinners[i % orderedWinners.length]!;
        credit(recipient.playerId, 1, pot.index);
      }
    }
  }

  return [...payouts.entries()].map(([playerId, data]) => ({
    playerId,
    amount: data.amount,
    fromPots: data.fromPots,
  }));
}

/**
 * Assegna l'intero piatto a un solo giocatore.
 * Usata quando tutti gli altri hanno foldato: non c'è showdown,
 * e il vincitore prende tutto indipendentemente dalle carte.
 */
export function awardUncontested(
  pots: readonly Pot[],
  winnerId: PlayerId
): Payout[] {
  const total = totalPotAmount(pots);
  if (total === 0) {
    return [];
  }

  return [
    {
      playerId: winnerId,
      amount: total,
      fromPots: pots.map((pot) => pot.index),
    },
  ];
}

/**
 * Verifica di integrità contabile: la somma distribuita deve
 * coincidere con la somma dei pot.
 *
 * Da invocare nel Match Server dopo ogni distribuzione: un
 * disallineamento significa Z-Coins creati o distrutti, ed è
 * un difetto da bloccare prima che raggiunga il database.
 */
export function verifyPayoutIntegrity(
  pots: readonly Pot[],
  payouts: readonly Payout[]
): { valid: boolean; potTotal: number; payoutTotal: number } {
  const potTotal = totalPotAmount(pots);
  const payoutTotal = payouts.reduce((sum, payout) => sum + payout.amount, 0);

  return {
    valid: potTotal === payoutTotal,
    potTotal,
    payoutTotal,
  };
}
