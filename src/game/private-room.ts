/**
 * Poker Zeta — Stanza privata fra amici
 *
 * Affianca Room senza sostituirla. Room regge un umano e due bot ed
 * è il tavolo che oggi funziona: non va toccato. Qui gli umani sono
 * da due a sei e di bot non ce n'è nessuno.
 *
 * ECONOMIA SEPARATA — la scelta che governa tutto il file.
 * Le fiche di un tavolo privato NON vengono dal wallet e non ci
 * tornano: le carica chi ospita, quanto vuole. Il motivo non è
 * comodità ma sicurezza: fiche che entrano ed escono dal wallet in
 * una stanza chiusa fra amici sarebbero un canale di trasferimento
 * di valore — mi siedo, ti passo tutto foldando, tu esci col mio.
 * Qui quel canale non esiste. La ricompensa vera è l'XP.
 *
 * Il rake esiste ma è un regolatore di ritmo deciso da chi ospita,
 * da 0 a 6 per cento: le fiche trattenute spariscono, non vanno a
 * nessuno. Il conto serve solo a sapere quando ricaricare.
 *
 * Le tre differenze tecniche rispetto a Room:
 * 1. La vista si costruisce PER OGNI giocatore: ognuno vede solo le
 *    proprie carte.
 * 2. Il conto alla rovescia vale per chiunque debba agire.
 * 3. Chi arriva a mano iniziata aspetta la successiva.
 */

import {
  applyAction,
  currentPotTotal,
  getAvailableActions,
  isHandComplete,
  startHand,
  ActionType,
  PlayerStatus,
  type ActionType as ActionTypeT,
  type HandState,
  type PlayerId,
  type Street,
  type TableConfig,
} from '../engine/index.js';

import { deriveTableConfig, MAX_SEATS_PRIVATE } from './table-config.js';
import { chargeRake, rakeableTotal } from './rake.js';

import type { ActionLogEntry, PlayerView, TableView } from './protocol.js';

/** Tempo concesso per agire. Uguale ai tavoli contro bot. */
const TURN_MS = 25_000;

/**
 * Pausa fra una mano e l'altra.
 *
 * Nei tavoli contro bot la mano successiva la chiede il giocatore.
 * Qui non si può: aspettare che tutti e sei premano un pulsante
 * significa che chi si distrae blocca il tavolo. Parte da sola, e
 * la pausa serve a leggere il risultato.
 */
const NEXT_HAND_MS = 6_000;

/** Sotto questo numero la mano non parte. */
const MIN_PLAYERS = 2;

/** Tetto alla percentuale trattenuta, imposto dal server. */
const MAX_RAKE_PERCENT = 6;

interface Seduto {
  playerId: PlayerId;
  name: string;
  seat: number;
  stack: number;
}

export interface PrivateRoomOptions {
  /** Il codice del tavolo fa da identificativo. */
  code: string;
  /** Chi ha creato il tavolo: decide ricariche e impostazioni. */
  hostId: PlayerId;
  /** Serve solo a ricavare i bui dal livello scelto. */
  buyIn: number;
  maxSeats?: number;
  /** Percentuale trattenuta da ogni piatto, da 0 a 6. */
  rakePercent?: number;
  /** Invia la vista a un singolo giocatore. */
  sendState: (playerId: PlayerId, view: TableView) => void;
  /** Comunica un errore a un singolo giocatore. */
  sendError: (playerId: PlayerId, message: string) => void;
  /** Avvisa che il tavolo si è svuotato e va chiuso. */
  onEmpty?: () => void;
  /** Esito di una mano, per far avanzare le missioni. */
  onHandComplete?: (playerId: PlayerId, esito: { won: boolean }) => void;
}

export class PrivateRoom {
  readonly code: string;

  private readonly hostId: PlayerId;
  private readonly config: TableConfig;
  private readonly maxSeats: number;
  private readonly rakePercent: number;
  private readonly seduti = new Map<PlayerId, Seduto>();

  private readonly sendState: PrivateRoomOptions['sendState'];
  private readonly sendError: PrivateRoomOptions['sendError'];
  private readonly onEmpty?: () => void;
  private readonly onHandComplete?: PrivateRoomOptions['onHandComplete'];

  private state: HandState | null = null;
  private log: ActionLogEntry[] = [];
  private logId = 0;
  private folded = new Set<PlayerId>();
  private dealerSeat = 0;

  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private turnDeadline: number | null = null;
  private turnOwner: PlayerId | null = null;
  private nextHandTimer: ReturnType<typeof setTimeout> | null = null;

