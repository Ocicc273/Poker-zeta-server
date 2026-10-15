import type { Socket } from 'socket.io';
import { MttEvent, type MttCommand, type MttReply } from './mtt-protocol.js';
import type { MttService } from './mtt-service.js';

export function attachMtt(socket: Socket, user: { userId: string; username: string | null }, service: MttService,
  joinGate: (job: () => Promise<void>) => Promise<void>): void {
  let watchGeneration = 0;
  const request = (job: () => Promise<void>, reply?: (r: MttReply) => void) => {
    void job().then(() => { if (typeof reply === 'function') reply({ ok: true }); })
      .catch((error: unknown) => { if (typeof reply === 'function') reply({ ok: false, error: error instanceof Error ? error.message : 'Torneo non disponibile' }); });
  };
  socket.on(MttEvent.Watch, (p, reply) => {
    const generation = ++watchGeneration;
    request(() => service.watch(socket.id, user.userId, p?.id ?? null,
      state => { if (socket.connected) socket.emit(MttEvent.State, state); },
      () => socket.connected && generation === watchGeneration), reply);
  });
  socket.on(MttEvent.Command, (p: MttCommand, reply) => request(() => p?.kind === 'join'
    ? joinGate(() => service.command(user.userId, user.username ?? 'Giocatore', p))
    : service.command(user.userId, user.username ?? 'Giocatore', p), reply));
  socket.on('disconnect', () => service.disconnect(socket.id));
}
