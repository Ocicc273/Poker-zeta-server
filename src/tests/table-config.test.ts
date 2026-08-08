/**
 * Poker Zeta — Test della configurazione del tavolo
 * Riferimento: ECON-001 §5
 *
 * Il buy-in arriva dal client e non è affidabile. Questi test
 * verificano che nessun valore inventato produca un tavolo assurdo,
 * e che i bui appartengano sempre a un livello della scala invece
 * di essere calcolati su misura.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_BUY_IN,
  MIN_BUY_IN,
  deriveTableConfig,
  sanitizeBuyIn,
} from '../game/table-config.js';

import {
  HOLDEM_STAKES,
  resolveStakeLevel,
  stakeLevelByNumber,
} from '../game/stakes.js';

/* ── La scala ─────────────────────────────────────────────── */

test('scala: i livelli sono progressivi e coerenti', () => {
  let precedente = 0;

  for (const stake of HOLDEM_STAKES) {
    assert.ok(stake.bigBlind > precedente, 'bui non crescenti');
    assert.equal(stake.smallBlind * 2, stake.bigBlind, 'small blind non è metà');
    assert.ok(stake.minBuyIn < stake.maxBuyIn, 'intervallo invertito');
    precedente = stake.bigBlind;
  }
});

test('scala: ogni livello rispetta i 20-100 big blind', () => {
  // È la regola generale di ECON-001: sotto i 20 big blind un
  // tavolo non è giocabile, sopra i 100 non è più cash game.
  for (const stake of HOLDEM_STAKES) {
    assert.equal(
      stake.minBuyIn / stake.bigBlind,
      20,
      `livello ${stake.level}: il minimo non è 20 big blind`,
    );
    assert.equal(
      stake.maxBuyIn / stake.bigBlind,
      100,
      `livello ${stake.level}: il massimo non è 100 big blind`,
    );
  }
});

test('scala: i livelli si trovano per numero', () => {
  assert.equal(stakeLevelByNumber(1)?.bigBlind, 100);
  assert.equal(stakeLevelByNumber(7)?.bigBlind, 1_000_000);
  assert.equal(stakeLevelByNumber(99), undefined);
});

/* ── Risoluzione del livello ──────────────────────────────── */

test('livello: un buy-in tipico finisce dove deve', () => {
  assert.equal(resolveStakeLevel(5_000).bigBlind, 100);
  assert.equal(resolveStakeLevel(20_000).bigBlind, 500);
  assert.equal(resolveStakeLevel(100_000).bigBlind, 2_000);
  assert.equal(resolveStakeLevel(500_000).bigBlind, 10_000);
  assert.equal(resolveStakeLevel(3_000_000).bigBlind, 50_000);
});

test('livello: nella sovrapposizione vince la maggiore profondità', () => {
  // 40.000 sta sia nel livello 2 (80 big blind) sia nel 3 (20 big
  // blind). Chi porta quella cifra vuole lo stack profondo.
  assert.equal(resolveStakeLevel(40_000).level, 2);
  assert.equal(resolveStakeLevel(50_000).level, 2);
  assert.equal(resolveStakeLevel(50_001).level, 3);
});

test('livello: oltre la scala si resta al livello più alto', () => {
  assert.equal(resolveStakeLevel(999_999_999).level, 7);
});

/* ── Normalizzazione del buy-in ───────────────────────────── */

test('buy-in: un valore negativo viene riportato al minimo', () => {
  assert.equal(sanitizeBuyIn(-5_000), MIN_BUY_IN);
  assert.equal(MIN_BUY_IN, 2_000);
});

test('buy-in: un valore enorme viene riportato al massimo', () => {
  assert.equal(sanitizeBuyIn(999_999_999), MAX_BUY_IN);
  assert.equal(MAX_BUY_IN, 100_000_000);
});


