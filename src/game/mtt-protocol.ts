import type { TableView } from './protocol.js';
import type { ActionType } from '../engine/index.js';

export const MttEvent = { Watch: 'mtt:watch', Command: 'mtt:command', State: 'mtt:state' } as const;
export interface MttConfig {
  name: string; capacity: number; minimum: number; startingStack: number;
  scheduledAt: number; levelMs: number; bigBlinds: number[];
}
export interface MttCommand {
  requestId: string; kind: 'create' | 'join' | 'leave' | 'cancel' | 'action';
  tournamentId: string; config?: MttConfig;
  tableId?: string; handId?: string; version?: number; type?: ActionType; amount?: number;
}
export interface MttSummary {
  id: string; name: string; status: 'waiting' | 'running' | 'finished' | 'cancelled';
  capacity: number; count: number; scheduledAt: number; startingStack: number;
  levelMs: number; bigBlinds: number[]; registered: boolean; revision: number;
}
export interface MttView extends MttSummary {
  level: number; nextLevelAt: number | null; round: number; finalTable: boolean;
  players: { id: string; name: string; stack: number; place: number | null; points: number; table: string | null; connected: boolean }[];
  table: TableView | null; actionVersion: number; waitingForTables: boolean;
}
export interface MttState {
  ready: boolean; error?: string; serverNow: number; canCreate: boolean;
  tournaments: MttSummary[]; selected: MttView | null;
}
export interface MttReply { ok: boolean; error?: string }
