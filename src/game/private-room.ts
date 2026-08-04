/**
 * Poker Zeta — Stanza privata fra umani
 *
 * Affianca Room senza sostituirla. Room regge un umano e due bot,
 * ed è il tavolo che oggi funziona: non va toccato. Qui gli umani
 * sono da due a sei e di bot non ce n'è nessuno.
 *
 * Le tre differenze che contano rispetto a Room:
 *
 * 1. La vista si costruisce PER OGNI giocatore, perché ognuno vede
 *    solo le proprie carte. Room ne costruiva una sola.
 * 2. Il conto alla rovescia vale per chiunque debba agire, non per
 *    un giocatore prestabilito.
 * 3. Chi arriva a mano iniziata aspetta la successiva: entra nei
 *    posti ma non nella mano in corso.
 *
 * Come Room, non conosce Socket.io: riceve funzioni per parlare e
 * le usa.
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
import { chargeRake, computeRake, rakeableTotal } from './rake.js';

import type { ActionLogEntry, PlayerView, TableView } from './protocol.js';

/** Tempo concesso per agire. Uguale ai tavoli contro bot. */
const TURN_MS = 25_000;

/**
 * Pausa fra una mano e l'altra.
 *
 * Nei tavoli contro bot la mano successiva la chiede il giocatore.
 * Qui non si può: aspettare che tutti e sei premano un pulsante
 * significherebbe che chi si distrae blocca il tavolo. Parte da
 * sola, e la pausa serve a leggere il risultato.
 */
const NEXT_HAND_MS = 6_000;

/** Sotto questo numero la mano non parte. */
const MIN_PLAYERS = 2;

interface Seduto {
  playerId: PlayerId;
  name: string;
  seat: number;
  stack: number;
  /** Sessione del wallet: serve al riaccredito quando si alza. */
  sessionId: string;
}

export interface PrivateRoomOptions {
  /** Il codice del tavolo fa da identificativo. */
  code: string;
  buyIn: number;
  maxSeats?: number;
  /** Invia la vista a un singolo giocatore. */
  sendState: (playerId: PlayerId, view: TableView) => void;
  /** Comunica un errore a un singolo giocatore. */
  sendError: (playerId: PlayerId, message: string) => void;
  /** Avvisa che il tavolo si è svuotato e va chiuso. */
  onEmpty?: () => void;
  /** Esito di una mano, per far avanzare le missioni. */
  onHandComplete?: (
    playerId: PlayerId,
    esito: { won: boolean; chipsWon: number },
  ) => void;
}

export class PrivateRoom {
  readonly code: string;

  private readonly config: TableConfig;
  private readonly maxSeats: number;
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
  private nextHandTimer: ReturnType<typeof setTimeout> | null = null;

  private closed = false;
  private rakeCollected = 0;

  constructor(options: PrivateRoomOptions) {
    this.code = options.code;
    this.maxSeats = Math.min(options.maxSeats ?? MAX_SEATS_PRIVATE, MAX_SEATS_PRIVATE);
    this.config = deriveTableConfig(options.buyIn, this.maxSeats).config;

    this.sendState = options.sendState;
    this.sendError = options.sendError;
    this.onEmpty = options.onEmpty;
    this.onHandComplete = options.onHandComplete;
  }

  /* ── Posti ─────────────────────────────────────────────── */

  /** Il primo posto libero, oppure null se il tavolo è pieno. */
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
   * Se una mano è in corso NON lo aggiunge alla mano: entrerà alla
   * successiva. È il comportamento del poker vero, e l'alternativa
   * — ricostruire la mano in corso — sarebbe sbagliata comunque.
   */
  siediti(
    playerId: PlayerId,
    name: string,
    stack: number,
    sessionId: string,
  ): boolean {
    if (this.closed) return false;

    if (this.seduti.has(playerId)) {
      // Rientro dopo una disconnessione: il posto è ancora suo.
      this.inviaA(playerId);
      return true;
    }

    const seat = this.postoLibero();
    if (seat === null) return false;

    this.seduti.set(playerId, { playerId, name, seat, stack, sessionId });
    this.broadcast();
    this.forseAvviaMano();
    return true;
  }

  /** Alza un giocatore dal tavolo. Restituisce lo stack da riaccreditare. */
  alzati(playerId: PlayerId): { stack: number; sessionId: string } | null {
    const seduto = this.seduti.get(playerId);
    if (!seduto) return null;

    const stack = this.stackDi(playerId);
    const sessionId = seduto.sessionId;

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
      return { stack, sessionId };
    }

