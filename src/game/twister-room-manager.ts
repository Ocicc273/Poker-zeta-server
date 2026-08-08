/**
 * Poker Zeta — Registro delle partite Twister
 *
 * Fa al Twister quello che room-manager.ts fa al cash, ma il
 * denaro si muove in modo opposto e va capito prima di leggere
 * il codice.
 *
 * NEL CASH il buy-in è un DEPOSITO: entri, lo lasci sul tavolo,
 * e all'uscita ti torna quello che ne resta. Il tavolo si può
 * abbandonare, e abbandonarlo restituisce fiche.
 *
 * NEL TWISTER il buy-in è un'ISCRIZIONE: è speso nell'istante in
 * cui la partita comincia e non torna più. Quello che torna è un
 * PREMIO, che dipende dal piazzamento e dal moltiplicatore, non
 * dalle fiche che avevi in mano. Perciò qui non esiste nessun
 * timer di abbandono: chi stacca il socket non "perde il tavolo",
 * resta seduto e il timer di turno lo folda finché non è
 * eliminato. La partita finisce da sola, e solo allora si paga.
 *
 * IL GIRO DEL DENARO, che è il motivo per cui questo file esiste:
 *   il giocatore versa      B
 *   il bankroll bot versa  2B
 *   montepremi           M × B   (M medio 2,82)
 *   al giocatore           quota del suo piazzamento
 *   al bankroll            tutto il resto
 * "Tutto il resto" sono due cose, non una: il residuo 3B − M×B, e
 * i premi che spettano ai bot quando il moltiplicatore è alto. Se
 * si dimenticassero i secondi, il bankroll si eroderebbe come nel
 * cash e il formato perderebbe il suo margine.
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

/**
 * Quanto si tiene in vita una partita FINITA, per dare tempo al
 * client di rientrare e leggere il risultato. Il denaro è già
 * stato mosso: qui non si custodiscono fiche, solo una schermata.
 */
const FINISHED_GRACE_MS = 90_000;

interface ActiveTwister {
  room: TwisterRoom;
  sessionId: string;
  playerId: PlayerId;
  /** null quando nessun socket è collegato in questo momento. */
  socketId: string | null;
  /** Z-Coins prelevati dal bankroll all'iscrizione: 2 × buy-in. */
  drawn: number;
  buyIn: number;
  /** True da quando i premi sono stati liquidati. */
  settled: boolean;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

const games = new Map<PlayerId, ActiveTwister>();

let io: Server | null = null;

/** Da chiamare una volta all'avvio, come per il cash. */
export function configureTwisterManager(server: Server): void {
  io = server;
}

function emitToPlayer(
  playerId: PlayerId,
  event: string,
  payload: unknown,
): void {
  const entry = games.get(playerId);
  if (!io || !entry || entry.socketId === null) return;
  io.to(entry.socketId).emit(event, payload);
}

/* ── Iscrizione ──────────────────────────────────────────── */

export interface JoinTwisterResult {
  room: TwisterRoom;
  /** True se il giocatore è rientrato in una partita già in corso. */
  reattached: boolean;
}

/**
 * Iscrive il giocatore a un Twister, o lo riattacca a quello che
 * sta già giocando.
 *
 * Il buy-in richiesto viene IGNORATO in caso di rientro: la
 * partita è già pagata e ha già il suo moltiplicatore estratto.
 *
 * L'ordine dei passaggi non è arbitrario. Prima si estrae il
 * moltiplicatore, perché deve essere deciso dal server e prima
 * della prima mano. Poi si addebita il giocatore. Poi si preleva
 * dal bankroll. Ogni passo che fallisce annulla i precedenti: non
 * deve esistere una partita a metà pagata.
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

  // Estratto qui, con la sorgente crittografica di node:crypto, e
  // annunciato dalla stanza al primo broadcast. Il client non lo
  // scopre mai prima del server.
  const multiplier = drawMultiplier();

  const sessionId = await openTableSession(playerId, buyIn);

  // Il bankroll versa la quota degli avversari. A differenza del
  // cash non serve dividerla per bot — le fiche da torneo sono
  // fisse a 500 per tutti — quindi qui è puro movimento contabile
  // e va prelevata INTERA o niente: una partita a tre pagata da
  // due non ha montepremi.
  const dovuto = buyIn * TWISTER_BOT_COUNT;
  let drawn = 0;
  try {
    drawn = await drawFromBotPool(dovuto);
  } catch (error) {
    await closeTableSession(sessionId, buyIn).catch(() => undefined);
    throw error;
  }

  if (drawn < dovuto) {
  if (entry.drawn > 0) {
        await returnToBotPool(entry.drawn, 'twister_cancelled').catch(
          (error) => {
            console.error(
              `Annullamento Twister: rientro di ${entry.drawn} Z-Coins fallito:`,
              error,
            );
          },
        );
      }

      await closeTableSession(entry.sessionId, entry.buyIn).catch((error) => {
        console.error(
          `Annullamento Twister: rimborso del buy-in fallito (sessione ${entry.sessionId}):`,
          error,
        );
      });

      console.log(
        `Twister annullato per ${entry.playerId}: rimborsati ${entry.buyIn} Z-Coins`,
      );
    }),
  );
}    
