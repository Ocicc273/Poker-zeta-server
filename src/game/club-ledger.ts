import { randomUUID } from 'node:crypto';

// Il motore usa interi: solo i tavoli Club lavorano in centesimi di chip.
export const CHIP_SCALE = 100;
export const MAX_CHIP_UNITS = 1_000_000_000;
export const CLUB_BLINDS = [[25,50],[50,100],[100,200],[200,400],[500,1000],
  [1000,2000],[2500,5000],[5000,10000],[10000,20000]] as const;

export function chipUnits(raw: unknown, allowZero = false): number {
  if (typeof raw !== 'number' && typeof raw !== 'string') throw new Error('Importo non valido.');
  const value = String(raw).trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error('Usa al massimo due decimali.');
  const [whole, fraction = ''] = value.split('.');
  const units = Number(whole) * CHIP_SCALE + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(units) || units < (allowZero ? 0 : 1) || units > MAX_CHIP_UNITS)
    throw new Error('Importo fuori dai limiti.');
  return units;
}

export function clubBlinds(small: unknown, big: unknown) {
  const smallBlind = chipUnits(small), bigBlind = chipUnits(big);
  if (bigBlind <= smallBlind) throw new Error('Il big blind deve superare lo small blind.');
  return { smallBlind, bigBlind, ante: 0 };
}

export interface ClubSeat {
  id: string;
  userId: string;
  name: string;
  initialUnits: number;
  reloadUnits: number;
  currentUnits: number;
  finalUnits: number | null;
  openedAt: string;
  closedAt: string | null;
}
export interface ClubCheckpoint {
  code: string;
  requestId: string;
  clubId: string;
  hostId: string;
  tableName: string;
  maxSeats: number;
  rakePercent: number;
  smallBlind: number;
  bigBlind: number;
  allocations: Record<string, number>;
  seats: ClubSeat[];
  rakeUnits: number;
  version: number;
  closed: boolean;
  inHand: boolean;
}
export interface ClubOperation {
  id: string;
  kind: 'create' | 'join' | 'assign' | 'reload' | 'hand' | 'leave' | 'close' | 'start' | 'action';
  actor: string;
  target?: string;
  amountUnits?: number;
  actionType?: string;
}

export function assertClubConservation(state: ClubCheckpoint): void {
  const units = state.seats.flatMap(s => [s.initialUnits, s.reloadUnits, s.currentUnits,
    ...(s.finalUnits === null ? [] : [s.finalUnits])]);
  if (units.some(n => !Number.isSafeInteger(n) || n < 0) ||
      !Number.isSafeInteger(state.rakeUnits) || state.rakeUnits < 0) throw new Error('Saldi non validi.');
  const loaded = state.seats.reduce((n, s) => n + s.initialUnits + s.reloadUnits, 0);
  const remaining = state.seats.reduce((n, s) => n + (s.finalUnits ?? s.currentUnits), 0);
  if (!Number.isSafeInteger(loaded) || !Number.isSafeInteger(remaining)) throw new Error('Totali fuori dai limiti.');
  if (remaining + state.rakeUnits !== loaded) throw new Error('Conservazione delle chips violata.');
}

export function openClubSeat(state: ClubCheckpoint, userId: string, name: string): ClubSeat {
  const existing = state.seats.find(s => s.userId === userId && s.closedAt === null);
  if (existing) return existing;
  const amount = state.allocations[userId];
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Stack non ancora autorizzato dall’admin.');
  const seat: ClubSeat = { id: randomUUID(), userId, name, initialUnits: amount, reloadUnits: 0,
    currentUnits: amount, finalUnits: null, openedAt: new Date().toISOString(), closedAt: null };
  state.seats.push(seat);
  return seat;
}

export function reloadClubSeat(state: ClubCheckpoint, target: string, amount: number): ClubSeat {
  const seat = state.seats.find(s => s.userId === target && s.closedAt === null);
  if (!seat || !Number.isSafeInteger(amount) || amount <= 0 ||
      seat.currentUnits + amount > MAX_CHIP_UNITS) throw new Error('Ricarica non valida.');
  seat.reloadUnits += amount;
  seat.currentUnits += amount;
  return seat;
}

export function closeClubSeat(state: ClubCheckpoint, userId: string): void {
  const seat = state.seats.find(s => s.userId === userId && s.closedAt === null);
  if (!seat) return;
  seat.finalUnits = seat.currentUnits;
  seat.closedAt = new Date().toISOString();
}

// Una sola operazione per tavolo. Il commit deve precedere qualsiasi conferma.
export class ClubGate {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
