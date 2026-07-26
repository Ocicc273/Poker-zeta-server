/**
 * Poker Zeta — Movimenti di Z-Coins fra wallet e tavolo
 *
 * Il Match Server non scrive mai sul database: chiede alla Edge
 * Function di farlo. Qui vive solo il modo di chiedere.
 *
 * Ogni errore che arriva da qui è significativo per il giocatore
 * ("saldo insufficiente") o per noi ("funzione irraggiungibile"),
 * e va distinto dai guasti generici.
 */

import { env } from '../config/env.js';

/** Errore che il giocatore può vedere: saldo, sessione, parametri. */
export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletError';
  }
}

/** Oltre questo tempo si smette di aspettare: il tavolo non deve appendersi. */
const TIMEOUT_MS = 8_000;

async function callWallet<T>(body: unknown): Promise<T> {
  let response: Response;

  try {
    response = await fetch(env.WALLET_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-match-server-secret': env.MATCH_SERVER_SECRET,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new WalletError(
      `Servizio wallet irraggiungibile: ${(error as Error).message}`,
    );
  }

  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    // Risposta non JSON: probabilmente una pagina di errore.
    parsed = {};
  }

  if (!response.ok) {
    const message =
      typeof parsed.error === 'string'
        ? parsed.error
        : `Errore wallet (${response.status})`;
    throw new WalletError(message);
  }

  return parsed as T;
}

/**
 * Apre una sessione: il buy-in lascia il wallet.
 * Fallisce se il saldo non basta — ed è giusto che il tavolo
 * non si apra affatto in quel caso.
 */
export async function openTableSession(
  userId: string,
  buyIn: number,
): Promise<string> {
  const result = await callWallet<{ sessionId?: string }>({
    action: 'open',
    userId,
    buyIn,
  });

  if (typeof result.sessionId !== 'string') {
    throw new WalletError('Sessione non creata dal servizio wallet.');
  }

  return result.sessionId;
}

/**
 * Chiude una sessione: lo stack residuo torna nel wallet.
 * È idempotente lato database, quindi una doppia chiamata non
 * accredita due volte.
 */
export async function closeTableSession(
  sessionId: string,
  finalStack: number,
): Promise<number> {
  const result = await callWallet<{ returned?: number }>({
    action: 'close',
    sessionId,
    finalStack: Math.max(0, Math.floor(finalStack)),
  });

  return Number(result.returned ?? 0);
}
