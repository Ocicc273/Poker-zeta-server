/**
 * Poker Zeta — Livelli di stake del cash game
 * Riferimento: ECON-001 §5
 *
 * Ogni tavolo esiste con i propri bui FISSI. Il giocatore scegle
 * quanto portarci dentro, entro un intervallo.
 *
 * È il modello del poker cash reale, e sostituisce quello
 * precedente in cui i bui venivano ricavati dal buy-in con un
 * rapporto fisso. Quel modello funzionava ma era insolito: rendeva
 * il tavolo una conseguenza dello stack invece del contrario.
 *
 * Regola generale: buy-in minimo 20 big blind, massimo 100.
 */

export interface StakeLevel {
  /** Progressivo, da 1. Compare nell'interfaccia. */
  readonly level: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly minBuyIn: number;
  readonly maxBuyIn: number;
}

/**
 * Scala per Texas Hold'em No Limit.
 *
 * Gli intervalli si sovrappongono di proposito: 4.000 è un buy-in
 * legittimo sia a 25/50 (80 big blind) sia a 100/200 (20 big
 * blind). La regola di risoluzione più sotto decide quale, e
 * sceglie sempre quello che dà più profondità di stack.
 */
export const HOLDEM_STAKES: readonly StakeLevel[] = [
  { level: 1, smallBlind: 50, bigBlind: 100, minBuyIn: 2_000, maxBuyIn: 10_000 },
  { level: 2, smallBlind: 250, bigBlind: 500, minBuyIn: 10_000, maxBuyIn: 50_000 },
  { level: 3, smallBlind: 1_000, bigBlind: 2_000, minBuyIn: 40_000, maxBuyIn: 200_000 },
  { level: 4, smallBlind: 5_000, bigBlind: 10_000, minBuyIn: 200_000, maxBuyIn: 1_000_000 },
  { level: 5, smallBlind: 25_000, bigBlind: 50_000, minBuyIn: 1_000_000, maxBuyIn: 5_000_000 },
  { level: 6, smallBlind: 100_000, bigBlind: 200_000, minBuyIn: 4_000_000, maxBuyIn: 20_000_000 },
  { level: 7, smallBlind: 500_000, bigBlind: 1_000_000, minBuyIn: 20_000_000, maxBuyIn: 100_000_000 },
] as const;

/** Il livello più basso: soglia del fondo di ripartenza (ECON-001 §4). */
export const LOWEST_LEVEL: StakeLevel = HOLDEM_STAKES[0]!;

/** Il livello più alto disponibile. */
export const HIGHEST_LEVEL: StakeLevel =
  HOLDEM_STAKES[HOLDEM_STAKES.length - 1]!;

/**
 * Individua il livello adatto a un buy-in richiesto.
 *
 * Si prende il primo livello il cui massimo copre la richiesta.
 * Dove gli intervalli si sovrappongono questo sceglie i bui più
 * bassi, cioè più big blind per lo stesso denaro: chi porta 4.000
 * al tavolo vuole 80 big blind, non 20.
 *
 * Un buy-in fuori scala non viene rifiutato: viene riportato dentro
 * i limiti. Il client può chiedere qualunque cosa, il server decide.
 */
export function resolveStakeLevel(buyIn: number): StakeLevel {
  for (const level of HOLDEM_STAKES) {
    if (buyIn <= level.maxBuyIn) {
      return level;
    }
  }
  return HIGHEST_LEVEL;
}

/** Cerca un livello per numero. undefined se non esiste. */
export function stakeLevelByNumber(level: number): StakeLevel | undefined {
  return HOLDEM_STAKES.find((entry) => entry.level === level);
}
