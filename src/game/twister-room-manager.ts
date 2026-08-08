/**
 * Poker Zeta — Registro delle partite Twister
 *
 * Differenza dal cash: qui il buy-in è un'ISCRIZIONE, spesa e non
 * più restituibile. Quello che torna è un PREMIO, deciso dal
 * piazzamento e dal moltiplicatore. Perciò non esiste timer di
 * abbandono: chi stacca resta seduto e viene foldato dal timer di
 * turno fino all'eliminazione.
 *
 * Giro del denaro: il giocatore versa B, il bankroll 2B,
 * montepremi M×B. Al bankroll torna il residuo (3−M)×B PIÙ le
 * quote spettanti ai bot, che dai 100× in su non sono zero. Se si
 * dimenticassero le seconde, il bankroll si eroderebbe come nel
 * cash.
 */

import type { Server } from 'socket.io';

import {
  sanitizeTwisterBuyIn,
  TwisterRoom,
  TWISTER_BOT_COUNT,
  type TwisterResult,
  type TwisterRoomOptions,
} from './twister-room.js';

import { drawMultiplier } from './twister-multipliers.js';

import {
  closeTableSession,
  drawFromBotPool,
  openTableSession,
  returnToBotPool,
  WalletError,
} from '../wallet/table-session.js';

import { ServerEvent } from './protocol.js';
import type { PlayerId } from '../engine/index.js';

/** Quanto resta viva una partita FINITA, solo per mostrare l'esito. */
const FINISHED_GRACE_MS = 90_000;

