/**
 * Poker Zeta — Tavolo Twister
 *
 * Tre giocatori, un umano e due bot, fiche da torneo e bui che
 * salgono: si finisce in pochi minuti e c'è un solo vincitore
 * (quasi sempre). È il formato pensato per il telefono, dove una
 * sessione dura il tempo di una fila alla posta.
 *
 * DUE MONETE DA NON CONFONDERE:
 * — dentro la partita si gioca con FICHE DA TORNEO, che nascono e
 *   muoiono col tavolo e non valgono nulla fuori;
 * — il buy-in e il premio sono in Z-COINS, e il premio dipende dal
 *   PIAZZAMENTO e dal moltiplicatore, non da quante fiche avevi.
 * Il motore non sa niente del denaro, e il denaro non dipende dal
 * motore. È la ragione per cui qui non c'è rake: il margine sta
 * già nella tabella dei moltiplicatori.
 *
 * Il moltiplicatore lo estrae CHI COSTRUISCE la stanza, non lei:
 * va conosciuto e mostrato prima che la prima mano cominci, ed è
 * il gestore a doverlo comunicare al bankroll.
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

import { prizeSplit, TWISTER_SEATS } from './twister-multipliers.js';

import type { ActionLogEntry, PlayerView, TableView } from './protocol.js';

/* ── Costanti del formato ────────────────────────────────── */

/** Fiche da torneo di partenza. 25 big blind: hyper-turbo. */
const STARTING_CHIPS = 500;

/**
 * Struttura dei bui. Si sale ogni SALITA_OGNI mani.
 *
 * Non è a tempo ma a mani giocate: col tempo, un giocatore che
 * pensa a lungo si troverebbe i bui saliti senza aver giocato, e
 * dal telefono capita di mettere via il telefono a metà mano.
 */
const BLINDS: readonly { small: number; big: number }[] = [
  { small: 10, big: 20 },
  { small: 15, big: 30 },
  { small: 20, big: 40 },
  { small: 30, big: 60 },
  { small: 50, big: 100 },
  { small: 75, big: 150 },
  { small: 100, big: 200 },
  { small: 150, big: 300 },
  { small: 200, big: 400 },
  { small: 300, big: 600 },
] as const;

const SALITA_OGNI = 3;

/** Buy-in ammessi, in Z-Coins. Scala per dieci dell'8 agosto. */
export const TWISTER_BUY_INS: readonly number[] = [
  2_000, 5_000, 10_000, 25_000, 50_000, 100_000,
] as const;

/** Riporta un buy-in richiesto al più vicino fra quelli ammessi. */
export function sanitizeTwisterBuyIn(raw: unknown): number {
  const valore = Number(raw);
  if (!Number.isFinite(valore)) return TWISTER_BUY_INS[0]!;

  return TWISTER_BUY_INS.reduce((migliore, candidato) =>
    Math.abs(candidato - valore) < Math.abs(migliore - valore)
      ? candidato
      : migliore,
  );
}

const TURN_MS = 20_000;
const BOT_THINK_MS = 800;
/** Pausa fra una mano e l'altra: qui parte da sola. */
const NEXT_HAND_MS = 2_500;

/* ── Avversari ───────────────────────────────────────────── */

interface BotDefinition {
  playerId: PlayerId;
  name: string;
  profile: BotProfile;
  seat: number;
}

const BOTS: readonly BotDefinition[] = [
  { playerId: 'bot-1', name: 'Tricky', profile: 'loose', seat: 1 },
  { playerId: 'bot-2', name: 'Boss', profile: 'tight', seat: 2 },
];

export const TWISTER_BOT_COUNT = BOTS.length;

/* ── Esito ───────────────────────────────────────────────── */

export interface TwisterPrize {
  playerId: PlayerId;
  /** Piazzamento, 1 = vincitore. */
  place: number;
  /** Z-Coins spettanti. Zero è legittimo. */
  zCoins: number;
}

export interface TwisterResult {
  multiplier: number;
  buyIn: number;
  /** Montepremi totale in Z-Coins: moltiplicatore × buy-in. */
  pool: number;
  /** Dal primo all'ultimo. */
  ranking: readonly PlayerId[];
  prizes: readonly TwisterPrize[];
  /**
   * Z-Coins che NON vanno a nessuno e tornano al bankroll:
   * i tre buy-in raccolti meno il montepremi. È il margine del
   * formato, e va restituito al pool o il bankroll si erode.
   */
  residuo: number;
}

