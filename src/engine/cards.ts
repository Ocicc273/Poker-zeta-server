/**
 * Poker Zeta — Carte e mazzo
 * Riferimento: SDD Server Authoritative, ZB-001 modalità ufficiali
 *
 * Rappresentazione delle carte e generazione del mazzo.
 *
 * VINCOLO DI SICUREZZA: lo shuffle usa crypto.getRandomValues, non
 * Math.random. Math.random è prevedibile e in un gioco di carte con
 * valore economico costituisce una vulnerabilità: conoscendo alcuni
 * output un attaccante può predire lo stato del generatore.
 *
 * Questo modulo è puro: nessuna dipendenza da React, DOM o rete.
 * Girerà identico nel Match Server Node e nei test.
 */

/* ────────────────────────────────────────────────────────────
   TIPI
   ──────────────────────────────────────────────────────────── */

/** Semi. Ordine convenzionale usato solo per la serializzazione. */
export const SUITS = ['c', 'd', 'h', 's'] as const;
export type Suit = (typeof SUITS)[number];

/**
 * Ranghi in ordine crescente di forza.
 * L'asso vale 14 in questa scala; il caso A-2-3-4-5 (ruota) è
 * gestito esplicitamente nella valutazione delle scale.
 */
export const RANKS = [
  '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A',
] as const;
export type Rank = (typeof RANKS)[number];

/** Valore numerico di un rango. 2 → 2, T → 10, A → 14. */
export type RankValue = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface Card {
  rank: Rank;
  suit: Suit;
  /** Valore numerico, precalcolato: evita lookup ripetuti in valutazione. */
  value: RankValue;
}

/** Nomi leggibili dei semi, per l'interfaccia. */
export const SUIT_NAMES: Record<Suit, string> = {
  c: 'Fiori',
  d: 'Quadri',
  h: 'Cuori',
  s: 'Picche',
};

/** Simboli dei semi. */
export const SUIT_SYMBOLS: Record<Suit, string> = {
  c: '♣',
  d: '♦',
  h: '♥',
  s: '♠',
};

/** Semi rossi: serve alla UI per la colorazione. */
export const RED_SUITS: readonly Suit[] = ['d', 'h'];

/* ────────────────────────────────────────────────────────────
   COSTRUZIONE
   ──────────────────────────────────────────────────────────── */

/** Mappa rango → valore numerico. */
const RANK_VALUES: Record<Rank, RankValue> = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

/** Crea una carta. */
export function createCard(rank: Rank, suit: Suit): Card {
  return { rank, suit, value: RANK_VALUES[rank] };
}

/**
 * Notazione compatta di una carta: "As", "Th", "2c".
 * Formato usato per log, replay e serializzazione di rete:
 * due caratteri invece di un oggetto JSON.
 */
export function cardToString(card: Card): string {
  return `${card.rank}${card.suit}`;
}

/**
 * Interpreta la notazione compatta.
 * @throws Se la stringa non è una carta valida.
 */
export function cardFromString(notation: string): Card {
  if (notation.length !== 2) {
    throw new Error(`Notazione carta non valida: "${notation}"`);
  }

  const rank = notation[0]!.toUpperCase() as Rank;
  const suit = notation[1]!.toLowerCase() as Suit;

  if (!RANKS.includes(rank)) {
    throw new Error(`Rango non valido: "${rank}"`);
  }
  if (!SUITS.includes(suit)) {
    throw new Error(`Seme non valido: "${suit}"`);
  }

  return createCard(rank, suit);
}

/** Interpreta una lista di carte: "As Kh Qd" o "AsKhQd". */
export function cardsFromString(notation: string): Card[] {
  const compact = notation.replace(/\s+/g, '');

  if (compact.length % 2 !== 0) {
    throw new Error(`Lista carte malformata: "${notation}"`);
  }

  const cards: Card[] = [];
  for (let i = 0; i < compact.length; i += 2) {
    cards.push(cardFromString(compact.slice(i, i + 2)));
  }
  return cards;
}

/** Mazzo completo di 52 carte, in ordine canonico non mescolato. */
export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(createCard(rank, suit));
    }
  }
  return deck;
}

/* ────────────────────────────────────────────────────────────
   CASUALITÀ CRITTOGRAFICA
   ──────────────────────────────────────────────────────────── */

/**
 * Sorgente di casualità. Astratta come interfaccia per due ragioni:
 * consente l'iniezione di un generatore deterministico nei test, e
 * permette di sostituire l'implementazione con un RNG certificato
 * quando il progetto richiederà la licenza di gioco.
 */
