/**
 * Poker Zeta — Test della distribuzione allo showdown
 *
 * Qui entra in gioco il valutatore delle mani, quindi servono carte
 * vere. Sono separati da pot.test.ts di proposito: se il modo in cui
 * costruisco le carte non basta al valutatore, cade solo questo file
 * e l aritmetica dei pot resta protetta.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPots,
  distributePots,
  totalPotAmount,
  verifyPayoutIntegrity,
  type Contribution,
  type ShowdownEntry,
} from '../engine/pot.js';

import { card } from './helpers.js';

/** Scala reale di picche più due carte irrilevanti. */
const SCALA_REALE = [
  card(14, 's'),
  card(13, 's'),
  card(12, 's'),
  card(11, 's'),
  card(10, 's'),
  card(2, 'd'),
  card(3, 'c'),
];

/** Coppia di due. */
const COPPIA_DI_DUE = [
  card(2, 'h'),
  card(2, 'd'),
  card(7, 'c'),
  card(9, 'h'),
  card(11, 'd'),
  card(4, 'c'),
  card(6, 's'),
];

/** Coppia di tre: batte la coppia di due, perde con tutto il resto. */
const COPPIA_DI_TRE = [
  card(3, 'h'),
  card(3, 'd'),
  card(7, 'c'),
  card(9, 'h'),
  card(11, 'd'),
  card(4, 'c'),
  card(6, 's'),
];

test('showdown: chi è all-in corto vince solo il piatto principale', () => {
  // A ha la mano migliore in assoluto ma ha impegnato 50: può
  // prendere il piatto principale e nulla più. È la ragione per cui
  // esistono i side pot.
  const contributions: Contribution[] = [
    { playerId: 'A', amount: 50, eligible: true },
    { playerId: 'B', amount: 200, eligible: true },
    { playerId: 'C', amount: 500, eligible: true },
  ];

  const pots = buildPots(contributions);

  const showdown: ShowdownEntry[] = [
    { playerId: 'A', cards: SCALA_REALE },
    { playerId: 'B', cards: COPPIA_DI_DUE },
    { playerId: 'C', cards: COPPIA_DI_TRE },
  ];

  const payouts = distributePots(pots, showdown, ['A', 'B', 'C']);
  const per = (id: string): number =>
    payouts.find((p) => p.playerId === id)?.amount ?? 0;

  assert.equal(per('A'), 150, 'A deve prendere solo il piatto principale');
  assert.equal(per('C'), 600, 'C deve prendere i due side pot');
  assert.equal(per('B'), 0, 'B ha la mano peggiore fra i contendenti');

  assert.ok(verifyPayoutIntegrity(pots, payouts).valid);
});

test('showdown: le fiche distribuite sono sempre quelle raccolte', () => {
  // L invariante che conta più di ogni altro: qualunque sia
  // l esito, non nascono né sparaiscono Z-Coins.
  const casi: Contribution[][] = [
    [
      { playerId: 'A', amount: 100, eligible: true },
      { playerId: 'B', amount: 100, eligible: true },
    ],
    [
      { playerId: 'A', amount: 33, eligible: true },
      { playerId: 'B', amount: 77, eligible: true },
      { playerId: 'C', amount: 155, eligible: true },
    ],
    [
      { playerId: 'A', amount: 10, eligible: false },
      { playerId: 'B', amount: 90, eligible: true },
      { playerId: 'C', amount: 90, eligible: true },
    ],
  ];

  const mani = new Map<string, readonly ReturnType<typeof card>[]>([
    ['A', SCALA_REALE],
    ['B', COPPIA_DI_DUE],
    ['C', COPPIA_DI_TRE],
  ]);

  for (const contributions of casi) {
    const pots = buildPots(contributions);

    const showdown: ShowdownEntry[] = contributions
      .filter((c) => c.eligible)
      .map((c) => ({ playerId: c.playerId, cards: mani.get(c.playerId)! }));

    const payouts = distributePots(pots, showdown, ['A', 'B', 'C']);
    const check = verifyPayoutIntegrity(pots, payouts);

    assert.ok(
      check.valid,
      `squilibrio: piatti ${check.potTotal}, distribuito ${check.payoutTotal}`,
    );
  }
});

test('showdown: a parità di mano il piatto si divide', () => {
  // Due mani identiche: impossibile con un mazzo vero, deliberato
  // qui per forzare la parità senza dipendere da come il
  // valutatore ordina mani diverse.
  const contributions: Contribution[] = [
    { playerId: 'A', amount: 100, eligible: true },
    { playerId: 'B', amount: 100, eligible: true },
  ];

  const pots = buildPots(contributions);

  const payouts = distributePots(
    pots,
    [
      { playerId: 'A', cards: COPPIA_DI_DUE },
      { playerId: 'B', cards: COPPIA_DI_DUE },
    ],
    ['A', 'B'],
  );

  const per = (id: string): number =>
    payouts.find((p) => p.playerId === id)?.amount ?? 0;

  assert.equal(per('A'), 100);
  assert.equal(per('B'), 100);
  assert.ok(verifyPayoutIntegrity(pots, payouts).valid);
});

test('showdown: il resto indivisibile non viene mai scartato', () => {
  // Piatto di 101 fra due vincitori a pari merito: 50 e 50 fanno
  // 100, e la fiche dispari deve andare a qualcuno.
  const contributions: Contribution[] = [
    { playerId: 'A', amount: 50, eligible: true },
    { playerId: 'B', amount: 51, eligible: true },
  ];

  const pots = buildPots(contributions);
  assert.equal(totalPotAmount(pots), 101);

  const payouts = distributePots(
    pots,
    [
      { playerId: 'A', cards: COPPIA_DI_DUE },
      { playerId: 'B', cards: COPPIA_DI_DUE },
    ],
    ['A', 'B'],
  );

  const check = verifyPayoutIntegrity(pots, payouts);
  assert.ok(check.valid, `una fiche è andata perduta: ${JSON.stringify(check)}`);
  assert.equal(check.payoutTotal, 101);
});