  private closed = false;
  private rakeCollected = 0;

  constructor(options: PrivateRoomOptions) {
    this.code = options.code;
    this.hostId = options.hostId;
    this.maxSeats = Math.min(
      options.maxSeats ?? MAX_SEATS_PRIVATE,
      MAX_SEATS_PRIVATE,
    );
    // Il tetto sta nel server e non nell'interfaccia: un client
    // modificato non deve poter prosciugare il tavolo.
    this.rakePercent = Math.min(
      MAX_RAKE_PERCENT,
      Math.max(0, options.rakePercent ?? 0),
    );
    this.config = deriveTableConfig(options.buyIn, this.maxSeats).config;

    this.sendState = options.sendState;
    this.sendError = options.sendError;
    this.onEmpty = options.onEmpty;
    this.onHandComplete = options.onHandComplete;
  }

  /* ── Posti ─────────────────────────────────────────────── */

  private postoLibero(): number | null {
    const occupati = new Set([...this.seduti.values()].map((s) => s.seat));
    for (let i = 0; i < this.maxSeats; i++) {
      if (!occupati.has(i)) return i;
    }
    return null;
  }

  /**
   * Fa sedere un giocatore.
   *
   * Lo stack lo decide chi ospita: non c'è niente da addebitare.
   * Se una mano è in corso NON entra nella mano: giocherà dalla
   * successiva, come al tavolo vero.
   */
  siediti(playerId: PlayerId, name: string, stack: number): boolean {
    if (this.closed) return false;

    if (this.seduti.has(playerId)) {
      // Rientro dopo una disconnessione: il posto è ancora suo.
      this.inviaA(playerId);
      return true;
    }

    const seat = this.postoLibero();
    if (seat === null) return false;

    this.seduti.set(playerId, {
      playerId,
      name,
      seat,
      stack: Math.max(0, Math.floor(stack)),
    });
    this.broadcast();
    this.forseAvviaMano();
    return true;
  }

  /** Alza un giocatore dal tavolo. */
  alzati(playerId: PlayerId): boolean {
    if (!this.seduti.has(playerId)) return false;

    this.seduti.delete(playerId);

    // Se se ne va mentre la mano è viva, per il motore è un fold:
    // le fiche già nel piatto restano lì, come per chi passa.
    const state = this.state;
    if (state && !isHandComplete(state)) {
      const inMano = state.players.find((p) => p.playerId === playerId);
      if (inMano && inMano.status === PlayerStatus.Active) {
        this.applicaEDiffondi(playerId, ActionType.Fold);
      }
    }

    if (this.seduti.size === 0) {
      this.close();
      this.onEmpty?.();
      return true;
    }

    this.broadcast();
    return true;
  }

  /**
   * Ricarica le fiche di un giocatore. Solo chi ospita può farlo.
   *
   * Non si applica a mano in corso: cambiare lo stack mentre le
   * puntate sono vive confonderebbe il motore.
   */
  ricarica(richiedente: PlayerId, playerId: PlayerId, stack: number): boolean {
    if (richiedente !== this.hostId) return false;

    const seduto = this.seduti.get(playerId);
    if (!seduto || stack <= 0) return false;

    const state = this.state;
    if (state && !isHandComplete(state)) return false;

    seduto.stack = Math.floor(stack);
    this.broadcast();
    this.forseAvviaMano();
    return true;
  }

  /* ── Interrogazioni ────────────────────────────────────── */

  giocatoriSeduti(): number {
    return this.seduti.size;
  }

  haPosto(): boolean {
    return this.postoLibero() !== null;
  }

  eSeduto(playerId: PlayerId): boolean {
    return this.seduti.has(playerId);
  }

  rakeTotal(): number {
    return this.rakeCollected;
  }

  close(): void {
    this.closed = true;
    this.clearTurnTimer();
    this.clearNextHandTimer();
  }

  /* ── Mani ──────────────────────────────────────────────── */

  private clearNextHandTimer(): void {
    if (this.nextHandTimer !== null) {
      clearTimeout(this.nextHandTimer);
      this.nextHandTimer = null;
    }
  }

