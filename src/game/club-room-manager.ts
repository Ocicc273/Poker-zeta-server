import type { Server } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { PrivateRoom } from './private-room.js';
import type { CreateTableRequest } from './private-room-manager.js';
import type { ActionType, PlayerId } from '../engine/index.js';
import type { TableView } from './protocol.js';
import { ServerEvent } from './protocol.js';
import { clubStore } from '../wallet/club-session.js';
import { recordMissionEvent } from '../wallet/table-session.js';
import { chipUnits, clubBlinds, assertClubConservation, openClubSeat, reloadClubSeat,
  closeClubSeat, ClubGate, type ClubCheckpoint, type ClubOperation } from './club-ledger.js';

export const clubPhase3Enabled = process.env.CLUB_PHASE3_ENABLED === 'true';
export const clubEffects = { recordMissionEvent };
type Entry = { state: ClubCheckpoint; room: PrivateRoom; gate: ClubGate; baseRake: number; closing: boolean;
  blocked: boolean; pendingMissions: string[] };
const tables = new Map<string, Entry>();
const players = new Map<string, string>();
const sockets = new Map<string, string>();
let io: Server;
export function configureClubRooms(server: Server) { io = server; }
function emit(userId: string, event: string, data: unknown) {
  const socket = sockets.get(userId);
  if (socket) io?.to(socket).emit(event, data);
}
function bind(userId: string, socketId: string) {
  const previous = sockets.get(userId);
  sockets.set(userId, socketId);
  if (previous && previous !== socketId) io?.sockets.sockets.get(previous)?.disconnect(true);
}

/** La rete esprime chip; solo questo adattatore divide gli interi del motore. */
export function chipView(view: TableView): TableView {
  const n = (value: number) => value / 100;
  return { ...view, pot: n(view.pot), currentBet: n(view.currentBet),
    players: view.players.map(p => ({ ...p, stack: n(p.stack), committedThisStreet: n(p.committedThisStreet) })),
    payouts: view.payouts.map(p => ({ ...p, amount: n(p.amount) })),
    blinds: { smallBlind: n(view.blinds.smallBlind), bigBlind: n(view.blinds.bigBlind), ante: 0 },
    availableActions: view.availableActions.map(a => ({ ...a,
      ...(a.minAmount === undefined ? {} : { minAmount: n(a.minAmount) }),
      ...(a.maxAmount === undefined ? {} : { maxAmount: n(a.maxAmount) }) })),
    privateRakeTotal: view.privateRakeTotal == null ? null : n(view.privateRakeTotal),
    privateTable: view.privateTable ? { ...view.privateTable,
      startingStack: n(view.privateTable.startingStack), clubPhase3: true } : undefined };
}

function entryFor(userId: string) { const code = players.get(userId); return code ? tables.get(code) : undefined; }
export function clubRoomByPlayer(userId: string) { return entryFor(userId)?.room; }
export function clubRoomByCode(code: string) { return tables.get(code.toUpperCase())?.room; }
export function clubRoomCount() { return tables.size; }
export function clubPlayerCount() { return players.size; }
export function clubSummaries(clubId: string) {
  return [...tables.values()].filter(t => t.state.clubId === clubId).map(t => ({
    code: t.state.code, tableName: t.state.tableName, maxSeats: t.state.maxSeats,
    occupied: t.room.giocatoriSeduti(), connected: t.room.giocatoriConnessi(),
    smallBlind: t.state.smallBlind / 100, bigBlind: t.state.bigBlind / 100,
  }));
}
function publish(entry: Entry) {
  io?.to('club:' + entry.state.clubId).emit('server:club-tables-changed');
}
function syncBalances(entry: Entry) {
  for (const p of entry.room.accountingStacks()) {
    const seat = entry.state.seats.find(s => s.userId === p.playerId && s.closedAt === null);
    if (seat) seat.currentUnits = p.stack;
  }
  entry.state.rakeUnits = entry.baseRake + entry.room.rakeTotal();
  entry.state.inHand = entry.room.handInProgress();
  assertClubConservation(entry.state);
}

