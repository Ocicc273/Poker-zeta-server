/**
 * Poker Zeta — Contratto di rete fra client e Match Server
 *
 * Questo file è l'unico punto in cui sono definiti i nomi degli
 * eventi e la forma dei messaggi. Una copia identica vivrà nel
 * client: se le due divergono, il tavolo smette di funzionare in
 * modi difficili da diagnosticare.
 */

import type {
  ActionType,
  AvailableAction,
  Card,
  PlayerId,
  Street,
} from '../engine/index.js';

/* ── Eventi ──────────────────────────────────────────────── */

export const ClientEvent = {
  JoinTable: 'client:join-table',
  Action: 'client:action',
  NextHand: 'client:next-hand',
  LeaveTable: 'client:leave-table',
} as const;

export const ServerEvent = {
  Welcome: 'server:welcome',
  TableState: 'server:table-state',
  Error: 'server:error',
  TableClosed: 'server:table-closed',
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

/**
 * Come il client vede un giocatore al tavolo.
 *
 * holeCards è null quando le carte non sono visibili a chi riceve
 * questa vista. holeCardCount resta valorizzato perché l'interfaccia
 * deve comunque disegnare il dorso delle carte.
 */
export interface PlayerView {
  playerId: PlayerId;
  name: string;
  seat: number;
  stack: number;
  committedThisStreet: number;
  status: string;
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
  isHandComplete: boolean;
  canStartNextHand: boolean;
  blinds: { smallBlind: number; bigBlind: number; ante: number };
  log: readonly ActionLogEntry[];
}

export interface ServerErrorPayload {
  message: string;
}

export interface TableClosedPayload {
  reason: string;
}
