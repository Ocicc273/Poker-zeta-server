/**
 * Poker Zeta — Registro delle stanze attive
 *
 * Per ora ogni giocatore ha la sua stanza privata con due bot.
 * Quando arriverà il multiplayer fra umani, cambierà la logica di
 * assegnazione qui dentro: il resto del server non se ne accorgerà.
 */

import { Room } from './room.js';
import type { PlayerId } from '../engine/index.js';

const rooms = new Map<string, Room>();

/** Una stanza per socket: chiude quando il socket se ne va. */
export function createRoom(
  socketId: string,
  options: Omit<ConstructorParameters<typeof Room>[0], 'roomId'>,
): Room {
  closeRoom(socketId);

  const room = new Room({ ...options, roomId: socketId });
  rooms.set(socketId, room);
  return room;
}

export function getRoom(socketId: string): Room | undefined {
  return rooms.get(socketId);
}

export function closeRoom(socketId: string): void {
  const existing = rooms.get(socketId);
  if (existing) {
    existing.close();
    rooms.delete(socketId);
  }
}

export function activeRoomCount(): number {
  return rooms.size;
}

/** Solo per diagnostica. */
export function describeRooms(): { roomId: string; player: PlayerId }[] {
  return [...rooms.keys()].map((roomId) => ({ roomId, player: roomId }));
}