export interface TwisterRoomOptions {
  roomId: string;
  humanPlayerId: PlayerId;
  humanName: string;
  /** Già normalizzato con sanitizeTwisterBuyIn. */
  buyIn: number;
  /** Estratto da drawMultiplier() prima di costruire la stanza. */
  multiplier: number;
  sendState: (view: TableView) => void;
  sendError: (message: string) => void;
  /** Chiamata una volta sola, a partita finita. */
  onFinish: (result: TwisterResult) => void;
}

/* ── Stanza ──────────────────────────────────────────────── */

export class TwisterRoom {
  readonly roomId: string;
  readonly multiplier: number;
  readonly buyIn: number;

  private readonly humanId: PlayerId;
  private readonly names = new Map<PlayerId, string>();
  private readonly seats = new Map<PlayerId, number>();
  /** FICHE DA TORNEO, non Z-Coins. */
  private readonly chips = new Map<PlayerId, number>();

  private readonly sendState: (view: TableView) => void;
  private readonly sendError: (message: string) => void;
  private readonly onFinish: (result: TwisterResult) => void;

  private state: HandState | null = null;
  private log: ActionLogEntry[] = [];
  private logId = 0;
  private folded = new Set<PlayerId>();
  private dealerSeat = 0;
  private handsPlayed = 0;
  private blindLevel = 0;

  /** Eliminati in ordine di uscita: il primo uscito è l'ultimo in classifica. */
  private eliminati: PlayerId[] = [];

  private botTimer: ReturnType<typeof setTimeout> | null = null;
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private turnDeadline: number | null = null;
  private nextHandTimer: ReturnType<typeof setTimeout> | null = null;

  private closed = false;
  private finita = false;

  constructor(options: TwisterRoomOptions) {
    this.roomId = options.roomId;
    this.multiplier = options.multiplier;
    this.buyIn = options.buyIn;
    this.humanId = options.humanPlayerId;
    this.sendState = options.sendState;
    this.sendError = options.sendError;
    this.onFinish = options.onFinish;

    this.names.set(this.humanId, options.humanName);
    this.seats.set(this.humanId, 0);
    this.chips.set(this.humanId, STARTING_CHIPS);

    for (const bot of BOTS) {
      this.names.set(bot.playerId, bot.name);
      this.seats.set(bot.playerId, bot.seat);
      this.chips.set(bot.playerId, STARTING_CHIPS);
    }
  }

  /* ── Ciclo di vita ─────────────────────────────────────── */

  start(): void {
    this.annuncia(`Moltiplicatore ${this.multiplier}×`);
    this.avviaMano();
  }

  close(): void {
    this.closed = true;
    this.clearBotTimer();
    this.clearTurnTimer();
    if (this.nextHandTimer !== null) {
      clearTimeout(this.nextHandTimer);
      this.nextHandTimer = null;
    }
  }

  resendState(): void {
    this.broadcast();
  }

  /**
   * Nel Twister non si esce: il buy-in è speso e il piazzamento
   * dipende dall'ordine di eliminazione. Chi abbandona viene
   * foldato dal timer a ogni turno finché non finisce le fiche.
   */
  canLeave(): boolean {
    return this.finita;
  }

  private get config(): TableConfig {
    const livello = BLINDS[Math.min(this.blindLevel, BLINDS.length - 1)]!;
    return {
      maxSeats: TWISTER_SEATS,
      blinds: { smallBlind: livello.small, bigBlind: livello.big, ante: 0 },
      structure: 'no-limit',
    };
  }

  /* ── Mani ──────────────────────────────────────────────── */
/**
   * La partita è decisa quando resta un solo giocatore con fiche
   * OPPURE quando l'umano è fuori: il suo piazzamento è fissato
   * nell'istante dell'eliminazione, e restare a guardare due bot
   * non aggiunge niente — nemmeno ai conti, perché le quote dei
   * bot tornano al pool in ogni caso.
   */
  private decisa(): boolean {
    return this.vivi().length <= 1 || (this.chips.get(this.humanId) ?? 0) <= 0;
  }

