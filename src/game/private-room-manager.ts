/**
 * Poker Zeta — Registro dei tavoli privati
 *
 * Fratello di room-manager.ts, con una differenza che cambia tutto:
 * là una stanza appartiene a un giocatore, qui un tavolo appartiene
 * a un CODICE e i giocatori sono molti. Da questo discende
 * l'indicizzazione doppia: i tavoli per codice, e una mappa che dice
 * dove sta ciascun giocatore.
 *
 * NIENTE WALLET. Non si apre nessuna table_session, non si addebita
 * e non si riaccredita: le fiche le carica chi ospita e restano nel
 * tavolo. Se qui comparisse una chiamata a openTableSession sarebbe
 * un errore, non una dimenticanza — vedi la nota in private-room.ts.
 */

import type { Server } from 'socket.io';

import { PrivateRoom } from './private-room.js';
import { MAX_SEATS_PRIVATE } from './table-config.js';
import { HOLDEM_STAKES, stakeLevelByNumber } from './stakes.js';
import {
  authorizeClubMember,
  closePrivateTable,
  openPrivateTable,
  recordMissionEvent,
} from '../wallet/table-session.js';
import { ServerEvent } from './protocol.js';
import type { PlayerId } from '../engine/index.js';

/** Come per i tavoli contro bot: la linea che cade non è un'uscita. */
const ABANDON_MS = 120_000;

/** Limiti allo stack iniziale. Larghi: è chi ospita a decidere. */
const MIN_STACK = 100;
const MAX_STACK = 10_000_000;

/** Tetto al rake, ripetuto qui perché il gestore rifiuta prima. */
const MAX_RAKE_PERCENT = 6;

/** Errore che il giocatore può leggere così com'è. */
export class PrivateTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivateTableError';
  }
}

interface ActiveTable {
  room: PrivateRoom;
  code: string;
  hostId: PlayerId;
  /** Le fiche che riceve chi entra: le stesse per tutti. */
  startingStack: number;
  stakeLevel: number;
  maxSeats: number;
  requestId?: string;
  clubId?: string;
  tableName?: string;
}

const tables = new Map<string, ActiveTable>();
const codeByPlayer = new Map<PlayerId, string>();
const socketByPlayer = new Map<PlayerId, string>();
const abandonTimers = new Map<PlayerId, ReturnType<typeof setTimeout>>();

let io: Server | null = null;

/** Da chiamare una volta all'avvio, come per le stanze normali. */
export function configurePrivateRoomManager(server: Server): void {
  io = server;
}

/* ── Trasmissione ────────────────────────────────────────── */

/**
 * Invia al socket collegato in questo momento a quel giocatore.
 *
 * Qui sta la differenza pratica con room-manager: là si guardava la
 * stanza per trovare il socket, perché era una sola. Qui il socket
 * si cerca per giocatore, perché al tavolo ce ne sono sei.
 */
function emitToPlayer(
  playerId: PlayerId,
  event: string,
  payload: unknown,
): void {
  const socketId = socketByPlayer.get(playerId);
  if (!io || socketId === undefined) return;
  io.to(socketId).emit(event, payload);
}

function bindSocket(playerId: PlayerId, socketId: string): void {
  const previous = socketByPlayer.get(playerId);
  if (previous !== undefined && previous !== socketId && io) {
    const socket = io.sockets.sockets.get(previous);
    socket?.emit(ServerEvent.TableClosed, {
      reason: 'Sessione privata sostituita da un nuovo collegamento.',
    });
    socket?.disconnect(true);
  }
  socketByPlayer.set(playerId, socketId);
}

function cancelAbandonTimer(playerId: PlayerId): void {
  const timer = abandonTimers.get(playerId);
  if (timer !== undefined) {
    clearTimeout(timer);
    abandonTimers.delete(playerId);
  }
}

function forgetPlayer(playerId: PlayerId): void {
  cancelAbandonTimer(playerId);
  codeByPlayer.delete(playerId);
  socketByPlayer.delete(playerId);
}

/* ── Creazione ───────────────────────────────────────────── */

export interface CreateTableRequest {
  clubId?: unknown;
  tableName?: unknown;
  gameMode?: unknown;
  requestId?: unknown;
  stakeLevel: unknown;
  maxSeats: unknown;
  rakePercent: unknown;
  startingStack: unknown;
  manualStart?: unknown;
}

