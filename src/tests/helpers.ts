/**
 * Poker Zeta — Utilità per i test
 *
 * I test costruiscono carte a mano invece di pescarle dal mazzo:
 * servono situazioni precise, non casuali.
 */

import type { Card } from '../engine/index.js';

/**
 * Costruisce una carta dai due soli campi che la logica dei bot
 * legge davvero: valore e seme.
 *
 * Il cast è deliberato. Il tipo Card completo appartiene al motore
 * e potrebbe avere altri campi; qui interessa solo che il bot
 * riceva qualcosa di leggibile. Se un giorno un test fallirà
 * perché mancano campi, sarà il segnale che il motore ha cambiato
 * contratto — ed è un'informazione utile, non un fastidio.
 */
export function card(value: number, suit: string): Card {
  return { value, suit } as unknown as Card;
}
