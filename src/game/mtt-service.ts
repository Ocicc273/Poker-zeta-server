import { randomUUID } from 'node:crypto';
import { MttEngine, newTournament, type MttSnapshot } from './mtt-engine.js';
import type { MttCommand, MttState } from './mtt-protocol.js';
import type { MttRecord, MttStore } from '../wallet/mtt.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Watch = { user: string; selected: string | null; admin: boolean; send: (s: MttState) => void };
type Entry = { record: MttRecord; queue: Promise<unknown>; error?: string; pending?: Record<string, unknown>; recover: boolean };

/** Registro durevole separato dal torneo legacy in Z-Coins. */
export class MttService {
  readonly owner = randomUUID();
  private entries = new Map<string, Entry>();
  private watches = new Map<string, Watch>();
  private ready = false;
  private closed = false;
  private refreshAt = -Infinity;
  private refreshing: Promise<void> | null = null;
  constructor(private readonly store: MttStore, private readonly now = Date.now) {}

  hasPlayer(user: string): boolean {
    return [...this.entries.values()].some(e => [e.record.snapshot, e.pending?.snapshot as MttSnapshot | undefined]
      .some(s => s && ['waiting', 'running'].includes(s.status) && s.players.some(p => p.id === user)));
  }
  private serial<T>(entry: Entry, job: () => Promise<T>): Promise<T> {
    const promise = entry.queue.then(job); entry.queue = promise.catch(() => undefined); return promise;
  }
  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const records = await this.store<MttRecord[]>('list');
        for (const record of records) if (!this.entries.has(record.id)) {
          new MttEngine(record.snapshot);
          this.entries.set(record.id, { record, queue: Promise.resolve(), recover: record.snapshot.status === 'running' });
        }
        this.ready = true;
      } catch { this.ready = false; }
      finally { this.refreshAt = this.now(); this.refreshing = null; }
    })();
    return this.refreshing;
  }
  async watch(socket: string, user: string, selected: string | null, send: Watch['send'], valid = () => true): Promise<void> {
    if (selected !== null && !uuid.test(selected)) throw new Error('Torneo non valido.');
    await this.refresh();
    const access = this.ready ? await this.store<{ admin: boolean }>('access', { userId: user }) : { admin: false };
    if (!valid()) return;
    this.watches.set(socket, { user, selected, admin: access.admin, send });
    this.broadcast();
  }
  disconnect(socket: string): void { this.watches.delete(socket); }
  private async acquire(e: Entry): Promise<void> {
    const record = await this.store<MttRecord>('acquire', { id: e.record.id, owner: this.owner });
    if (record.epoch !== e.record.epoch || record.owner !== e.record.owner) e.recover = record.snapshot.status === 'running';
    if (record.snapshot.status !== 'running') e.recover = false;
    e.record = record;
  }
  private async flush(e: Entry): Promise<void> {
    if (!e.pending) return;
    try {
      e.record = await this.store<MttRecord>('commit', e.pending);
      e.pending = undefined; e.error = undefined;
    } catch (error) {
      // Rifiuto certo (conflitto/lease): niente retry infinito del vecchio comando.
      if ((error as { status?: number }).status === 409) e.pending = undefined;
      e.error = 'Salvataggio in attesa. Il torneo è sospeso e riprova automaticamente.';
      e.recover = true;
      throw error;
    }
  }
  private async persist(e: Entry, engine: MttEngine, requestId: string, command: unknown, actor?: string): Promise<void> {
    engine.state.savedAt = this.now(); engine.assertIntegrity();
    e.pending = { id: e.record.id, owner: this.owner, epoch: e.record.epoch,
      revision: e.record.revision, requestId, command, actor, snapshot: engine.state };
    await this.flush(e);
  }
  async command(user: string, name: string, c: MttCommand): Promise<void> {
    if (this.closed || !this.ready) throw new Error('Tornei non disponibili. Riprova dalla lobby.');
    if (!c || !uuid.test(c.requestId) || !uuid.test(c.tournamentId) || !['create','join','leave','cancel','action'].includes(c.kind)) throw new Error('Comando torneo non valido.');
    if (c.kind === 'create') {
      const snapshot = newTournament(c.tournamentId, c.config!, this.now());
      const record = await this.store<MttRecord>('create', { id: c.tournamentId, userId: user, snapshot, requestId: c.requestId });
      if (!this.entries.has(record.id)) this.entries.set(record.id, { record, queue: Promise.resolve(), recover: false });
      this.broadcast(); return;
    }
    const e = this.entries.get(c.tournamentId);
    if (!e) throw new Error('Torneo non trovato. Ricarica la lobby.');
    await this.serial(e, async () => {
      await this.flush(e);
      // Ricevuta prima di rivalidare un'azione già eseguita (ACK perso).
      const receipt = await this.store<{ found: boolean }>('receipt', { id: c.tournamentId, requestId: c.requestId, command: c, actor: user });
      if (receipt.found) return;
      await this.acquire(e);
      if (e.recover) throw new Error('Ripristino in corso. Attendi il nuovo stato.');
      const engine = new MttEngine(e.record.snapshot);
      if (c.kind === 'join') {
        if (this.hasPlayer(user) && !engine.state.players.some(p => p.id === user)) throw new Error('Hai già un torneo in corso.');
        engine.join(user, name, this.now());
      } else if (c.kind === 'leave') engine.leave(user);
      else if (c.kind === 'cancel') {
        const access = await this.store<{ admin: boolean }>('access', { userId: user });
        if (!access.admin) throw new Error('Permesso amministratore richiesto.');
        engine.cancel();
      } else engine.action(user, c, this.now());
      await this.persist(e, engine, c.requestId, c, user);
    });
    this.broadcast();
  }
  async tick(): Promise<void> {
    if (this.closed) return;
    if (this.now() - this.refreshAt >= 15_000) await this.refresh();
    await Promise.all([...this.entries.values()].map(e => this.serial(e, async () => {
      if (this.closed || !['waiting','running'].includes(e.record.snapshot.status)) return;
      try {
        await this.flush(e);
        if (!['waiting','running'].includes(e.record.snapshot.status)) { e.recover = false; e.error = undefined; return; }
        if (e.record.owner !== this.owner || e.recover) await this.acquire(e);
        const engine = new MttEngine(e.record.snapshot);
        const recovering = e.recover;
        if (recovering) engine.resume(this.now());
        const changed = engine.tick(this.now());
        if (changed || recovering || this.now() - engine.state.savedAt >= 5_000) {
          await this.persist(e, engine, randomUUID(), { kind: recovering ? 'resume' : 'tick' });
          e.recover = false;
        }
      } catch { e.error = 'Torneo in pausa: sincronizzazione con il server in corso.'; }
    })));
    this.broadcast();
  }
  state(user: string, selected: string | null, admin = false): MttState {
    const connected = new Set([...this.watches.values()].map(w => w.user));
    const active = [...this.entries.values()].find(e => ['waiting','running'].includes(e.record.snapshot.status) && e.record.snapshot.players.some(p => p.id === user));
    const e = selected ? this.entries.get(selected) : active;
    return { ready: this.ready && !this.closed, serverNow: this.now(), canCreate: admin,
      error: !this.ready ? 'Il servizio tornei gratuiti non è ancora disponibile.' : e?.error,
      tournaments: [...this.entries.values()].map(e => new MttEngine(e.record.snapshot).summary(user, e.record.revision))
        .sort((a,b) => b.scheduledAt - a.scheduledAt),
      selected: e ? new MttEngine(e.record.snapshot).view(user, e.record.revision, this.now(), connected) : null };
  }
  private broadcast(): void { for (const w of this.watches.values()) w.send(this.state(w.user, w.selected, w.admin)); }
  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.entries.values()].map(e => this.serial(e, async () => {
      try { await this.flush(e); await this.store('release', { id: e.record.id, owner: this.owner, epoch: e.record.epoch }); }
      catch { /* La lease scade: il successore recupera il checkpoint, non annulla. */ }
    })));
  }
}