// Una risposta persa viene ritentata con gli stessi identificativo e contenuto.
// Durante l'incertezza il tavolo resta fermo: niente nuove chips o conferme.
async function persist(entry: Entry, operation: ClubOperation): Promise<void> {
  const version = entry.state.version;
  let attempts = 0;
  for (;;) {
    try {
      const next = await clubStore.commit(entry.state, operation);
      if (next !== version + 1) throw new Error('Versione contabile non coerente.');
      entry.state.version = next;
      return;
    } catch (error) {
      if (attempts++ === 0) for (const id of entry.room.playerIds())
        emit(id, ServerEvent.Error, { message: 'Salvataggio contabile in attesa. Tavolo temporaneamente sospeso.' });
      console.error('Commit Club in attesa:', operation.id, (error as Error).message);
      await new Promise<void>(resolve => { setTimeout(resolve, 5000); });
    }
  }
}

function run(entry: Entry, operation: ClubOperation, mutate: () => void): Promise<boolean> {
  return entry.gate.run(async () => {
    if (entry.blocked) throw new Error('Errore contabile: tavolo sospeso.');
    if (entry.state.closed || entry.closing && operation.kind !== 'close') throw new Error('Tavolo in chiusura.');
    if (await clubStore.receipt(entry.state.code, operation)) return true;
    const before = structuredClone(entry.state);
    entry.room.holdCheckpoint();
    try {
      mutate();
    } catch (error) {
      entry.state = before;
      entry.room.resumeCheckpoint();
      throw error;
    }
    try { syncBalances(entry); } catch (error) { entry.blocked = true; throw error; }
    await persist(entry, operation);
    for (const id of entry.pendingMissions.splice(0))
      void clubEffects.recordMissionEvent(id, 'private_hands_played', 1);
    entry.room.resumeCheckpoint();
    publish(entry);
    return true;
  });
}

function attach(state: ClubCheckpoint): Entry {
  let entry!: Entry;
  const room = new PrivateRoom({
    code: state.code, hostId: state.hostId, buyIn: 1000, maxSeats: state.maxSeats,
    startingStack: state.allocations[state.hostId], rakePercent: state.rakePercent, manualStart: true,
    clubBlinds: { smallBlind: state.smallBlind, bigBlind: state.bigBlind, ante: 0 },
    sendState: (id, view) => emit(id, ServerEvent.TableState, chipView({ ...view,
      privateRakeTotal: view.privateRakeTotal == null ? null : entry.baseRake + view.privateRakeTotal })),
    sendError: (id, message) => emit(id, ServerEvent.Error, { message }),
    onHandComplete: id => entry.pendingMissions.push(id),
    dispatch: mutate => { void run(entry, { id: randomUUID(), kind: 'hand', actor: state.hostId }, mutate)
      .catch(error => console.error('Timer Club:', error)); },
  });
  entry = { state: structuredClone(state), room, gate: new ClubGate(), baseRake: state.rakeUnits,
    closing: false, blocked: false, pendingMissions: [] };
  room.holdCheckpoint();
  for (const s of state.seats.filter(s => s.closedAt === null)) {
    room.siediti(s.userId, s.name, s.currentUnits);
    room.disconnetti(s.userId);
    players.set(s.userId, state.code);
  }
  tables.set(state.code, entry);
  room.resumeCheckpoint();
  return entry;
}

export async function recoverClubRooms(): Promise<void> {
  if (!clubPhase3Enabled) return;
  // Se il recupero fallisce il server NON accetta socket con conti incompleti.
  for (const state of await clubStore.recover()) {
    assertClubConservation(state);
    const entry = attach(state);
    if (state.inHand) await run(entry, { id: randomUUID(), kind: 'hand', actor: state.hostId }, () => {});
  }
}

