import { env } from '../config/env.js';
import type { ClubCheckpoint, ClubOperation } from '../game/club-ledger.js';

async function call<T>(action: string, data: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(env.WALLET_FUNCTION_URL, {
    method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json', 'x-match-server-secret': env.MATCH_SERVER_SECRET },
    body: JSON.stringify({ action: 'club-' + action, ...data }),
  });
  const result = await response.json() as { error?: string; data?: T };
  if (!response.ok) throw new Error(result.error ?? 'Contabilità Club non disponibile.');
  return result.data as T;
}

export const clubStore = {
  create: (state: ClubCheckpoint, requestId: string) => call<ClubCheckpoint>('create', { state, requestId }),
  recover: () => call<ClubCheckpoint[]>('recover'),
  receipt: (code: string, operation: ClubOperation) => call<boolean>('receipt', { code, operation }),
  commit: (state: ClubCheckpoint, operation: ClubOperation) => call<number>('commit', { state, operation }),
  authorize: (userId: string, clubId: string, manager = false) =>
    call<boolean>('authorize', { userId, clubId, manager }),
};
