/**
 * Poker Zeta — Stanza di gioco autoritativa
 *
 * Una stanza contiene un giocatore umano e due bot. Il motore gira
 * qui: il client non calcola nulla, riceve una proiezione dello
 * stato e chiede di agire.
 *
 * La stanza non conosce Socket.io. Riceve una funzione per emettere
 * e la usa: così è testabile e non dipende dal trasporto.
 */

import {
  applyAction,
  currentPotTotal,
  decideBotAction,
  getAvailableActions,
  isHandComplete,
  startHand,
  ActionType,
  PlayerStatus,
  type ActionType as ActionTypeT,
  type BotProfile,
  type HandState,
  type PlayerId,
  type Street,
  type TableConfig,
} from '../engine/index.js';

import {
  deriveTableConfig,
  sanitizeBuyIn,
  MAX_SEATS,
} from './table-config.js';

import type {
  ActionLogEntry,
  PlayerView,
  TableView,
} from './protocol.js';

/* ── Avversari ───────────────────────────────────────────── */

interface BotDefinition {
  playerId: PlayerId;
  name: string;
  profile: BotProfile;
  seat: number;
}

const BOTS: readonly BotDefinition[] = [
  { playerId: 'bot-1', name: 'Giarack', profile: 'tight', seat: 1 },
  { playerId: 'bot-2', name: 'Don Duck', profile: 'loose', seat: 2 },
];

/**
 * Pausa prima di ogni azione dei bot.
 *
 * Sul server ha un secondo scopo oltre alla leggibilità: senza
 * pausa, una mano fra soli bot si risolverebbe in un ciclo stretto
 * bloccando il thread.
 */
const BOT_THINK_MS = 900;

/* ── Stanza ──────────────────────────────────────────────── */

export interface RoomOptions {
  roomId: string;
  humanPlayerId: PlayerId;
  humanName: string;
  buyIn: unknown;
  /** Invia la vista aggiornata al giocatore umano. */
  sendState: (view: TableView) => void;
  /** Comunica un errore senza interrompere la partita. */
  sendError: (message: string) => void;
}

export class Room {
  readonly roomId: string;

  private readonly humanId: PlayerId;
  private readonly config: TableConfig;
  private readonly startingStack: number;
  private readonly names = new Map<PlayerId, string>();
  private readonly seats = new Map<PlayerId, number>();
  private readonly stacks = new Map<PlayerId, number>();

  private readonly sendState: (view: TableView) => void;
  private readonly sendError: (message: string) => void;

  private state: HandState | null = null;
  private log: ActionLogEntry[] = [];
  private logId = 0;
  private folded = new Set<PlayerId>();
  private dealerSeat = 0;
  private botTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(options: RoomOptions) {
    this.roomId = options.roomId;
    this.humanId = options.humanPlayerId;
    this.sendState = options.sendState;
    this.sendError = options.sendError;

    const buyIn = sanitizeBuyIn(options.buyIn);
    const derived = deriveTableConfig(buyIn);
    this.config = derived.config;
    this.startingStack = derived.startingStack;

    this.names.set(this.humanId, options.humanName);
    this.seats.set(this.humanId, 0);
    this.stacks.set(this.humanId, this.startingStack);

    for (const bot of BOTS) {
      this.names.set(bot.playerId, bot.name);
      this.seats.set(bot.playerId, bot.seat);
      this.stacks.set(bot.playerId, this.startingStack);
    }
  }

  /* ── Ciclo di vita ─────────────────────────────────────── */

  /** Avvia la prima mano e trasmette lo stato iniziale. */
  start(): void {
    this.startNextHand();
  }

  /** Chiude la stanza e annulla ogni turno bot in sospeso. */
  close(): void {
    this.closed = true;
    this.clearBotTimer();
  }
  /**
   * Stack attuale del giocatore umano.
   *
   * Serve al riaccredito quando lascia il tavolo. Durante una mano
   * lo stack vero è quello dentro lo stato del motore, perché le
   * fiche già puntate ne sono uscite; fra una mano e l'altra vale
   * quello persistente.
   */
  humanStack(): number {
    const state = this.state;

    if (state !== null && !isHandComplete(state)) {
      const inHand = state.players.find((p) => p.playerId === this.humanId);
      if (inHand) {
        // Le fiche impegnate nel piatto sono ancora sue finché la
        // mano non si chiude: contarle evita di regalarle al banco.
        return inHand.stack + inHand.committedThisStreet;
      }
    }

    return this.stacks.get(this.humanId) ?? 0;
  }