  /**
   * Avvia la mano successiva se ci sono le condizioni.
   *
   * Ci si arriva da tre strade — arriva un giocatore, ne esce uno,
   * la mano finisce — e senza queste guardie se ne aprirebbero due
   * insieme.
   */
  private forseAvviaMano(): void {
    if (this.closed) return;
    if (this.state !== null && !isHandComplete(this.state)) return;
    if (this.nextHandTimer !== null) return;

    const pronti = [...this.seduti.values()].filter((s) => s.stack > 0);
    if (pronti.length < MIN_PLAYERS) return;

    const attesa = this.state === null ? 1_500 : NEXT_HAND_MS;

    this.nextHandTimer = setTimeout(() => {
      this.nextHandTimer = null;
      this.avviaMano();
    }, attesa);
  }

  private avviaMano(): void {
    if (this.closed) return;

    const partecipanti = [...this.seduti.values()]
      .filter((s) => s.stack > 0)
      .map((s) => ({ playerId: s.playerId, seat: s.seat, stack: s.stack }))
      .sort((a, b) => a.seat - b.seat);

    if (partecipanti.length < MIN_PLAYERS) {
      this.broadcast();
      return;
    }

    // Il bottone deve stare su un posto occupato da chi gioca
    // questa mano, altrimenti startHand solleva.
    const occupati = partecipanti.map((p) => p.seat);
    let guard = 0;
    while (!occupati.includes(this.dealerSeat) && guard < this.maxSeats) {
      this.dealerSeat = (this.dealerSeat + 1) % this.maxSeats;
      guard += 1;
    }

    try {
      this.state = startHand(
        `${this.code}-${Date.now()}`,
        this.config,
        partecipanti,
        this.dealerSeat,
      );
      this.log = [];
      this.logId = 0;
      this.folded = new Set();
    } catch (error) {
      this.diffondiErrore(
        `Impossibile avviare la mano: ${(error as Error).message}`,
      );
      return;
    }

    this.broadcast();
  }

  /* ── Azioni ────────────────────────────────────────────── */

  azione(playerId: PlayerId, type: ActionTypeT, amount?: number): void {
    if (this.closed) return;

    const state = this.state;
    if (!state) {
      this.sendError(playerId, 'Nessuna mano in corso.');
      return;
    }
    if (isHandComplete(state)) {
      this.sendError(playerId, 'La mano è conclusa.');
      return;
    }
    // Il turno lo decide il server: che il client abbia mostrato o
    // meno i pulsanti non conta.
    if (state.toActPlayerId !== playerId) {
      this.sendError(playerId, 'Non è il tuo turno.');
      return;
    }

    this.applicaEDiffondi(playerId, type, amount);
  }

  private applicaEDiffondi(
    playerId: PlayerId,
    type: ActionTypeT,
    amount?: number,
  ): void {
    const current = this.state;
    if (!current) return;

    let next: HandState;
    try {
      next = applyAction(current, { type, playerId, amount });
    } catch (error) {
      // Azione rifiutata: lo stato resta quello di prima e il conto
      // alla rovescia continua, perché il turno non è consumato.
      this.sendError(playerId, (error as Error).message);
      this.broadcast();
      return;
    }

    this.appendLog(playerId, type, amount, current.street);

    if (type === ActionType.Fold) {
      this.folded.add(playerId);
    }

    // Il rake si trattiene PRIMA che gli stack finiscano nei posti.
    if (isHandComplete(next)) {
      next = this.trattieniRake(next);
    }

    this.state = next;

    if (isHandComplete(next)) {
      for (const p of next.players) {
        const seduto = this.seduti.get(p.playerId);
        if (seduto) seduto.stack = p.stack;
      }

      this.dealerSeat = (this.dealerSeat + 1) % this.maxSeats;
      this.clearTurnTimer();
      this.registraMissioni(next);
      this.forseAvviaMano();
    }

    this.broadcast();
  }

  /* ── Missioni ──────────────────────────────────────────── */

  private registraMissioni(next: HandState): void {
    if (!this.onHandComplete) return;

    for (const p of next.players) {
      if (!this.seduti.has(p.playerId)) continue;

      const vinta = next.payouts.find((x) => x.playerId === p.playerId);
      try {
        this.onHandComplete(p.playerId, {
          won: vinta !== undefined && vinta.amount > 0,
        });
      } catch (error) {
        // Le missioni non devono poter far cadere una mano.
        console.error(`Missioni fallite nel tavolo ${this.code}:`, error);
      }
    }
  }

  /* ── Rake ──────────────────────────────────────────────── */