test('buy-in: valori non numerici ricadono sul minimo', () => {
  assert.equal(sanitizeBuyIn('mille'), MIN_BUY_IN);
  assert.equal(sanitizeBuyIn(undefined), MIN_BUY_IN);
  assert.equal(sanitizeBuyIn(null), MIN_BUY_IN);
  assert.equal(sanitizeBuyIn(Number.NaN), MIN_BUY_IN);
  // Infinity non è finito: come qualunque valore non valido ricade
  // sul minimo. Meglio concedere poco che regalare il massimo.
  assert.equal(sanitizeBuyIn(Number.POSITIVE_INFINITY), MIN_BUY_IN);
});

test('buy-in: un valore valido resta intero e invariato', () => {
  assert.equal(sanitizeBuyIn(15_000), 15_000);
  assert.equal(sanitizeBuyIn(15_000.7), 15_000);
});

test('buy-in: viene vincolato all intervallo del proprio livello', () => {
  const normalizzato = sanitizeBuyIn(2_500);
  const livello = resolveStakeLevel(normalizzato);

  assert.ok(normalizzato >= livello.minBuyIn);
  assert.ok(normalizzato <= livello.maxBuyIn);
});

test('buy-in: normalizzare due volte non cambia il risultato', () => {
  for (const raw of [-1, 0, 1_999, 2_000, 7_430, 40_000, 500_000, 9_000_000]) {
    const una = sanitizeBuyIn(raw);
    assert.equal(sanitizeBuyIn(una), una, `instabile su ${raw}`);
  }
});

/* ── Configurazione del tavolo ────────────────────────────── */

test('tavolo: i bui vengono dal livello, non dal buy-in', () => {
  const basso = deriveTableConfig(12_000);
  const alto = deriveTableConfig(48_000);

  assert.equal(basso.config.blinds.bigBlind, alto.config.blinds.bigBlind);
  assert.equal(basso.config.blinds.bigBlind, 500);
  assert.notEqual(basso.startingStack, alto.startingStack);
});

test('tavolo: i bui sono interi positivi e coerenti', () => {
  for (const buyIn of [2_000, 10_000, 50_000, 200_000, 100_000_000]) {
    const { config } = deriveTableConfig(buyIn);
    const { smallBlind, bigBlind } = config.blinds;

    assert.ok(Number.isInteger(smallBlind));
    assert.ok(Number.isInteger(bigBlind));
    assert.ok(smallBlind >= 1);
    assert.ok(bigBlind > smallBlind);
  }
});

test('tavolo: lo stack vale sempre fra 20 e 100 big blind', () => {
  for (const buyIn of [2_000, 3_500, 10_000, 40_000, 170_000, 4_000_000]) {
    const { config, startingStack } = deriveTableConfig(buyIn);
    const bb = config.blinds.bigBlind;

    assert.ok(startingStack >= bb * 20, `${buyIn}: meno di 20 big blind`);
    assert.ok(startingStack <= bb * 100, `${buyIn}: più di 100 big blind`);
  }
});

test('tavolo: il livello viene restituito insieme alla configurazione', () => {
  assert.equal(deriveTableConfig(20_000).stake.level, 2);
});

test('tavolo: i posti sono tre', () => {
  assert.equal(deriveTableConfig(10_000).config.maxSeats, 3);
});

// Minimi d'ingresso REALI: sotto queste cifre la
// risoluzione ricade sul livello precedente. La
// schermata Play del client li ha duplicati, quindi
// se cambiano qui va cambiato anche lì.
const ENTRY_MINS = [
  2_000, 10_001, 50_001, 200_001, 1_000_001, 5_000_001, 20_000_001,
];

test("ogni minimo d'ingresso risolve il suo livello", () => {
  ENTRY_MINS.forEach((buyIn, index) => {
    assert.equal(resolveStakeLevel(buyIn).level, index + 1);
  });
});

test("il minimo nominale ricade sul livello sotto", () => {
  HOLDEM_STAKES.slice(1).forEach((level, index) => {
    assert.equal(
      resolveStakeLevel(level.minBuyIn).level,
      index + 1
    );
  });
});
