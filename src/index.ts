/**
 * Poker Zeta — Match Server
 * Punto di ingresso.
 *
 * Questa prima versione fa solo una cosa: partire e restare in
 * ascolto. Serve a verificare che l'infrastruttura Railway funzioni
 * prima di aggiungere qualsiasi logica di gioco.
 */

import { createServer } from 'node:http';
import { Server } from 'socket.io';

// Railway assegna la porta tramite variabile d'ambiente. In locale
// si usa 3001 come default.
const PORT = Number(process.env.PORT) || 3001;

const httpServer = createServer((req, res) => {
  // Endpoint di health check: Railway lo usa per sapere se il
  // server è vivo. Risponde anche a un browser che apre l'URL.
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'poker-zeta-server' }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const io = new Server(httpServer, {
  cors: {
    // In sviluppo si accetta qualsiasi origine. Verrà ristretto al
    // dominio del client prima del lancio.
    origin: '*',
  },
});

io.on('connection', (socket) => {
  console.log(`Client connesso: ${socket.id}`);

  socket.on('disconnect', (reason) => {
    console.log(`Client disconnesso: ${socket.id} (${reason})`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Match Server in ascolto sulla porta ${PORT}`);
});
