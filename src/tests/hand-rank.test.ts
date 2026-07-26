/**
 * Poker Zeta — Test della valutazione delle mani
 *
 * Questo è il codice che stabilisce chi vince. Non produce importi
 * come pot.ts, ma decide a chi vanno: un difetto qui paga la
 * persona sbagliata, che è lo stesso danno per vie diverse.
 *
 * I casi limite che contano davvero sono tre, e hanno ciascuno il
 * proprio test: la ruota A-2-3-4-5 che vale cinque e non asso, la
 * scala e il colore separati che NON fanno scala colore, e la
 * selezione delle migliori cinque carte su sette.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CATEGORY_NAMES,
  HandCategory,
  compareHands,
  evaluateHand,
  findWinners,
  handsAreEqual,
  rankPlayers,
} from '../engine/hand-rank.js';

import { hand } from './helpers.js';

/** Valuta una mano dalla notazione compatta. */
function valuta(notazione: string) {
  return evaluateHand(hand(notazione));
}

/* ── Riconoscimento delle categorie ───────────────────────── */

test('mani: ogni categoria viene riconosciuta', () => {
  const casi: readonly [string, HandCategory][] = [
    ['As Ks Qs Js Ts', HandCategory.RoyalFlush],
    ['9s 8s 7s 6s 5s', HandCategory.StraightFlush],
    ['As Ah Ad Ac Kh', HandCategory.FourOfAKind],
    ['As Ah Ad Ks Kh', HandCategory.FullHouse],
    ['As Ks Qs Js 9s', HandCategory.Flush],
    ['As Kh Qd Jc Th', HandCategory.Straight],
    ['As Ah Ad Ks Qh', HandCategory.ThreeOfAKind],
    ['As Ah Ks Kh Qd', HandCategory.TwoPair],
    ['As Ah Ks Qh Jd', HandCategory.Pair],
    ['As Kh Qd Jc 9h', HandCategory.HighCard],
  ];

  for (const [notazione, attesa] of casi) {
    assert.equal(
      valuta(notazione).category,
      attesa,
      `${notazione} valutata ${CATEGORY_NAMES[valuta(notazione).category]}`,
    );
  }
});

test('mani: ogni categoria ha un nome', () => {
  // Se un giorno si aggiunge una categoria senza etichetta,
  // l interfaccia mostrerebbe undefined.
  for (const value of Object.values(HandCategory)) {
    if (typeof value === 'number') {
      assert.ok(
        CATEGORY_NAMES[value as HandCategory],
        `categoria ${value} senza nome`,
      );
    }
  }
});

/* ── La ruota ─────────────────────────────────────────────── */

test('ruota: A-2-3-4-5 è una scala al Cinque, non all Asso', () => {
  // L errore più comune nelle implementazioni ingenue: l asso vale
  // 14 nella scala dei ranghi, ma qui fa da 1 e la mano è 5-high.
  const mano = valuta('Ah 2d 3c 4s 5h');

  assert.equal(mano.category, HandCategory.Straight);
  assert.equal(mano.strength[1], 5, 'la ruota è stata valutata come A-high');
  assert.ok(
    mano.description.includes('Cinque'),
    `descrizione inattesa: ${mano.description}`,
  );
});

test('ruota: perde contro qualunque scala più alta', () => {
  const ruota = valuta('Ah 2d 3c 4s 5h');
  const seiAlto = valuta('2h 3d 4c 5s 6h');

  assert.ok(compareHands(seiAlto, ruota) > 0, 'la ruota batte la scala al Sei');
});

test('ruota: dello stesso seme è scala colore, non scala reale', () => {
  const mano = valuta('Ah 2h 3h 4h 5h');

  assert.equal(mano.category, HandCategory.StraightFlush);
  assert.equal(mano.strength[1], 5);
});

test('ruota: riconosciuta anche fra sette carte con carte alte', () => {
  // Asso, Re e Donna presenti: la tentazione è valutare A-high.
  const mano = valuta('Ah 2d 3c 4s 5h Kd Qc');

  assert.equal(mano.category, HandCategory.Straight);
  assert.equal(mano.strength[1], 5);
});

/* ── Scala e colore separati ──────────────────────────────── */

test('scala colore: serve la scala DENTRO il colore', () => {
  // Cinque picche (colore) e una scala A-K-Q-J-T che usa semi
  // diversi. Non è scala colore: è colore.
  const mano = valuta('As Ks Qs 9s 2s Jh Td');

  assert.equal(mano.category, HandCategory.Flush);
});

/* ── Migliori cinque su sette ─────────────────────────────── */

test('sette carte: i kicker sono i tre più alti fra i restanti', () => {
  const mano = valuta('As Ah Kd Qc Jh 9s 3d');

  assert.equal(mano.category, HandCategory.Pair);
  assert.deepEqual(
    [...mano.strength],
    [HandCategory.Pair, 14, 13, 12, 11],
    'kicker scelti male',
  );
  assert.equal(mano.cards.length, 5);
});

test('sette carte: con tre coppie contano le due più alte', () => {
  const mano = valuta('As Ah Ks Kh Qd Qc 2s');

  assert.equal(mano.category, HandCategory.TwoPair);
  assert.deepEqual([...mano.strength], [HandCategory.TwoPair, 14, 13, 12]);
});

