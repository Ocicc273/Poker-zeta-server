import { randomUUID } from 'node:crypto';
import { TOURNAMENT, tournamentBlinds } from './tournament-config.js';
import { TournamentRoom } from './tournament-room.js';
import type { TournamentStore, TournamentRecord } from '../wallet/tournament.js';
import type { TournamentState, TournamentAction } from './tournament-protocol.js';

// Tutte le operazioni di iscrizione/avvio/liquidazione passano dalla stessa coda.
export class TournamentService {
  readonly owner = randomUUID();
  private queue: Promise<unknown> = Promise.resolve();
  private record: TournamentRecord | null = null;
  private room: TournamentRoom | null = null;
  private startsAt: number | null = null;
  private heartbeatAt = 0;
  private closed = false;
  private paused = false;
  private pending = new Set<string>();
  private watches = new Map<string, { userId: string; send: (state: TournamentState) => void }>();

  constructor(private readonly store: TournamentStore, private readonly now = Date.now) {}

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const result = this.queue.then(job);
    this.queue = result.catch(() => undefined);
    return result;
  }

  hasPlayer(id: string): boolean {
    return this.pending.has(id) || !!this.record?.entries.some(e => e.user_id === id && e.active);
  }

  private async call(action: string, args: Record<string, unknown> = {}) {
    return this.store(action, { id: this.record?.id, owner: this.owner, ...args });
  }

  watch(socketId: string, userId: string, send: (state: TournamentState) => void): Promise<void> {
    this.watches.set(socketId, { userId, send });
    return this.serial(async () => {
      if (this.closed) throw new Error('Server in riavvio.');
      if (!this.record) {
        await this.store('recover');
        this.record = await this.store('create', { id: randomUUID(), owner: this.owner,
          buyIn: TOURNAMENT.buyIn, maxPlayers: TOURNAMENT.maxPlayers, minPlayers: TOURNAMENT.minPlayers });
        this.heartbeatAt = this.now();
      }
      this.broadcast();
    });
  }

  disconnect(socketId: string): void { this.watches.delete(socketId); this.broadcast(); }

  join(id: string, userId: string, name: string): Promise<void> {
    this.pending.add(userId);
    return this.serial(async () => {
      try {
        if (this.closed || this.paused || !this.record || this.record.id !== id) throw new Error('Aggiorna la lobby prima di iscriverti.');
        this.record = await this.call('join', { userId, name });
        if (this.record.entries.filter(e => e.active).length >= TOURNAMENT.minPlayers && this.startsAt === null) {
          this.startsAt = this.now() + TOURNAMENT.registrationMs;
        }
      } catch (error) {
        // Anche se la risposta del pagamento si perde, inspect recupera l'iscrizione.
        if (this.record) {
          try { this.record = await this.call('inspect'); }
          catch { this.paused = true; throw error; }
        }
        throw error;
      } finally {
        if (!this.paused) this.pending.delete(userId);
        this.broadcast();
      }
    });
  }

  leave(id: string, userId: string): Promise<void> {
    return this.serial(async () => {
      if (!this.record || this.record.id !== id) throw new Error('Torneo non trovato.');
      this.record = await this.call('leave', { userId });
      if (this.record.entries.filter(e => e.active).length < TOURNAMENT.minPlayers) this.startsAt = null;
      this.broadcast();
    });
  }

  action(userId: string, action: TournamentAction): Promise<void> {
    return this.serial(async () => {
      if (this.closed || this.paused || this.record?.status !== 'running' || !this.room) throw new Error('Torneo non disponibile.');
      this.room.act(userId, action, this.now());
      await this.finishIfNeeded();
      this.broadcast();
    });
  }

  private async finishIfNeeded() {
    if (!this.room?.winner || !this.record || ['finished', 'cancelled'].includes(this.record.status)) return;
    this.record.status = 'settling';
    // Classifica e premio vengono registrati insieme, in una transazione idempotente.
    this.record = await this.call('finish', { ranking: [...this.room.players].sort((a, b) => a.place! - b.place!).map(p => p.id) });
  }

  tick(): Promise<void> {
    return this.serial(async () => {
      if (this.closed || !this.record) return;
      try {
        if (this.now() - this.heartbeatAt >= 15_000) {
          this.record = await this.call('heartbeat');
          await this.store('recover');
          this.heartbeatAt = this.now();
          this.paused = false;
          this.pending.clear();
        }
        if (this.paused) return;
        const active = this.record.entries.filter(e => e.active);
        if (this.record.status === 'waiting' && active.length >= TOURNAMENT.minPlayers && this.startsAt === null) this.startsAt = this.now() + TOURNAMENT.registrationMs;
        if (this.record.status === 'waiting' && active.length >= TOURNAMENT.minPlayers &&
          (active.length === TOURNAMENT.maxPlayers || (this.startsAt !== null && this.now() >= this.startsAt))) {
          this.record = await this.call('start');
        }
        // Recupera anche uno start confermato dal DB la cui risposta si era persa.
        if (this.record.status === 'running' && !this.room) this.room = new TournamentRoom(this.record.id,
          active.map(e => ({ id: e.user_id, name: e.name })), this.now());
        if (this.record.status === 'running') this.room?.tick(this.now());
        await this.finishIfNeeded();
      } catch {
        this.paused = true;
      } finally { this.broadcast(); }
    });
  }

  next(id: string): Promise<void> {
    return this.serial(async () => {
      if (this.closed || !this.record || this.record.id !== id || !['finished', 'cancelled'].includes(this.record.status)) throw new Error('Il torneo non è ancora concluso.');
      const record = await this.store('create', { id: randomUUID(), owner: this.owner,
        buyIn: TOURNAMENT.buyIn, maxPlayers: TOURNAMENT.maxPlayers, minPlayers: TOURNAMENT.minPlayers });
      this.record = record; this.room = null; this.startsAt = null; this.paused = false; this.pending.clear();
      this.heartbeatAt = this.now(); this.broadcast();
    });
  }

  shutdown(): Promise<void> {
    this.closed = true;
    return this.serial(async () => {
      if (!this.record) return;
      if (this.room?.winner) await this.finishIfNeeded();
      else this.record = await this.call('cancel');
      this.broadcast();
    });
  }

  snapshot(userId: string): TournamentState | null {
    if (!this.record) return null;
    const now = this.now();
    const elapsed = this.room ? now - this.room.startedAt : 0;
    const level = tournamentBlinds(elapsed).level;
    const players = this.room?.players ?? this.record.entries.filter(e => !e.refunded).map((e, seat) => ({
      id: e.user_id, name: e.name, seat, stack: TOURNAMENT.startingStack, place: e.place,
    }));
    const own = this.record.entries.find(e => e.user_id === userId);
    return { id: this.record.id, name: TOURNAMENT.name, status: this.record.status,
      buyIn: this.record.buy_in, pool: this.record.buy_in * this.record.entries.filter(e => !e.refunded).length,
      minPlayers: TOURNAMENT.minPlayers, maxPlayers: TOURNAMENT.maxPlayers, startingStack: TOURNAMENT.startingStack,
      startsAt: this.startsAt, level, nextLevelAt: this.room && level < TOURNAMENT.blinds.length ? this.room.startedAt + level * TOURNAMENT.levelMs : null,
      turnMs: TOURNAMENT.turnMs, registrationMs: TOURNAMENT.registrationMs, levelMs: TOURNAMENT.levelMs, serverNow: now, yourId: userId,
      registered: !!own && !own.refunded, players: players.map(p => ({ ...p,
        stack: this.room?.hand?.players.find(h => h.playerId === p.id)?.stack ?? p.stack,
        connected: [...this.watches.values()].some(w => w.userId === p.id) })),
      table: this.room?.view(userId, now) ?? null, actionVersion: this.room?.version ?? 0, prize: own?.prize ?? 0,
      error: this.paused ? 'Contabilità temporaneamente non disponibile. Partita sospesa, ritento automaticamente.' : undefined,
    };
  }

  private broadcast(): void {
    for (const watch of this.watches.values()) {
      const state = this.snapshot(watch.userId);
      if (state) watch.send(state);
    }
  }
}
