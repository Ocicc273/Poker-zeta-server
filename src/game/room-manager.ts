/**
 * Poker Zeta — Registro delle stanze attive
 *
 * Le stanze sono indicizzate per GIOCATORE, non per connessione.
 * È la differenza fra "hai perso la linea, hai perso il piatto" e
 * "hai perso la linea, rientri e ritrovi la tua mano".
 *
 * Il socket è una finestra: si può chiudere e riaprire. La partita
 * e le fiche impegnate sopravvivono, entro un tempo di attesa.
 */

import type { Server } from 'socket.io';
import { Room, type RoomOptions } from './room.js';
import { sanitizeBuyIn } from './table-config.js';
import { closeTableSession, openTableSession } from '../wallet/table-session.js';
import { ServerEvent } from './protocol.js';
import type { PlayerId } from '../engine/index.js';

/**
 * Quanto si tiene in vita un tavolo senza nessuno attaccato.
 *
 * Troppo corto e una galleria in metropolitana costa il buy-in;
 * troppo lungo e le fiche restano bloccate fuori dal wallet dopo
 * che il giocatore se n'è andato davvero.
 */
const ABANDON_MS = 120_000;

interface ActiveRoom {
  room: Room;
  sessionId: string;
  playerId: PlayerId;
  /** null quando nessun socket è collegato in questo momento. */
  socketId: string | null;
  abandonTimer: ReturnType<typeof setTimeout> | null;
}

const rooms = new Map<PlayerId, ActiveRoom>();

let io: Server | null = null;

/** Da chiamare una volta all'avvio, prima di aprire stanze. */
export function configureRoomManager(server: Server): void {
  io = server;
}

/**
 * Invia al socket attualmente collegato al giocatore.
 * Se non c'è nessuno collegato, il messaggio si perde: è voluto,
 * il client riceverà la fotografia completa quando si riattacca.
 */
function emitToPlayer(playerId: PlayerId, event: string, payload: unknown): void {
  const entry = rooms.get(playerId);
  if (!io || !entry || entry.socketId === null) return;
  io.to(entry.socketId).emit(event, payload);
}

function cancelAbandonTimer(entry: ActiveRoom): void {
  if (entry.abandonTimer !== null) {
    clearTimeout(entry.abandonTimer);
    entry.abandonTimer = null;
  }
}

/* ── Ingresso ────────────────────────────────────────────── */

export interface JoinResult {
  room: Room;
  /** True se il giocatore è rientrato in una partita già aperta. */
  reattached: boolean;
}

/**
 * Attacca il socket a una stanza: la ritrova se esiste, altrimenti
 * la crea addebitando il buy-in.
 *
 * Il buy-in richiesto viene ignorato in caso di rientro: si è già
 * seduti a quel tavolo con quelle fiche, e riaddebitare sarebbe
 * esattamente il difetto che questo modulo elimina.
 */
export async function joinRoom(
  socketId: string,
  playerId: PlayerId,
  playerName: string,
  requestedBuyIn: unknown,
): Promise<JoinResult> {
  const existing = rooms.get(playerId);

  if (existing) {
    cancelAbandonTimer(existing);
    existing.socketId = socketId;
    existing.room.resendState();
    return { room: existing.room, reattached: true };
  }

  // Lo stesso valore normalizzato viene addebitato e usato come
  // stack: se i due divergessero, il giocatore pagherebbe una
  // cifra e ne riceverebbe un'altra.
  const buyIn = sanitizeBuyIn(requestedBuyIn);

  // L'addebito viene prima: se fallisce, nessuna stanza deve
  // esistere.
  const sessionId = await openTableSession(playerId, buyIn);

  const options: RoomOptions = {
    roomId: `room-${playerId}`,
    humanPlayerId: playerId,
    humanName: playerName,
    buyIn,
    sendState: (view) => emitToPlayer(playerId, ServerEvent.TableState, view),
    sendError: (message) =>
      emitToPlayer(playerId, ServerEvent.Error, { message }),
  };

  const room = new Room(options);

  rooms.set(playerId, {
    room,
    sessionId,
    playerId,
    socketId,
    abandonTimer: null,
  });

  return { room, reattached: false };
}

/* ── Distacco e abbandono ────────────────────────────────── */

/**
 * Il socket se n'è andato, ma il giocatore forse no.
 *
 * Non chiude nulla e non muove fiche: avvia solo il conto alla
 * rovescia. Se il giocatore rientra prima della scadenza, ritrova
 * tutto com'era.
 */
export function detachSocket(playerId: PlayerId, socketId: string): void {
  const entry = rooms.get(playerId);
  if (!entry) return;

  // Una disconnessione tardiva di un socket vecchio non deve
  // staccare quello nuovo che nel frattempo si è già attaccato.
  if (entry.socketId !== socketId) return;

  entry.socketId = null;
  cancelAbandonTimer(entry);

  entry.abandonTimer = setTimeout(() => {
    entry.abandonTimer = null;
    void closeRoom(playerId).catch((error) => {
      console.error(`Chiusura per abbandono fallita (${playerId}):`, error);
    });
  }, ABANDON_MS);
}

/* ── Uscita ──────────────────────────────────────────────── */

/**
 * Chiude la stanza e restituisce lo stack al wallet.
 *
 * Non solleva verso l'esterno: viene invocata anche da un timer,
 * dove non c'è nessuno a cui riportare l'errore. Se il riaccredito
 * fallisce, la sessione resta aperta nel database e le fiche sono
 * recuperabili — per questo esiste la tabella table_sessions.
 */
export async function closeRoom(playerId: PlayerId): Promise<number | null> {
  const entry = rooms.get(playerId);
  if (!entry) return null;

  rooms.delete(playerId);
  cancelAbandonTimer(entry);

  const finalStack = entry.room.humanStack();
  entry.room.close();

  try {
    const returned = await closeTableSession(entry.sessionId, finalStack);
    console.log(
      `Tavolo chiuso per ${playerId}: riaccreditate ${returned} Z-Coins`,
    );
    return returned;
  } catch (error) {
    console.error(
      `Riaccredito fallito per la sessione ${entry.sessionId} ` +
        `(giocatore ${playerId}, stack ${finalStack}):`,
      error,
    );
    return null;
  }
}

/* ── Interrogazioni ──────────────────────────────────────── */

export function getRoomByPlayer(playerId: PlayerId): Room | undefined {
  return rooms.get(playerId)?.room;
}

export function activeRoomCount(): number {
  return rooms.size;
}

/** Stanze vive ma senza nessuno collegato, in attesa di rientro. */
export function waitingRoomCount(): number {
  let count = 0;
  for (const entry of rooms.values()) {
    if (entry.socketId === null) count += 1;
  }
  return count;
}

/**
 * Chiude tutte le stanze restituendo le fiche.
 *
 * Serve allo spegnimento del processo: un riavvio lascerebbe le
 * sessioni aperte nel database e le fiche fuori dal wallet, senza
 * nessuno a reclamarle.
 */
export async function closeAllRooms(): Promise<void> {
  const players = [...rooms.keys()];
  await Promise.allSettled(players.map((playerId) => closeRoom(playerId)));
}
