/**
 * Poker Zeta — Test del rake
 *
 * Gli ultimi tre test sono INVARIANTI ECONOMICI: se cadono, il rake
 * non sta più facendo il suo mestiere di scarico e l'inflazione delle
 * Z-Coins riparte. Vanno trattati come i test del Twister.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RAKE_CAP_BIG_BLINDS,
  RAKE_PERCENT,
  applyRake,
  computeRake,
  rakeCap,
} from '../game/rake.js';

/** Tavolo di livello 1: bui 5/10. */
const BB = 10;

const contestedHand = { bigBlind: BB, sawFlop: true, contested: true };

test('no flop, no drop', () => {
  assert.equal(
    computeRake({ ...contestedHand, sawFlop: false, pot: 5_000 }),
    0
  );
});

test('nessun rake su un piatto non conteso', () => {
  assert.equal(
    computeRake({ ...contestedHand, contested: false, pot: 5_000 }),
    0
  );
});

test('il 5% si applica sotto il tetto', () => {
  // 400 fiche → 20, e il tetto è 30: comanda la percentuale.
  assert.equal(computeRake({ ...contestedHand, pot: 400 }), 20);
});

test('il tetto comanda sui piatti grossi', () => {
  // Il tetto scatta oltre 600 fiche, cioè 60 big blind.
  assert.equal(computeRake({ ...contestedHand, pot: 600 }), 30);
  assert.equal(computeRake({ ...contestedHand, pot: 50_000 }), 30);
});

test('il tetto cresce col big blind del tavolo', () => {
  assert.equal(rakeCap(10), 30);
  assert.equal(rakeCap(5_000), 15_000);
  // Livello 5: il tetto scatta oltre 300.000 fiche.
  assert.equal(
    computeRake({ bigBlind: 5_000, sawFlop: true, contested: true, pot: 400_000 }),
    15_000
  );
});

test('arrotondamento sempre per difetto', () => {
  // 199 × 0,05 = 9,95 → 9, mai 10.
  assert.equal(computeRake({ ...contestedHand, pot: 199 }), 9);
});

test('piatti minuscoli non producono rake', () => {
  assert.equal(computeRake({ ...contestedHand, pot: 0 }), 0);
  assert.equal(computeRake({ ...contestedHand, pot: 19 }), 0);
});

test('valori assurdi non producono rake', () => {
  assert.equal(computeRake({ ...contestedHand, pot: -100 }), 0);
  assert.equal(computeRake({ ...contestedHand, pot: Number.NaN }), 0);
  assert.equal(computeRake({ ...contestedHand, pot: Number.POSITIVE_INFINITY }), 0);
});

test('applyRake preleva dal piatto principale', () => {
  const { pots, taken } = applyRake([1_000, 300], 30);
  assert.deepEqual(pots, [970, 300]);
  assert.equal(taken, 30);
});

test('applyRake trabocca sui piatti laterali quando serve', () => {
  const { pots, taken } = applyRake([20, 300], 30);
  assert.deepEqual(pots, [0, 290]);
  assert.equal(taken, 30);
});

test('applyRake non preleva più di quanto c\u2019è', () => {
  const { pots, taken } = applyRake([5, 4], 30);
  assert.deepEqual(pots, [0, 0]);
  assert.equal(taken, 9);
});

/* ── Invarianti economici ─────────────────────────────────── */

test("il rake non supera mai il tetto né la percentuale", () => {
  for (let pot = 1; pot <= 5_000; pot += 7) {
    const rake = computeRake({ ...contestedHand, pot });
    assert.ok(rake <= pot * RAKE_PERCENT, `percentuale sforata con pot ${pot}`);
    assert.ok(
      rake <= RAKE_CAP_BIG_BLINDS * BB,
      `tetto sforato con pot ${pot}`
    );
    assert.ok(Number.isInteger(rake), `rake non intero con pot ${pot}`);
    assert.ok(rake >= 0, `rake negativo con pot ${pot}`);
  }
});

test('il rake non riduce mai il piatto sotto zero', () => {
  for (let pot = 1; pot <= 2_000; pot += 13) {
    const rake = computeRake({ ...contestedHand, pot });
    const { pots, taken } = applyRake([pot], rake);
    assert.equal(taken, rake);
    assert.equal(pots[0], pot - rake);
    assert.ok(pots[0] >= 0);
  }
});

test("il rake è davvero uno scarico: su un piatto conteso al flop è > 0", () => {
  // Se questo test cade, i tavoli non drenano più nulla e le fonti di
  // Z-Coins restano senza contrappeso.
  assert.ok(computeRake({ ...contestedHand, pot: 20 }) > 0);
  assert.ok(computeRake({ ...contestedHand, pot: 1_000 }) > 0);
});
