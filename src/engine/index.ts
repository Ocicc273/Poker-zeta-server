/**
 * Poker Zeta — Motore di gioco, export pubblico
 *
 * Punto di ingresso unico del motore. Il resto dell'applicazione
 * importa da qui, mai dai singoli moduli: il motore deve poter
 * essere riorganizzato internamente senza rompere i chiamanti.
 *
 * Questo modulo è puro e non dipende da React né dal DOM: verrà
 * riutilizzato senza modifiche nel Match Server Node.
 */

export {
  SUITS,
  RANKS,
  SUIT_NAMES,
  SUIT_SYMBOLS,
  RED_SUITS,
  createCard,
  cardToString,
  cardFromString,
  cardsFromString,
  createDeck,
  createShuffledDeck,
  shuffle,
  Deck,
  CryptoRandomSource,
  SeededRandomSource,
} from './cards';

export type { Suit, Rank, RankValue, Card, RandomSource } from './cards';

export {
  HandCategory,
  CATEGORY_NAMES,
  evaluateHand,
  compareHands,
  handsAreEqual,
  rankPlayers,
  findWinners,
} from './hand-rank';

export type { HandRank, RankedPlayer } from './hand-rank';
export {
  Street,
  PlayerStatus,
  ActionType,
  InvalidActionError,
  COMMUNITY_CARDS_BY_STREET,
} from './table-types';

export type {
  PlayerId,
  SeatIndex,
  PlayerState,
  PlayerAction,
  AvailableAction,
  BlindStructure,
  TableConfig,
} from './table-types';

export {
  buildPots,
  distributePots,
  awardUncontested,
  totalPotAmount,
  verifyPayoutIntegrity,
} from './pot';

export type { Contribution, Pot, Payout, ShowdownEntry } from './pot';

export {
  startHand,
  applyAction,
  getAvailableActions,
  isHandComplete,
  currentPotTotal,
  toPlayerView,
} from './hand-state';

export type { HandState, SeatAssignment } from './hand-state';
export { decideBotAction } from './bot';
export type { BotProfile, BotDecisionContext } from './bot';
export {
  evaluateOmahaHand,
  rankOmahaPlayers,
  maxPotLimitRaise,
  OMAHA_HOLE_CARDS,
  OMAHA_REQUIRED_HOLE,
  OMAHA_REQUIRED_COMMUNITY,
} from './omaha';

export type { OmahaHandRank, RankedOmahaPlayer } from './omaha';
