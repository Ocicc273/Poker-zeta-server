/**
 * Poker Zeta — Tipi del tavolo e della mano
 * Riferimento: SDD Server Authoritative, ZB-001 modalità ufficiali
 *
 * Vocabolario condiviso fra motore, Match Server e interfaccia.
 * Nessuna logica: solo tipi e costanti.
 *
 * CONVENZIONE SUGLI IMPORTI: tutti gli importi sono interi in
 * Z-Coins. Mai numeri decimali. I decimali in virgola mobile
 * accumulano errori di arrotondamento, e in un gioco con valore
 * economico un errore di 0,01 su un pot è un difetto contabile.
 * Le divisioni di pot usano divisione intera con resto esplicito.
 */

import type { Card } from './cards';

/* ────────────────────────────────────────────────────────────
   IDENTIFICATORI
   ──────────────────────────────────────────────────────────── */

/** Identificativo di un giocatore. Corrisponde a profiles.id. */
export type PlayerId = string;

/** Posizione fisica al tavolo, 0-based. */
export type SeatIndex = number;

/* ────────────────────────────────────────────────────────────
   FASI
   ──────────────────────────────────────────────────────────── */

/** Fasi di una mano di poker in ordine cronologico. */
export enum Street {
  Preflop = 'preflop',
  Flop = 'flop',
  Turn = 'turn',
  River = 'river',
  Showdown = 'showdown',
  Complete = 'complete',
}

/** Numero di carte comuni scoperte a ciascuna fase. */
export const COMMUNITY_CARDS_BY_STREET: Record<Street, number> = {
  [Street.Preflop]: 0,
  [Street.Flop]: 3,
  [Street.Turn]: 4,
  [Street.River]: 5,
  [Street.Showdown]: 5,
  [Street.Complete]: 5,
};

/* ────────────────────────────────────────────────────────────
   STATO DEL GIOCATORE
   ──────────────────────────────────────────────────────────── */

/** Stato di un giocatore rispetto alla mano corrente. */
export enum PlayerStatus {
  /** In gioco, può agire. */
  Active = 'active',
  /** Ha abbandonato la mano. */
  Folded = 'folded',
  /** Ha impegnato tutto lo stack: non può più agire ma resta in gara. */
  AllIn = 'all-in',
  /** Seduto al tavolo ma non partecipa a questa mano. */
  SittingOut = 'sitting-out',
}

export interface PlayerState {
  playerId: PlayerId;
  seat: SeatIndex;
  /** Z-Coins disponibili, non ancora impegnati. */
  stack: number;
  /** Z-Coins impegnati nella street corrente. */
  committedThisStreet: number;
  /** Z-Coins impegnati complessivamente in questa mano. */
  committedTotal: number;
  status: PlayerStatus;
  /** Carte personali. Vuote per i giocatori non in mano. */
  holeCards: readonly Card[];
  /**
   * True se il giocatore ha già agito nella street corrente.
   * Necessario per distinguere "non ha ancora parlato" da "ha
   * chiamato": entrambi hanno lo stesso importo impegnato quando
   * nessuno ha puntato.
   */
  hasActedThisStreet: boolean;
}

/* ────────────────────────────────────────────────────────────
   AZIONI
   ──────────────────────────────────────────────────────────── */

export enum ActionType {
  Fold = 'fold',
  Check = 'check',
  Call = 'call',
  Bet = 'bet',
  Raise = 'raise',
  AllIn = 'all-in',
}

/** Azione richiesta da un giocatore. */
export interface PlayerAction {
  type: ActionType;
  playerId: PlayerId;
  /**
   * Importo TOTALE a cui il giocatore porta la propria puntata
   * nella street, non l'incremento.
   *
   * Questa scelta elimina un'intera classe di ambiguità: con
   * "raise to 100" il significato è univoco, con "raise 100" no
   * (incremento di 100? portare a 100?). È anche la convenzione
   * dei tavoli fisici e delle poker room professionali.
   *
   * Ignorato per fold e check.
   */
  amount?: number;
}

/** Azione disponibile per il giocatore di turno. */
export interface AvailableAction {
  type: ActionType;
  /** Importo minimo per bet e raise. */
  minAmount?: number;
  /** Importo massimo: limitato dallo stack. */
  maxAmount?: number;
}

/* ────────────────────────────────────────────────────────────
   CONFIGURAZIONE
   ──────────────────────────────────────────────────────────── */

export interface BlindStructure {
  smallBlind: number;
  bigBlind: number;
  /** Ante versato da ogni giocatore. 0 se non previsto. */
  ante: number;
}

export interface TableConfig {
  /** Posti al tavolo. */
  maxSeats: number;
  blinds: BlindStructure;
  /**
   * Struttura di puntata. 'no-limit' consente qualsiasi importo
   * fino allo stack; 'pot-limit' limita al valore del piatto.
   */
  structure: 'no-limit' | 'pot-limit';
}

/* ────────────────────────────────────────────────────────────
   ERRORI
   ──────────────────────────────────────────────────────────── */

/**
 * Errore di azione non valida.
 *
 * Tipo dedicato invece di Error generico: il Match Server deve
 * distinguere un'azione illegale del client (da rifiutare, senza
 * interrompere la mano) da un bug del motore (da segnalare).
 */
export class InvalidActionError extends Error {
  constructor(
    message: string,
    readonly action: PlayerAction
  ) {
    super(message);
    this.name = 'InvalidActionError';
  }
}
