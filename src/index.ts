/**
 * Poker Zeta — Match Server
 * Punto di ingresso.
 *
 * Il server è autoritativo: riceve richieste di azione, le fa
 * validare al motore e rispedisce una proiezione dello stato.
 * Nulla di ciò che arriva dal client viene creduto sulla parola.
 */

import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { env } from './config/env.js';
import { verifyAccessToken } from './auth/verify-token.js';
import * as engine from './engine/index.js';
import {
  ClientEvent,
  ServerEvent,
  type ActionPayload,
  type JoinTablePayload,
} from './game/protocol.js';
import {
  activeRoomCount,
  closeRoom,
  createRoom,
  getRoom,
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
        rooms: activeRoomCount(),
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

  socket.on(ClientEvent.JoinTable, (payload: JoinTablePayload) => {
    const room = createRoom(socket.id, {
      humanPlayerId: player.userId,
      humanName: player.username ?? 'Tu',
      buyIn: payload?.buyIn,
      sendState: (view) => socket.emit(ServerEvent.TableState, view),
      sendError: (message) => socket.emit(ServerEvent.Error, { message }),
    });

    console.log(`Stanza aperta per ${label} (${socket.id})`);
    room.start();
  });

  socket.on(ClientEvent.Action, (payload: ActionPayload) => {
    const room = getRoom(socket.id);
    if (!room) {
      socket.emit(ServerEvent.Error, { message: 'Nessun tavolo attivo.' });
      return;
    }
    room.handleHumanAction(payload?.type, payload?.amount);
  });

  socket.on(ClientEvent.NextHand, () => {
    const room = getRoom(socket.id);
    if (!room) {
      socket.emit(ServerEvent.Error, { message: 'Nessun tavolo attivo.' });
      return;
    }
    room.startNextHand();
  });

  socket.on(ClientEvent.LeaveTable, () => {
    closeRoom(socket.id);
    socket.emit(ServerEvent.TableClosed, { reason: 'Hai lasciato il tavolo.' });
  });

  socket.on('disconnect', (reason) => {
    // La stanza muore con il socket: senza questo, i timer dei bot
    // continuerebbero a girare su una partita che nessuno guarda.
    closeRoom(socket.id);
    console.log(`Disconnesso: ${player.userId} (${reason})`);
  });
});

httpServer.listen(env.PORT, () => {
  console.log(
    `Match Server in ascolto sulla porta ${env.PORT} — motore: ${engineExports} export`,
  );
});