  private vivi(): PlayerId[] {
  private vivi(): PlayerId[] {
    return [...this.chips.entries()]
      .filter(([, c]) => c > 0)
      .map(([id]) => id);
  }

  private avviaMano(): void {
    if (this.closed || this.finita) return;

    const vivi = this.vivi();
    if (this.decisa()) {
      this.concludi();
      return;
    }

    // I bui salgono a mani giocate, non a tempo.
    this.blindLevel = Math.min(
      Math.floor(this.handsPlayed / SALITA_OGNI),
      BLINDS.length - 1,
    );

    const partecipanti = vivi
      .map((playerId) => ({
        playerId,
        seat: this.seats.get(playerId) ?? 0,
        stack: this.chips.get(playerId) ?? 0,
      }))
      .sort((a, b) => a.seat - b.seat);

    const occupati = partecipanti.map((p) => p.seat);
    let guard = 0;
    while (!occupati.includes(this.dealerSeat) && guard < TWISTER_SEATS) {
      this.dealerSeat = (this.dealerSeat + 1) % TWISTER_SEATS;
      guard += 1;
    }

    try {
      this.state = startHand(
        `${this.roomId}-${this.handsPlayed + 1}`,
        this.config,
        partecipanti,
        this.dealerSeat,
      );
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

  handleHumanAction(type: ActionTypeT, amount?: number): void {
    if (this.closed || this.finita) return;

    const state = this.state;
    if (!state) {
      this.sendError('Nessuna mano in corso.');
      return;
    }
    if (isHandComplete(state)) {
      this.sendError('La mano è conclusa.');
      return;
    }
    if (state.toActPlayerId !== this.humanId) {
      this.sendError('Non è il tuo turno.');
      return;
    }

    this.applica(this.humanId, type, amount);
    this.scheduleBotTurn();
  }

  private applica(
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
      this.sendError((error as Error).message);
      this.broadcast();
      return;
    }

    this.appendLog(playerId, type, amount, current.street);
    if (type === ActionType.Fold) this.folded.add(playerId);

    this.state = next;

    // NESSUN RAKE qui: il margine del formato sta nella tabella dei
    // moltiplicatori. Trattenere anche sulle mani sarebbe un
    // secondo prelievo su un montepremi già deciso.
    if (isHandComplete(next)) {
      for (const p of next.players) {
        this.chips.set(p.playerId, p.stack);
      }

      // Chi è appena finito a zero esce, e l'ordine di uscita è la
      // classifica letta al rovescio.
      for (const p of next.players) {
        if ((this.chips.get(p.playerId) ?? 0) <= 0 && !this.eliminati.includes(p.playerId)) {
          this.eliminati.push(p.playerId);
          this.annuncia(`${this.names.get(p.playerId) ?? p.playerId} è fuori`);
        }
      }

      this.handsPlayed += 1;
      this.dealerSeat = (this.dealerSeat + 1) % TWISTER_SEATS;
      this.clearTurnTimer();
      this.clearBotTimer();

      if (this.decisa()) {
        this.broadcast();
        this.concludi();
        return;
      }

      this.nextHandTimer = setTimeout(() => {
        this.nextHandTimer = null;
        this.avviaMano();
      }, NEXT_HAND_MS);
    }

    this.broadcast();
  }

  /* ── Fine partita ──────────────────────────────────────── */

  /**
   * Chiude la partita e calcola i premi.
   *
   * La classifica è: chi è rimasto, poi gli eliminati dall'ultimo
   * uscito al primo. Il montepremi è moltiplicatore × buy-in, e
   * quello che avanza rispetto ai tre buy-in raccolti torna al
   * bankroll — è il margine del formato.
   */
  private concludi(): void {
    if (this.finita) return;
    this.finita = true;
    this.clearBotTimer();
    this.clearTurnTimer();

    const superstiti = this.vivi();
    const ranking: PlayerId[] = [
      ...superstiti,
      ...[...this.eliminati].reverse(),
    ];

    const pool = this.multiplier * this.buyIn;
    const quote = prizeSplit(this.multiplier);

    let distribuito = 0;
    const prizes: TwisterPrize[] = ranking.map((playerId, i) => {
      const quota = quote[i] ?? 0;
      // Per difetto: meglio un residuo che fiche create dal nulla.
      const zCoins = Math.floor(pool * quota);
      distribuito += zCoins;
      return { playerId, place: i + 1, zCoins };
    });

    const raccolto = this.buyIn * TWISTER_SEATS;

    const mio = prizes.find((p) => p.playerId === this.humanId);
    this.annuncia(
      mio && mio.zCoins > 0
        ? `${mio.place}° posto — ${mio.zCoins.toLocaleString('it-IT')} Z-Coins`
        : `${mio?.place ?? TWISTER_SEATS}° posto`,
    );

    this.broadcast();

    try {
      this.onFinish({
        multiplier: this.multiplier,
        buyIn: this.buyIn,
        pool,
        ranking,
        prizes,
        residuo: raccolto - distribuito,
      });
    } catch (error) {
      console.error(`Chiusura Twister ${this.roomId} fallita:`, error);
    }
  }

  /* ── Turno del giocatore ───────────────────────────────── */

  private clearTurnTimer(): void {
    if (this.turnTimer !== null) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    this.turnDeadline = null;
  }

  private refreshTurnTimer(): void {
    const state = this.state;
    const tocca =
      state !== null &&
      !isHandComplete(state) &&
      state.toActPlayerId === this.humanId;

    if (!tocca) {
      this.clearTurnTimer();
      return;
    }
    if (this.turnTimer !== null) return;

    this.turnDeadline = Date.now() + TURN_MS;
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      this.scadutoIlTurno();
    }, TURN_MS);
  }