  /* ── Mani ──────────────────────────────────────────────── */

  startNextHand(): void {
    if (this.closed) return;

    if (this.state !== null && !isHandComplete(this.state)) {
      this.sendError('La mano corrente non è ancora conclusa.');
      return;
    }

    const participants = [...this.seats.entries()]
      .map(([playerId, seat]) => ({
        playerId,
        seat,
        stack: this.stacks.get(playerId) ?? 0,
      }))
      .filter((p) => p.stack > 0)
      .sort((a, b) => a.seat - b.seat);

    if (participants.length < 2) {
      this.sendError('Partita conclusa: non ci sono abbastanza giocatori.');
      this.broadcast();
      return;
    }

    // Il bottone deve trovarsi su un posto ancora occupato.
    const occupied = participants.map((p) => p.seat);
    let guard = 0;
    while (!occupied.includes(this.dealerSeat) && guard < MAX_SEATS) {
      this.dealerSeat = (this.dealerSeat + 1) % MAX_SEATS;
      guard += 1;
    }

    const handId = `${this.roomId}-${Date.now()}`;

    try {
      this.state = startHand(handId, this.config, participants, this.dealerSeat);
      this.log = [];
      this.logId = 0;
      this.folded = new Set();
    } catch (error) {
      this.sendError(`Impossibile avviare la mano: ${(error as Error).message}`);
      return;
    }

    this.broadcast();
    this.scheduleBotTurn();
  }

  /* ── Azioni ────────────────────────────────────────────── */

  /** Azione richiesta dal giocatore umano. */
  handleHumanAction(type: ActionTypeT, amount?: number): void {
    if (this.closed) return;

    const state = this.state;
    if (!state) {
      this.sendError('Nessuna mano in corso.');
      return;
    }
    if (isHandComplete(state)) {
      this.sendError('La mano è conclusa.');
      return;
    }
    // Il turno lo decide il server: che il client abbia mostrato o
    // meno i pulsanti non conta.
    if (state.toActPlayerId !== this.humanId) {
      this.sendError('Non è il tuo turno.');
      return;
    }

    this.applyAndBroadcast(this.humanId, type, amount);
    this.scheduleBotTurn();
  }

  private applyAndBroadcast(
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
      // Azione rifiutata dal motore: lo stato resta quello di prima.
      this.sendError((error as Error).message);
      this.broadcast();
      return;
    }

    this.appendLog(playerId, type, amount, current.street);

    if (type === ActionType.Fold) {
      // Serve a decidere chi mostra le carte allo showdown.
      this.folded.add(playerId);
    }

    this.state = next;

    if (isHandComplete(next)) {
      for (const player of next.players) {
        this.stacks.set(player.playerId, player.stack);
      }
      this.dealerSeat = (this.dealerSeat + 1) % MAX_SEATS;
      this.clearBotTimer();
    }

