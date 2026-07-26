/**
 * Poker Zeta — Test di mazzo e mescolata
 *
 * Un difetto qui non si manifesta come errore: si manifesta come
 * un gioco leggermente truccato che nessuno nota. Una mescolata
 * sbilanciata, una carta distribuita due volte, un mazzo di 51
 * carte — tutte cose che passano inosservate a occhio e che un
 * test cattura subito.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CryptoRandomSource,
  Deck,
  RANKS,
  SUITS,
  SeededRandomSource,
  cardFromString,
  cardToString,
  cardsFromString,
  createDeck,
  createShuffledDeck,
  shuffle,
} from '../engine/cards.js';

/** Firma ordinata di un mazzo, per confrontarne la composizione. */
function firma(cards: readonly { rank: string; suit: string }[]): string {
  return cards
    .map((c) => `${c.rank}${c.suit}`)
    .sort()
    .join(',');
}

test('mazzo: 52 carte, tutte diverse', () => {
  const deck = createDeck();

  assert.equal(deck.length, 52);
  assert.equal(new Set(deck.map(cardToString)).size, 52);
});

test('mazzo: contiene ogni combinazione di rango e seme', () => {
  const presenti = new Set(createDeck().map(cardToString));

  for (const rank of RANKS) {
    for (const suit of SUITS) {
      assert.ok(presenti.has(`${rank}${suit}`), `manca ${rank}${suit}`);
    }
  }
});

test('mazzo: il valore numerico è coerente con il rango', () => {
  for (const card of createDeck()) {
    assert.ok(card.value >= 2 && card.value <= 14, 'valore fuori scala');
    assert.equal(
      card.value,
      RANKS.indexOf(card.rank) + 2,
      `valore incoerente per ${cardToString(card)}`,
    );
  }
});

test('notazione: andata e ritorno su tutte e 52 le carte', () => {
  for (const card of createDeck()) {
    assert.deepEqual(cardFromString(cardToString(card)), card);
  }
});

test('notazione: maiuscole e minuscole sono tollerate', () => {
  assert.deepEqual(cardFromString('as'), cardFromString('As'));
  assert.deepEqual(cardFromString('TH'), cardFromString('Th'));
});

test('notazione: le stringhe non valide vengono rifiutate', () => {
  assert.throws(() => cardFromString('Xs'), /Rango/);
  assert.throws(() => cardFromString('Az'), /Seme/);
  assert.throws(() => cardFromString('A'));
  assert.throws(() => cardFromString('Ashh'));
  assert.throws(() => cardsFromString('AsK'));
});

test('notazione: una lista si legge con o senza spazi', () => {
  const conSpazi = cardsFromString('As Kh Qd');
  const senzaSpazi = cardsFromString('AsKhQd');

  assert.equal(conSpazi.length, 3);
  assert.deepEqual(conSpazi, senzaSpazi);
});

test('mescolata: conserva esattamente le stesse carte', () => {
  // Il test che conta: mescolare deve riordinare, non alterare.
  // Una carta perduta o duplicata qui è un gioco truccato.
  const originale = createDeck();

  for (let seme = 1; seme <= 20; seme += 1) {
    const mescolato = shuffle(originale, new SeededRandomSource(seme));

    assert.equal(mescolato.length, 52);
    assert.equal(
      firma(mescolato),
      firma(originale),
      `il seme ${seme} ha alterato la composizione`,
    );
  }
});

test('mescolata: non modifica il mazzo di partenza', () => {
  const originale = createDeck();
  const prima = firma(originale);

  shuffle(originale, new SeededRandomSource(7));

  assert.equal(firma(originale), prima, 'il mazzo in ingresso è stato mutato');
});

test('mescolata: cambia davvero l ordine', () => {
  const originale = createDeck();
  const mescolato = shuffle(originale, new SeededRandomSource(42));

  const uguali = mescolato.filter(
    (card, i) => cardToString(card) === cardToString(originale[i]!),
  ).length;

  // Con 52 carte le posizioni rimaste identiche per caso sono
  // pochissime. Se fossero tutte, la mescolata non sta mescolando.
  assert.ok(uguali < 10, `${uguali} carte non si sono mosse`);
});

test('mescolata: a parità di seme il risultato è identico', () => {
  // Serve ai test riproducibili: senza determinismo non si può
  // ricostruire una mano che ha prodotto un difetto.
  const a = shuffle(createDeck(), new SeededRandomSource(12_345));
  const b = shuffle(createDeck(), new SeededRandomSource(12_345));

  assert.deepEqual(a, b);
});

test('mescolata: semi diversi danno risultati diversi', () => {
  const a = shuffle(createDeck(), new SeededRandomSource(1));
  const b = shuffle(createDeck(), new SeededRandomSource(2));

  assert.notEqual(
    a.map(cardToString).join(''),
    b.map(cardToString).join(''),
  );
});

test('mescolata: il seme zero non degenera', () => {
  // Lo stato zero è un punto fisso di xorshift: se non fosse
  // gestito, il generatore restituirebbe sempre lo stesso valore.
  const mescolato = shuffle(createDeck(), new SeededRandomSource(0));

  assert.equal(firma(mescolato), firma(createDeck()));
  assert.equal(new Set(mescolato.map(cardToString)).size, 52);
});

test('casualità: la carta in cima varia fra mescolate reali', () => {
  // Controllo lasco sulla sorgente crittografica. Non misura
  // l uniformità: verifica che non ci sia un blocco evidente.
  const prime = new Set<string>();

  for (let i = 0; i < 200; i += 1) {
    prime.add(cardToString(createShuffledDeck()[0]!));
  }

  assert.ok(prime.size > 20, `solo ${prime.size} carte diverse in cima`);
});

test('casualità: nextInt rifiuta limiti non validi', () => {
  const random = new CryptoRandomSource();

  assert.throws(() => random.nextInt(0));
  assert.throws(() => random.nextInt(-1));
  assert.throws(() => random.nextInt(2.5));
  assert.equal(random.nextInt(1), 0, 'con un solo esito deve dare 0');
});

test('casualità: nextInt resta dentro l intervallo', () => {
  const random = new CryptoRandomSource();

  for (let i = 0; i < 500; i += 1) {
    const value = random.nextInt(52);
    assert.ok(value >= 0 && value < 52, `valore fuori intervallo: ${value}`);
    assert.ok(Number.isInteger(value));
  }
});

test('mazzo con stato: distribuisce 52 carte diverse e poi si ferma', () => {
  const deck = new Deck(new SeededRandomSource(99));

  assert.equal(deck.remaining, 52);

  const estratte = new Set<string>();
  for (let i = 0; i < 52; i += 1) {
    estratte.add(cardToString(deck.draw()));
  }

  assert.equal(estratte.size, 52, 'una carta è stata distribuita due volte');
  assert.equal(deck.remaining, 0);
  assert.throws(() => deck.draw(), /esaurito/);
});

test('mazzo con stato: drawMany e burn consumano il conto giusto', () => {
  const deck = new Deck(new SeededRandomSource(5));

  const cinque = deck.drawMany(5);
  assert.equal(cinque.length, 5);
  assert.equal(deck.remaining, 47);

  deck.burn();
  assert.equal(deck.remaining, 46, 'la burn card non è stata consumata');

  assert.equal(deck.drawMany(0).length, 0);
  assert.throws(() => deck.drawMany(-1));
  assert.throws(() => deck.drawMany(100), /insufficienti/);
});