export async function createClubRoom(socketId: string, hostId: string, name: string, request: CreateTableRequest) {
  if (request.gameMode !== undefined && request.gameMode !== 'holdem') throw new Error('Nei Club è disponibile Hold’em.');
  if (!request.requestId || typeof request.requestId !== 'string') throw new Error('Identificativo richiesta obbligatorio.');
  if (entryFor(hostId) && entryFor(hostId)!.state.requestId !== request.requestId)
    throw new Error('Sei già seduto a un tavolo Club.');
  const blinds = clubBlinds(request.smallBlind, request.bigBlind);
  if (!Number.isInteger(request.maxSeats) || Number(request.maxSeats) < 2 || Number(request.maxSeats) > 6 ||
      !Number.isInteger(request.rakePercent) || Number(request.rakePercent) < 0 || Number(request.rakePercent) > 6)
    throw new Error('Configurazione Club non valida.');
  if (!request.initialStacks || typeof request.initialStacks !== 'object' || Array.isArray(request.initialStacks))
    throw new Error('Assegna uno stack a ogni giocatore.');
  const allocations = Object.fromEntries(Object.entries(request.initialStacks).map(([id, value]) => [id, chipUnits(value)]));
  const state: ClubCheckpoint = { code: '', requestId: request.requestId, clubId: String(request.clubId), hostId, tableName: String(request.tableName),
    maxSeats: Number(request.maxSeats), rakePercent: Number(request.rakePercent),
    smallBlind: blinds.smallBlind, bigBlind: blinds.bigBlind, allocations, seats: [], rakeUnits: 0, version: 0,
    closed: false, inHand: false };
  openClubSeat(state, hostId, name);
  const saved = await clubStore.create(state, request.requestId);
  const existing = tables.get(saved.code);
  const entry = existing ?? attach(saved);
  if (!existing && saved.version === 0) void clubEffects.recordMissionEvent(hostId, 'private_table_created', 1);
  bind(hostId, socketId);
  entry.room.siediti(hostId, name, 0);
  publish(entry);
  return saved.code;
}
export async function joinClubRoom(socketId: string, code: string, userId: string, name: string): Promise<PrivateRoom> {
  const entry = tables.get(code);
  if (!entry || entry.closing) throw new Error('Tavolo Club non disponibile.');
  if (entryFor(userId) && entryFor(userId) !== entry) throw new Error('Sei già seduto a un altro tavolo.');
  if (!await clubStore.authorize(userId, entry.state.clubId)) throw new Error('Accesso Club non autorizzato.');
  if (entry.room.eSeduto(userId)) {
    bind(userId, socketId);
    entry.room.siediti(userId, name, 0);
    return entry.room;
  }
  await run(entry, { id: randomUUID(), kind: 'join', actor: userId, target: userId }, () => {
    if (!entry.room.haPosto()) throw new Error('Tavolo al completo.');
    const seat = openClubSeat(entry.state, userId, name);
    if (!entry.room.siediti(userId, name, seat.currentUnits)) throw new Error('Ingresso non riuscito.');
    players.set(userId, code);
  });
  bind(userId, socketId);
  entry.room.siediti(userId, name, 0);
  publish(entry);
  return entry.room;
}
export function detachClubSocket(userId: string, socketId: string) {
  if (sockets.get(userId) !== socketId) return;
  sockets.delete(userId);
  entryFor(userId)?.room.disconnetti(userId);
}
export async function actClub(userId: string, type: ActionType, amount?: unknown, requestId?: string): Promise<boolean> {
  const entry = entryFor(userId);
  if (!entry) return false;
  const units = amount === undefined ? undefined : chipUnits(amount, true);
  if (!await clubStore.authorize(userId, entry.state.clubId)) throw new Error('Accesso Club non autorizzato.');
  await run(entry, { id: requestId ?? randomUUID(), kind: 'action', actor: userId,
    actionType: type, ...(units === undefined ? {} : { amountUnits: units }) }, () => entry.room.azione(userId, type, units));
  return true;
}
export async function startClub(userId: string): Promise<boolean> {
  const entry = entryFor(userId);
  if (!entry) return false;
  if (!await clubStore.authorize(userId, entry.state.clubId, true)) throw new Error('Permesso amministratore richiesto.');
  if (entry.room.giocatoriConnessi() < 2) throw new Error('Servono due giocatori collegati.');
  await run(entry, { id: randomUUID(), kind: 'start', actor: userId }, () => {
    if (!entry.room.avviaDaHost(entry.state.hostId)) throw new Error('Avvio non disponibile.');
  });
  return true;
}
export async function reloadClub(actor: string, code: string, target: string, amount: unknown, requestId: string) {
  const entry = tables.get(code.toUpperCase());
  if (!entry || !requestId) throw new Error('Tavolo o richiesta non validi.');
  if (!await clubStore.authorize(actor, entry.state.clubId, true)) throw new Error('Permesso amministratore richiesto.');
  const units = chipUnits(amount);
  return run(entry, { id: requestId, kind: 'reload', actor, target, amountUnits: units }, () => {
    if (entry.room.handInProgress()) throw new Error('Ricarica disponibile tra le mani.');
    reloadClubSeat(entry.state, target, units);
    if (!entry.room.addAuthorizedChips(target, units)) throw new Error('Giocatore non seduto.');
  });
}
export async function assignClub(actor: string, code: string, target: string, amount: unknown, requestId: string) {
  const entry = tables.get(code.toUpperCase());
  if (!entry || !requestId) throw new Error('Tavolo o richiesta non validi.');
  if (!await clubStore.authorize(actor, entry.state.clubId, true) ||
      !await clubStore.authorize(target, entry.state.clubId)) throw new Error('Permesso o membro non valido.');
  const units = chipUnits(amount);
  return run(entry, { id: requestId, kind: 'assign', actor, target, amountUnits: units }, () => {
    if (entry.room.eSeduto(target)) throw new Error('Giocatore già seduto: usa una ricarica.');
    entry.state.allocations[target] = units;
  });
}
export async function currentClubStacks(actor: string, code: string) {
  const entry = tables.get(code.toUpperCase());
  if (!entry || !await clubStore.authorize(actor, entry.state.clubId)) throw new Error('Tavolo non disponibile.');
  const manager = await clubStore.authorize(actor, entry.state.clubId, true);
  if (entry.room.checkpointPending()) throw new Error('Salvataggio contabile in attesa.');
  return { code: entry.state.code, seats: entry.room.liveStacks().filter(s => manager || s.userId === actor),
    observedAt: new Date().toISOString() };
}
export async function leaveClub(userId: string): Promise<boolean> {
  const entry = entryFor(userId);
  if (!entry) return false;
  if (entry.room.handInProgress()) throw new Error('Aspetta la fine della mano.');
  await run(entry, { id: randomUUID(), kind: 'leave', actor: userId, target: userId }, () => {
    syncBalances(entry);
    closeClubSeat(entry.state, userId);
    if (!entry.room.alzati(userId)) throw new Error('Uscita non riuscita.');
    if (entry.room.giocatoriSeduti() === 0) entry.state.closed = true;
  });
  players.delete(userId);
  sockets.delete(userId);
  if (entry.state.closed) tables.delete(entry.state.code);
  publish(entry);
  return true;
}
export async function closeClub(actor: string, code: string): Promise<boolean> {
  const entry = tables.get(code.toUpperCase());
  if (!entry) return true;
  if (!await clubStore.authorize(actor, entry.state.clubId, true)) throw new Error('Permesso amministratore richiesto.');
  if (entry.room.handInProgress()) throw new Error('Aspetta la fine della mano prima di chiudere.');
  return finishClose(entry, actor);
}
async function finishClose(entry: Entry, actor: string): Promise<boolean> {
  try {
    await run(entry, { id: randomUUID(), kind: 'close', actor }, () => {
      if (entry.room.handInProgress()) throw new Error('Aspetta la fine della mano prima di chiudere.');
      entry.closing = true;
      syncBalances(entry);
      for (const seat of entry.state.seats) closeClubSeat(entry.state, seat.userId);
      entry.state.closed = true;
    });
    entry.room.close();
    for (const id of entry.room.playerIds()) {
      emit(id, ServerEvent.TableClosed, { reason: 'Tavolo chiuso. Stack finali registrati automaticamente.' });
      players.delete(id); sockets.delete(id);
    }
    tables.delete(entry.state.code);
    publish(entry);
    return true;
  } catch (error) { entry.closing = false; throw error; }
}
export async function stopClubRooms() {
  // Lo spegnimento non liquida una mano incompleta: il riavvio riprende l'ultimo checkpoint.
  for (const entry of tables.values()) entry.room.close();
}
