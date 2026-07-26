/**
 * Poker Zeta — Valutazione delle mani
 * Riferimento: SDD Server Authoritative
 *
 * Determina la forza di una mano di poker e permette di confrontare
 * due mani per stabilire vincitore o parità.
 *
 * ARCHITETTURA DELLA VALUTAZIONE
 * Ogni mano è ridotta a una tupla numerica confrontabile
 * lessicograficamente: [categoria, tiebreak1, tiebreak2, ...].
 * Questo evita decine di casi speciali nel confronto: due mani si
 * comparano scorrendo le tuple, e la prima differenza decide.
 *
 * Esempio: coppia di Re con K-K-9-5-2 →
 *   [2 (coppia), 13 (re), 9, 5, 2]
 * Coppia di Re con K-K-9-6-2 →
 *   [2, 13, 9, 6, 2]
 * La quarta posizione decide: 6 batte 5.
 *
 * Il modulo è puro e sincrono: nessun I/O, nessuno stato globale.
 */

import type { Card, RankValue } from './cards';

/* ────────────────────────────────────────────────────────────
   CATEGORIE
   ──────────────────────────────────────────────────────────── */

/**
 * Categorie di mano in ordine crescente di forza.
 * I valori numerici sono la prima componente della tupla di forza.
 */
export enum HandCategory {
  HighCard = 1,
  Pair = 2,
  TwoPair = 3,
  ThreeOfAKind = 4,
  Straight = 5,
  Flush = 6,
  FullHouse = 7,
  FourOfAKind = 8,
  StraightFlush = 9,
  RoyalFlush = 10,
}

/** Nomi italiani delle categorie, per l'interfaccia. */
export const CATEGORY_NAMES: Record<HandCategory, string> = {
  [HandCategory.HighCard]: 'Carta alta',
  [HandCategory.Pair]: 'Coppia',
  [HandCategory.TwoPair]: 'Doppia coppia',
  [HandCategory.ThreeOfAKind]: 'Tris',
  [HandCategory.Straight]: 'Scala',
  [HandCategory.Flush]: 'Colore',
  [HandCategory.FullHouse]: 'Full',
  [HandCategory.FourOfAKind]: 'Poker',
  [HandCategory.StraightFlush]: 'Scala colore',
  [HandCategory.RoyalFlush]: 'Scala reale',
};

/** Risultato della valutazione di una mano. */
export interface HandRank {
  category: HandCategory;
  /**
   * Tupla di forza completa: [categoria, ...tiebreak].
   * Confrontabile lessicograficamente con un'altra tupla.
   */
  strength: readonly number[];
  /** Le esatte 5 carte che compongono la mano migliore. */
  cards: readonly Card[];
  /** Descrizione leggibile: "Full di Re su 9". */
  description: string;
}

/* ────────────────────────────────────────────────────────────
   UTILITÀ INTERNE
   ──────────────────────────────────────────────────────────── */

/** Nome singolare di un rango, per le descrizioni. */
const RANK_LABELS: Record<RankValue, string> = {
  2: 'Due',
  3: 'Tre',
  4: 'Quattro',
  5: 'Cinque',
  6: 'Sei',
  7: 'Sette',
  8: 'Otto',
  9: 'Nove',
  10: 'Dieci',
  11: 'Jack',
  12: 'Donna',
  13: 'Re',
  14: 'Asso',
};

/** Nome plurale, per coppie e tris. */
const RANK_LABELS_PLURAL: Record<RankValue, string> = {
  2: 'Due',
  3: 'Tre',
  4: 'Quattro',
  5: 'Cinque',
  6: 'Sei',
  7: 'Sette',
  8: 'Otto',
  9: 'Nove',
  10: 'Dieci',
  11: 'Jack',
  12: 'Donne',
  13: 'Re',
  14: 'Assi',
};

/** Raggruppa le carte per valore, ordinando per frequenza poi per valore. */
interface RankGroup {
  value: RankValue;
  count: number;
  cards: Card[];
}

