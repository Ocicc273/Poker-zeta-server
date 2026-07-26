/**
 * Poker Zeta — Registro delle stanze attive
 *
 * Oltre a tenere le stanze, questo modulo è il punto dove le fiche
 * entrano ed escono dal wallet: aprire una stanza costa il buy-in,
 * chiuderla restituisce quel che resta.
 *
 * L'ordine conta: prima si addebita, poi si apre il tavolo. Se
 * l'addebito fallisce non deve esistere nessuna stanza.
 */

import { Room, type RoomOptions } from './room.js';
import { sanitizeBuyIn } from './table-config.js';
import { closeTableSession, openTableSession } from '../wallet/table-session.js';
import type { PlayerId } from '../engine/index.js';

interface ActiveRoom {
  room: Room;
  sessionId: string;
  playerId: PlayerId;
}

const rooms = new Map<string, ActiveRoom>();

export type CreateRoomOptions = Omit<RoomOptions, 'roomId'>;

/**
 * Addebita il buy-in e apre la stanza.
 * Propaga l'errore del wallet: chi chiama decide cosa dire al
 * giocatore.
 */
export async function createRoom(
  socketId: string,
  options: CreateRoomOptions,
): Promise<Room> {
  await closeRoom(socketId);

  // Lo stesso valore normalizzato viene addebitato e usato come
  // stack: se i due divergessero, il giocatore pagherebbe una cifra
  // e ne riceverebbe un'altra.
  const buyIn = sanitizeBuyIn(options.buyIn);

  const sessionId = await openTableSession(options.humanPlayerId, buyIn);

  const room = new Room({ ...options, buyIn, roomId: socketId });
  rooms.set(socketId, {
    room,
    sessionId,
    playerId: options.humanPlayerId,
  });

  return room;
}

export function getRoom(socketId: string): Room | undefined {
  return rooms.get(socketId)?.room;
}

/**
 * Chiude la stanza e restituisce lo stack al wallet.
 *
 * Non solleva: viene invocata anche dal disconnect, dove non c'è
 * nessuno a cui riportare l'errore. Se il riaccredito fallisce, la
 * sessione resta aperta nel database e le fiche sono recuperabili —
 * per questo esiste la tabella table_sessions.
 */
export async function closeRoom(socketId: string): Promise<number | null> {
  const active = rooms.get(socketId);
  if (!active) return null;

  rooms.delete(socketId);

  const finalStack = active.room.humanStack();
  active.room.close();

  try {
    return await closeTableSession(active.sessionId, finalStack);
  } catch (error) {
    console.error(
      `Riaccredito fallito per la sessione ${active.sessionId} ` +
        `(giocatore ${active.playerId}, stack ${finalStack}):`,
      error,
    );
    return null;
  }
}

export function activeRoomCount(): number {
  return rooms.size;
}
