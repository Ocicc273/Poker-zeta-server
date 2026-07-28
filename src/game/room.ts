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

import {
  chargeRake,
  computeRake,
  rakeableTotal,
} from './rake.js';

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

/** Quanti avversari siedono al tavolo. Serve al gestore delle stanze. */
export const BOT_COUNT = BOTS.length;

/**
 * Pausa prima di ogni azione dei bot.
 *
 * Sul server ha un secondo scopo oltre alla leggibilità: senza
 * pausa, una mano fra soli bot si risolverebbe in un ciclo stretto
 * bloccando il thread.
 */
const BOT_THINK_MS = 900;

/**
 * Tempo concesso al giocatore per agire.
 *
 * Non è una scortesia: senza scadenza un solo giocatore assente
 * blocca il tavolo a tempo indeterminato. Venticinque secondi
 * bastano per una decisione ponderata e non fanno addormentare
 * chi aspetta.
 */
const TURN_MS = 25_000;

/* ── Stanza ──────────────────────────────────────────────── */

export interface RoomOptions {
  roomId: string;
  humanPlayerId: PlayerId;
  humanName: string;
  buyIn: unknown;
  /**
   * Stack iniziale di ogni bot, nello stesso ordine di BOTS.
   *
   * Arrivano dall'esterno perché provengono dal bankroll, che è
   * finito: inventarli qui dentro era il modo in cui i tavoli
   * contro bot stampavano Z-Coins.
   */
  botStacks: readonly number[];
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
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private turnDeadline: number | null = null;
  private closed = false;
  private rakeCollected = 0;na8

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

    
    BOTS.forEach((bot, index) => {
      this.names.set(bot.playerId, bot.name);
      this.seats.set(bot.playerId, bot.seat);
      this.stacks.set(bot.playerId, options.botStacks[index] ?? 0);
    });
  }

  /* ── Ciclo di vita ─────────────────────────────────────── */

  /** Avvia la prima mano e trasmette lo stato iniziale. */
  start(): void {
    this.startNextHand();
  }

  /** Chiude la stanza e annulla ogni conto alla rovescia. */
  close(): void {
    this.closed = true;
    this.clearBotTimer();
    this.clearTurnTimer();
  }

  /**
   * Stack attuale del giocatore umano.
   *
   * Serve al riaccredito quando lascia il tavolo. Le fiche già
   * versate nel piatto NON contano: restituirle renderebbe
   * l'uscita a metà mano un modo per annullare una puntata
   * perdente. Uscire equivale a foldare, e chi folda le lascia lì.
   */
  humanStack(): number {
    const state = this.state;

    if (state !== null && !isHandComplete(state)) {
      const inHand = state.players.find((p) => p.playerId === this.humanId);
      if (inHand) {
        return inHand.stack;
      }
    }

    return this.stacks.get(this.humanId) ?? 0;
  }
