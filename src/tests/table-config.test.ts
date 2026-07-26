/**
 * Poker Zeta — Test della configurazione del tavolo
 *
 * Il buy-in arriva dal client, quindi non è affidabile. Questi
 * test verificano che nessun valore inventato riesca a produrre un
 * tavolo assurdo.
 *
 * NOTA: da riscrivere quando arriverà la scala dei bui prefissati
 * (decisione D-015). Oggi i bui sono ancora derivati dal buy-in.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveTableConfig, sanitizeBuyIn } from '../game/table-config.js';

test('buy-in: un valore negativo viene riportato al minimo', () => {
  assert.equal(sanitizeBuyIn(-5_000), 100);
});

test('buy-in: un valore enorme viene riportato al massimo', () => {
  assert.equal(sanitizeBuyIn(9_999_999), 50_000);
});

test('buy-in: valori non numerici ricadono sul minimo', () => {
  assert.equal(sanitizeBuyIn('mille'), 100);
  assert.equal(sanitizeBuyIn(undefined), 100);
  assert.equal(sanitizeBuyIn(null), 100);
  assert.equal(sanitizeBuyIn(Number.NaN), 100);
  // Infinity non è un numero finito: ricade sul minimo, come
  // qualunque altro valore non valido. Meglio concedere poco che
  // regalare il massimo a chi manda spazzatura.
  assert.equal(sanitizeBuyIn(Number.POSITIVE_INFINITY), 100);
});

test('buy-in: un valore valido resta intero e invariato', () => {
  assert.equal(sanitizeBuyIn(1_500), 1_500);
  assert.equal(sanitizeBuyIn(1_500.7), 1_500);
});

test('buy-in: normalizzare due volte non cambia il risultato', () => {
  // Il manager normalizza prima di addebitare e la stanza
  // normalizza di nuovo: se le due divergessero, il giocatore
  // pagherebbe una cifra e ne riceverebbe un'altra.
  for (const raw of [-1, 0, 100, 743, 50_000, 80_000]) {
    const una = sanitizeBuyIn(raw);
    assert.equal(sanitizeBuyIn(una), una);
  }
});

test('tavolo: i bui sono interi positivi e coerenti fra loro', () => {
  for (const buyIn of [100, 500, 1_000, 5_000, 50_000]) {
    const { config, startingStack } = deriveTableConfig(buyIn);
    const { smallBlind, bigBlind } = config.blinds;

    assert.ok(Number.isInteger(smallBlind), 'small blind non intero');
    assert.ok(Number.isInteger(bigBlind), 'big blind non intero');
    assert.ok(smallBlind >= 1, 'small blind sotto 1');
    assert.ok(bigBlind > smallBlind, 'big blind non maggiore dello small');
    assert.equal(startingStack, buyIn, 'lo stack non corrisponde al buy-in');
  }
});

test('tavolo: lo stack copre almeno una decina di big blind', () => {
  // Un tavolo dove si entra con tre big blind non è giocabile.
  for (const buyIn of [100, 500, 5_000, 50_000]) {
    const { config, startingStack } = deriveTableConfig(buyIn);
    assert.ok(
      startingStack >= config.blinds.bigBlind * 10,
      `con buy-in ${buyIn} lo stack vale meno di 10 big blind`,
    );
  }
});
