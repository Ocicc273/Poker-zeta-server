/**
 * Poker Zeta — Derivazione della configurazione del tavolo
 *
 * Il buy-in arriva dal client, quindi non è affidabile: qui viene
 * validato e trasformato in bui e stack. Un client modificato che
 * chiede un buy-in da dieci milioni deve trovare un muro.
 */

import type { TableConfig } from '../engine/index.js';

/** Un buy-in standard vale 40 big blind (stessa regola del client). */
const BIG_BLINDS_PER_BUYIN = 40;

/** Limiti di sicurezza, non regole di gioco. */
const MIN_BUY_IN = 100;
const MAX_BUY_IN = 50_000;

/** Posti al tavolo: 1 umano + 2 bot. */
export const MAX_SEATS = 3;

const NICE_VALUES = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000,
] as const;

function roundToNiceValue(value: number): number {
  let closest: number = NICE_VALUES[0];
  let smallestGap = Math.abs(value - closest);

  for (const step of NICE_VALUES) {
    const gap = Math.abs(value - step);
    if (gap < smallestGap) {
      smallestGap = gap;
      closest = step;
    }
  }
  return closest;
}

/**
 * Riporta un buy-in arbitrario dentro i limiti consentiti.
 *
 * Nota: qui NON viene ancora verificato che il giocatore possieda
 * davvero quelle Z-Coins. Il controllo sul wallet è un pezzo a sé
 * e va fatto prima di considerare reale l'economia del gioco.
 */
export function sanitizeBuyIn(raw: unknown): number {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : MIN_BUY_IN;
  const clamped = Math.min(MAX_BUY_IN, Math.max(MIN_BUY_IN, Math.floor(value)));
  return clamped;
}

export function deriveTableConfig(buyIn: number): {
  config: TableConfig;
  startingStack: number;
} {
  const rawBigBlind = Math.max(2, Math.round(buyIn / BIG_BLINDS_PER_BUYIN));
  const bigBlind = roundToNiceValue(rawBigBlind);

  return {
    config: {
      maxSeats: MAX_SEATS,
      blinds: {
        smallBlind: Math.max(1, Math.floor(bigBlind / 2)),
        bigBlind,
        ante: 0,
      },
      structure: 'no-limit',
    },
    startingStack: buyIn,
  };
}
