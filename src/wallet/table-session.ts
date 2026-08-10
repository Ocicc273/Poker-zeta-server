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
/**
 * Preleva fiche dal bankroll dei bot.
 *
 * Può restituire meno del richiesto: il pool è finito, ed è
 * proprio questo che impedisce ai tavoli contro bot di creare
 * Z-Coins dal nulla.
 */
export async function drawFromBotPool(amount: number): Promise<number> {
  const result = await callWallet<{ drawn?: number }>({
    action: 'bot-draw',
    amount: Math.max(0, Math.floor(amount)),
  });
  return Number(result.drawn ?? 0);
}

/** Restituisce fiche al bankroll dei bot. Torna il saldo del pool. */
export async function returnToBotPool(
  amount: number,
  reason = 'table_close',
): Promise<number> {
  const result = await callWallet<{ balance?: number }>({
    action: 'bot-return',
    amount: Math.max(0, Math.floor(amount)),
    reason,
  });
  return Number(result.balance ?? 0);
}

/**
 * Fondo di ripartenza. Restituisce quanto è stato erogato, zero se
 * il giocatore non ne ha diritto — che non è un errore.
 */
export async function claimRestartFund(userId: string): Promise<number> {
  const result = await callWallet<{ granted?: number }>({
    action: 'restart-fund',
    userId,
  });
  return Number(result.granted ?? 0);
}
/**
 * Riconciliazione all'avvio: annulla le sessioni rimaste aperte da
 * un crash. Le stanze vivono in memoria, quindi all'avvio ogni
 * sessione ancora aperta è per definizione orfana.
 *
 * NON solleva: un guasto qui non deve impedire al server di partire.
 */
export async function reconcileOrphanSessions(): Promise<number> {
  try {
    const result = await callWallet<{ reconciled?: number }>({
      action: 'reconcile',
    });
    return Number(result.reconciled ?? 0);
  } catch (error) {
    console.error("Riconciliazione all'avvio fallita:", error);
    return 0;
  }
}

/** Registra il rake prelevato in una sessione. Solo misura. */
export async function recordRake(
  sessionId: string,
  amount: number,
): Promise<number> {
  const result = await callWallet<{ rakeTotal?: number }>({
    action: 'record-rake',
    sessionId,
    amount: Math.max(0, Math.floor(amount)),
  });
  return Number(result.rakeTotal ?? 0);
}
/** Le metriche che il catalogo missioni sa contare. */
export type MissionMetric =
  | 'hands_played'
  | 'hands_won'
  | 'chips_won'
  | 'daily_login'
  | 'private_table_created'
  | 'private_hands_played';

/**
 * Registra un fatto che fa avanzare le missioni.
 *
 * NON solleva mai. Le missioni sono un contorno: un guasto qui non
 * deve poter far cadere una mano vera. Restituisce quante missioni
 * si sono completate adesso, zero se qualcosa è andato storto.
 */
export async function recordMissionEvent(
  userId: string,
  metric: MissionMetric,
  amount = 1,
): Promise<number> {
  try {
    const result = await callWallet<{ completed?: number }>({
      action: 'mission-event',
      userId,
      metric,
      amount: Math.max(0, Math.floor(amount)),
    });
    return Number(result.completed ?? 0);
  } catch (error) {
    console.error(`Registrazione missione fallita (${metric}):`, error);
    return 0;
  }
}

/**
 * Riscuote una missione completata: l'XP entra nello Zeta Prestige.
 * Torna zero se non spetta — che non è un errore, come per il fondo.
 */
export async function claimMission(
  userId: string,
  code: string,
): Promise<number> {
  const result = await callWallet<{ grantedXp?: number }>({
    action: 'mission-claim',
    userId,
    code,
  });
  return Number(result.grantedXp ?? 0);
    }
/** Un movimento del bankroll dei bot, come lo restituisce il database. */
export interface BotBankrollMovement {
  id: number;
  amount: number;
  reason: string;
  created_at: string;
}

export interface BotBankrollStatus {
  balance: number;
  updatedAt: string | null;
  movements: readonly BotBankrollMovement[];
}

/**
 * Fotografia del bankroll dei bot: saldo e ultimi movimenti.
 * Sola lettura — nessuna fiche si muove.
 */
export async function botStatus(): Promise<BotBankrollStatus> {
  const result = await callWallet<{
    balance?: number;
    updated_at?: string;
    movements?: BotBankrollMovement[];
  }>({ action: 'bot-status' });

  return {
    balance: Number(result.balance ?? 0),
    updatedAt: result.updated_at ?? null,
    movements: result.movements ?? [],
  };
}
/**
 * Apre un tavolo privato e restituisce il codice d'invito.
 *
 * Non muove fiche: le fiche dei tavoli privati non vengono dal
 * wallet. Questa riga serve solo a rendere il codice ritrovabile
 * da chi lo digita e a mostrare il tavolo nell'elenco.
 */
export async function openPrivateTable(
  hostId: string,
  stakeLevel: number,
  buyIn: number,
  maxSeats: number,
): Promise<string> {
  const result = await callWallet<{ code?: string }>({
    action: 'private-open',
    hostId,
    stakeLevel: Math.max(1, Math.floor(stakeLevel)),
    buyIn: Math.max(1, Math.floor(buyIn)),
    maxSeats: Math.max(2, Math.floor(maxSeats)),
  });

  if (typeof result.code !== 'string') {
    throw new WalletError('Tavolo non creato dal servizio wallet.');
  }

  return result.code;
}

/**
 * Segna un tavolo privato come chiuso.
 *
 * NON solleva: viene invocata anche quando l'ultimo giocatore se ne
 * va, dove non c'è nessuno a cui riportare l'errore. Una riga
 * rimasta aperta è brutta nell'elenco ma non rompe niente.
 */
export async function closePrivateTable(code: string): Promise<void> {
  try {
    await callWallet({ action: 'private-close', code });
  } catch (error) {
    console.error(`Chiusura del tavolo privato ${code} fallita:`, error);
  }
}
