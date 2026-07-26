/**
 * Poker Zeta — Test della costruzione dei pot
 *
 * Questo è il codice che decide chi viene pagato e quanto. Un
 * difetto qui non produce un comportamento strano: produce Z-Coins
 * sbagliate nel wallet di qualcuno.
 *
 * L'invariante che ogni test protegge è sempre lo stesso: la somma
 * dei pot deve valere esattamente quanto la somma dei contributi.
 * Nessuna fiche creata, nessuna persa.
 *
 * Nota: nessuno di questi test tocca le carte. Sono aritmetica pura
 * sui contributi, verificabile senza far intervenire il valutatore
 * delle mani.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  awardUncontested,
  buildPots,
  totalPotAmount,
  verifyPayoutIntegrity,
  type Contribution,
} from '../engine/pot.js';

/** Somma dei contributi: il totale che i pot devono contenere. */
function sommaContributi(contributions: readonly Contribution[]): number {
  return contributions.reduce((total, c) => total + c.amount, 0);
}

test('pot: l esempio della documentazione produce 150/300/300', () => {
  // Tre all-in a 50, 200 e 500. È il caso descritto in testa a
  // pot.ts: se questo cambia, la documentazione è diventata falsa.
  const contributions: Contribution[] = [
    { playerId: 'A', amount: 50, eligible: true },
    { playerId: 'B', amount: 200, eligible: true },
    { playerId: 'C', amount: 500, eligible: true },
  ];

  const pots = buildPots(contributions);

  assert.equal(pots.length, 3);

  assert.equal(pots[0]!.amount, 150);
  assert.deepEqual([...pots[0]!.eligiblePlayers], ['A', 'B', 'C']);

  assert.equal(pots[1]!.amount, 300);
  assert.deepEqual([...pots[1]!.eligiblePlayers], ['B', 'C']);

  assert.equal(pots[2]!.amount, 300);
  assert.deepEqual([...pots[2]!.eligiblePlayers], ['C']);

  assert.equal(totalPotAmount(pots), 750);
});

test('pot: gli indici sono progressivi da zero', () => {
  const pots = buildPots([
    { playerId: 'A', amount: 50, eligible: true },
    { playerId: 'B', amount: 200, eligible: true },
    { playerId: 'C', amount: 500, eligible: true },
  ]);

  pots.forEach((pot, i) => assert.equal(pot.index, i));
});

test('pot: contributi uguali producono un solo piatto', () => {
  const contributions: Contribution[] = [
    { playerId: 'A', amount: 100, eligible: true },
    { playerId: 'B', amount: 100, eligible: true },
    { playerId: 'C', amount: 100, eligible: true },
  ];

  const pots = buildPots(contributions);

  assert.equal(pots.length, 1);
  assert.equal(pots[0]!.amount, 300);
  assert.equal(totalPotAmount(pots), sommaContributi(contributions));
});

test('pot: chi folda alimenta il piatto ma non può vincerlo', () => {
  const contributions: Contribution[] = [
    { playerId: 'A', amount: 50, eligible: false },
    { playerId: 'B', amount: 200, eligible: true },
    { playerId: 'C', amount: 200, eligible: true },
  ];

  const pots = buildPots(contributions);

  // Le 50 di A sono nel piatto…
  assert.equal(totalPotAmount(pots), 450);
  assert.equal(totalPotAmount(pots), sommaContributi(contributions));

  // …ma A non compare fra chi può vincere, in nessun pot.
  for (const pot of pots) {
    assert.ok(
      !pot.eligiblePlayers.includes('A'),
      `A può vincere il pot ${pot.index} pur avendo foldato`,
    );
  }
});

test('pot: una fetta senza aventi diritto confluisce nel pot precedente', () => {
  // B ha puntato più di A e poi ha foldato. La fetta sopra i 100 ha
  // un solo contributore, che non può vincerla: quelle fiche non
  // devono sparire, devono finire nel piatto sotto.
  const contributions: Contribution[] = [
    { playerId: 'A', amount: 100, eligible: true },
    { playerId: 'B', amount: 200, eligible: false },
  ];

  const pots = buildPots(contributions);

  assert.equal(pots.length, 1);
  assert.equal(pots[0]!.amount, 300, 'le fiche di B sono state perse');
  assert.equal(totalPotAmount(pots), sommaContributi(contributions));
});