  /**
   * Trattiene la percentuale decisa da chi ospita.
   *
   * Due regole tenute dai tavoli veri, senza le quali un tavolo al
   * sei per cento si prosciuga in una serata: niente rake se la
   * mano finisce prima del flop, e niente rake su un piatto non
   * conteso. Si rastrella solo la parte CONTESA: quello che nessuno
   * ha pareggiato torna a chi l'ha messo e non è mai stato in gioco.
   */
  private trattieniRake(next: HandState): HandState {
    if (this.rakePercent <= 0) return next;

    const amounts = next.players.map((p) => p.committedTotal);
    const conteso = rakeableTotal(amounts);
    const contestato = amounts.filter((a) => a > 0).length >= 2;
    const vistoFlop = next.communityCards.length >= 3;

    if (!contestato || !vistoFlop || conteso <= 0) return next;

    const rake = Math.floor((conteso * this.rakePercent) / 100);
    if (rake <= 0) return next;

    const { charges, taken } = chargeRake(
      next.payouts.map((p) => ({ playerId: p.playerId, amount: p.amount })),
      rake,
    );

    if (taken <= 0) return next;

    const charged = new Map(charges.map((c) => [c.playerId, c.amount]));

    const players = next.players.map((p) => {
      const fee = charged.get(p.playerId) ?? 0;
      return fee > 0 ? { ...p, stack: p.stack - fee } : p;
    });

    const payouts = next.payouts.map((p) => {
      const fee = charged.get(p.playerId) ?? 0;
      return fee > 0 ? { ...p, amount: p.amount - fee } : p;
    });

    this.rakeCollected += taken;

    return { ...next, players, payouts };
  }

  /* ── Conto alla rovescia ───────────────────────────────── */

  private clearTurnTimer(): void {
    if (this.turnTimer !== null) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    this.turnDeadline = null;
    this.turnOwner = null;
  }

