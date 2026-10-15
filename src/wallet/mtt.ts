import { env } from '../config/env.js';
import type { MttSnapshot } from '../game/mtt-engine.js';

export interface MttRecord { id: string; revision: number; epoch: number; owner: string | null; snapshot: MttSnapshot; }
export type MttStore = <T>(action: string, args?: Record<string, unknown>) => Promise<T>;
export const mttStore: MttStore = async <T>(action: string, args: Record<string, unknown> = {}): Promise<T> => {
  const response = await fetch(`${env.SUPABASE_URL}/functions/v1/mtt-session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-match-server-secret': env.MATCH_SERVER_SECRET },
    body: JSON.stringify({ action, ...args }), signal: AbortSignal.timeout(8_000),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error ?? 'Servizio tornei non disponibile.'), { status: response.status });
  return data as T;
};