test('pot: la conservazione delle fiche vale su molte configurazioni', () => {
  // Invariante centrale del modulo, provato su casi assortiti
  // invece che su uno solo.
  const casi: Contribution[][] = [
    [
      { playerId: 'A', amount: 1, eligible: true },
      { playerId: 'B', amount: 1, eligible: true },
    ],
    [
      { playerId: 'A', amount: 3, eligible: true },
      { playerId: 'B', amount: 7, eligible: true },
      { playerId: 'C', amount: 11, eligible: true },
    ],
    [
      { playerId: 'A', amount: 25, eligible: false },
      { playerId: 'B', amount: 50, eligible: true },
      { playerId: 'C', amount: 1_000, eligible: true },
      { playerId: 'D', amount: 1_000, eligible: true },
    ],
    [
      { playerId: 'A', amount: 0, eligible: true },
      { playerId: 'B', amount: 500, eligible: true },
      { playerId: 'C', amount: 500, eligible: true },
    ],
    [
      { playerId: 'A', amount: 997, eligible: true },
      { playerId: 'B', amount: 998, eligible: true },
      { playerId: 'C', amount: 999, eligible: true },
    ],
  ];

  for (const contributions of casi) {
    const pots = buildPots(contributions);
    assert.equal(
      totalPotAmount(pots),
      sommaContributi(contributions),
      `conservazione violata su ${JSON.stringify(contributions)}`,
    );
  }
});

test('pot: un contributo nullo non genera piatti', () => {
  assert.deepEqual(buildPots([]), []);
  assert.deepEqual(
    buildPots([
      { playerId: 'A', amount: 0, eligible: true },
      { playerId: 'B', amount: 0, eligible: true },
    ]),
    [],
  );
});

test('pot: un contributo negativo o decimale viene rifiutato', () => {
  // Non è una condizione di gioco: è uno stato corrotto, e va
  // fermato invece di essere interpretato.
  assert.throws(() =>
    buildPots([{ playerId: 'A', amount: -10, eligible: true }]),
  );
  assert.throws(() =>
    buildPots([{ playerId: 'A', amount: 12.5, eligible: true }]),
  );
  assert.throws(() =>
    buildPots([{ playerId: 'A', amount: Number.NaN, eligible: true }]),
  );
});

test('pot: senza showdown il piatto intero va a chi resta', () => {
  const pots = buildPots([
    { playerId: 'A', amount: 50, eligible: false },
    { playerId: 'B', amount: 200, eligible: true },
  ]);

  const payouts = awardUncontested(pots, 'B');

  assert.equal(payouts.length, 1);
  assert.equal(payouts[0]!.playerId, 'B');
  assert.equal(payouts[0]!.amount, 250);
  assert.ok(verifyPayoutIntegrity(pots, payouts).valid);
});

test('pot: senza piatto non si distribuisce nulla', () => {
  assert.deepEqual(awardUncontested([], 'A'), []);
});

test('pot: la verifica di integrità riconosce uno squilibrio', () => {
  const pots = buildPots([
    { playerId: 'A', amount: 100, eligible: true },
    { playerId: 'B', amount: 100, eligible: true },
  ]);

  const corretto = verifyPayoutIntegrity(pots, [
    { playerId: 'A', amount: 200, fromPots: [0] },
  ]);
  assert.ok(corretto.valid);
  assert.equal(corretto.potTotal, 200);
  assert.equal(corretto.payoutTotal, 200);

  // Una fiche in più è già un difetto: significa Z-Coins create.
  const sbagliato = verifyPayoutIntegrity(pots, [
    { playerId: 'A', amount: 201, fromPots: [0] },
  ]);
  assert.equal(sbagliato.valid, false);
});