    this.broadcast();
  }

  /* ── Turni dei bot ─────────────────────────────────────── */

  private scheduleBotTurn(): void {
    if (this.closed) return;

    const state = this.state;
    if (!state || isHandComplete(state)) return;

    const toAct = state.toActPlayerId;
    if (toAct === null || toAct === this.humanId) return;

    const bot = BOTS.find((b) => b.playerId === toAct);
    if (!bot) return;

    this.clearBotTimer();
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      this.runBotTurn(bot);
    }, BOT_THINK_MS);
  }

  private runBotTurn(bot: BotDefinition): void {
    if (this.closed) return;

    // Questo metodo gira dentro un setTimeout: un'eccezione qui non
    // ha nessuno sopra che la raccolga e abbatterebbe il processo,
    // chiudendo i tavoli di tutti. Il rischio non è accettabile per
    // il turno di un bot.
    try {
      const state = this.state;
      if (!state || isHandComplete(state)) return;
      if (state.toActPlayerId !== bot.playerId) return;

      const player = state.players.find((p) => p.playerId === bot.playerId);
      if (!player || player.status !== PlayerStatus.Active) return;

      const available = getAvailableActions(state);
      if (available.length === 0) return;

      const decision = decideBotAction({
        playerId: bot.playerId,
        profile: bot.profile,
        holeCards: player.holeCards,
        communityCards: state.communityCards,
        street: state.street,
        available,
        toCall: state.currentBet - player.committedThisStreet,
        potSize: currentPotTotal(state),
        stack: player.stack,
      });

      this.applyAndBroadcast(bot.playerId, decision.type, decision.amount);
      this.scheduleBotTurn();
    } catch (error) {
      console.error(
        `Turno bot fallito [${bot.playerId}] nella stanza ${this.roomId}:`,
        error,
      );
      this.sendError('Errore interno durante il turno di un avversario.');
    }
  }

  private clearBotTimer(): void {
    if (this.botTimer !== null) {
      clearTimeout(this.botTimer);
      this.botTimer = null;
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
      text: this.describeAction(playerId, type, amount),
      street,
    });
  }

  private describeAction(
    playerId: PlayerId,
    type: ActionTypeT,
    amount: number | undefined,
  ): string {
    const name = this.names.get(playerId) ?? playerId;
    const formatted = amount?.toLocaleString('it-IT') ?? '';

    switch (type) {
      case ActionType.Fold:
        return `${name} passa`;
      case ActionType.Check:
        return `${name} bussa`;
      case ActionType.Call:
        return `${name} chiama`;
      case ActionType.Bet:
        return `${name} punta ${formatted}`;
      case ActionType.Raise:
        return `${name} rilancia a ${formatted}`;
      case ActionType.AllIn:
        return `${name} va all-in`;
      default:
        return `${name} agisce`;
    }
  }

  /* ── Proiezione per il client ──────────────────────────── */

  private broadcast(): void {
    if (this.closed) return;

    try {
      this.sendState(this.buildView());
    } catch (error) {
      console.error(`Proiezione fallita nella stanza ${this.roomId}:`, error);
      this.sendError('Errore interno nella lettura del tavolo.');
    }
  }

  /**
   * Costruisce la vista destinata al giocatore umano.
   *
   * Qui avviene la censura: le carte degli altri esistono nello
   * stato del server ma non entrano nel messaggio, tranne a mano
   * conclusa e solo per chi non ha passato.
   */
  private buildView(): TableView {
    const state = this.state;
    const complete = state !== null && isHandComplete(state);

    const players: PlayerView[] = [...this.seats.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([playerId, seat]) => {
        const engineState = state?.players.find((p) => p.playerId === playerId);
        const isSelf = playerId === this.humanId;
        const holeCards = engineState?.holeCards ?? [];

        const visible =
          isSelf ||
          (complete && !this.folded.has(playerId) && holeCards.length > 0);

        return {
          playerId,
          name: this.names.get(playerId) ?? playerId,
          seat,
          stack: engineState?.stack ?? this.stacks.get(playerId) ?? 0,
          committedThisStreet: engineState?.committedThisStreet ?? 0,
          status: engineState?.status ?? PlayerStatus.SittingOut,
          isDealer: seat === this.dealerSeat,
          isBot: playerId !== this.humanId,
          holeCards: visible ? holeCards : null,
          holeCardCount: holeCards.length,
        };
      });

    const isYourTurn =
      state !== null && !complete && state.toActPlayerId === this.humanId;

    const yourStack = complete
      ? (this.stacks.get(this.humanId) ?? 0)
      : (state?.players.find((p) => p.playerId === this.humanId)?.stack ?? 0);

    return {
      handId: state?.handId ?? null,
      street: state?.street ?? null,
      communityCards: state?.communityCards ?? [],
      pot: state ? currentPotTotal(state) : 0,
      currentBet: state?.currentBet ?? 0,
      toActPlayerId: state?.toActPlayerId ?? null,
      yourPlayerId: this.humanId,
      players,
      availableActions: isYourTurn && state ? getAvailableActions(state) : [],
      isYourTurn,
      isHandComplete: complete,
      canStartNextHand: (state === null || complete) && yourStack > 0,
      isBusted: complete && yourStack <= 0,
      payouts: complete ? (state?.payouts ?? []) : [],
      blinds: this.config.blinds,
      log: this.log,
    };
  }
      }
