/**
 * Poker Zeta — Match Server
 * Punto di ingresso.
 *
 * Da questa versione il server carica il motore di gioco:
 * le stesse regole che girano nel client, ma qui sono
 * l'unica versione che conta.
 */

import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { env } from './config/env.js';
import { verifyAccessToken } from './auth/verify-token.js';
import * as engine from './engine/index.js';

interface ConnectedPlayer {
  userId: string;
  username: string | null;
}

// Se il motore non si carica, il server non deve nemmeno partire:
// meglio un crash all'avvio che un tavolo senza regole.
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

  console.log(
    `Giocatore autenticato: ${player.username ?? '(senza nome)'} [${player.userId}]`,
  );

  socket.emit('server:welcome', player);

  socket.on('disconnect', (reason) => {
    console.log(`Disconnesso: ${player.userId} (${reason})`);
  });
});

httpServer.listen(env.PORT, () => {
  console.log(
    `Match Server in ascolto sulla porta ${env.PORT} — motore: ${engineExports} export`,
  );
});
