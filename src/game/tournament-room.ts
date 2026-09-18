import { startHand, applyAction, getAvailableActions, isHandComplete, currentPotTotal,
  ActionType, PlayerStatus, type HandState, type TableConfig } from '../engine/index.js';
import { runOutForcedAllIn } from '../engine/hand-state.js';
import { TOURNAMENT, tournamentBlinds } from './tournament-config.js';
import type { TournamentPlayer, TournamentAction } from './tournament-protocol.js';
import type { TableView } from './protocol.js';

// Il timer esterno chiama tick: la stanza è testabile senza rete, database o timer reali.
export class TournamentRoom {
  readonly players: TournamentPlayer[];
  hand: HandState | null = null;
  version = 0;
  deadline: number | null = null;
  nextHandAt: number;
  winner: string | null = null;
  private dealer = 0;
  private handNumber = 0;
  private handStacks = new Map<string, number>();
  private turnKey = '';

  constructor(readonly id: string, players: { id: string; name: string }[], readonly startedAt: number) {
    if (players.length < TOURNAMENT.minPlayers || players.length > TOURNAMENT.maxPlayers || new Set(players.map(p => p.id)).size !== players.length) {
      throw new Error('Numero di iscritti non valido.');
    }
    this.players = players.map((p, seat) => ({ ...p, seat, stack: TOURNAMENT.startingStack, place: null }));
    this.nextHandAt = startedAt;
  }

  tick(now: number): boolean {
    if (this.winner) return false;
    if ((!this.hand || isHandComplete(this.hand)) && now >= this.nextHandAt) {
      const alive = this.players.filter(p => p.stack > 0);
      while (!alive.some(p => p.seat === this.dealer)) this.dealer = (this.dealer + 1) % this.players.length;
      const config: TableConfig = { maxSeats: 6, variant: 'holdem', structure: 'no-limit', blinds: tournamentBlinds(now - this.startedAt) };
      this.handStacks = new Map(alive.map(p => [p.id, p.stack]));
      this.hand = runOutForcedAllIn(startHand(`${this.id}-${++this.handNumber}`, config,
        alive.map(p => ({ playerId: p.id, seat: p.seat, stack: p.stack })), this.dealer));
      this.afterAction(now);
      return true;
    }
    if (this.hand && !isHandComplete(this.hand) && this.deadline !== null && now >= this.deadline) {
      const actions = getAvailableActions(this.hand);
      this.act(this.hand.toActPlayerId!, { id: this.id, handId: this.hand.handId, version: this.version,
        type: actions.some(a => a.type === ActionType.Check) ? ActionType.Check : ActionType.Fold }, now);
      return true;
    }
    return false;
  }

  act(playerId: string, action: TournamentAction, now: number): void {
    if (!this.hand || this.winner || isHandComplete(this.hand) || action.id !== this.id ||
      action.handId !== this.hand.handId || action.version !== this.version || this.hand.toActPlayerId !== playerId) {
      throw new Error('Turno non più valido: attendi lo stato aggiornato.');
    }
    this.hand = applyAction(this.hand, { playerId, type: action.type, amount: action.amount });
    this.afterAction(now);
  }

  private afterAction(now: number): void {
    const hand = this.hand!;
    this.version++;
    if (isHandComplete(hand)) {
      const before = this.players.filter(p => p.place === null).length;
      for (const p of hand.players) this.players.find(x => x.id === p.playerId)!.stack = p.stack;
      // Eliminazioni simultanee: stack a inizio mano, poi posto (regola pubblicata in lobby).
      const out = this.players.filter(p => p.place === null && p.stack === 0)
        .sort((a, b) => this.handStacks.get(a.id)! - this.handStacks.get(b.id)! || b.seat - a.seat);
      out.forEach((p, i) => { p.place = before - i; });
      const alive = this.players.filter(p => p.stack > 0);
      if (alive.length === 1) { alive[0]!.place = 1; this.winner = alive[0]!.id; }
      this.deadline = null;
      this.turnKey = '';
      this.nextHandAt = now + TOURNAMENT.betweenHandsMs;
      this.dealer = (this.dealer + 1) % this.players.length;
    } else {
      const key = `${hand.handId}:${hand.street}:${hand.toActPlayerId}`;
      if (key !== this.turnKey) { this.turnKey = key; this.deadline = now + TOURNAMENT.turnMs; }
    }
  }

  view(viewer: string, now: number): TableView | null {
    const hand = this.hand;
    if (!hand || !this.players.some(p => p.id === viewer)) return null;
    const complete = isHandComplete(hand);
    return {
      tableId: this.id, format: 'tournament', handId: hand.handId, street: hand.street,
      communityCards: hand.communityCards, pot: currentPotTotal(hand), currentBet: hand.currentBet,
      toActPlayerId: hand.toActPlayerId, yourPlayerId: viewer,
      players: this.players.map(p => {
        const state = hand.players.find(x => x.playerId === p.id);
        const showdown = complete && hand.players.filter(x => x.status !== PlayerStatus.Folded).length > 1;
        const visible = p.id === viewer || (showdown && state?.status !== PlayerStatus.Folded);
        return { playerId: p.id, name: p.name, seat: p.seat, stack: state?.stack ?? p.stack,
          committedThisStreet: state?.committedThisStreet ?? 0, status: state?.status ?? PlayerStatus.SittingOut,
          isDealer: p.seat === hand.dealerSeat, isBot: false,
          holeCards: visible ? state?.holeCards ?? [] : null, holeCardCount: state?.holeCards.length ?? 0 };
      }),
      availableActions: !complete && hand.toActPlayerId === viewer ? getAvailableActions(hand) : [],
      isYourTurn: !complete && hand.toActPlayerId === viewer,
      turnMillisLeft: this.deadline === null ? null : Math.max(0, this.deadline - now),
      isHandComplete: complete, canStartNextHand: false,
      isBusted: this.players.find(p => p.id === viewer)!.stack === 0,
      payouts: complete ? hand.payouts : [], blinds: hand.config.blinds, log: [],
    };
  }
}
