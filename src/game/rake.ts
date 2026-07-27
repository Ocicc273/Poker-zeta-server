/**
 * Poker Zeta — Rake
 * Riferimento: ECON-001, decisioni economiche del 26 lug 2026
 *
 * Il rake è l'unico SCARICO dell'economia: le fiche trattenute qui
 * escono dalla circolazione e non tornano nel wallet di nessuno né nel
 * pool dei bot. È quello che tiene sotto controllo la massa di
 * Z-Coins, quindi le sue regole vanno tenute esplicite e testate.
 *
 * REGOLE APPROVATE
 *   · 5% del piatto
 *   · tetto a 3 big blind
 *   · "no flop, no drop": nessun rake se la mano si chiude prima del
 *     flop
 *   · nessun rake su un piatto non conteso (chi vince senza che
 *     nessuno abbia pagato non paga il servizio)
 *
 * DUE PRECISAZIONI CHE CAMBIANO I NUMERI
 *   1. `pot` deve essere il piatto CONTESO: la parte non pagata di una
 *      puntata torna a chi l'ha fatta e non va mai rastrellata. Se il
 *      motore lascia l'importo non pagato dentro il piatto, va tolto
 *      prima di chiamare computeRake.
 *   2. L'arrotondamento è per DIFETTO, sempre a favore del giocatore.
 *      Le fiche sono intere.
 */

/** Percentuale trattenuta sul piatto conteso. */
export const RAKE_PERCENT = 0.05;

/** Tetto massimo, espresso in big blind del tavolo. */
export const RAKE_CAP_BIG_BLINDS = 3;

export interface RakeInput {
  /** Piatto conteso in fiche, già al netto delle puntate non pagate. */
  pot: number;
  /** Big blind del tavolo: serve per il tetto. */
  bigBlind: number;
  /** La mano ha visto il flop? */
  sawFlop: boolean;
  /** Almeno due giocatori hanno messo fiche nel piatto? */
  contested: boolean;
}

/** Tetto in fiche per un tavolo con questo big blind. */
export function rakeCap(bigBlind: number): number {
  if (!Number.isFinite(bigBlind) || bigBlind <= 0) return 0;
  return RAKE_CAP_BIG_BLINDS * bigBlind;
}

/**
 * Rake da trattenere su un piatto. Restituisce sempre un intero fra 0
 * e il piatto stesso: nessuna via d'uscita può produrre un valore
 * negativo o superiore a quanto c'è sul tavolo.
 */
export function computeRake({
  pot,
  bigBlind,
  sawFlop,
  contested,
}: RakeInput): number {
  if (!sawFlop || !contested) return 0;
  if (!Number.isFinite(pot) || pot <= 0) return 0;

  const percentage = Math.floor(pot * RAKE_PERCENT);
  const capped = Math.min(percentage, rakeCap(bigBlind));

  return Math.max(0, Math.min(capped, Math.floor(pot)));
}

/**
 * Ripartisce il rake sui piatti da pagare (principale e laterali).
 *
 * Si preleva dal piatto principale e si trabocca sui successivi solo
 * se non basta. Con un tetto di 3 big blind il caso del traboccamento
 * è raro, ma la funzione non lo dà per scontato.
 *
 * Restituisce i piatti già decurtati e quanto è stato effettivamente
 * prelevato — che può essere meno del richiesto se i piatti non
 * bastano. Il chiamante deve registrare `taken`, non il valore
 * richiesto, altrimenti la contabilità non torna.
 */
export function applyRake(
  pots: readonly number[],
  rake: number
): { pots: number[]; taken: number } {
  const remainingPots = pots.map((amount) => Math.max(0, Math.floor(amount)));
  let left = Math.max(0, Math.floor(rake));
  let taken = 0;

  for (let index = 0; index < remainingPots.length && left > 0; index += 1) {
    const slice = Math.min(remainingPots[index], left);
    remainingPots[index] -= slice;
    left -= slice;
    taken += slice;
  }

  return { pots: remainingPots, taken };
}
