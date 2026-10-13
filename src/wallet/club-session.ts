import { env } from '../config/env.js';
import type { ClubCheckpoint, ClubOperation } from '../game/club-ledger.js';

/** Solo gli errori temporanei vanno ritentati; un rifiuto esplicito sospende il tavolo. */
export class ClubStoreError extends Error {
  readonly transient: boolean;
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = 'ClubStoreError';
    this.transient = status === null || status === 408 || status === 429 || status >= 500;
  }
}

async function call<T>(action: string, data: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(env.WALLET_FUNCTION_URL, {
    method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json', 'x-match-server-secret': env.MATCH_SERVER_SECRET },
    body: JSON.stringify({ action: 'club-' + action, ...data }),
  });
  let result: { error?: string; data?: T };
  try { result = await response.json(); } catch {
    throw new ClubStoreError('Risposta contabile non leggibile.', response.ok ? null : response.status);
  }
  if (!response.ok) throw new ClubStoreError(result.error ?? 'Contabilità Club non disponibile.', response.status);
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
