/**
 * Poker Zeta — Utilità per i test
 *
 * Le carte si costruiscono con la notazione compatta del motore
 * ("As", "Th", "2c") passando per il suo stesso parser.
 *
 * La versione precedente le fabbricava a mano con un cast e ometteva
 * il campo rank: il compilatore non se ne accorgeva, il valutatore
 * delle mani sì. Quando il motore sa già costruire una cosa, i test
 * devono chiedergliela invece di rifarla.
 */

import {
  cardFromString,
  cardsFromString,
  type Card,
} from '../engine/cards.js';

/** Una carta dalla notazione compatta: card('As'). */
export function card(notation: string): Card {
  return cardFromString(notation);
}

/** Più carte in una volta: hand('As Ks Qs Js Ts 2d 3c'). */
export function hand(notation: string): Card[] {
  return cardsFromString(notation);
}
