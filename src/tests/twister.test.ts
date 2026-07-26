/**
 * Poker Zeta — Test della tabella dei moltiplicatori
 *
 * Questi test proteggono un numero: il rake del Twister. Se
 * qualcuno modifica un peso senza rifare i conti, il deploy si
 * ferma qui invece di andare in produzione con un formato che
 * regala Z-Coins.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MULTIPLIER_TABLE,
  TOTAL_WEIGHT,
  drawMultiplier,
  effectiveRake,
  prizeSplit,
  totalWeight,
  weightedSum,
} from '../game/twister-multipliers.js';

test('twister: i pesi sommano esattamente a un milione', () => {
  assert.equal(totalWeight(), TOTAL_WEIGHT);
});

test('twister: il valore atteso è 2,82 come da ECON-001', () => {
  assert.equal(weightedSum(), 2_820_000);
});

test('twister: il rake effettivo è il 6%', () => {
  // Confronto con tolleranza: il calcolo passa da una divisione.
  assert.ok(
    Math.abs(effectiveRake() - 0.06) < 1e-9,
    `rake calcolato ${effectiveRake()}, atteso 0.06`,
  );
});

test('twister: il rake resta positivo — il formato non crea fiche', () => {
  // Invariante economico: se questo cade, ogni partita immette
  // Z-Coins nel sistema invece di toglierne.
  assert.ok(effectiveRake() > 0, 'il Twister sta creando Z-Coins');
});

test('twister: i pesi sono interi positivi e i moltiplicatori crescenti', () => {
  let precedente = 0;
  for (const entry of MULTIPLIER_TABLE) {
    assert.ok(Number.isInteger(entry.weight), 'peso non intero');
    assert.ok(entry.weight > 0, 'peso non positivo');
    assert.ok(
      entry.multiplier > precedente,
      'moltiplicatori non in ordine crescente',
    );
    precedente = entry.multiplier;
  }
});

test('twister: gli estremi dell estrazione danno i moltiplicatori attesi', () => {
  assert.equal(drawMultiplier(1), 2, 'il primo numero deve dare 2×');
  assert.equal(drawMultiplier(TOTAL_WEIGHT), 5_000, 'l ultimo deve dare 5.000×');
});

test('twister: i confini fra fasce cadono al posto giusto', () => {
  // Un errore di un'unità qui sposterebbe migliaia di partite da
  // una fascia all'altra senza che nessuno se ne accorga.
  assert.equal(drawMultiplier(629_434), 2);
  assert.equal(drawMultiplier(629_435), 3);
  assert.equal(drawMultiplier(841_478), 3);
  assert.equal(drawMultiplier(841_479), 4);
  assert.equal(drawMultiplier(999_998), 1_000);
  assert.equal(drawMultiplier(999_999), 5_000);
});

test('twister: ogni estrazione valida produce un moltiplicatore della tabella', () => {
  const consentiti = new Set(MULTIPLIER_TABLE.map((e) => e.multiplier));

  // Campionamento a passo fisso: copre tutte le fasce senza
  // scorrere un milione di valori a ogni build.
  for (let roll = 1; roll <= TOTAL_WEIGHT; roll += 997) {
    assert.ok(consentiti.has(drawMultiplier(roll)));
  }
});

test('twister: un estrazione fuori intervallo viene rifiutata', () => {
  assert.throws(() => drawMultiplier(0));
  assert.throws(() => drawMultiplier(TOTAL_WEIGHT + 1));
  assert.throws(() => drawMultiplier(1.5));
});

test('twister: senza parametri estrae comunque un valore legale', () => {
  const consentiti = new Set(MULTIPLIER_TABLE.map((e) => e.multiplier));
  for (let i = 0; i < 200; i += 1) {
    assert.ok(consentiti.has(drawMultiplier()));
  }
});

test('twister: la ripartizione del premio somma sempre a uno', () => {
  for (const entry of MULTIPLIER_TABLE) {
    const quote = prizeSplit(entry.multiplier);
    const somma = quote.reduce((a, b) => a + b, 0);
    assert.ok(
      Math.abs(somma - 1) < 1e-9,
      `con ${entry.multiplier}× le quote sommano a ${somma}`,
    );
  }
});

test('twister: i moltiplicatori alti pagano anche secondo e terzo', () => {
  assert.deepEqual(prizeSplit(25), [1, 0, 0]);
  assert.deepEqual(prizeSplit(100), [0.8, 0.15, 0.05]);
  assert.deepEqual(prizeSplit(5_000), [0.8, 0.15, 0.05]);
});