export interface RandomSource {
  /** Intero uniforme in [0, maxExclusive). */
  nextInt(maxExclusive: number): number;
}

/**
 * Generatore crittografico basato su Web Crypto.
 * Disponibile sia in Node 19+ che nei browser moderni.
 */
export class CryptoRandomSource implements RandomSource {
  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`Limite non valido: ${maxExclusive}`);
    }

    // Rejection sampling: scartare i valori nella coda non uniforme
    // elimina il modulo bias. Con un intervallo piccolo come 52 la
    // probabilità di scarto è trascurabile.
    const range = 2 ** 32;
    const limit = range - (range % maxExclusive);

    const buffer = new Uint32Array(1);
    let value: number;

    do {
      crypto.getRandomValues(buffer);
      value = buffer[0]!;
    } while (value >= limit);

    return value % maxExclusive;
  }
}

/**
 * Generatore deterministico per i test (xorshift32).
 * NON usare in produzione: è prevedibile per definizione.
 */
export class SeededRandomSource implements RandomSource {
  private state: number;

  constructor(seed: number) {
    // Lo stato zero è un punto fisso di xorshift: va evitato.
    this.state = seed === 0 ? 0x9e3779b9 : seed >>> 0;
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`Limite non valido: ${maxExclusive}`);
    }

    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;

    return this.state % maxExclusive;
  }
}

/* ────────────────────────────────────────────────────────────
   SHUFFLE
   ──────────────────────────────────────────────────────────── */

/**
 * Mescola un mazzo con Fisher-Yates.
 *
 * Fisher-Yates produce ognuna delle 52! permutazioni con la stessa
 * probabilità, a condizione che la sorgente sia uniforme. Varianti
 * scorrette dell'algoritmo (indice casuale su tutto l'array anziché
 * sulla porzione non ancora mescolata) introducono bias: qui l'indice
 * è estratto in [0, i] come richiede l'algoritmo corretto.
 *
 * Restituisce un nuovo array: il mazzo in ingresso non è modificato.
 */
export function shuffle(
  cards: readonly Card[],
  random: RandomSource = new CryptoRandomSource()
): Card[] {
  const result = [...cards];

  for (let i = result.length - 1; i > 0; i--) {
    const j = random.nextInt(i + 1);
    const temp = result[i]!;
    result[i] = result[j]!;
    result[j] = temp;
  }

  return result;
}

/** Mazzo mescolato, pronto per la distribuzione. */
export function createShuffledDeck(random?: RandomSource): Card[] {
  return shuffle(createDeck(), random);
}

/* ────────────────────────────────────────────────────────────
   DISTRIBUZIONE
   ──────────────────────────────────────────────────────────── */

/**
 * Mazzo con stato di distribuzione.
 *
 * Incapsula la posizione corrente invece di mutare l'array: impedisce
 * che una carta venga distribuita due volte per errore, e rende
 * verificabile quante carte restano.
 */
export class Deck {
  private readonly cards: readonly Card[];
  private position = 0;

  constructor(random?: RandomSource) {
    this.cards = createShuffledDeck(random);
  }

  /** Carte non ancora distribuite. */
  get remaining(): number {
    return this.cards.length - this.position;
  }

  /**
   * Estrae la carta successiva.
   * @throws Se il mazzo è esaurito: indica un bug nella logica di
   *         gioco, non una condizione da gestire silenziosamente.
   */
  draw(): Card {
    if (this.position >= this.cards.length) {
      throw new Error('Mazzo esaurito: distribuzione non valida.');
    }
    return this.cards[this.position++]!;
  }

  /** Estrae n carte. */
  drawMany(count: number): Card[] {
    if (count < 0) {
      throw new Error(`Numero di carte non valido: ${count}`);
    }
    if (count > this.remaining) {
      throw new Error(
        `Carte insufficienti: richieste ${count}, disponibili ${this.remaining}.`
      );
    }

    const drawn: Card[] = [];
    for (let i = 0; i < count; i++) {
      drawn.push(this.draw());
    }
    return drawn;
  }

  /**
   * Scarta una carta senza distribuirla (burn card).
   * Usata prima di flop, turn e river secondo la procedura standard
   * dei tavoli fisici, mantenuta per fedeltà e verificabilità.
   */
  burn(): Card {
    return this.draw();
  }
}
