/**
 * Poker Zeta — Contratto di rete fra client e Match Server
 *
 * Questo file è l'unico punto in cui sono definiti i nomi degli
 * eventi e la forma dei messaggi. Una copia identica vive nel
 * client in src/lib/table-protocol.ts: se le due divergono, il
 * tavolo smette di funzionare in modi difficili da diagnosticare.
 */

import type {
  ActionType,
  AvailableAction,
  Card,
  PlayerId,
  PlayerStatus,
  Street,
} from '../engine/index.js';

/* ── Eventi ──────────────────────────────────────────────── */

export const ClientEvent = {
  JoinTable: 'client:join-table',
  Action: 'client:action',
  NextHand: 'client:next-hand',
  LeaveTable: 'client:leave-table',
  ClaimRestartFund: 'client:claim-restart-fund',
  CreatePrivateTable: 'client:create-private-table',
  JoinPrivateTable: 'client:join-private-table',
  LeavePrivateTable: 'client:leave-private-table',
  RechargePlayer: 'client:recharge-player',
} as const;

export const ServerEvent = {
  Welcome: 'server:welcome',
  TableState: 'server:table-state',
  Error: 'server:error',
  TableClosed: 'server:table-closed',
  RestartFund: 'server:restart-fund',
  PrivateTableCreated: 'server:private-table-created',
} as const;

/* ── Messaggi dal client ─────────────────────────────────── */

export interface JoinTablePayload {
  buyIn: number;
}

export interface ActionPayload {
  type: ActionType;
  amount?: number;
}

/* ── Messaggi dal server ─────────────────────────────────── */

export interface ActionLogEntry {
  id: number;
  playerId: PlayerId;
  text: string;
  street: Street;
}

export interface PayoutView {
  playerId: PlayerId;
  amount: number;
}

/**
 * Come il client vede un giocatore al tavolo.
 *
 * holeCards è null quando le carte non sono visibili a chi riceve
 * questa vista. holeCardCount resta valorizzato perché
 * l'interfaccia deve comunque disegnare il dorso delle carte.
 */
export interface PlayerView {
  playerId: PlayerId;
  name: string;
  seat: number;
  stack: number;
  committedThisStreet: number;
  status: PlayerStatus;
  isDealer: boolean;
  isBot: boolean;
  holeCards: readonly Card[] | null;
  holeCardCount: number;
}

/**
 * Lo stato del tavolo come viene trasmesso.
 *
 * È una proiezione, non lo stato interno: il motore lavora con una
 * struttura più ricca che resta sul server.
 */
export interface TableView {
  handId: string | null;
  street: Street | null;
  communityCards: readonly Card[];
  pot: number;
  currentBet: number;
  toActPlayerId: PlayerId | null;
  yourPlayerId: PlayerId;
  players: readonly PlayerView[];
  availableActions: readonly AvailableAction[];
  isYourTurn: boolean;
  /**
   * Millisecondi rimasti a CHI DEVE AGIRE, chiunque sia. null se
   * nessuno deve agire. Nei tavoli contro bot vale solo per il
   * proprio turno, nei tavoli privati per il turno di chiunque.
   */
  turnMillisLeft: number | null;
  isHandComplete: boolean;
  canStartNextHand: boolean;
  isBusted: boolean;
  payouts: readonly PayoutView[];
  blinds: { smallBlind: number; bigBlind: number; ante: number };
  log: readonly ActionLogEntry[];
  /**
   * Fiche trattenute dal rake in questo tavolo dall'apertura.
   *
   * Presente solo nei tavoli privati e solo per chi ospita: serve
   * a sapere quanto si è consumato il tavolo e decidere quando
   * ricaricare. Altrove è null o assente.
   */
  privateRakeTotal?: number | null;
}

export interface ServerErrorPayload {
  message: string;
}

export interface TableClosedPayload {
  reason: string;
}

/**
 * Esito della richiesta del fondo di ripartenza.
 *
 * granted a zero NON è un errore: significa che il giocatore non
 * ne ha diritto adesso, perché l'ha già ricevuto nelle ultime 24
 * ore o perché il saldo è sopra la soglia. Il messaggio serve al
 * client per dirlo senza doverlo dedurre.
 */
export interface RestartFundPayload {
  granted: number;
  message: string;
}

/* ── Messaggi dei tavoli privati ─────────────────────────── */

export interface CreatePrivateTablePayload {
  /** Numero del livello di stake: decide i bui, non lo stack. */
  stakeLevel: number;
  maxSeats: number;
  /** Da 0 a 6. Oltre, il server taglia. */
  rakePercent: number;
  /** Fiche date a ciascuno. Non escono da nessun wallet. */
  startingStack: number;
}

export interface JoinPrivateTablePayload {
  code: string;
}

export interface RechargePlayerPayload {
  playerId: PlayerId;
  stack: number;
}

/** Il codice da condividere. Arriva solo a chi ha creato il tavolo. */
export interface PrivateTableCreatedPayload {
  code: string;
}