  private scadutoIlTurno(): void {
    if (this.closed || this.finita) return;

    try {
      const state = this.state;
      if (!state || isHandComplete(state)) return;
      if (state.toActPlayerId !== this.humanId) return;

      const available = getAvailableActions(state);
      if (available.length === 0) return;

      const ha = (t: ActionTypeT): boolean => available.some((a) => a.type === t);
      const type = ha(ActionType.Check)
        ? ActionType.Check
        : ha(ActionType.Fold)
          ? ActionType.Fold
          : available[0]!.type;

      this.clearTurnTimer();
      this.sendError('Tempo scaduto.');
      this.applica(this.humanId, type);
      this.scheduleBotTurn();
    } catch (error) {
      console.error(`Timeout fallito nel Twister ${this.roomId}:`, error);
    }
  }

  /* ── Turni dei bot ─────────────────────────────────────── */

  private clearBotTimer(): void {
    if (this.botTimer !== null) {
      clearTimeout(this.botTimer);
      this.botTimer = null;
    }
  }

  private scheduleBotTurn(): void {
    if (this.closed || this.finita) return;

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
    if (this.closed || this.finita) return;

    // Gira dentro un setTimeout: un'eccezione qui non ha nessuno
    // sopra che la raccolga e abbatterebbe il processo.
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

      this.applica(bot.playerId, decision.type, decision.amount);
      this.scheduleBotTurn();
    } catch (error) {
      console.error(`Turno bot fallito nel Twister ${this.roomId}:`, error);
      this.sendError('Errore interno durante il turno di un avversario.');
    }
  }

  /* ── Registro ──────────────────────────────────────────── */

  /** Riga di registro che non viene da un'azione. */
  private annuncia(testo: string): void {
    this.logId += 1;
    this.log.push({
      id: this.logId,
      playerId: this.humanId,
      text: testo,
      street: this.state?.street ?? ('preflop' as Street),
    });
  }

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
    const name = this.names.get(playerId) ?? playerId;
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

  /* ── Proiezione ────────────────────────────────────────── */

  private broadcast(): void {
    if (this.closed) return;
    this.refreshTurnTimer();

    try {
      this.sendState(this.buildView());
    } catch (error) {
      console.error(`Proiezione fallita nel Twister ${this.roomId}:`, error);
    }
  }

  private buildView(): TableView {
    const state = this.state;
    const complete = state !== null && isHandComplete(state);

    const players: PlayerView[] = [...this.seats.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([playerId, seat]) => {
        const inMano = state?.players.find((p) => p.playerId === playerId);
        const isSelf = playerId === this.humanId;
        const holeCards = inMano?.holeCards ?? [];

        const visible =
          isSelf ||
          (complete && !this.folded.has(playerId) && holeCards.length > 0);

        return {
          playerId,
          name: this.names.get(playerId) ?? playerId,
          seat,
          stack: inMano?.stack ?? this.chips.get(playerId) ?? 0,
          committedThisStreet: inMano?.committedThisStreet ?? 0,
          status: inMano?.status ?? PlayerStatus.SittingOut,
          isDealer: seat === this.dealerSeat,
          isBot: playerId !== this.humanId,
          holeCards: visible ? holeCards : null,
          holeCardCount: holeCards.length,
        };
      });

    const tocca =
      state !== null && !complete && state.toActPlayerId === this.humanId;

    return {
      handId: state?.handId ?? null,
      street: state?.street ?? null,
      communityCards: state?.communityCards ?? [],
      pot: state ? currentPotTotal(state) : 0,
      currentBet: state?.currentBet ?? 0,
      toActPlayerId: state?.toActPlayerId ?? null,
      yourPlayerId: this.humanId,
      players,
      availableActions: tocca && state ? getAvailableActions(state) : [],
      isYourTurn: tocca,
      turnMillisLeft:
        this.turnDeadline !== null
          ? Math.max(0, this.turnDeadline - Date.now())
          : null,
      isHandComplete: complete,
      // Qui la mano successiva parte da sola: nessun pulsante.
      canStartNextHand: false,
      // Nel Twister finire le fiche non è un incidente da riparare
      // col fondo: è l'eliminazione, e fa parte del gioco.
      isBusted: false,
      payouts: complete ? (state?.payouts ?? []) : [],
      blinds: this.config.blinds,
      log: this.log,
    };
  }
  }
