/**
 * Poker Zeta — Test dell Omaha e del tetto Pot Limit
 *
 * Due cose sotto protezione: il vincolo 2 personali + 3 comuni,
 * che è la regola stessa della variante, e il calcolo del tetto
 * del piatto, dove il chiamato conta due volte ed è l errore
 * classico di ogni implementazione.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cardsFromString } from '../engine/cards.js';
import { evaluateOmahaHand } from '../engine/omaha.js';
import { HandCategory } from '../engine/hand-rank.js';
import {
  startHand,
  getAvailableActions,
  applyAction,
} from '../engine/hand-state.js';
import { ActionType, type TableConfig } from '../engine/table-types.js';

/* ── Vincolo 2+3 ─────────────────────────────────────────── */

test("omaha: rifiuta un numero di carte personali diverso da quattro", () => {
  const board = cardsFromString('9h 5h Jd 8c 3d');
  assert.throws(() => evaluateOmahaHand(cardsFromString('Ah Kh Qh'), board));
  assert.throws(() =>
    evaluateOmahaHand(cardsFromString('Ah Kh Qh Jh Th'), board),
  );
});

test("omaha: rifiuta un board con meno di tre carte", () => {
  assert.throws(() =>
    evaluateOmahaHand(cardsFromString('Ah Kh Qh Jh'), cardsFromString('9h 5h')),
  );
});

test("omaha: il tris in mano non conta, solo due assi entrano in gioco", () => {
  // A-A-A-K in mano, un solo re sul board: usando due assi non si
  // può usare anche il re, quindi resta coppia di assi.
  const best = evaluateOmahaHand(
    cardsFromString('As Ah Ad Kc'),
    cardsFromString('Kh Qd Js 9c 3h'),
  );
  assert.equal(best.category, HandCategory.Pair);
});

test("omaha: tre carte dello stesso seme in mano non fanno colore", () => {
  const best = evaluateOmahaHand(
    cardsFromString('Ah Kh Qh 2c'),
    cardsFromString('Jh Th 3d 4s 5c'),
  );
  assert.notEqual(best.category, HandCategory.Flush);
});

test("omaha: il board non gioca da solo", () => {
  // Scala reale a cuori sul board: in Hold em vincerebbero tutti,
  // in Omaha nessuno la può usare.
  const best = evaluateOmahaHand(
    cardsFromString('2c 3d 4h 5s'),
    cardsFromString('Ah Kh Qh Jh Th'),
  );
  assert.notEqual(best.category, HandCategory.Flush);
});

test("omaha: usa sempre esattamente due personali e tre comuni", () => {
  const best = evaluateOmahaHand(
    cardsFromString('As Kd 7h 2c'),
    cardsFromString('Ac Kh 7s 3d 9c'),
  );
  assert.equal(best.usedHoleCards.length, 2);
  assert.equal(best.usedCommunityCards.length, 3);
});

/* ── Tetto Pot Limit ─────────────────────────────────────── */

function config(
  structure: 'no-limit' | 'pot-limit',
  variant: 'holdem' | 'omaha',
): TableConfig {
  return {
    maxSeats: 3,
    blinds: { smallBlind: 5, bigBlind: 10, ante: 0 },
    structure,
    variant,
  };
}

const posti = [
  { playerId: 'a', seat: 0, stack: 1_000 },
  { playerId: 'b', seat: 1, stack: 1_000 },
];

test("omaha: distribuisce quattro carte a testa", () => {
  const mano = startHand('h1', config('pot-limit', 'omaha'), posti, 0);
  for (const p of mano.players) {
    assert.equal(p.holeCards.length, 4);
  }
});

test("holdem: continua a distribuire due carte a testa", () => {
  const mano = startHand('h2', config('no-limit', 'holdem'), posti, 0);
  for (const p of mano.players) {
    assert.equal(p.holeCards.length, 2);
  }
});

test("pot limit: heads-up con bui 5/10 il tetto preflop è 30", () => {
  // Piatto 15, da chiamare 5: si chiama e si rilancia di 20.
  const mano = startHand('h3', config('pot-limit', 'omaha'), posti, 0);
  const raise = getAvailableActions(mano).find(
    (a) => a.type === ActionType.Raise,
  );
  assert.ok(raise, 'il rilancio deve essere disponibile');
  assert.equal(raise.maxAmount, 30);
});

test("no limit: nella stessa posizione il tetto resta lo stack", () => {
  const mano = startHand('h4', config('no-limit', 'holdem'), posti, 0);
  const raise = getAvailableActions(mano).find(
    (a) => a.type === ActionType.Raise,
  );
  assert.ok(raise, 'il rilancio deve essere disponibile');
  assert.equal(raise.maxAmount, 1_000);
});

test("pot limit: un rilancio oltre il tetto viene rifiutato", () => {
  const mano = startHand('h5', config('pot-limit', 'omaha'), posti, 0);
  const chi = mano.toActPlayerId!;
  assert.throws(() =>
    applyAction(mano, { type: ActionType.Raise, playerId: chi, amount: 31 }),
  );
});

test("pot limit: il rilancio esatto al tetto passa", () => {
  const mano = startHand('h6', config('pot-limit', 'omaha'), posti, 0);
  const chi = mano.toActPlayerId!;
  const dopo = applyAction(mano, {
    type: ActionType.Raise,
    playerId: chi,
    amount: 30,
  });
  assert.equal(dopo.currentBet, 30);
});
