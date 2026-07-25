/**
 * Poker Zeta — Match Server
 * Punto di ingresso.
 *
 * Da questa versione nessun socket entra senza identità
 * verificata: il middleware io.use() rifiuta la connessione
 * prima che il client possa emettere un solo evento.
 */

import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { env } from './config/env.js';
import { verifyAccessToken } from './auth/verify-token.js';

const httpServer = createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        service: 'poker-zeta-server',
        auth: 'enabled',
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
    // Nessun dettaglio al client: un messaggio d'errore preciso
    // aiuterebbe solo chi sta sondando il server.
    next(new Error('AUTH_NON_VALIDA'));
  }
});

io.on('connection', (socket) => {
  const player = socket.data.player as { userId: string; username: string | null };
  console.log(
    `Giocatore autenticato: ${player.username ?? '(senza nome)'} [${player.userId}]`,
  );

  socket.on('disconnect', (reason) => {
    console.log(`Disconnesso: ${player.userId} (${reason})`);
  });
});

httpServer.listen(env.PORT, () => {
  console.log(`Match Server in ascolto sulla porta ${env.PORT}`);
});
