/**
 * Poker Zeta — Tabella dei moltiplicatori del Twister
 * Riferimento: ECON-001 §9.2
 *
 * Le probabilità di questa tabella NON sono un dettaglio estetico:
 * sono il rake del formato. La formula è
 *
 *     rake = (3 − valore atteso del moltiplicatore) / 3
 *
 * perché tre giocatori versano un buy-in ciascuno e il montepremi
 * vale moltiplicatore × buy-in. Un valore atteso di 3 significa
 * rake zero; sopra 3, il Twister crea Z-Coins a ogni partita.
 *
 * Chi modifica un peso sta modificando l'economia del gioco. Il
 * test di integrità in tests/twister.test.ts lo ferma prima del
 * deploy se i conti non tornano.
 */

import { randomInt } from 'node:crypto';

export interface MultiplierEntry {
  readonly multiplier: number;
  readonly weight: number;
}

/**
 * Pesi interi su un milione, non probabilità decimali.
 *
 * Sommare decimali produce tabelle che non fanno esattamente 1 e
 * un'estrazione leggermente sbagliata che nessuno nota per mesi.
 * Con gli interi lo sbilanciamento è impossibile da nascondere.
 */
export const MULTIPLIER_TABLE: readonly MultiplierEntry[] = [
  { multiplier: 2, weight: 629_434 },
  { multiplier: 3, weight: 212_044 },
  { multiplier: 4, weight: 100_000 },
  { multiplier: 6, weight: 45_000 },
  { multiplier: 10, weight: 10_000 },
  { multiplier: 25, weight: 3_000 },
  { multiplier: 100, weight: 500 },
  { multiplier: 1_000, weight: 20 },
  { multiplier: 5_000, weight: 2 },
] as const;

/** Somma attesa dei pesi. Verificata dai test. */
export const TOTAL_WEIGHT = 1_000_000;

/** Numero di giocatori a un tavolo Twister. */
export const TWISTER_SEATS = 3;

/**
 * Somma di peso × moltiplicatore.
 * Diviso TOTAL_WEIGHT dà il valore atteso: 2,82.
 */
export function weightedSum(): number {
  return MULTIPLIER_TABLE.reduce(
    (total, entry) => total + entry.weight * entry.multiplier,
    0,
  );
}

/** Somma dei pesi. Deve valere TOTAL_WEIGHT. */
export function totalWeight(): number {
  return MULTIPLIER_TABLE.reduce((total, entry) => total + entry.weight, 0);
}

/**
 * Rake effettivo del formato, ricavato dalla tabella.
 *
 * Non è una costante scritta a mano: è calcolato dai pesi, così
 * non può divergere da essi.
 */
export function effectiveRake(): number {
  const expectedValue = weightedSum() / totalWeight();
  return (TWISTER_SEATS - expectedValue) / TWISTER_SEATS;
}

/**
 * Estrae il moltiplicatore di una partita.
 *
 * L'estrazione appartiene al server e usa la stessa qualità di
 * casualità del mazzo. Il parametro `roll` esiste solo per i test:
 * in produzione va lasciato vuoto.
 *
 * @param roll numero fra 1 e TOTAL_WEIGHT, estremi inclusi
 */
export function drawMultiplier(roll?: number): number {
  const value = roll ?? randomInt(1, TOTAL_WEIGHT + 1);

  if (!Number.isInteger(value) || value < 1 || value > TOTAL_WEIGHT) {
    throw new Error(
      `Estrazione fuori intervallo: ${value} (atteso 1…${TOTAL_WEIGHT})`,
    );
  }

  let cumulative = 0;
  for (const entry of MULTIPLIER_TABLE) {
    cumulative += entry.weight;
    if (value <= cumulative) return entry.multiplier;
  }

  // Irraggiungibile se i pesi sommano a TOTAL_WEIGHT, ma se un
  // giorno non lo facessero questo è il punto in cui il difetto
  // diventerebbe visibile invece di restituire silenziosamente
  // l'ultimo valore.
  throw new Error('Tabella dei moltiplicatori incoerente: pesi insufficienti.');
}

/**
 * Ripartizione del montepremi fra primo, secondo e terzo.
 * Riferimento: ECON-001 §9.3
 *
 * Winner-takes-all sui moltiplicatori bassi, che sono la quasi
 * totalità delle partite. Dai 100× in su pagano anche gli altri
 * due: perdere un tavolo da 100× senza nulla in mano è una
 * frustrazione che si ricorda.
 */
export function prizeSplit(multiplier: number): readonly number[] {
  return multiplier >= 100 ? [0.8, 0.15, 0.05] : [1, 0, 0];
}