function intero(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

/**
 * Apre un tavolo e restituisce il codice da condividere.
 *
 * Il codice lo genera il database, non il server: due processi
 * Railway che generassero codici in parallelo potrebbero produrre
 * lo stesso, mentre il vincolo di unicità sulla tabella no.
 */
export async function createTable(
  socketId: string,
  hostId: PlayerId,
  hostName: string,
  request: CreateTableRequest,
): Promise<string> {
  if (codeByPlayer.has(hostId)) {
    throw new PrivateTableError(
      'Sei già seduto a un tavolo privato: escine prima di aprirne un altro.',
    );
  }

  const clubId = typeof request.clubId === 'string' ? request.clubId : undefined;
  const tableName = typeof request.tableName === 'string' ? request.tableName.trim() : undefined;
  if (request.gameMode !== undefined && request.gameMode !== 'holdem') {
    throw new PrivateTableError('Nei tavoli privati è disponibile solo Hold’em.');
  }
  if (clubId && (!/^[0-9a-f-]{36}$/i.test(clubId) || !tableName || tableName.length < 3 || tableName.length > 40)) {
    throw new PrivateTableError('Club o nome tavolo non valido.');
  }
  if (clubId && (!Number.isInteger(request.stakeLevel) || !stakeLevelByNumber(request.stakeLevel as number)
    || !Number.isInteger(request.maxSeats) || Number(request.maxSeats) < 2 || Number(request.maxSeats) > MAX_SEATS_PRIVATE
    || !Number.isInteger(request.startingStack) || Number(request.startingStack) < MIN_STACK || Number(request.startingStack) > MAX_STACK
    || Number(request.startingStack) < stakeLevelByNumber(Number(request.stakeLevel))!.bigBlind
    || !Number.isInteger(request.rakePercent) || Number(request.rakePercent) < 0 || Number(request.rakePercent) > MAX_RAKE_PERCENT)) {
    throw new PrivateTableError('Impostazioni del tavolo non supportate.');
  }
  const stake =
    stakeLevelByNumber(intero(request.stakeLevel, 1)) ?? HOLDEM_STAKES[0]!;

  const maxSeats = Math.min(
    MAX_SEATS_PRIVATE,
    Math.max(2, intero(request.maxSeats, MAX_SEATS_PRIVATE)),
  );

  const rakePercent = Math.min(
    MAX_RAKE_PERCENT,
    Math.max(0, intero(request.rakePercent, 0)),
  );

  const startingStack = Math.min(
    MAX_STACK,
    Math.max(MIN_STACK, intero(request.startingStack, stake.bigBlind * 100)),
  );
  const requestId =
    typeof request.requestId === 'string' && request.requestId.length > 0
      ? request.requestId.slice(0, 80)
      : undefined;
  const manualStart = request.manualStart === true;

  // Il codice arriva dal database: se questa fallisce, non deve
  // esistere nessun tavolo in memoria.
  const code = await openPrivateTable(
    hostId,
    stake.level,
    startingStack,
    maxSeats,
    requestId,
    clubId,
    tableName,
  );

  const room = new PrivateRoom({
    code,
    hostId,
    // ATTENZIONE — questo NON è il buy-in di nessuno.
    // PrivateRoom lo usa solo per chiamare resolveStakeLevel e
    // ricavarne i bui. Passare startingStack sarebbe sbagliato: un
    // tavolo a 5/10 con stack da 50.000 diventerebbe da solo un
    // tavolo a 500/1.000. maxBuyIn è l'unico valore che
    // resolveStakeLevel riporta sempre al livello giusto, perché gli
    // intervalli della scala si sovrappongono verso il basso.
    // Se un giorno la scala cambia, questa riga va riverificata.
    buyIn: stake.maxBuyIn,
    maxSeats,
    rakePercent,
    startingStack,
    manualStart: clubId ? true : manualStart,
    sendState: (playerId, view) => {
      emitToPlayer(playerId, ServerEvent.TableState, view);
      if (clubId) publishClubTables(clubId);
    },
    sendError: (playerId, message) =>
      emitToPlayer(playerId, ServerEvent.Error, { message }),
    onEmpty: () => {
      void dismissTable(code);
    },
    onHandComplete: (playerId) => {
      // Non si aspetta l'esito: la mano è già finita e il giocatore
      // non deve attendere il database. Gli errori sono già ingoiati
      // dentro recordMissionEvent.
      void recordMissionEvent(playerId, 'private_hands_played', 1);
    },
  });

  tables.set(code, {
    room,
    code,
    hostId,
    startingStack,
    stakeLevel: stake.level,
    maxSeats,
    requestId,
    clubId,
    tableName,
  });

  bindSocket(hostId, socketId);
  codeByPlayer.set(hostId, code);

  room.siediti(hostId, hostName, startingStack);

  void recordMissionEvent(hostId, 'private_table_created', 1);

  console.log(
    `Tavolo privato ${code} aperto da ${hostId} ` +
      `(livello ${stake.level}, ${maxSeats} posti, rake ${rakePercent}%)`,
  );

  return code;
}

/* ── Ingresso ────────────────────────────────────────────── */

/**
 * Fa entrare un giocatore con un codice.
 *
 * Come in room-manager, il rientro dopo una disconnessione non è un
 * ingresso nuovo: il posto e le fiche sono ancora suoi, e non
 * riceve un secondo stack.
 */
export async function joinTable(
  socketId: string,
  rawCode: unknown,
  playerId: PlayerId,
  playerName: string,
): Promise<PrivateRoom> {
  const code = String(rawCode ?? '')
    .trim()
    .toUpperCase();

  const entry = tables.get(code);
  if (!entry) {
    throw new PrivateTableError('Codice non valido: nessun tavolo con questo codice.');
  }

  if (entry.clubId) {
    try { await authorizeClubMember(playerId, entry.clubId); }
    catch { throw new PrivateTableError('Ingresso riservato ai membri del club.'); }
    if (tables.get(code) !== entry) throw new PrivateTableError('Tavolo chiuso.');
  }
  const altrove = codeByPlayer.get(playerId);
  if (altrove !== undefined && altrove !== code) {
    throw new PrivateTableError(
      'Sei già seduto a un altro tavolo privato.',
    );
  }

  bindSocket(playerId, socketId);
  cancelAbandonTimer(playerId);

  if (entry.room.eSeduto(playerId)) {
    // Rientro: la fotografia completa, niente stack nuovo.
    codeByPlayer.set(playerId, code);
    entry.room.siediti(playerId, playerName, entry.startingStack);
    return entry.room;
  }

  if (!entry.room.haPosto()) {
    socketByPlayer.delete(playerId);
    throw new PrivateTableError('Il tavolo è al completo.');
  }

  codeByPlayer.set(playerId, code);
  entry.room.siediti(playerId, playerName, entry.startingStack);

  return entry.room;
}

/* ── Ricarica ────────────────────────────────────────────── */

/**
 * Rimette fiche a un giocatore. Solo chi ospita può.
 *
 * Il controllo su chi sia l'host lo fa PrivateRoom: qui si verifica
 * solo che i due siano allo stesso tavolo, altrimenti un host
 * potrebbe ricaricare qualcuno seduto altrove.
 */
export function rechargePlayer(
  requesterId: PlayerId,
  targetId: PlayerId,
  stack: unknown,
): boolean {
  const code = codeByPlayer.get(requesterId);
  if (code === undefined) return false;
  if (codeByPlayer.get(targetId) !== code) return false;

  const entry = tables.get(code);
  if (!entry) return false;

  const amount = Math.min(MAX_STACK, Math.max(0, intero(stack, 0)));
  return entry.room.ricarica(requesterId, targetId, amount);
}

export function startPrivateTable(playerId: PlayerId): boolean {
  const code = codeByPlayer.get(playerId);
  if (code === undefined) return false;
  const entry = tables.get(code);
  if (!entry) return false;
  return entry.room.avviaDaHost(playerId);
}

/* ── Uscita ──────────────────────────────────────────────── */

/**
 * Alza un giocatore dal tavolo.
 *
 * Non muove fiche: quelle restano al tavolo finché il tavolo
 * esiste, e spariscono con lui. È la conseguenza voluta
 * dell'economia separata.
 */
export function leaveTable(playerId: PlayerId): boolean {
  const code = codeByPlayer.get(playerId);
  const socketId = socketByPlayer.get(playerId);
  forgetPlayer(playerId);
  if (code === undefined) return true;

  const entry = tables.get(code);
  if (!entry) return true;

  if (entry.hostId === playerId) {
    void dismissTable(code);
    return true;
  }

  // Se era l'ultimo, alzati chiama onEmpty che porta a dismissTable.
  if (!entry.room.alzati(playerId)) {
    codeByPlayer.set(playerId, code);
    if (socketId !== undefined) socketByPlayer.set(playerId, socketId);
    return false;
  }
  return true;
}

/**
 * Il socket se n'è andato, il giocatore forse no.
 *
 * Diversamente dai tavoli contro bot, qui il conto alla rovescia
 * riguarda UN POSTO, non il tavolo: gli altri continuano a giocare
 * e il motore folda per l'assente allo scadere di ogni turno.
 */
export function detachPrivateSocket(
  playerId: PlayerId,
  socketId: string,
): void {
  if (socketByPlayer.get(playerId) !== socketId) return;
  if (!codeByPlayer.has(playerId)) return;

  socketByPlayer.delete(playerId);
  cancelAbandonTimer(playerId);

  const code = codeByPlayer.get(playerId);
  if (code !== undefined) {
    tables.get(code)?.room.disconnetti(playerId);
  }

  const timer = setTimeout(() => {
    abandonTimers.delete(playerId);
    try {
      leaveTable(playerId);
    } catch (error) {
      console.error(`Abbandono del tavolo privato fallito (${playerId}):`, error);
    }
  }, ABANDON_MS);

  abandonTimers.set(playerId, timer);
}

/**
 * Toglie il tavolo dalla memoria e segna la riga come chiusa.
 *
 * Non solleva: viene chiamata anche da onEmpty e dai timer, dove
 * non c'è nessuno a cui riportare l'errore.
 */
async function dismissTable(code: string): Promise<void> {
  const entry = tables.get(code);
  if (!entry) return;

  tables.delete(code);
  if (entry.clubId) publishClubTables(entry.clubId);
  for (const playerId of entry.room.playerIds()) {
    emitToPlayer(playerId, ServerEvent.TableClosed, {
      reason: 'Tavolo privato chiuso.',
    });
  }
  entry.room.close();

  // Chiunque risultasse ancora legato a questo codice va liberato,
  // altrimenti non potrebbe più entrare da nessuna parte.
  for (const [playerId, suo] of [...codeByPlayer.entries()]) {
    if (suo === code) forgetPlayer(playerId);
  }

  console.log(
    `Tavolo privato ${code} chiuso (rake trattenuto: ${entry.room.rakeTotal()})`,
  );

  await closePrivateTable(code);
}

/* ── Interrogazioni ──────────────────────────────────────── */

export function getPrivateTableByPlayer(
  playerId: PlayerId,
): PrivateRoom | undefined {
  const code = codeByPlayer.get(playerId);
  return code === undefined ? undefined : tables.get(code)?.room;
}

export function getPrivateTableByCode(code: string): PrivateRoom | undefined {
  return tables.get(code.trim().toUpperCase())?.room;
}

export function privateTableCount(): number {
  return tables.size;
}
/**
 * Quante persone sono sedute, sommando tutti i tavoli privati.
 *
 * Diverso da privateTableCount: là si contano i tavoli, qui le
 * teste. Un tavolo da sei pieno vale uno nel primo conto e sei
 * in questo.
 */
export function privatePlayerCount(): number {
  let totale = 0;
  for (const entry of tables.values()) {
    totale += entry.room.giocatoriSeduti();
  }
  return totale;
}

/** Chiude tutti i tavoli: serve allo spegnimento ordinato. */
export async function closeAllPrivateTables(): Promise<void> {
  const codes = [...tables.keys()];
  await Promise.allSettled(codes.map((code) => dismissTable(code)));
}

/** Public occupancy only: never broadcast hole cards or a player's TableView. */
export function clubTableSummaries(clubId: string) {
  return [...tables.values()].filter(t => t.clubId === clubId).map(t => ({
    code: t.code, tableName: t.tableName, maxSeats: t.maxSeats,
    occupied: t.room.giocatoriSeduti(), connected: t.room.giocatoriConnessi(),
  }));
}
const clubSnapshots = new Map<string, string>();
function publishClubTables(clubId: string): void {
  const snapshot = JSON.stringify(clubTableSummaries(clubId));
  if (clubSnapshots.get(clubId) === snapshot) return;
  clubSnapshots.set(clubId, snapshot);
  io?.to('club:' + clubId).emit('server:club-tables', clubTableSummaries(clubId));
}
