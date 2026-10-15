import { Deck, CryptoRandomSource } from '../engine/cards.js';
import { startHand, applyAction, isHandComplete, getAvailableActions, ActionType,
  type HandState, type RandomSource } from '../engine/index.js';
import { runOutForcedAllIn } from '../engine/hand-state.js';
import { tournamentHandView } from './tournament-room.js';
import type { MttCommand, MttConfig, MttSummary, MttView } from './mtt-protocol.js';

export type SavedHand = Omit<HandState, 'deck'> & { deck: ReturnType<Deck['snapshot']> };
export interface MttPlayer { id: string; name: string; stack: number; place: number | null; points: number; }
export interface MttTable {
  id: string; seats: string[]; dealer: number; hand: SavedHand | null;
  deadline: number | null; version: number; turnKey: string;
}
export interface MttSnapshot {
  codec: 1; id: string; config: MttConfig; status: MttSummary['status'];
  players: MttPlayer[]; tables: MttTable[]; round: number;
  startedAt: number | null; nextRoundAt: number | null; savedAt: number;
  roundStacks: Record<string, number>; roundSettled: boolean;
}
const TURN_MS = 25_000;
const BETWEEN_MS = 4_000;
export function validateConfig(c: MttConfig): void {
  if (!c || typeof c.name !== 'string' || c.name.trim().length < 3 || c.name.length > 60 ||
    !Number.isInteger(c.capacity) || c.capacity < 2 || c.capacity > 18 ||
    !Number.isInteger(c.minimum) || c.minimum < 2 || c.minimum > c.capacity ||
    !Number.isSafeInteger(c.startingStack) || c.startingStack < 100 || c.startingStack > 1_000_000 ||
    !Number.isSafeInteger(c.scheduledAt) || !Number.isInteger(c.levelMs) || c.levelMs < 60_000 || c.levelMs > 3_600_000 ||
    !Array.isArray(c.bigBlinds) || c.bigBlinds.length < 1 || c.bigBlinds.length > 40 ||
    c.bigBlinds.some((b, i) => !Number.isSafeInteger(b) || b < 2 || b > 1_000_000 || b % 2 !== 0 || i > 0 && b <= c.bigBlinds[i - 1]!)) {
    throw new Error('Configurazione torneo non valida.');
  }
}
export function newTournament(id: string, config: MttConfig, now: number): MttSnapshot {
  validateConfig(config);
  if (config.scheduledAt < now + 30_000 || config.scheduledAt > now + 30 * 86400_000) throw new Error('Scegli un orario tra 30 secondi e 30 giorni.');
  return { codec: 1, id, config: structuredClone(config), status: 'waiting', players: [], tables: [],
    round: 0, startedAt: null, nextRoundAt: null, savedAt: now, roundStacks: {}, roundSettled: true };
}
export function saveHand(hand: HandState): SavedHand { return { ...structuredClone({ ...hand, deck: undefined }), deck: hand.deck.snapshot() }; }
export function loadHand(hand: SavedHand): HandState { return { ...structuredClone(hand), deck: Deck.restore(hand.deck) }; }

