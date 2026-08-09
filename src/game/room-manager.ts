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
import { BOT_COUNT, Room, type RoomOptions } from './room.js';
import { sanitizeBuyIn } from './table-config.js';
import {
  closeTableSession,
  drawFromBotPool,
  openTableSession,
  recordMissionEvent,
  recordRake,
  returnToBotPool,
  WalletError,
} from '../wallet/table-session.js';
import { ServerEvent } from './protocol.js';
import type { PlayerId } from '../engine/index.js';
import type { Variant } from '../engine/table-types.js';

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
  /** Variante del tavolo aperto: serve a rifiutare un rientro sbagliato. */
  variant: Variant;
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
  requestedVariant?: unknown,
): Promise<JoinResult> {
  // La variante arriva dal client come qualsiasi altro dato:
  // tutto ciò che non è esattamente 'omaha' è Hold'em.
  const variant: Variant = requestedVariant === 'omaha' ? 'omaha' : 'holdem';

  const existing = rooms.get(playerId);

  if (existing) {
    // Un tavolo aperto vince sulla richiesta nuova: le fiche sono
    // già impegnate lì. Senza questo controllo si aprirebbe la
    // schermata Omaha su una partita Hold'em, con due carte in mano.
    if (existing.variant !== variant) {
      throw new WalletError(
        existing.variant === 'omaha'
          ? 'Hai un tavolo Omaha aperto. Lascialo prima di sederti al Hold\'em.'
          : 'Hai un tavolo Hold\'em aperto. Lascialo prima di sederti all\'Omaha.',
      );
    }

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

  // Le fiche dei bot escono da un pool finito. Se il pool non
  // basta, il tavolo non si apre e il buy-in torna indietro:
  // meglio negare l'ingresso che sedere avversari senza fiche.
  let drawn = 0;
  try {
    drawn = await drawFromBotPool(buyIn * BOT_COUNT);
  } catch (error) {
    await closeTableSession(sessionId, buyIn).catch(() => undefined);
    throw error;
  }

  const perBot = Math.floor(drawn / BOT_COUNT);

  if (perBot < 1) {
    // Si restituisce quel poco che era stato prelevato, e si
    // rimborsa il buy-in chiudendo subito la sessione.
    await returnToBotPool(drawn, 'table_refused').catch(() => undefined);
    await closeTableSession(sessionId, buyIn).catch(() => undefined);
    throw new WalletError(
      'Nessun tavolo disponibile in questo momento. Riprova più tardi.',
    );
  }

  // L'eventuale resto della divisione rientra subito: tenerlo
  // fuori dal pool senza che nessuno lo usi sarebbe una perdita
  // silenziosa.
  const resto = drawn - perBot * BOT_COUNT;
  if (resto > 0) {
    await returnToBotPool(resto, 'table_remainder').catch(() => undefined);
  }

  const options: RoomOptions = {
    roomId: `room-${playerId}`,
    humanPlayerId: playerId,
    humanName: playerName,
    buyIn,
    botStacks: Array.from({ length: BOT_COUNT }, () => perBot),
    variant,
    sendState: (view) =>
      emitToPlayer(playerId, ServerEvent.TableState, {
        ...view,
        format: variant === 'omaha' ? 'omaha' : 'cash',
      }),
    sendError: (message) =>
      emitToPlayer(playerId, ServerEvent.Error, { message }),
    onHandComplete: ({ won, chipsWon }) => {
      // Non si aspetta l'esito: la mano è già conclusa e il
      // giocatore non deve attendere il database per vederne il
      // risultato. Gli errori sono già ingoiati dalla funzione.
      void recordMissionEvent(playerId, 'hands_played', 1);
      if (won) {
        void recordMissionEvent(playerId, 'hands_won', 1);
        if (chipsWon > 0) {
          void recordMissionEvent(playerId, 'chips_won', chipsWon);
        }
      }
    },
  };

  const room = new Room(options);

  rooms.set(playerId, {
    room,
    sessionId,
    playerId,
    variant,  
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
// Le fiche rimaste ai bot tornano nel pool. Va fatto anche se il
  // riaccredito del giocatore fallisce: sono due contabilità
  // separate e una non deve trascinare l'altra.
  const botTotal = entry.room.botStacksTotal();
  if (botTotal > 0) {
    await returnToBotPool(botTotal).catch((error) => {
      console.error(
        `Rientro nel bankroll bot fallito (${botTotal} fiche):`,
        error,
      );
    });
  }
  // Il rake va scritto sulla sessione prima di chiuderla:
  // dopo la chiusura quella riga non è più la corrente e il
  // totale si perderebbe. Un fallimento qui non blocca il
  // riaccredito — le fiche del rake sono già uscite dagli
  // stack, questa è solo la registrazione contabile.
  const rake = entry.room.rakeTotal();
  if (rake > 0) {
    await recordRake(entry.sessionId, rake).catch((error) => {
      console.error(
        `Registrazione del rake fallita ` +
          `(${rake} fiche, sessione ${entry.sessionId}):`,
        error,
      );
    });
  }
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
