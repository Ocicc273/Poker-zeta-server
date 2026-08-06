/**
 * Poker Zeta — Match Server
 * Punto di ingresso.
 *
 * Il server è autoritativo: riceve richieste di azione, le fa
 * validare al motore e rispedisce una proiezione dello stato.
 * Le partite appartengono ai giocatori, non alle connessioni:
 * un socket che cade non porta via il tavolo.
 *
 * Da qui si servono DUE mondi: i tavoli contro bot, dove una
 * stanza appartiene a un giocatore e le fiche vengono dal wallet;
 * e i tavoli privati, dove un tavolo appartiene a un codice e le
 * fiche non toccano il wallet. Ogni gestore ha le sue funzioni e
 * non si mescolano.
 */

import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { env } from './config/env.js';
import { verifyAccessToken } from './auth/verify-token.js';
import * as engine from './engine/index.js';
import {
  botStatus,
  claimRestartFund,
  WalletError,
} from './wallet/table-session.js';
import {
  ClientEvent,
  ServerEvent,
  type ActionPayload,
  type CreatePrivateTablePayload,
  type JoinPrivateTablePayload,
  type JoinTablePayload,
  type RechargePlayerPayload,
} from './game/protocol.js';
import {
  activeRoomCount,
  closeAllRooms,
  closeRoom,
  configureRoomManager,
  detachSocket,
  getRoomByPlayer,
  joinRoom,
  waitingRoomCount,
} from './game/room-manager.js';
import {
  closeAllPrivateTables,
  configurePrivateRoomManager,
  createTable as createPrivateTable,
  detachPrivateSocket,
  getPrivateTableByPlayer,
  joinTable as joinPrivateTable,
  leaveTable as leavePrivateTable,
  privateTableCount,
  PrivateTableError,
  rechargePlayer,
} from './game/private-room-manager.js';

interface ConnectedPlayer {
  userId: string;
  username: string | null;
}

const engineExports = Object.keys(engine).length;
if (engineExports === 0) {
  throw new Error('Motore di gioco non caricato: src/engine è vuoto.');
}