/** Ogni transizione opera su una copia: un commit fallito non consuma carte. */
export class MttEngine {
  readonly state: MttSnapshot;
  constructor(snapshot: MttSnapshot) {
    this.state = structuredClone(snapshot);
    this.assertIntegrity();
  }
  private hand(t: MttTable): HandState | null { return t.hand ? loadHand(t.hand) : null; }
  private alive(): MttPlayer[] { return this.state.players.filter(p => p.place === null); }
  level(now: number): number {
    return Math.min(this.state.config.bigBlinds.length - 1,
      Math.floor(Math.max(0, now - (this.state.startedAt ?? now)) / this.state.config.levelMs));
  }
  join(id: string, name: string, now: number): void {
    const s = this.state;
    if (s.status !== 'waiting' || now >= s.config.scheduledAt) throw new Error('Iscrizioni chiuse.');
    if (s.players.some(p => p.id === id)) return;
    if (s.players.length >= s.config.capacity) throw new Error('Torneo completo.');
    s.players.push({ id, name: name.slice(0, 40), stack: s.config.startingStack, place: null, points: 0 });
  }
  leave(id: string): void {
    if (this.state.status !== 'waiting') throw new Error('Il torneo è iniziato: il posto resta tuo.');
    this.state.players = this.state.players.filter(p => p.id !== id);
  }
  cancel(): void {
    if (this.state.status !== 'waiting') throw new Error('Puoi annullare soltanto un torneo non iniziato.');
    this.state.status = 'cancelled';
  }
  /** Durante un fermo il clock e i turni conservano il tempo residuo. */
  resume(now: number): void {
    const s = this.state;
    const gap = Math.max(0, now - s.savedAt);
    if (s.status === 'running') {
      s.startedAt = s.startedAt! + gap;
      if (s.nextRoundAt !== null) s.nextRoundAt += gap;
      for (const t of s.tables) if (t.deadline !== null) t.deadline += gap;
    }
    s.savedAt = now;
  }
  private updateHand(t: MttTable, hand: HandState, now: number): void {
    t.hand = saveHand(hand); t.version++;
    if (isHandComplete(hand)) { t.deadline = null; t.turnKey = ''; }
    else {
      const key = `${hand.handId}:${hand.street}:${hand.toActPlayerId}`;
      if (key !== t.turnKey) { t.turnKey = key; t.deadline = now + TURN_MS; }
    }
  }
  action(userId: string, a: MttCommand, now: number): void {
    const t = this.state.tables.find(x => x.id === a.tableId);
    if (this.state.status !== 'running' || !t || !t.hand || t.hand.handId !== a.handId ||
      t.version !== a.version || t.hand.toActPlayerId !== userId || !t.seats.includes(userId) ||
      t.deadline === null || now >= t.deadline || a.tournamentId !== this.state.id) throw new Error('Turno scaduto o tavolo cambiato. Attendi lo stato aggiornato.');
    this.updateHand(t, applyAction(this.hand(t)!, { playerId: userId, type: a.type!, amount: a.amount }), now);
    this.finishRound(now);
  }
  tick(now: number, random?: RandomSource): boolean {
    const s = this.state;
    if (s.status === 'waiting') {
      if (now < s.config.scheduledAt) return false;
      if (s.players.length < s.config.minimum) { s.status = 'cancelled'; return true; }
      s.status = 'running'; s.startedAt = now; s.nextRoundAt = now;
      // Fisher–Yates con la sorgente crittografica del motore.
      const rng = random ?? new CryptoRandomSource();
      for (let i = s.players.length - 1; i > 0; i--) {
        const j = rng.nextInt(i + 1);
        [s.players[i], s.players[j]] = [s.players[j]!, s.players[i]!];
      }
      this.seatInitial();
    }
    if (s.status !== 'running') return false;
    let changed = false;
    for (const t of s.tables) if (t.hand && t.deadline !== null && now >= t.deadline) {
      const h = this.hand(t)!;
      this.updateHand(t, applyAction(h, { playerId: h.toActPlayerId!, type:
        getAvailableActions(h).some(a => a.type === ActionType.Check) ? ActionType.Check : ActionType.Fold }), now);
      changed = true;
    }
    if (this.finishRound(now)) changed = true;
    if (s.status === 'running' && s.roundSettled && s.nextRoundAt !== null && now >= s.nextRoundAt) {
      this.balance(); s.round++; s.roundSettled = false; s.nextRoundAt = null;
      s.roundStacks = Object.fromEntries(this.alive().map(p => [p.id, p.stack]));
      for (const t of s.tables) {
        const bb = s.config.bigBlinds[this.level(now)]!;
        const hand = runOutForcedAllIn(startHand(`${s.id}:${t.id}:${s.round}`, {
          maxSeats: 6, variant: 'holdem', structure: 'no-limit', blinds: { smallBlind: bb / 2, bigBlind: bb, ante: 0 },
        }, t.seats.map((id, seat) => ({ playerId: id, seat, stack: s.players.find(p => p.id === id)!.stack })), t.dealer, random));
        this.updateHand(t, hand, now);
      }
      this.finishRound(now); changed = true;
    }
    return changed;
  }
  private seatInitial(): void {
    const s = this.state, count = Math.ceil(s.players.length / 6);
    s.tables = Array.from({ length: count }, (_, i) => ({ id: `t${i + 1}`, seats: [], dealer: 0, hand: null, deadline: null, version: 0, turnKey: '' }));
    s.players.forEach((p, i) => s.tables[i % count]!.seats.push(p.id));
  }
  /** Barriera mano-per-mano: nessun trasferimento con fiches nel piatto. */
  private finishRound(now: number): boolean {
    const s = this.state;
    if (s.roundSettled || s.tables.some(t => !t.hand || !isHandComplete(this.hand(t)!))) return false;
    for (const t of s.tables) for (const p of t.hand!.players) s.players.find(x => x.id === p.playerId)!.stack = p.stack;
    const eliminated = this.alive().filter(p => p.stack === 0).sort((a, b) => s.roundStacks[a.id]! - s.roundStacks[b.id]!);
    let remaining = this.alive().length;
    // A parità di stack iniziale nello stesso round, stesso piazzamento.
    for (let i = 0; i < eliminated.length;) {
      let end = i + 1;
      while (end < eliminated.length && s.roundStacks[eliminated[end]!.id] === s.roundStacks[eliminated[i]!.id]) end++;
      const place = remaining - (end - i) + 1;
      for (let j = i; j < end; j++) eliminated[j]!.place = place;
      remaining -= end - i; i = end;
    }
    s.roundSettled = true; s.nextRoundAt = now + BETWEEN_MS;
    if (this.alive().length === 1) {
      const winner = this.alive()[0]!; winner.place = 1; winner.points = 100;
      s.status = 'finished'; s.nextRoundAt = null;
    }
    return true;
  }
  private balance(): void {
    const s = this.state;
    // Ordine di attesa del prossimo big blind, conservato durante gli spostamenti.
    const queues = s.tables.map(t => {
      const n = t.seats.length, bb = (t.dealer + (n === 2 ? 1 : 2)) % n;
      return Array.from({ length: n }, (_, i) => t.seats[(bb + 1 + i) % n]!)
        .filter(id => s.players.find(p => p.id === id)!.place === null);
    });
    const count = Math.ceil(this.alive().length / 6);
    while (queues.length > count) {
      const moved = queues.pop()!;
      for (const id of moved) queues.reduce((a, b) => a.length <= b.length ? a : b).push(id);
    }
    while (Math.max(...queues.map(q => q.length)) - Math.min(...queues.map(q => q.length)) > 1) {
      const from = queues.reduce((a, b) => a.length >= b.length ? a : b);
      const to = queues.reduce((a, b) => a.length <= b.length ? a : b);
      to.push(from.pop()!);
    }
    s.tables = queues.map((seats, i) => ({ ...s.tables[i]!, seats, dealer: seats.length === 2 ? 1 : seats.length - 2,
      hand: null, deadline: null, turnKey: '' }));
  }
  assertIntegrity(): void {
    const s = this.state;
    if (s.codec !== 1 || !['waiting', 'running', 'finished', 'cancelled'].includes(s.status)) throw new Error('Versione checkpoint non supportata.');
    validateConfig(s.config);
    if (s.players.length > s.config.capacity || new Set(s.players.map(p => p.id)).size !== s.players.length ||
      s.players.some(p => !Number.isSafeInteger(p.stack) || p.stack < 0 ||
        p.place !== null && (!Number.isInteger(p.place) || p.place < 1 || p.place > s.players.length) ||
        p.points !== (s.status === 'finished' && p.place === 1 ? 100 : 0))) throw new Error('Iscritti o stack non validi.');
    if (s.status === 'waiting' || s.status === 'cancelled') {
      if (s.tables.length || s.players.some(p => p.stack !== s.config.startingStack || p.place !== null)) throw new Error('Checkpoint iscrizioni non valido.');
      return;
    }
    const seats = s.tables.flatMap(t => t.seats);
    if (new Set(seats).size !== seats.length || new Set(s.tables.map(t => t.id)).size !== s.tables.length ||
      s.tables.some(t => t.seats.length < 2 || t.seats.length > 6) ||
      seats.some(id => !s.players.some(p => p.id === id)) || this.alive().some(p => !seats.includes(p.id))) throw new Error('Assegnazioni non valide.');
    let total = 0;
    for (const p of s.players) {
      const h = s.tables.find(t => t.hand?.players.some(x => x.playerId === p.id))?.hand;
      const hp = h?.players.find(x => x.playerId === p.id);
      total += hp ? hp.stack + (isHandComplete(loadHand(h!)) ? 0 : hp.committedTotal) : p.stack;
    }
    if (total !== s.config.startingStack * s.players.length) throw new Error('Conservazione delle fiche violata.');
    for (const t of s.tables) if (t.hand) {
      const h = loadHand(t.hand), n = h.players.length, board = h.communityCards.length;
      if (n !== t.seats.length || h.players.some(p => !t.seats.includes(p.playerId) ||
        !Number.isSafeInteger(p.stack) || p.stack < 0 || !Number.isSafeInteger(p.committedTotal) || p.committedTotal < 0) ||
        ![0,3,4,5].includes(board)) throw new Error('Mano nel checkpoint non valida.');
      const burns = board === 0 ? 0 : board - 2;
      if (t.hand.deck.position !== n * 2 + board + burns) throw new Error('Posizione mazzo non coerente.');
      const same = (a: { rank: string; suit: string; value: number }, b: typeof a) => a.rank === b.rank && a.suit === b.suit && a.value === b.value;
      const dealer = h.players.findIndex(p => p.seat === h.dealerSeat);
      if (dealer < 0) throw new Error('Bottone non valido.');
      const smallBlind = n === 2 ? dealer : (dealer + 1) % n;
      for (let i = 0; i < n; i++) if (h.players[i]!.holeCards.length !== 2 ||
        h.players[i]!.holeCards.some((c, j) => !same(c, t.hand!.deck.cards[j * n + (i - smallBlind + n) % n]!))) throw new Error('Carte personali non coerenti con il mazzo.');
      const indexes = [n * 2 + 1, n * 2 + 2, n * 2 + 3, n * 2 + 5, n * 2 + 7];
      if (h.communityCards.some((c, i) => !same(c, t.hand!.deck.cards[indexes[i]!]!))) throw new Error('Board non coerente con il mazzo.');
      const cards = [...h.communityCards, ...h.players.flatMap(p => p.holeCards)].map(c => c.rank + c.suit);
      if (new Set(cards).size !== cards.length) throw new Error('Carta duplicata.');
    }
  }
  summary(user: string, revision: number): MttSummary {
    const s = this.state;
    return { id: s.id, name: s.config.name, status: s.status, capacity: s.config.capacity, count: s.players.length,
      scheduledAt: s.config.scheduledAt, startingStack: s.config.startingStack, levelMs: s.config.levelMs,
      bigBlinds: [...s.config.bigBlinds], registered: s.players.some(p => p.id === user), revision };
  }
  view(user: string, revision: number, now: number, connected: Set<string>): MttView {
    const s = this.state, own = s.tables.find(t => t.seats.includes(user)), level = this.level(now);
    return { ...this.summary(user, revision), round: s.round, level: level + 1,
      nextLevelAt: s.status === 'running' && level < s.config.bigBlinds.length - 1 ? s.startedAt! + (level + 1) * s.config.levelMs : null,
      finalTable: s.tables.length === 1 && s.status !== 'waiting',
      players: s.players.map(p => { const t = s.tables.find(t => t.seats.includes(p.id)); return { ...p,
        stack: t?.hand?.players.find(x => x.playerId === p.id)?.stack ?? p.stack, table: t?.id ?? null, connected: connected.has(p.id) }; }),
      table: own ? tournamentHandView(own.id, own.seats.map((id, seat) => ({ ...s.players.find(p => p.id === id)!, seat })), this.hand(own), own.deadline, user, now) : null,
      actionVersion: own?.version ?? 0,
      waitingForTables: !!own?.hand && isHandComplete(this.hand(own)!) && !s.roundSettled,
    };
  }
}
