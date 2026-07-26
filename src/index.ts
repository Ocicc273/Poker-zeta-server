/**
 * Poker Zeta — Match Server
 * Punto di ingresso.
 *
 * Il server è autoritativo: riceve richieste di azione, le fa
 * validare al motore e rispedisce una proiezione dello stato.
 * Le partite appartengono ai giocatori, non alle connessioni:
 * un socket che cade non porta via il tavolo.
 */

import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { env } from './config/env.js';
import { verifyAccessToken } from './auth/verify-token.js';
import * as engine from './engine/index.js';
import { WalletError } from './wallet/table-session.js';
import {
  ClientEvent,
  ServerEvent,
  type ActionPayload,
  type JoinTablePayload,
} from './game/protocol.js';
import {
  activeRoomCount,
  closeRoom,
  configureRoomManager,
  detachSocket,
  getRoomByPlayer,
  joinRoom,
  waitingRoomCount,
} from './game/room-manager.js';

interface ConnectedPlayer {
  userId: string;
  username: string | null;
}

const engineExports = Object.keys(engine).length;
if (engineExports === 0) {
  throw new Error('Motore di gioco non caricato: src/engine è vuoto.');
}

const httpServer = createServer((req, res) => {
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
    // Uscita volontaria: qui il giocatore ha deciso, quindi si
    // chiude subito e le fiche rientrano senza attesa.
    const returned = await closeRoom(player.userId);

    socket.emit(ServerEvent.TableClosed, {
      reason:
        returned === null
          ? 'Hai lasciato il tavolo.'
          : `Hai lasciato il tavolo con ${returned.toLocaleString('it-IT')} Z-Coins.`,
    });
  });

  socket.on('disconnect', (reason) => {
    // Nessun riaccredito qui: il tavolo resta in attesa, e solo se
    // il giocatore non torna verrà chiuso dal timer di abbandono.
    detachSocket(player.userId, socket.id);
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
