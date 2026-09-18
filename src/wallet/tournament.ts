import { env } from '../config/env.js';
import type { TournamentStatus } from '../game/tournament-protocol.js';

export interface TournamentRecord {
  id: string; status: TournamentStatus; buy_in: number;
  entries: { user_id: string; name: string; active: boolean; place: number | null; prize: number; refunded: boolean }[];
}
export type TournamentStore = (action: string, args?: Record<string, unknown>) => Promise<TournamentRecord>;

// Endpoint separato: nessuna open/close di table_sessions per un torneo.
export const tournamentStore: TournamentStore = async (action, args = {}) => {
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`${env.SUPABASE_URL}/functions/v1/tournament-session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-match-server-secret': env.MATCH_SERVER_SECRET },
        body: JSON.stringify({ action, ...args }), signal: AbortSignal.timeout(8_000),
      });
      const body = await response.json() as TournamentRecord & { error?: string };
      if (!response.ok) throw new Error(body.error || 'Servizio tornei non disponibile.');
      return body;
    } catch (error) { failure = error; }
  }
  throw failure;
};
