import type { TableView } from './protocol.js';
import type { ActionType } from '../engine/index.js';

export const TournamentEvent = {
  Next: 'tournament:next',
  Watch: 'tournament:watch', Join: 'tournament:join', Leave: 'tournament:leave',
  Action: 'tournament:action', State: 'tournament:state',
} as const;
export type TournamentStatus = 'waiting' | 'running' | 'settling' | 'finished' | 'cancelled';
export interface TournamentPlayer {
  id: string; name: string; seat: number; stack: number; place: number | null;
}
export interface TournamentState {
  id: string; name: string; status: TournamentStatus; buyIn: number; pool: number;
  minPlayers: number; maxPlayers: number; startingStack: number; startsAt: number | null;
  level: number; nextLevelAt: number | null; turnMs: number; registrationMs: number; levelMs: number; serverNow: number;
  players: (TournamentPlayer & { connected: boolean })[];
  yourId: string; registered: boolean; table: TableView | null;
  actionVersion: number; prize: number; error?: string;
  previous?: { status: string; prize: number; refund: number } | null;
}
export interface TournamentAction {
  id: string; handId: string; version: number; type: ActionType; amount?: number;
}
export interface TournamentReply { ok: boolean; error?: string }