/**
   * Fiche complessive ancora in mano ai bot.
   *
   * Serve a restituirle al bankroll quando il tavolo chiude. Come
   * per il giocatore umano, quelle già versate nel piatto non
   * contano: appartengono alla mano in corso, non al pool.
   */
  botStacksTotal(): number {
    const state = this.state;
    let total = 0;

    for (const bot of BOTS) {
      if (state !== null && !isHandComplete(state)) {
        const inHand = state.players.find((p) => p.playerId === bot.playerId);
        total += inHand ? inHand.stack : (this.stacks.get(bot.playerId) ?? 0);
      } else {
        total += this.stacks.get(bot.playerId) ?? 0;
      }
    }

    return total;

    /** Rake trattenuto da questa stanza finora. */
  rakeTotal(): number {
    return this.rakeCollected;
  }

  /**
   * Trattiene il rake su una mano appena conclusa e
   * restituisce lo stato già al netto.
   *
   * Si decurtano sia gli stack sia i payouts: la vista
   * mostra al giocatore quello che ha davvero incassato,
   * non la cifra lorda.
   */
  private settleHand(next: HandState): HandState {
    const amounts = next.players.map((p) => p.committedTotal);

    const rake = computeRake({
      pot: rakeableTotal(amounts),
      bigBlind: this.config.blinds.bigBlind,
      sawFlop: next.communityCards.length >= 3,
      contested: amounts.filter((a) => a > 0).length >= 2,
    });

    if (rake <= 0) return next;

    const { charges, taken } = chargeRake(
      next.payouts.map((p) => ({
        playerId: p.playerId,
        amount: p.amount,
      })),
      rake,
    );

    if (taken <= 0) return next;

    const charged = new Map(
      charges.map((c) => [c.playerId, c.amount]),
    );

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
  }
  /**
   * Ritrasmette lo stato corrente.
   *
   * Serve a un client che si riattacca a una partita già in corso:
   * ha perso tutti gli aggiornamenti mentre era via e deve
   * ricevere la fotografia di adesso, non ricominciare.
   */
  resendState(): void {
    this.broadcast();
  }

  /**
   * Se il giocatore può alzarsi adesso.
   *
   * Con fiche impegnate in una mano in corso non si esce: sarebbe
   * un modo per annullare una puntata perdente. Dopo un fold, o
   * fra una mano e l'altra, è libero di andarsene.
   *
   * Vale anche per chi è all-in: le sue fiche sono nel piatto e
   * potrebbe ancora vincerlo, quindi uscire lo danneggerebbe.
   */
  canLeave(): boolean {
    const state = this.state;
    if (state === null || isHandComplete(state)) return true;

    const inHand = state.players.find((p) => p.playerId === this.humanId);
    if (!inHand) return true;

    return inHand.status === PlayerStatus.Folded;
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
      // Azione rifiutata dal motore: lo stato resta quello di prima
      // e il conto alla rovescia continua, perché il turno non è
      // stato consumato.
      this.sendError((error as Error).message);
      this.broadcast();
      return;
    }

    this.appendLog(playerId, type, amount, current.street);

   if (type === ActionType.Fold) {
      // Serve a decidere chi mostra le carte allo showdown.
      this.folded.add(playerId);
    }

    if (isHandComplete(next)) {
      next = this.settleHand(next);
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

  /* ── Turno del giocatore ───────────────────────────────── */

  private clearTurnTimer(): void {
    if (this.turnTimer !== null) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    this.turnDeadline = null;
  }

  /**
   * Allinea il conto alla rovescia allo stato corrente.
   *
   * Viene invocato a ogni trasmissione. Se il turno era già in
   * corso il conto NON riparte: una ritrasmissione dello stato,
   * per esempio dopo una riconnessione, non deve regalare tempo.
   */
  private refreshTurnTimer(): void {
    const state = this.state;
    const isHumanTurn =
      state !== null &&
      !isHandComplete(state) &&
      state.toActPlayerId === this.humanId;

    if (!isHumanTurn) {
      this.clearTurnTimer();
      return;
    }

    if (this.turnTimer !== null) return;

    this.turnDeadline = Date.now() + TURN_MS;
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      this.forceTurnTimeout();
    }, TURN_MS);
  }

  /**
   * Il tempo è scaduto: agisce il server.
   *
   * Check se non costa nulla, altrimenti fold. Un timeout non deve
   * mai impegnare fiche che il giocatore non ha scelto di mettere.
   * Bui e ante restano dovuti: quelli li versa il motore all'inizio
   * della mano, non dipendono da questa decisione.
   */
  private forceTurnTimeout(): void {
    if (this.closed) return;

    // Gira dentro un setTimeout: un'eccezione qui non avrebbe
    // nessuno sopra a raccoglierla e abbatterebbe il processo.
    try {
      const state = this.state;
      if (!state || isHandComplete(state)) return;
      if (state.toActPlayerId !== this.humanId) return;

      const available = getAvailableActions(state);
      if (available.length === 0) return;

      const has = (type: ActionTypeT): boolean =>
        available.some((a) => a.type === type);

      const type = has(ActionType.Check)
        ? ActionType.Check
        : has(ActionType.Fold)
          ? ActionType.Fold
          : available[0]!.type;

      this.clearTurnTimer();
      this.sendError('Tempo scaduto.');
      this.applyAndBroadcast(this.humanId, type);
      this.scheduleBotTurn();
    } catch (error) {
      console.error(
        `Timeout di turno fallito nella stanza ${this.roomId}:`,
        error,
      );
    }
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

    // Il conto alla rovescia si allinea prima di trasmettere, così
    // la vista porta con sé il tempo rimasto.
    this.refreshTurnTimer();

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
      turnMillisLeft:
        this.turnDeadline !== null
          ? Math.max(0, this.turnDeadline - Date.now())
          : null,
      isHandComplete: complete,
      canStartNextHand: (state === null || complete) && yourStack > 0,
      isBusted: complete && yourStack <= 0,
      payouts: complete ? (state?.payouts ?? []) : [],
      blinds: this.config.blinds,
      log: this.log,
    };
  }
  }
