import { PlayerStatus } from '../engine/table-types.js';
import type { HandState } from '../engine/hand-state.js';
import { isHandComplete } from '../engine/hand-state.js';
import { evaluateHand } from '../engine/hand-rank.js';
import { evaluateOmahaHand } from '../engine/omaha.js';
import type { ShowdownHandView } from './protocol.js';

// La proiezione è calcolata solo sul server. Nessuna carta di chi ha foldato.
export function showdownView(state: HandState | null): {
  showdown: readonly ShowdownHandView[];
  winnerIds: readonly string[];
} {
  if (!state || !isHandComplete(state)) return { showdown: [], winnerIds: [] };
  const winnerIds = state.payouts.filter(p => p.amount > 0 && p.fromPots.some(index =>
    state.pots.some(pot => pot.index === index && !pot.uncalled))).map(p => p.playerId);
  const players = state.players.filter(p => p.status === PlayerStatus.Active || p.status === PlayerStatus.AllIn);
  if (players.length < 2 || state.communityCards.length !== 5) return { showdown: [], winnerIds };
  const variant = state.config.variant === 'omaha' ? 'omaha' : 'holdem';
  const showdown: ShowdownHandView[] = players.map(p => {
    const rank = variant === 'omaha'
      ? evaluateOmahaHand(p.holeCards, state.communityCards)
      : evaluateHand([...p.holeCards, ...state.communityCards]);
    const used = new Set(rank.cards.map(c => `${c.rank}${c.suit}`));
    return { playerId: p.playerId, variant, description: rank.description, cards: rank.cards,
      usedHoleCards: p.holeCards.filter(c => used.has(`${c.rank}${c.suit}`)),
      usedCommunityCards: state.communityCards.filter(c => used.has(`${c.rank}${c.suit}`)) };
  });
  return { showdown, winnerIds };
}