function groupByRank(cards: readonly Card[]): RankGroup[] {
  const groups = new Map<RankValue, RankGroup>();

  for (const card of cards) {
    const existing = groups.get(card.value);
    if (existing) {
      existing.count++;
      existing.cards.push(card);
    } else {
      groups.set(card.value, { value: card.value, count: 1, cards: [card] });
    }
  }

  // Ordine: prima le frequenze alte (poker > tris > coppia), a pari
  // frequenza il valore più alto. Così il primo gruppo è sempre il
  // più significativo per la categoria.
  return [...groups.values()].sort(
    (a, b) => b.count - a.count || b.value - a.value
  );
}

/** Raggruppa per seme. Serve a individuare il colore. */
function groupBySuit(cards: readonly Card[]): Map<string, Card[]> {
  const groups = new Map<string, Card[]>();

  for (const card of cards) {
    const existing = groups.get(card.suit);
    if (existing) {
      existing.push(card);
    } else {
      groups.set(card.suit, [card]);
    }
  }

  return groups;
}

/**
 * Individua la scala più alta in un insieme di carte.
 *
 * Gestisce la ruota (A-2-3-4-5): l'asso vale 14 nella scala dei
 * ranghi, ma in questa scala funge da 1 e la mano vale 5-high, non
 * A-high. È l'errore più comune nelle implementazioni ingenue.
 *
 * @returns Il valore della carta più alta della scala, o null.
 */
function findStraightHigh(cards: readonly Card[]): RankValue | null {
  const present = new Set<number>(cards.map((card) => card.value));

  // L'asso partecipa anche come 1 per la ruota.
  if (present.has(14)) {
    present.add(1);
  }

  // Si cerca dall'alto: la prima scala trovata è la migliore.
  for (let high = 14; high >= 5; high--) {
    let complete = true;
    for (let offset = 0; offset < 5; offset++) {
      if (!present.has(high - offset)) {
        complete = false;
        break;
      }
    }
    if (complete) {
      return high as RankValue;
    }
  }

  return null;
}

/** Estrae le 5 carte che formano la scala con la data carta alta. */
function extractStraightCards(
  cards: readonly Card[],
  high: RankValue
): Card[] {
  const needed: number[] = [];
  for (let offset = 0; offset < 5; offset++) {
    needed.push(high - offset);
  }

  const selected: Card[] = [];

  for (const target of needed) {
    // Il 1 della ruota corrisponde all'asso.
    const lookFor = target === 1 ? 14 : target;
    const match = cards.find(
      (card) => card.value === lookFor && !selected.includes(card)
    );
    if (match) {
      selected.push(match);
    }
  }

  return selected;
}

/** Ordina le carte per valore decrescente. */
function sortByValueDesc(cards: readonly Card[]): Card[] {
  return [...cards].sort((a, b) => b.value - a.value);
}

/* ────────────────────────────────────────────────────────────
   VALUTAZIONE
   ──────────────────────────────────────────────────────────── */

/**
 * Valuta la migliore mano di 5 carte ottenibile dalle carte fornite.
 *
 * Accetta da 5 a 7 carte: 5 per una mano chiusa, 7 per Texas Hold'em
 * (2 personali + 5 comuni), 6 per stati intermedi.
 *
 * Per Omaha la selezione è vincolata (esattamente 2 personali + 3
 * comuni) e va gestita dal chiamante, generando le combinazioni
 * valide e valutandole singolarmente.
 *
 * @throws Se le carte sono meno di 5 o contengono duplicati.
 */
