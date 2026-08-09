/**
 * Poker Zeta — Derivazione della configurazione del tavolo
 * Riferimento: ECON-001 §5
 *
 * Il buy-in arriva dal client, quindi non è affidabile: qui viene
 * ricondotto a un livello di stake esistente e vincolato al suo
 * intervallo. Un client modificato che chiede un buy-in da dieci
 * milioni deve trovare un muro, non un tavolo su misura.
 *
 * Le firme sono rimaste quelle di prima perché room.ts le usa:
 * cambia il modo in cui i bui vengono determinati, non il contratto.
 */

import type { TableConfig } from '../engine/index.js';
import type { Variant } from '../engine/table-types.js';
import {
  HIGHEST_LEVEL,
  LOWEST_LEVEL,
  resolveStakeLevel,
  type StakeLevel,
} from './stakes.js';

/**
 * Posti al tavolo contro i bot: 1 umano + 2 bot.
 *
 * Resta 3 perché i BOTS in room.ts sono due. Non è il limite del
 * motore, che regge fino a MAX_SEATS_PRIVATE.
 */
export const MAX_SEATS = 3;

/**
 * Posti di un tavolo privato.
 *
 * Sei è il numero delle poltrone disegnate nella sala: mettere un
 * settimo giocatore significherebbe non avere dove sederlo.
 */
export const MAX_SEATS_PRIVATE = 6;

/** Limiti assoluti, ricavati dalla scala invece di essere ripetuti. */
export const MIN_BUY_IN = LOWEST_LEVEL.minBuyIn;
export const MAX_BUY_IN = HIGHEST_LEVEL.maxBuyIn;

/**
 * Riporta un buy-in arbitrario dentro i limiti della scala.
 *
 * Nota: qui NON viene verificato che il giocatore possieda davvero
 * quelle Z-Coins. Quel controllo vive nella funzione SQL
 * open_table_session, che rifiuta se il saldo non basta.
 */
export function sanitizeBuyIn(raw: unknown): number {
  const value =
    typeof raw === 'number' && Number.isFinite(raw) ? raw : MIN_BUY_IN;

  const intero = Math.floor(value);
  const dentroScala = Math.min(MAX_BUY_IN, Math.max(MIN_BUY_IN, intero));

  // Il buy-in va vincolato anche all'intervallo del proprio livello:
  // 1.500 appartiene al livello 2, che parte da 1.000, quindi resta
  // 1.500; ma 250 appartiene al livello 1 e non può salire sopra
  // 1.000 solo perché la scala nel complesso arriva più in alto.
  const level = resolveStakeLevel(dentroScala);

  return Math.min(level.maxBuyIn, Math.max(level.minBuyIn, dentroScala));
}

export interface DerivedTable {
  config: TableConfig;
  startingStack: number;
  stake: StakeLevel;
}

/**
 * Costruisce la configurazione del tavolo per un buy-in già
 * normalizzato.
 *
 * I bui NON dipendono dal buy-in: appartengono al livello. È la
 * differenza fra "scelgo un tavolo e decido quanto portarci" e
 * "il mio stack decide che tavolo è", che era il modello sbagliato.
 */
export function deriveTableConfig(
  buyIn: number,
  maxSeats: number = MAX_SEATS,
  variant: Variant = 'holdem',
): DerivedTable {
  const stake = resolveStakeLevel(buyIn);

  return {
    config: {
      maxSeats,
      blinds: {
        smallBlind: stake.smallBlind,
        bigBlind: stake.bigBlind,
        ante: 0,
      },
      // La struttura discende dalla variante: l'Omaha è Pot Limit
      // per definizione, e lasciarla scegliere a chi chiama
      // significherebbe poter aprire un Omaha No Limit per errore.
      structure: variant === 'omaha' ? 'pot-limit' : 'no-limit',
      variant,
    },
    startingStack: Math.min(
      stake.maxBuyIn,
      Math.max(stake.minBuyIn, Math.floor(buyIn)),
    ),
    stake,
  };
}