  /**
   * Allinea il conto alla rovescia a chi deve agire.
   *
   * Diversamente da Room, qui il turno passa di giocatore in
   * giocatore: quando cambia, il conto riparte. Se restasse fermo,
   * il secondo erediterebbe il tempo consumato dal primo.
   */
  private aggiornaTurnTimer(): void {
    const state = this.state;
    const chi = state && !isHandComplete(state) ? state.toActPlayerId : null;

    if (chi === null) {
      this.clearTurnTimer();
      return;
    }

    if (this.turnTimer !== null && this.turnOwner === chi) return;

    this.clearTurnTimer();
    this.turnOwner = chi;
    this.turnDeadline = Date.now() + TURN_MS;
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      this.scadutoIlTurno(chi);
    }, TURN_MS);
  }

  /**
   * Tempo scaduto: agisce il server.
   *
   * Check se non costa nulla, altrimenti fold. Un timeout non deve
   * mai impegnare fiche che il giocatore non ha scelto di mettere.
   */
  private scadutoIlTurno(atteso: PlayerId): void {
    if (this.closed) return;

    try {
      const state = this.state;
      if (!state || isHandComplete(state)) return;
      // Nel frattempo il turno può essere passato ad altri.
      if (state.toActPlayerId !== atteso) return;

      const available = getAvailableActions(state);
      if (available.length === 0) return;

      const ha = (t: ActionTypeT): boolean =>
        available.some((a) => a.type === t);

      const type = ha(ActionType.Check)
        ? ActionType.Check
        : ha(ActionType.Fold)
          ? ActionType.Fold
          : available[0]!.type;

      this.clearTurnTimer();
      this.sendError(atteso, 'Tempo scaduto.');
      this.applicaEDiffondi(atteso, type);
    } catch (error) {
      console.error(`Timeout fallito nel tavolo ${this.code}:`, error);
    }
  }

  /* ── Registro ──────────────────────────────────────────── */

  private appendLog(
    playerId: PlayerId,
    type: ActionTypeT,
    amount: number | undefined,
    street: Street,
  ): void {
    this.logId += 1;
    this.log.push({
      id: this.logId,
      playerId,
      text: this.descrivi(playerId, type, amount),
      street,
    });
  }

  private descrivi(
    playerId: PlayerId,
    type: ActionTypeT,
    amount: number | undefined,
  ): string {
    const name = this.seduti.get(playerId)?.name ?? playerId;
    const cifra = amount?.toLocaleString('it-IT') ?? '';

    switch (type) {
      case ActionType.Fold:
        return `${name} passa`;
      case ActionType.Check:
        return `${name} bussa`;
      case ActionType.Call:
        return `${name} chiama`;
      case ActionType.Bet:
        return `${name} punta ${cifra}`;
      case ActionType.Raise:
        return `${name} rilancia a ${cifra}`;
      case ActionType.AllIn:
        return `${name} va all-in`;
      default:
        return `${name} agisce`;
    }
  }

  /* ── Trasmissione ──────────────────────────────────────── */

  /** Rimanda lo stato a un giocatore che si riattacca. */
  inviaA(playerId: PlayerId): void {
    if (this.closed || !this.seduti.has(playerId)) return;
    try {
      this.sendState(playerId, this.buildView(playerId));
    } catch (error) {
      console.error(`Proiezione fallita per ${playerId}:`, error);
    }
  }

  /**
   * Manda a ciascuno la SUA vista.
   *
   * È la differenza sostanziale con Room: sei viste diverse, perché
   * ognuno vede solo le proprie carte. Costruirne una sola e
   * mandarla a tutti significherebbe consegnare le carte altrui.
   */
  private broadcast(): void {
    if (this.closed) return;

    this.aggiornaTurnTimer();

    for (const playerId of this.seduti.keys()) {
      this.inviaA(playerId);
    }
  }

  private diffondiErrore(message: string): void {
    for (const playerId of this.seduti.keys()) {
      this.sendError(playerId, message);
    }
  }

  private buildView(viewerId: PlayerId): TableView {
    const state = this.state;
    const complete = state !== null && isHandComplete(state);

    const players: PlayerView[] = [...this.seduti.values()]
      .sort((a, b) => a.seat - b.seat)
      .map((seduto) => {
        const inMano = state?.players.find(
          (p) => p.playerId === seduto.playerId,
        );
        const isSelf = seduto.playerId === viewerId;
        const holeCards = inMano?.holeCards ?? [];

        // Qui avviene la censura: le carte esistono nello stato del
        // server ma entrano nel messaggio solo se sono di chi
        // guarda, o a mano conclusa per chi non ha passato.
        const visible =
          isSelf ||
          (complete &&
            !this.folded.has(seduto.playerId) &&
            holeCards.length > 0);

        return {
          playerId: seduto.playerId,
          name: seduto.name,
          seat: seduto.seat,
          stack: inMano?.stack ?? seduto.stack,
          committedThisStreet: inMano?.committedThisStreet ?? 0,
          status: inMano?.status ?? PlayerStatus.SittingOut,
          isDealer: seduto.seat === this.dealerSeat,
          // Nei tavoli privati sono tutte persone.
          isBot: false,
          holeCards: visible ? holeCards : null,
          holeCardCount: holeCards.length,
        };
      });

    const tocca =
      state !== null && !complete && state.toActPlayerId === viewerId;
    const mioStack = this.seduti.get(viewerId)?.stack ?? 0;

    return {
      handId: state?.handId ?? null,
      street: state?.street ?? null,
      communityCards: state?.communityCards ?? [],
      pot: state ? currentPotTotal(state) : 0,
      currentBet: state?.currentBet ?? 0,
      toActPlayerId: state?.toActPlayerId ?? null,
      yourPlayerId: viewerId,
      players,
      availableActions: tocca && state ? getAvailableActions(state) : [],
      isYourTurn: tocca,
      // Il tempo è di CHI STA AGENDO, chiunque sia: al tavolo si
      // vede l'orologio dell'avversario, ed è quello che rende viva
      // l'attesa.
      turnMillisLeft:
        this.turnDeadline !== null
          ? Math.max(0, this.turnDeadline - Date.now())
          : null,
      isHandComplete: complete,
      // Qui la mano successiva parte da sola: nessun pulsante.
      canStartNextHand: false,
      // Nel privato non esiste il fondo di ripartenza: chi finisce
      // le fiche aspetta che chi ospita lo ricarichi.
      isBusted: false,
      payouts: complete ? (state?.payouts ?? []) : [],
      blinds: this.config.blinds,
      log: this.log,
      // Il conto del rake lo vede solo chi ospita: agli altri non
      // serve, e mostrarlo darebbe l'idea sbagliata che qualcuno ci
      // stia guadagnando.
      privateRakeTotal: viewerId === this.hostId ? this.rakeCollected : null,
      // Silenzia l'avviso: mioStack serve solo a documentare che
      // qui non si va mai "busted".
      ...(mioStack < 0 ? {} : {}),
    };
  }
}