test('sette carte: due tris formano un full, non un doppio tris', () => {
  const mano = valuta('As Ah Ad Ks Kh Kd 2c');

  assert.equal(mano.category, HandCategory.FullHouse);
  assert.deepEqual(
    [...mano.strength],
    [HandCategory.FullHouse, 14, 13],
    'il full deve usare il tris più alto',
  );
});

test('sette carte: il colore prende le cinque più alte del seme', () => {
  const mano = valuta('As Ks Qs Js 9s 2s 3h');

  assert.equal(mano.category, HandCategory.Flush);
  assert.deepEqual(
    [...mano.strength],
    [HandCategory.Flush, 14, 13, 12, 11, 9],
    'il 2 di picche non doveva entrare',
  );
});

test('sette carte: la mano restituita è sempre di cinque carte', () => {
  const notazioni = [
    'As Ks Qs Js Ts 2d 3c',
    'As Ah Ad Ac Kh Qd Jc',
    'As Ah Ks Kh Qd Qc 2s',
    '9h 8d 7c 6s 5h 2d 3c',
    '2h 4d 6c 8s Th Qd Ac',
  ];

  for (const notazione of notazioni) {
    assert.equal(valuta(notazione).cards.length, 5, notazione);
  }
});

/* ── Confronti ────────────────────────────────────────────── */

test('confronto: il kicker decide fra due coppie uguali', () => {
  // L esempio scritto in testa a hand-rank.ts.
  const a = valuta('Ks Kh 9d 5c 2h');
  const b = valuta('Kd Kc 9s 6h 2d');

  assert.ok(compareHands(b, a) > 0, 'il 6 deve battere il 5');
  assert.ok(compareHands(a, b) < 0);
});

test('confronto: le categorie sono ordinate correttamente', () => {
  const dalPeggiore = [
    'As Kh Qd Jc 9h',
    'As Ah Ks Qh Jd',
    'As Ah Ks Kh Qd',
    'As Ah Ad Ks Qh',
    'As Kh Qd Jc Th',
    'As Ks Qs Js 9s',
    'As Ah Ad Ks Kh',
    'As Ah Ad Ac Kh',
    '9s 8s 7s 6s 5s',
    'As Ks Qs Js Ts',
  ].map(valuta);

  for (let i = 1; i < dalPeggiore.length; i += 1) {
    assert.ok(
      compareHands(dalPeggiore[i]!, dalPeggiore[i - 1]!) > 0,
      `${dalPeggiore[i]!.description} non batte ${dalPeggiore[i - 1]!.description}`,
    );
  }
});

test('confronto: mani equivalenti di semi diversi sono pari', () => {
  // Il colore non ha gerarchia di semi: due colori identici in
  // valore dividono il piatto.
  const picche = valuta('As Ks Qs Js 9s');
  const cuori = valuta('Ah Kh Qh Jh 9h');

  assert.equal(compareHands(picche, cuori), 0);
  assert.ok(handsAreEqual(picche, cuori));
});

/* ── Classifica ───────────────────────────────────────────── */

test('classifica: la parità condivide la posizione', () => {
  const ranked = rankPlayers([
    { playerId: 'A', cards: hand('As Ks Qs Js Ts 2d 3c') },
    { playerId: 'B', cards: hand('Ah Kh Qh Jh Th 4d 5c') },
    { playerId: 'C', cards: hand('2h 2d 7c 9h Jd 4c 6s') },
  ]);

  const posizione = (id: string): number =>
    ranked.find((r) => r.playerId === id)!.position;

  assert.equal(posizione('A'), 1);
  assert.equal(posizione('B'), 1, 'due scale reali devono essere pari');
  assert.equal(posizione('C'), 3, 'dopo due primi si passa al terzo posto');
});

test('classifica: i vincitori sono tutti quelli in posizione uno', () => {
  const ranked = rankPlayers([
    { playerId: 'A', cards: hand('As Ks Qs Js Ts 2d 3c') },
    { playerId: 'B', cards: hand('Ah Kh Qh Jh Th 4d 5c') },
    { playerId: 'C', cards: hand('2h 2d 7c 9h Jd 4c 6s') },
  ]);

  const vincitori = findWinners(ranked).map((r) => r.playerId).sort();

  assert.deepEqual(vincitori, ['A', 'B']);
});

test('classifica: un solo giocatore è primo senza pari', () => {
  const ranked = rankPlayers([
    { playerId: 'A', cards: hand('2h 2d 7c 9h Jd 4c 6s') },
    { playerId: 'B', cards: hand('As Ks Qs Js Ts 2s 3c') },
  ]);

  assert.equal(findWinners(ranked).length, 1);
  assert.equal(findWinners(ranked)[0]!.playerId, 'B');
});

/* ── Stati non validi ─────────────────────────────────────── */

test('valutazione: meno di cinque carte viene rifiutata', () => {
  assert.throws(() => valuta('As Ks Qs Js'), /almeno 5/);
});

test('valutazione: una carta duplicata viene rifiutata', () => {
  // Un duplicato significa che la distribuzione ha un difetto:
  // va fermata, non interpretata.
  assert.throws(() => valuta('As As Ks Qs Js'), /duplicata/);
  assert.throws(() => valuta('As Ks Qs Js Ts 2d As'), /duplicata/);
});
