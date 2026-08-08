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
    if (drawn > 0) {
      await returnToBotPool(drawn, 'twister_refused').catch(() => undefined);
    }
    // Rimborso pieno: la partita non è mai cominciata.
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
    sendState: (view) => emitToPlayer(playerId, ServerEvent.TableState, view),
    sendError: (message) =>
      emitToPlayer(playerId, ServerEvent.Error, { message }),
    onFinish: (result) => {
      // onFinish è sincrona e viene chiamata da dentro la stanza:
      // il pagamento non può farla aspettare, e un errore qui non
      // deve risalire dentro il motore.
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
 * Paga il premio al giocatore e rimanda al bankroll tutto il
 * resto. Chiamata una volta sola per partita.
 *
 * Il premio viene accreditato con closeTableSession, che è
 * idempotente: se questa funzione partisse due volte, la seconda
 * restituirebbe 0 e non raddoppierebbe nulla. È la stessa
 * protezione che regge il cash.
 *
 * NOTA CONTABILE: la causale scritta in wallet_transactions sarà
 * quella della chiusura tavolo, non "premio Twister". La cifra è
 * giusta, l'etichetta è imprecisa. Si sistema quando la edge
 * function saprà distinguere i motivi — riscriverla adesso
 * significherebbe toccare il wallet per un'etichetta.
 */
async function settle(
  playerId: PlayerId,
  result: TwisterResult,
): Promise<void> {
  const entry = games.get(playerId);
  if (!entry || entry.settled) return;
  entry.settled = true;

  const premioUmano =
    result.prizes.find((p) => p.playerId === playerId)?.zCoins ?? 0;

  // Le quote spettanti ai bot NON sono premi: sono fiche del pool
  // che tornano al pool. Dai 100× in su prizeSplit paga anche
  // secondo e terzo, quindi questa somma è spesso diversa da zero.
  const quoteBot = result.prizes
    .filter((p) => p.playerId !== playerId)
    .reduce((somma, p) => somma + p.zCoins, 0);

  const alBankroll = result.residuo + quoteBot;

  // Prima il bankroll, poi il giocatore: se il secondo passo
  // fallisce la sessione resta aperta nel database ed è
  // recuperabile, mentre fiche non rientrate nel pool non
  // lascerebbero traccia da nessuna parte.
  if (alBankroll > 0) {
    await returnToBotPool(alBankroll, 'twister_margin').catch((error) => {
      console.error(
        `Rientro nel bankroll fallito (${alBankroll} Z-Coins, ` +
          `Twister di ${playerId}):`,
        error,
      );
    });
  }

  try {
    await closeTableSession(entry.sessionId, premioUmano);
    console.log(
      `Twister concluso per ${playerId}: moltiplicatore ` +
        `${result.multiplier}×, premio ${premioUmano} Z-Coins, ` +
        `${alBankroll} rientrati nel bankroll`,
    );
  } catch (error) {
    console.error(
      `Accredito del premio fallito (sessione ${entry.sessionId}, ` +
        `${premioUmano} Z-Coins):`,
      error,
    );
  }

  // La stanza resta viva un po': il client deve poter rientrare e
  // vedere com'è finita. Non custodisce più denaro.
  entry.cleanupTimer = setTimeout(() => {
    const corrente = games.get(playerId);
    if (corrente && corrente.settled) {
      corrente.room.close();
      games.delete(playerId);
    }
  }, FINISHED_GRACE_MS);
}

/* ── Distacco ────────────────────────────────────────────── */

/**
 * Il socket se n'è andato.
 *
 * Non chiude niente e non muove fiche: nel Twister non si può
 * uscire, si può solo essere eliminati. La partita continua da
 * sola — i bot giocano, il timer folda per l'assente — e finisce
 * pagando il piazzamento che si è meritato.
 */
export function detachTwisterSocket(
  playerId: PlayerId,
  socketId: string,
): void {
  const entry = games.get(playerId);
  if (!entry) return;
  if (entry.socketId !== socketId) return;
  entry.socketId = null;
}

/* ── Interrogazioni ──────────────────────────────────────── */

export function getTwisterByPlayer(
  playerId: PlayerId,
): TwisterRoom | undefined {
  return games.get(playerId)?.room;
}

/** Partite ancora in gioco, escluse quelle già liquidate. */
export function activeTwisterCount(): number {
  let count = 0;
  for (const entry of games.values()) {
    if (!entry.settled) count += 1;
  }
  return count;
}

/* ── Spegnimento ─────────────────────────────────────────── */

/**
 * Annulla le partite in corso allo spegnimento del processo.
 *
 * Qui non si può fare come nel cash, dove si restituisce lo stack
 * e il conto torna: le fiche da torneo non hanno valore fuori dal
 * tavolo, e una partita interrotta non ha un piazzamento. L'unica
 * cosa onesta è l'ANNULLAMENTO — buy-in rimborsato al giocatore,
 * quota restituita al bankroll, come se l'iscrizione non fosse
 * mai avvenuta. Il moltiplicatore estratto va perso, ed è giusto:
 * tenerlo valido su una partita non giocata sarebbe regalare o
 * togliere a seconda di com'era uscito.
 *
 * Resta scoperto il crash duro, dove questa funzione non gira
 * affatto: per quello serve la riconciliazione all'avvio, che è
 * un debito già aperto anche per il cash.
 */
export async function closeAllTwisterRooms(): Promise<void> {
  const entries = [...games.values()];
  games.clear();

  await Promise.allSettled(
    entries.map(async (entry) => {
      if (entry.cleanupTimer !== null) clearTimeout(entry.cleanupTimer);
      entry.room.close();

      // Le partite già liquidate non vanno toccate: il denaro è a
      // posto, restava solo la schermata.
      if (entry.settled)