    this.broadcast();
    return { stack, sessionId };
  }

  /**
   * Stack attuale di un giocatore.
   *
   * A mano in corso vale quello dentro la mano: le fiche già nel
   * piatto non tornano indietro, altrimenti uscire sarebbe un modo
   * per annullare una puntata perdente.
   */
  stackDi(playerId: PlayerId): number {
    const state = this.state;
    if (state && !isHandComplete(state)) {
      const inMano = state.players.find((p) => p.playerId === playerId);
      if (inMano) return inMano.stack;
    }
    return this.seduti.get(playerId)?.stack ?? 0;
  }

  /** Se il giocatore può alzarsi adesso senza perdere fiche impegnate. */
  puoAlzarsi(playerId: PlayerId): boolean {
    const state = this.state;
    if (!state || isHandComplete(state)) return true;

    const inMano = state.players.find((p) => p.playerId === playerId);
    if (!inMano) return true;

    return inMano.status === PlayerStatus.Folded;
  }

  giocatoriSeduti(): number {
    return this.seduti.size;
  }

  rakeTotal(): number {
    return this.rakeCollected;
  }

  /* ── Ciclo di vita ─────────────────────────────────────── */

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
   * Non fa nulla se una mano è già viva: è il punto in cui si entra
   * da tre strade diverse — arriva un giocatore, ne esce uno, la
   * mano finisce — e senza questa guardia se ne aprirebbero due.
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

    // Il bottone deve trovarsi su un posto occupato da chi gioca
    // questa mano, altrimenti startHand non lo trova e solleva.
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
      this.diffondiErrore(`Impossibile avviare la mano: ${(error as Error).message}`);
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
      // Solo chi ha davvero preso parte alla mano.
      if (!this.seduti.has(p.playerId)) continue;

      const vinta = next.payouts.find((x) => x.playerId === p.playerId);
      try {
        this.onHandComplete(p.playerId, {
          won: vinta !== undefined && vinta.amount > 0,
          chipsWon: vinta?.amount ?? 0,
        });
      } catch (error) {
        // Le missioni non devono poter far cadere una mano.
        console.error(`Missioni fallite nel tavolo ${this.code}:`, error);
      }
    }
  }

  /* ── Rake ──────────────────────────────────────────────── */

  private trattieniRake(next: HandState): HandState {
    const amounts = next.players.map((p) => p.committedTotal);

    const rake = computeRake({
      pot: rakeableTotal(amounts),
      bigBlind: this.config.blinds.bigBlind,
      sawFlop: next.communityCards.length >= 3,
      contested: amounts.filter((a) => a > 0).length >= 2,
    });

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
  }

  /**
   * Allinea il conto alla rovescia a chi deve agire.
   *
   * Diversamente da Room, qui il turno cambia di giocatore: quando
   * cambia, il conto va fatto ripartire. Se restasse fermo, chi
   * agisce per secondo erediterebbe il tempo già consumato dal
   * primo.
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

  private turnOwner: PlayerId | null = null;

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

      const ha = (t: ActionTypeT): boolean => available.some((a) => a.type === t);
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
        const inMano = state?.players.find((p) => p.playerId === seduto.playerId);
        const isSelf = seduto.playerId === viewerId;
        const holeCards = inMano?.holeCards ?? [];

        // Qui avviene la censura: le carte esistono nello stato del
        // server ma entrano nel messaggio solo se sono di chi
        // guarda, o a mano conclusa per chi non ha passato.
        const visible =
          isSelf ||
          (complete && !this.folded.has(seduto.playerId) && holeCards.length > 0);

        return {
          playerId: seduto.playerId,
          name: seduto.name,
          seat: seduto.seat,
          stack: inMano?.stack ?? seduto.stack,
          committedThisStreet: inMano?.committedThisStreet ?? 0,
          status: inMano?.status ?? PlayerStatus.SittingOut,
          isDealer: seduto.seat === this.dealerSeat,
          // Nei tavoli privati non ci sono bot: sono tutte persone.
          isBot: false,
          holeCards: visible ? holeCards : null,
          holeCardCount: holeCards.length,
        };
      });

    const tocca = state !== null && !complete && state.toActPlayerId === viewerId;
    const mioStack = this.stackDi(viewerId);

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
      // Il tempo è di CHI STA AGENDO, non di chi guarda: al tavolo
      // si vede l'orologio dell'avversario, ed è quello che rende
      // viva l'attesa. Chi guarda capisce a chi si riferisce da
      // toActPlayerId.
      turnMillisLeft:
        this.turnDeadline !== null
          ? Math.max(0, this.turnDeadline - Date.now())
          : null,
      isHandComplete: complete,
      // Nei tavoli privati la mano successiva parte da sola: non
      // esiste un pulsante da premere.
      canStartNextHand: false,
      isBusted: complete && mioStack <= 0,
      payouts: complete ? (state?.payouts ?? []) : [],
      blinds: this.config.blinds,
      log: this.log,
    };
  }
}