const httpServer = createServer((req, res) => {
  if (req.url?.startsWith('/bot-status')) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'x'}`);

    // Chiave assente o sbagliata: 404, non 401. Una rotta di
    // diagnostica non deve nemmeno rivelare di esistere.
    if (env.STATUS_KEY === '' || url.searchParams.get('key') !== env.STATUS_KEY) {
      res.writeHead(404);
      res.end();
      return;
    }

    void botStatus()
      .then((status) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status, null, 2));
      })
      .catch((error) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (error as Error).message }));
      });
    return;
  }
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        service: 'poker-zeta-server',
        auth: 'enabled',
        engine: engineExports,
        wallet: 'enabled',
        rooms: activeRoomCount(),
        waiting: waitingRoomCount(),
        privateTables: privateTableCount(),
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

const io = new Server(httpServer, {
  cors: {
    // Verrà ristretto al dominio del client prima del lancio.
    origin: '*',
  },
});

configureRoomManager(io);
configurePrivateRoomManager(io);

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;

  if (typeof token !== 'string' || token.length === 0) {
    next(new Error('AUTH_TOKEN_MANCANTE'));
    return;
  }

  try {
    const player = await verifyAccessToken(token);
    socket.data.player = player;
    next();
  } catch {
    next(new Error('AUTH_NON_VALIDA'));
  }
});

io.on('connection', (socket) => {
  const player = socket.data.player as ConnectedPlayer;
  const label = player.username ?? '(senza nome)';

  console.log(`Giocatore autenticato: ${label} [${player.userId}]`);
  socket.emit(ServerEvent.Welcome, player);

  socket.on(ClientEvent.JoinTable, async (payload: JoinTablePayload) => {
    try {
      const { reattached } = await joinRoom(
        socket.id,
        player.userId,
        player.username ?? 'Tu',
        payload?.buyIn,
      );

      if (reattached) {
        console.log(`${label} è rientrato al tavolo`);
        return;
      }

      console.log(`Stanza aperta per ${label} (${socket.id})`);
      getRoomByPlayer(player.userId)?.start();
    } catch (error) {
      // Saldo insufficiente è la causa più comune, ed è una
      // risposta legittima: il tavolo semplicemente non si apre.
      const message =
        error instanceof WalletError
          ? error.message
          : 'Impossibile aprire il tavolo.';

      console.error(`Ingresso rifiutato per ${label}:`, error);
      socket.emit(ServerEvent.Error, { message });
      socket.emit(ServerEvent.TableClosed, { reason: message });
    }
  });

  socket.on(ClientEvent.Action, (payload: ActionPayload) => {
    // I tavoli privati hanno la precedenza: se il giocatore è
    // seduto lì, è lì che sta agendo. La stanza contro bot può
    // essere ancora viva in attesa di rientro, e servirla adesso
    // significherebbe muovere il tavolo sbagliato.
    const privata = getPrivateTableByPlayer(player.userId);
    if (privata) {
      privata.azione(player.userId, payload?.type, payload?.amount);
      return;
    }

    const room = getRoomByPlayer(player.userId);
    if (!room) {
      socket.emit(ServerEvent.Error, { message: 'Nessun tavolo attivo.' });
      return;
    }
    room.handleHumanAction(payload?.type, payload?.amount);
  });

  socket.on(ClientEvent.NextHand, () => {
    const room = getRoomByPlayer(player.userId);
    if (!room) {
      socket.emit(ServerEvent.Error, { message: 'Nessun tavolo attivo.' });
      return;
    }
    room.startNextHand();
  });

  socket.on(ClientEvent.LeaveTable, async () => {
    const room = getRoomByPlayer(player.userId);

    if (room && !room.canLeave()) {
      socket.emit(ServerEvent.Error, {
        message:
          'Non puoi lasciare il tavolo durante una mano. Passa la mano o aspetta che finisca.',
      });
      return;
    }

    const returned = await closeRoom(player.userId);

    socket.emit(ServerEvent.TableClosed, {
      reason:
        returned === null
          ? 'Hai lasciato il tavolo.'
          : `Hai lasciato il tavolo con ${returned.toLocaleString('it-IT')} Z-Coins.`,
    });
  });

  socket.on(ClientEvent.ClaimRestartFund, async () => {
    try {
      const granted = await claimRestartFund(player.userId);

      socket.emit(ServerEvent.RestartFund, {
        granted,
        message:
          granted > 0
            ? `Fondo di ripartenza: ${granted.toLocaleString('it-IT')} ` +
              `Z-Coins accreditati. Lascia il tavolo e rientra per ` +
              `giocarli.`
            : `Fondo non disponibile adesso: si riceve una volta ` +
              `ogni 24 ore, e solo con il saldo sotto la soglia.`,
      });

      console.log(`Fondo di ripartenza per ${label}: ${granted}`);
    } catch (error) {
      // Un fallimento qui non è mai colpa del giocatore: o il
      // servizio non risponde, o la richiesta è malformata.
      const message =
        error instanceof WalletError
          ? error.message
          : 'Impossibile richiedere il fondo adesso.';

      console.error(`Fondo di ripartenza fallito per ${label}:`, error);
      socket.emit(ServerEvent.Error, { message });
    }
  });

  /* ── Tavoli privati ────────────────────────────────────── */

  socket.on(
    ClientEvent.CreatePrivateTable,
    async (payload: CreatePrivateTablePayload) => {
      try {
        const code = await createPrivateTable(
          socket.id,
          player.userId,
          player.username ?? 'Tu',
          {
            stakeLevel: payload?.stakeLevel,
            maxSeats: payload?.maxSeats,
            rakePercent: payload?.rakePercent,
            startingStack: payload?.startingStack,
          },
        );

        // Solo a chi ospita: è lui che deve condividerlo.
        socket.emit(ServerEvent.PrivateTableCreated, { code });
        console.log(`${label} ha aperto il tavolo privato ${code}`);
      } catch (error) {
        const message =
          error instanceof PrivateTableError
            ? error.message
            : 'Impossibile aprire il tavolo privato adesso.';

        console.error(`Apertura tavolo privato fallita per ${label}:`, error);
        socket.emit(ServerEvent.Error, { message });
      }
    },
  );

  socket.on(
    ClientEvent.JoinPrivateTable,
    (payload: JoinPrivateTablePayload) => {
      try {
        joinPrivateTable(
          socket.id,
          payload?.code,
          player.userId,
          player.username ?? 'Tu',
        );
        console.log(`${label} è entrato nel tavolo privato`);
      } catch (error) {
        // Codice sbagliato e tavolo pieno sono risposte legittime,
        // non guasti: il messaggio va mostrato così com'è.
        const message =
          error instanceof PrivateTableError
            ? error.message
            : 'Impossibile entrare nel tavolo.';

        socket.emit(ServerEvent.Error, { message });
      }
    },
  );

  socket.on(ClientEvent.LeavePrivateTable, () => {
    // Nessun riaccredito: le fiche del privato non sono mai uscite
    // da un wallet e non ci tornano.
    leavePrivateTable(player.userId);
    socket.emit(ServerEvent.TableClosed, {
      reason: 'Hai lasciato il tavolo privato.',
    });
  });

  socket.on(ClientEvent.RechargePlayer, (payload: RechargePlayerPayload) => {
    const fatto = rechargePlayer(
      player.userId,
      payload?.playerId,
      payload?.stack,
    );

    if (!fatto) {
      socket.emit(ServerEvent.Error, {
        message:
          'Ricarica non riuscita: può farla solo chi ospita, verso ' +
          'qualcuno seduto allo stesso tavolo, e non durante una mano.',
      });
    }
  });

  socket.on('disconnect', (reason) => {
    // Nessun riaccredito qui: il tavolo resta in attesa, e solo se
    // il giocatore non torna verrà chiuso dal timer di abbandono.
    // Le due chiamate non si escludono: una sola delle due trova
    // qualcosa da fare, l'altra esce subito.
    detachSocket(player.userId, socket.id);
    detachPrivateSocket(player.userId, socket.id);
    console.log(`Socket chiuso: ${player.userId} (${reason}) — tavolo in attesa`);
  });
});

httpServer.listen(env.PORT, () => {
  console.log(
    `Match Server in ascolto sulla porta ${env.PORT} — motore: ${engineExports} export`,
  );
});

/**
 * Rete di sicurezza del processo.
 *
 * Un'eccezione sfuggita non deve far sparire il server senza
 * lasciare traccia: qui viene registrata prima che Railway riavvii
 * il container, così nei log resta il motivo.
 */
process.on('uncaughtException', (error) => {
  console.error('Eccezione non gestita:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Promise rifiutata senza gestore:', reason);
});

/**
 * Spegnimento ordinato.
 *
 * Railway invia SIGTERM prima di sostituire il container a ogni
 * deploy. Senza questo blocco le stanze morirebbero con il
 * processo, lasciando sessioni aperte nel database e fiche fuori
 * dal wallet di chi stava giocando.
 *
 * I tavoli privati non hanno fiche da restituire, ma vanno chiusi
 * lo stesso: una riga rimasta aperta in private_tables continuerebbe
 * a comparire nell'elenco di un tavolo che non esiste più.
 *
 * Non copre i crash: per quelli servirà una riconciliazione
 * all'avvio che chiuda le sessioni rimaste aperte.
 */
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(
    `${signal} ricevuto: ${activeRoomCount()} tavoli e ` +
      `${privateTableCount()} tavoli privati da chiudere…`,
  );

  // Le chiamate di rete partono subito: con una finestra di
  // grazia stretta, disconnettere prima i client sarebbe
  // tempo rubato al rientro delle fiche.
  const startedAt = Date.now();

  try {
    await Promise.allSettled([closeAllRooms(), closeAllPrivateTables()]);
    console.log(`Tavoli chiusi in ${Date.now() - startedAt} ms.`);
  } catch (error) {
    console.error('Chiusura tavoli fallita durante lo spegnimento:', error);
  }

  io.close();

  httpServer.close(() => process.exit(0));

  // Se qualcosa resta appeso, il riavvio non deve bloccarsi.
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