export function evaluateHand(cards: readonly Card[]): HandRank {
  if (cards.length < 5) {
    throw new Error(
      `Valutazione impossibile: servono almeno 5 carte, ricevute ${cards.length}.`
    );
  }

  // Un duplicato indica un bug nella distribuzione: va rilevato subito,
  // non propagato in un risultato silenziosamente sbagliato.
  const seen = new Set<string>();
  for (const card of cards) {
    const key = `${card.rank}${card.suit}`;
    if (seen.has(key)) {
      throw new Error(`Carta duplicata nella valutazione: ${key}`);
    }
    seen.add(key);
  }

  const rankGroups = groupByRank(cards);
  const suitGroups = groupBySuit(cards);

  // Colore: cinque o più carte dello stesso seme.
  const flushCards = [...suitGroups.values()].find((group) => group.length >= 5);

  /* ── Scala colore e scala reale ────────────────────────────
     Va cercata la scala DENTRO le carte del colore, non fra tutte:
     avere una scala e un colore separati non produce scala colore. */
  if (flushCards) {
    const straightFlushHigh = findStraightHigh(flushCards);

    if (straightFlushHigh !== null) {
      const straightCards = extractStraightCards(flushCards, straightFlushHigh);

      if (straightFlushHigh === 14) {
        return {
          category: HandCategory.RoyalFlush,
          strength: [HandCategory.RoyalFlush],
          cards: straightCards,
          description: 'Scala reale',
        };
      }

      return {
        category: HandCategory.StraightFlush,
        strength: [HandCategory.StraightFlush, straightFlushHigh],
        cards: straightCards,
        description: `Scala colore al ${RANK_LABELS[straightFlushHigh]}`,
      };
    }
  }

  /* ── Poker (quattro dello stesso rango) ──────────────────── */
  if (rankGroups[0]!.count === 4) {
    const quads = rankGroups[0]!;
    // Il kicker è la carta più alta fra le restanti.
    const kicker = sortByValueDesc(
      cards.filter((card) => card.value !== quads.value)
    )[0]!;

    return {
      category: HandCategory.FourOfAKind,
      strength: [HandCategory.FourOfAKind, quads.value, kicker.value],
      cards: [...quads.cards, kicker],
      description: `Poker di ${RANK_LABELS_PLURAL[quads.value]}`,
    };
  }

  /* ── Full ─────────────────────────────────────────────────
     Con 7 carte possono esistere due tris: il full si forma col
     tris più alto e la coppia più alta fra le restanti. */
  if (rankGroups[0]!.count === 3) {
    const trips = rankGroups[0]!;
    const pairCandidate = rankGroups
      .slice(1)
      .find((group) => group.count >= 2);

    if (pairCandidate) {
      return {
        category: HandCategory.FullHouse,
        strength: [HandCategory.FullHouse, trips.value, pairCandidate.value],
        cards: [...trips.cards, ...pairCandidate.cards.slice(0, 2)],
        description: `Full di ${RANK_LABELS_PLURAL[trips.value]} su ${RANK_LABELS_PLURAL[pairCandidate.value]}`,
      };
    }
  }

  /* ── Colore ──────────────────────────────────────────────── */
  if (flushCards) {
    const best5 = sortByValueDesc(flushCards).slice(0, 5);

    return {
      category: HandCategory.Flush,
      strength: [HandCategory.Flush, ...best5.map((card) => card.value)],
      cards: best5,
      description: `Colore al ${RANK_LABELS[best5[0]!.value]}`,
    };
  }

  /* ── Scala ───────────────────────────────────────────────── */
  const straightHigh = findStraightHigh(cards);

  if (straightHigh !== null) {
    return {
      category: HandCategory.Straight,
      strength: [HandCategory.Straight, straightHigh],
      cards: extractStraightCards(cards, straightHigh),
      description: `Scala al ${RANK_LABELS[straightHigh]}`,
    };
  }

  /* ── Tris ────────────────────────────────────────────────── */
  if (rankGroups[0]!.count === 3) {
    const trips = rankGroups[0]!;
    const kickers = sortByValueDesc(
      cards.filter((card) => card.value !== trips.value)
    ).slice(0, 2);

    return {
      category: HandCategory.ThreeOfAKind,
      strength: [
        HandCategory.ThreeOfAKind,
        trips.value,
        ...kickers.map((card) => card.value),
      ],
      cards: [...trips.cards, ...kickers],
      description: `Tris di ${RANK_LABELS_PLURAL[trips.value]}`,
    };
  }

  /* ── Doppia coppia ────────────────────────────────────────
     Con 7 carte possono esistere tre coppie: contano le due più
     alte, la terza è irrilevante. */
  if (rankGroups[0]!.count === 2 && rankGroups[1]?.count === 2) {
    const high = rankGroups[0]!;
    const low = rankGroups[1]!;
    const kicker = sortByValueDesc(
      cards.filter(
        (card) => card.value !== high.value && card.value !== low.value
      )
    )[0]!;

    return {
      category: HandCategory.TwoPair,
      strength: [HandCategory.TwoPair, high.value, low.value, kicker.value],
      cards: [...high.cards, ...low.cards, kicker],
      description: `Doppia coppia, ${RANK_LABELS_PLURAL[high.value]} e ${RANK_LABELS_PLURAL[low.value]}`,
    };
  }

  /* ── Coppia ──────────────────────────────────────────────── */
  if (rankGroups[0]!.count === 2) {
    const pair = rankGroups[0]!;
    const kickers = sortByValueDesc(
      cards.filter((card) => card.value !== pair.value)
    ).slice(0, 3);

    return {
      category: HandCategory.Pair,
      strength: [
        HandCategory.Pair,
        pair.value,
        ...kickers.map((card) => card.value),
      ],
      cards: [...pair.cards, ...kickers],
      description: `Coppia di ${RANK_LABELS_PLURAL[pair.value]}`,
    };
  }

  /* ── Carta alta ──────────────────────────────────────────── */
  const best5 = sortByValueDesc(cards).slice(0, 5);

  return {
    category: HandCategory.HighCard,
    strength: [HandCategory.HighCard, ...best5.map((card) => card.value)],
    cards: best5,
    description: `${RANK_LABELS[best5[0]!.value]} alto`,
  };
}