interface ActiveTwister {
  room: TwisterRoom;
  sessionId: string;
  playerId: PlayerId;
  socketId: string | null;
  /** Z-Coins prelevati dal bankroll: 2 × buy-in. */
  drawn: number;
  buyIn: number;
  settled: boolean;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

const games = new Map<PlayerId, ActiveTwister>();

let io: Server | null = null;

export function configureTwisterManager(server: Server): void {
  io = server;
}

function emitToPlayer(playerId: PlayerId, event: string, payload: unknown): void {
  const entry = games.get(playerId);
  if (!io || !entry || entry.socketId === null) return;
  io.to(entry.socketId).emit(event, payload);
}

/* ── Iscrizione ──────────────────────────────────────────── */

export interface JoinTwisterResult {
  room: TwisterRoom;
  reattached: boolean;
}

/**
 * Ordine non arbitrario: moltiplicatore, poi addebito, poi
 * bankroll. Ogni passo che fallisce annulla i precedenti.
 */
export async function joinTwister(
  socketId: string,
  playerId: PlayerId,
  playerName: string,
  requestedBuyIn: unknown,
): Promise<JoinTwisterResult> {
  const existing = games.get(playerId);

  if (existing) {
    existing.socketId = socketId;
    existing.room.resendState();
    return { room: existing.room, reattached: true };
  }

  const buyIn = sanitizeTwisterBuyIn(requestedBuyIn);

  // Estratto dal server prima della prima mano, con node:crypto.
  const multiplier = drawMultiplier();

  const sessionId = await openTableSession(playerId, buyIn);

  // Va prelevato INTERO o niente: una partita a tre pagata da due
  // non ha montepremi.
  const dovuto = buyIn * TWISTER_BOT_COUNT;
  let drawn = 0;
  try {
    drawn = await drawFromBotPool(dovuto);
  } catch (error) {
    await closeTableSession(sessionId, buyIn).catch(() => undefined);
    throw error;
  }

  if (drawn < dovuto) {
    if (drawn > 0) {
      await returnToBotPool(drawn, 'twister_refused').catch(() => undefined);
    }
    await closeTableSession(sessionId, buyIn).catch(() => undefined);
    throw new WalletError(
      'Nessun Twister disponibile in questo momento. Riprova più tardi.',
    );
  }

  const options: TwisterRoomOptions = {
    roomId: `twister-${playerId}`,
    humanPlayerId: playerId,
    humanName: playerName,
    buyIn,
    multiplier,
    sendState: (view) =>
      emitToPlayer(playerId, ServerEvent.TableState, {
        ...view,
        tableId: `twister-${playerId}`,
        format: 'twister' as const,
        twisterMultiplier: multiplier,
      }),
    sendError: (message) => emitToPlayer(playerId, ServerEvent.Error, { message }),
    onFinish: (result) => {
      void settle(playerId, result).catch((error) => {
        console.error(`Liquidazione Twister fallita (${playerId}):`, error);
      });
    },
  };

  const room = new TwisterRoom(options);

  games.set(playerId, {
    room,
    sessionId,
    playerId,
    socketId,
    drawn,
    buyIn,
    settled: false,
    cleanupTimer: null,
  });

  room.start();

  return { room, reattached: false };
}

/* ── Liquidazione ────────────────────────────────────────── */

/**
 * Paga il premio e rimanda al bankroll tutto il resto. Una volta
 * sola: closeTableSession è idempotente, quindi un doppio invio
 * non raddoppia niente.
 *
 * La causale in wallet_transactions sarà quella della chiusura
 * tavolo, non "premio Twister": cifra giusta, etichetta imprecisa.
 */
async function settle(playerId: PlayerId, result: TwisterResult): Promise<void> {
  const entry = games.get(playerId);
  if (!entry || entry.settled) return;
  entry.settled = true;

  const premioUmano =
    result.prizes.find((p) => p.playerId === playerId)?.zCoins ?? 0;

  // Le quote dei bot non sono premi: sono fiche del pool.
  const quoteBot = result.prizes
    .filter((p) => p.playerId !== playerId)
    .reduce((somma, p) => somma + p.zCoins, 0);

  const alBankroll = result.residuo + quoteBot;

  // Prima il bankroll: un mancato rientro nel pool non lascia
  // traccia, una sessione non chiusa sì.
  if (alBankroll > 0) {
    await returnToBotPool(alBankroll, 'twister_margin').catch((error) => {
      console.error(`Rientro nel bankroll fallito (${alBankroll}):`, error);
    });
  } else if (alBankroll < 0) {
    // Sopra 3× il montepremi supera i tre buy-in raccolti: la
    // differenza deve USCIRE dal pool, non nascere dal nulla.
    // Senza questo ramo ogni moltiplicatore alto conia Z-Coins.
    const mancante = -alBankroll;
    const preso = await drawFromBotPool(mancante).catch((error) => {
      console.error(`Prelievo per il jackpot fallito (${mancante}):`, error);
      return 0;
    });

    if (preso < mancante) {
      // Il premio è già stato annunciato al giocatore e va pagato:
      // qui si lascia solo la traccia di quanto è stato coniato.
      console.error(
        `DEFICIT TWISTER: mancano ${mancante - preso} Z-Coins dal pool per ${playerId}`,
      );
    }
  }

  try {
    await closeTableSession(entry.sessionId, premioUmano);
    console.log(
      `Twister concluso per ${playerId}: ${result.multiplier}x, premio ${premioUmano}, al bankroll ${alBankroll}`,
    );
  } catch (error) {
    console.error(`Accredito del premio fallito (${entry.sessionId}):`, error);
  }

  // Il client non ha nessun altro modo di sapere che il torneo è
  // finito: TableView descrive una mano, non una partita. Il premio
  // viaggia nel testo, così non serve toccare il protocollo.
  emitToPlayer(playerId, ServerEvent.TableClosed, {
    reason:
      premioUmano > 0
        ? `${result.multiplier}× — hai vinto ${premioUmano.toLocaleString('it-IT')} Z-Coins`
        : `${result.multiplier}× — nessun premio questa volta`,
  });

  entry.cleanupTimer = setTimeout(() => {
    const corrente = games.get(playerId);
    if (corrente && corrente.settled) {
      corrente.room.close();
      games.delete(playerId);
    }
  }, FINISHED_GRACE_MS);
}

/* ── Distacco ────────────────────────────────────────────── */

/** Non muove fiche: nel Twister non si esce, si viene eliminati. */
export function detachTwisterSocket(playerId: PlayerId, socketId: string): void {
  const entry = games.get(playerId);
  if (!entry) return;
  if (entry.socketId !== socketId) return;
  entry.socketId = null;
}

/* ── Interrogazioni ──────────────────────────────────────── */

export function getTwisterByPlayer(playerId: PlayerId): TwisterRoom | undefined {
  return games.get(playerId)?.room;
}

export function activeTwisterCount(): number {
  let count = 0;
  for (const entry of games.values()) {
    if (!entry.settled) count += 1;
  }
  return count;
}
/**
 * Chiude una partita GIÀ liquidata, quando il giocatore preme
 * "esci" sulla schermata del risultato.
 *
 * Rifiuta se non è liquidata: durante il gioco non si esce, e
 * lasciarlo fare qui vorrebbe dire un buy-in speso senza
 * piazzamento — cioè fiche perse per un tocco sbagliato.
 */
export function dismissTwister(playerId: PlayerId): boolean {
  const entry = games.get(playerId);
  if (!entry || !entry.settled) return false;

  if (entry.cleanupTimer !== null) clearTimeout(entry.cleanupTimer);
  entry.room.close();
  games.delete(playerId);
  return true;
}

/* ── Spegnimento ─────────────────────────────────────────── */

/* ── Spegnimento ─────────────────────────────────────────── */

/**
 * Annulla le partite in corso: buy-in rimborsato, quota restituita
 * al bankroll, come se l'iscrizione non fosse mai avvenuta. Le
 * fiche da torneo non valgono fuori dal tavolo e una partita
 * interrotta non ha piazzamento, quindi l'annullamento è l'unica
 * cosa onesta. Il crash duro resta scoperto: serve la
 * riconciliazione all'avvio, debito già aperto anche per il cash.
 */
export async function closeAllTwisterRooms(): Promise<void> {
  const entries = [...games.values()];
  games.clear();

  await Promise.allSettled(
    entries.map(async (entry) => {
      if (entry.cleanupTimer !== null) clearTimeout(entry.cleanupTimer);
      entry.room.close();
      if (entry.settled) return;

      if (entry.drawn > 0) {
        await returnToBotPool(entry.drawn, 'twister_cancelled').catch((error) => {
          console.error(`Annullamento: rientro di ${entry.drawn} fallito:`, error);
        });
      }

      await closeTableSession(entry.sessionId, entry.buyIn).catch((error) => {
        console.error(`Annullamento: rimborso fallito (${entry.sessionId}):`, error);
      });

      console.log(`Twister annullato per ${entry.playerId}: rimborsati ${entry.buyIn}`);
    }),
  );
}