/* ────────────────────────────────────────────────────────────
   CONFRONTO
   ──────────────────────────────────────────────────────────── */

/**
 * Confronta due mani.
 * @returns Positivo se a è più forte, negativo se b, 0 in parità.
 */
export function compareHands(a: HandRank, b: HandRank): number {
  const length = Math.max(a.strength.length, b.strength.length);

  for (let i = 0; i < length; i++) {
    // Una tupla più corta è già stata decisa nelle posizioni
    // precedenti: il fallback a 0 non altera il risultato.
    const diff = (a.strength[i] ?? 0) - (b.strength[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

/** True se le due mani sono esattamente equivalenti (split pot). */
export function handsAreEqual(a: HandRank, b: HandRank): boolean {
  return compareHands(a, b) === 0;
}

/* ────────────────────────────────────────────────────────────
   CLASSIFICA
   ──────────────────────────────────────────────────────────── */

/** Mano valutata associata a un giocatore. */
export interface RankedPlayer<TId = string> {
  playerId: TId;
  rank: HandRank;
  /**
   * Posizione nello showdown, a partire da 1.
   * Giocatori in parità condividono la stessa posizione: è così che
   * lo split pot viene individuato senza confronti aggiuntivi.
   */
  position: number;
}

/**
 * Ordina i giocatori dal più forte al più debole, assegnando la
 * posizione di showdown.
 *
 * Le posizioni in parità restano identiche: [1, 1, 3] indica due
 * vincitori che dividono il piatto e un terzo classificato.
 */
export function rankPlayers<TId = string>(
  entries: readonly { playerId: TId; cards: readonly Card[] }[]
): RankedPlayer<TId>[] {
  const evaluated = entries.map((entry) => ({
    playerId: entry.playerId,
    rank: evaluateHand(entry.cards),
  }));

  evaluated.sort((a, b) => compareHands(b.rank, a.rank));

  const result: RankedPlayer<TId>[] = [];
  let currentPosition = 1;

  for (let i = 0; i < evaluated.length; i++) {
    const current = evaluated[i]!;

    if (i > 0) {
      const previous = evaluated[i - 1]!;
      // Solo un cambio di forza fa avanzare la posizione: in parità
      // si eredita quella precedente.
      if (!handsAreEqual(current.rank, previous.rank)) {
        currentPosition = i + 1;
      }
    }

    result.push({
      playerId: current.playerId,
      rank: current.rank,
      position: currentPosition,
    });
  }

  return result;
}

/** Giocatori vincenti: tutti quelli in posizione 1. */
export function findWinners<TId = string>(
  ranked: readonly RankedPlayer<TId>[]
): RankedPlayer<TId>[] {
  return ranked.filter((entry) => entry.position === 1);
    }
