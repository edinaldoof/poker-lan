import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import type { Card } from '../../shared/cards';
import { formatChips } from '../../shared/format';
import { describeStartingHand, evaluateHand } from '../../shared/handEvaluator';
import {
  DEFAULT_CONFIG,
  MAX_SEATS,
  PLAYER_AVATARS,
  PLAYER_COLORS,
  type ActionType,
  type AwardView,
  type Backlog,
  type ClientToServerEvents,
  type GameEvent,
  type HandSummary,
  type JoinResponse,
  type LegalActions,
  type LogEntry,
  type Narration,
  type PlayerActionRequest,
  type PlayerStatus,
  type PotView,
  type RequestedActionType,
  type SeatView,
  type ServerToClientEvents,
  type Street,
  type TableConfig,
  type TableView,
} from '../../shared/protocol';
import { BOT_PERSONALITIES, botThinkTimeMs, decideBotAction, type BotContext, type BotPersonality } from './BotBrain';
import { actionFactsOf, buildBotContext as briefBot, describeHandStart } from './bots/publicContext';
import { BotTableMemory } from './bots/TableMemory';
import {
  EngineError,
  TableEngine,
  type EnginePlayerState,
  type HandStartResult,
  type SettleResult,
} from './TableEngine';
import {
  narrateAction,
  narrateAward,
  narrateBlind,
  narrateBust,
  narrateDeal,
  narrateDisconnect,
  narrateGameStart,
  narrateHandStart,
  narrateJoin,
  narrateLeave,
  narrateReconnect,
  narrateRebuy,
  narrateReveal,
  narrateSpectator,
  narrateStreet,
  narrateWaiting,
} from './narration';

type GameServer = Server<ClientToServerEvents, ServerToClientEvents>;
type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
type TimerHandle = ReturnType<typeof setTimeout>;

export interface GameControllerOptions {
  /** Read on every update: the machine's addresses change when it moves to another Wi-Fi network. */
  lanUrls: () => string[];
}

const SEAT_ASSIGNMENT_ORDER = [0, 4, 2, 6, 1, 5, 3, 7];

const NEXT_HAND_DELAY_MS = 1800;
const IDLE_RESUME_DELAY_MS = 600;
const BLIND_GAP_MS = 550;
const ACTION_GAP_MS = 450;
const ROUND_END_DELAY_MS = 650;
const COLLECT_DURATION_MS = 900;
const EMPTY_COLLECT_DURATION_MS = 250;
const STREET_WAIT_MS = { flop: 1700, turn: 1250, river: 1250 } as const;
const RUNOUT_REVEAL_WAIT_MS = 2200;
const RUNOUT_STREET_WAIT_MS = 2400;
const SHOWDOWN_REVEAL_TO_AWARD_MS = 2400;
const AWARD_TO_HAND_END_MS = 4800;
const UNCONTESTED_AWARD_TO_HAND_END_MS = 2600;
const EXTRA_POT_NARRATION_GAP_MS = 1900;
const DEALING_PADDING_MS = 500;
const DEALING_STAGGER_MS = 150;

const DISCONNECTED_TURN_MS = 8000;
const DISCONNECT_REMOVAL_MS = 120_000;
const SWEEP_INTERVAL_MS = 5000;
const BOT_DECISION_MARGIN_MS = 1000;

const RATE_LIMIT_MAX_MESSAGES = 30;
const RATE_LIMIT_WINDOW_MS = 2000;

const LOG_LIMIT = 60;
const HAND_HISTORY_LIMIT = 20;

const MAX_NAME_LENGTH = 16;
const MAX_SPECTATORS = 16;
const TOKEN_PATTERN = /^[\w-]{8,64}$/;
// Characters that draw nothing (controls, formatting and bidi marks, soft hyphen, fillers, variation selectors, tags)
// would let a player pose as another or sit with a blank name. U+2800 is the one blank glyph outside those classes.
const INVISIBLE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]/gu;
const VISIBLE_CHARACTER = /[\p{L}\p{N}\p{P}\p{S}]/u;
// Cyrillic, Greek and IPA letters that most fonts draw like a Latin letter, so a name written with them reads as
// another player's name (a trimmed subset of the Unicode UTS #39 confusables; the platform ships no such table).
const LOOKALIKES_BY_LATIN_LETTER: Readonly<Record<string, string>> = {
  A: '\u0410\u0391', // А Α
  B: '\u0412\u0392', // В Β
  C: '\u0421', // С
  E: '\u0415\u0395', // Е Ε
  H: '\u041D\u0397', // Н Η
  I: '\u0406\u0399', // І Ι
  J: '\u0408', // Ј
  K: '\u041A\u039A', // К Κ
  M: '\u041C\u039C', // М Μ
  N: '\u039D', // Ν
  O: '\u041E\u039F', // О Ο
  P: '\u0420\u03A1', // Р Ρ
  S: '\u0405', // Ѕ
  T: '\u0422\u03A4', // Т Τ
  X: '\u0425\u03A7', // Х Χ
  Y: '\u03A5', // Υ
  Z: '\u0396', // Ζ
  a: '\u0430\u03B1\u0251', // а α ɑ
  c: '\u0441\u03F2', // с ϲ
  d: '\u0501', // ԁ
  e: '\u0435', // е
  g: '\u0261', // ɡ
  h: '\u04BB', // һ
  i: '\u0456\u03B9\u0131', // і ι ı
  j: '\u0458', // ј
  l: '\u04CF', // ӏ
  o: '\u043E\u03BF', // о ο
  p: '\u0440\u03C1', // р ρ
  q: '\u051B', // ԛ
  s: '\u0455', // ѕ
  u: '\u03C5', // υ
  v: '\u03BD\u0475', // ν ѵ
  w: '\u051D', // ԝ
  x: '\u0445', // х
  y: '\u0443', // у
};
const LATIN_LETTER_BY_LOOKALIKE: ReadonlyMap<string, string> = new Map(
  Object.entries(LOOKALIKES_BY_LATIN_LETTER).flatMap(([latinLetter, lookalikes]) =>
    [...lookalikes].map((lookalike): [string, string] => [lookalike, latinLetter]),
  ),
);

const MAX_SMALL_BLIND = 10_000;
const MAX_BIG_BLIND = 20_000;
const MIN_STACK_IN_BIG_BLINDS = 20;
const MAX_STARTING_STACK = 1_000_000;
const MIN_TURN_SECONDS = 10;
const MAX_TURN_SECONDS = 120;

const ALLOWED_ACTIONS: ReadonlySet<string> = new Set<RequestedActionType>(['fold', 'check', 'call', 'raise', 'allIn']);
const PERSISTENT_ACTION_LABELS: ReadonlySet<string> = new Set(['Fold', 'All-In']);

type HandStage = 'idle' | 'staging' | 'betting' | 'resolving';

interface Profile {
  id: string;
  token: string;
  name: string;
  color: string;
  avatar: string;
  isBot: boolean;
  personality?: BotPersonality;
  seat: number | null;
  socketId: string | null;
  connected: boolean;
  disconnectedAt: number | null;
  leaving: boolean;
}

interface ActiveTurn {
  seat: number;
  token: number;
  deadline: number;
  durationMs: number;
  /** The configured limit, kept so a player who reconnects after a shortened turn gets it back. */
  fullDeadline: number;
  fullDurationMs: number;
}

interface HandState {
  active: boolean;
  stage: HandStage;
  cardsDealt: boolean;
  /** Blinds the engine already posted but the table has not announced yet. */
  pendingBlinds: Map<number, number>;
  revealed: Set<number>;
  lastActions: Map<number, string>;
  potsSettled: boolean;
  showdownStreet: boolean;
}

/** What stays on the felt between the end of a hand and the next deal. */
interface LeftoverDisplay {
  community: Card[];
  holeCards: Map<number, { cards: Card[]; folded: boolean }>;
}

interface SharedView {
  seats: (SeatView | null)[];
  privateCards: Map<number, Card[]>;
  community: Card[];
  pots: PotView[];
  street: Street;
  currentBet: number;
  turnLegal: LegalActions | null;
  handNames: Map<number, string | null>;
}

interface RoundOutcome {
  handComplete: boolean;
  roundComplete: boolean;
  nextActor: number | null;
}

interface Admission {
  response: JoinResponse;
  profile?: Profile;
  /** `isRepeat`: the very socket that is already bound to this connected profile asked to join again. */
  reclaimed?: { wasDisconnected: boolean; isRepeat: boolean };
}

interface JoinDetails {
  name: string;
  color: string;
  avatar: string;
  token: string;
}

type ParsedJoin = JoinDetails | { error: string };
type ConfigResolution = { config: TableConfig } | { error: string };

/** Timers that can be cancelled together; the epoch also neutralises callbacks that were already queued. */
class TimerBucket {
  private readonly handles = new Set<TimerHandle>();
  private epoch = 0;

  constructor(private readonly reportError: (error: unknown) => void) {}

  get pending(): boolean {
    return this.handles.size > 0;
  }

  schedule(delayMs: number, run: () => void): void {
    const scheduledEpoch = this.epoch;
    const handle = setTimeout(() => {
      this.handles.delete(handle);
      if (scheduledEpoch !== this.epoch) return;
      try {
        run();
      } catch (error) {
        this.reportError(error);
      }
    }, delayMs);
    this.handles.add(handle);
  }

  clear(): void {
    for (const handle of this.handles) clearTimeout(handle);
    this.handles.clear();
    this.epoch += 1;
  }
}

function createIdleHandState(): HandState {
  return {
    active: false,
    stage: 'idle',
    cardsDealt: false,
    pendingBlinds: new Map(),
    revealed: new Set(),
    lastActions: new Map(),
    potsSettled: false,
    showdownStreet: false,
  };
}

function toPotView(pot: { amount: number; eligibleSeats: number[] }): PotView {
  return { amount: pot.amount, eligibleSeats: [...pot.eligibleSeats] };
}

function truncateByCodePoints(text: string, maxLength: number): string {
  return [...text].slice(0, maxLength).join('');
}

function removeInvisibleAndCollapseSpaces(text: string): string {
  return text.replace(INVISIBLE_CHARACTERS, '').replace(/\s+/g, ' ').trim();
}

function sanitizeName(rawName: unknown): string {
  if (typeof rawName !== 'string') return '';
  const cleaned = removeInvisibleAndCollapseSpaces(rawName.normalize('NFC'));
  const name = truncateByCodePoints(cleaned, MAX_NAME_LENGTH).trim();
  return VISIBLE_CHARACTER.test(name) ? name : '';
}

/** Two names with the same skeleton look alike on the table, so they must not be seated together. */
function nameSkeleton(name: string): string {
  const withLatinLetters = [...name].map((character) => LATIN_LETTER_BY_LOOKALIKE.get(character) ?? character).join('');
  // NFKC after the substitution so a lookalike plus a combining accent composes like its Latin counterpart does.
  return removeInvisibleAndCollapseSpaces(withLatinLetters.normalize('NFKC')).toLowerCase();
}

function makeNameUnique(baseName: string, takenSkeletons: ReadonlySet<string>): string {
  if (!takenSkeletons.has(nameSkeleton(baseName))) return baseName;
  for (let suffix = 2; ; suffix += 1) {
    const tag = ` ${suffix}`;
    const candidate = `${truncateByCodePoints(baseName, MAX_NAME_LENGTH - tag.length)}${tag}`;
    if (!takenSkeletons.has(nameSkeleton(candidate))) return candidate;
  }
}

function parseJoinRequest(raw: unknown): ParsedJoin {
  if (typeof raw !== 'object' || raw === null) return { error: 'Pedido de entrada inválido.' };
  const request = raw as Record<string, unknown>;
  const name = sanitizeName(request.name);
  if (name.length === 0) return { error: 'Informe um nome com 1 a 16 caracteres.' };
  if (typeof request.token !== 'string' || !TOKEN_PATTERN.test(request.token)) {
    return { error: 'Identificador de sessão inválido. Recarregue a página.' };
  }
  const color = PLAYER_COLORS.find((candidate) => candidate === request.color) ?? PLAYER_COLORS[0];
  const avatar = PLAYER_AVATARS.find((candidate) => candidate === request.avatar) ?? PLAYER_AVATARS[0];
  return { name, color, avatar, token: request.token };
}

function parseActionRequest(raw: unknown): PlayerActionRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { type, amount } = raw as { type?: unknown; amount?: unknown };
  if (typeof type !== 'string' || !ALLOWED_ACTIONS.has(type)) return null;
  const requestedType = type as RequestedActionType;
  const hasAmount = amount !== undefined && amount !== null;
  if (hasAmount && !Number.isInteger(amount)) return null;
  if (requestedType === 'raise' && !hasAmount) return null;
  return hasAmount ? { type: requestedType, amount: amount as number } : { type: requestedType };
}

function isIntegerInRange(value: number, minimum: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function resolveStartConfig(current: TableConfig, requested: unknown): ConfigResolution {
  const partial = typeof requested === 'object' && requested !== null ? (requested as Record<string, unknown>) : {};
  const isProvided = (key: keyof TableConfig): boolean => partial[key] !== undefined && partial[key] !== null;
  const read = (key: keyof TableConfig, fallback: number): number =>
    isProvided(key) ? (partial[key] as number) : fallback;

  const smallBlind = read('smallBlind', current.smallBlind);
  const defaultBigBlind = isProvided('smallBlind') ? smallBlind * 2 : current.bigBlind;
  const bigBlind = read('bigBlind', defaultBigBlind);
  const startingStack = read('startingStack', current.startingStack);
  const turnSeconds = read('turnSeconds', current.turnSeconds);

  if (!isIntegerInRange(smallBlind, 1, MAX_SMALL_BLIND)) {
    return { error: `O small blind deve ser um inteiro entre 1 e ${formatChips(MAX_SMALL_BLIND)}.` };
  }
  if (!isIntegerInRange(bigBlind, smallBlind, MAX_BIG_BLIND)) {
    return { error: `O big blind deve ser um inteiro entre o small blind e ${formatChips(MAX_BIG_BLIND)}.` };
  }
  const minimumStack = MIN_STACK_IN_BIG_BLINDS * bigBlind;
  if (!isIntegerInRange(startingStack, minimumStack, MAX_STARTING_STACK)) {
    return {
      error: `O stack inicial deve estar entre ${formatChips(minimumStack)} e ${formatChips(MAX_STARTING_STACK)} fichas.`,
    };
  }
  if (!isIntegerInRange(turnSeconds, MIN_TURN_SECONDS, MAX_TURN_SECONDS)) {
    return { error: `O tempo por jogada deve ficar entre ${MIN_TURN_SECONDS} e ${MAX_TURN_SECONDS} segundos.` };
  }
  return { config: { smallBlind, bigBlind, startingStack, turnSeconds } };
}

function describeAction(action: ActionType, amount: number, totalBet: number): string {
  switch (action) {
    case 'fold':
      return 'Fold';
    case 'check':
      return 'Check';
    case 'call':
      return `Pagou ${formatChips(amount)}`;
    case 'bet':
      return `Apostou ${formatChips(totalBet)}`;
    case 'raise':
      return `Aumentou p/ ${formatChips(totalBet)}`;
    case 'allIn':
      return 'All-In';
  }
}

function describePotLabel(index: number, potCount: number): string {
  if (potCount === 1) return 'pote';
  return index === 0 ? 'pote principal' : `side pot ${index}`;
}

function fallbackRequest(legal: LegalActions | null): PlayerActionRequest {
  return legal?.canCheck ? { type: 'check' } : { type: 'fold' };
}

/** A call with nothing to pay can only mean "check" (a stale button after the bet changed). */
function interpretCallAsCheck(request: PlayerActionRequest, legal: LegalActions | null): PlayerActionRequest {
  return request.type === 'call' && legal?.canCheck && !legal.canCall ? { type: 'check' } : request;
}

export class GameController {
  private readonly engine: TableEngine;
  private readonly profiles = new Map<string, Profile>();
  private readonly profilesByToken = new Map<string, Profile>();
  private readonly seats: (Profile | null)[] = Array.from({ length: MAX_SEATS }, () => null);
  private readonly profileIdBySocketId = new Map<string, string>();
  private readonly botIdsInJoinOrder: string[] = [];

  private readonly flowTimers = new TimerBucket((error) => this.reportFailure(error));
  private readonly turnTimers = new TimerBucket((error) => this.reportFailure(error));
  private readonly nextHandTimers = new TimerBucket((error) => this.reportFailure(error));
  private sweepInterval: TimerHandle | null = null;

  private phase: TableView['phase'] = 'lobby';
  private config: TableConfig = { ...DEFAULT_CONFIG };
  private seq = 0;
  private turnCounter = 0;
  private turn: ActiveTurn | null = null;
  private hand: HandState = createIdleHandState();
  private leftover: LeftoverDisplay | null = null;
  private waitingAnnounced = false;
  private attached = false;
  private stopped = false;

  private readonly log: LogEntry[] = [];
  private readonly handSummaries: HandSummary[] = [];
  /** What the whole table has seen: the bots' only source of reads on the other players. */
  private readonly botMemory = new BotTableMemory();

  constructor(
    private readonly io: GameServer,
    private readonly options: GameControllerOptions,
  ) {
    this.engine = new TableEngine({ smallBlind: this.config.smallBlind, bigBlind: this.config.bigBlind });
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.io.on('connection', (socket) => this.handleConnection(socket));
    this.sweepInterval = setInterval(() => this.sweepAbsentPlayers(), SWEEP_INTERVAL_MS);
    this.sweepInterval.unref();
  }

  shutdown(): void {
    this.stopped = true;
    this.flowTimers.clear();
    this.turnTimers.clear();
    this.nextHandTimers.clear();
    this.turn = null;
    if (this.sweepInterval !== null) clearInterval(this.sweepInterval);
    this.sweepInterval = null;
  }

  // ---------------------------------------------------------------- connections

  private handleConnection(socket: GameSocket): void {
    this.limitMessageRate(socket);

    socket.on('table:join', (request, acknowledge) => {
      const reply = typeof acknowledge === 'function' ? acknowledge : () => undefined;
      let admission: Admission;
      try {
        admission = this.admit(socket, request);
      } catch (error) {
        this.reportFailure(error);
        reply({ ok: false, error: 'Erro interno ao entrar na mesa.' });
        return;
      }
      // The ack is sent exactly once: a later failure must not turn a successful join into an error reply.
      reply(admission.response);
      if (admission.response.ok) this.guarded(socket, () => this.announceArrival(socket, admission));
    });
    socket.on('table:action', (request) => this.guarded(socket, () => this.handleAction(socket, request)));
    socket.on('table:addBot', () => this.guarded(socket, () => this.handleAddBot(socket)));
    socket.on('table:removeBot', () => this.guarded(socket, () => this.handleRemoveBot(socket)));
    socket.on('table:start', (config) => this.guarded(socket, () => this.handleStart(socket, config)));
    socket.on('table:rebuy', () => this.guarded(socket, () => this.handleRebuy(socket)));
    socket.on('table:leave', () => this.guarded(socket, () => this.handleLeave(socket)));
    socket.on('disconnect', () => this.guarded(socket, () => this.handleDisconnect(socket)));

    this.sendSnapshot(socket);
  }

  private limitMessageRate(socket: GameSocket): void {
    let windowStart = Date.now();
    let messagesInWindow = 0;
    socket.use((_packet, next) => {
      const now = Date.now();
      if (now - windowStart >= RATE_LIMIT_WINDOW_MS) {
        windowStart = now;
        messagesInWindow = 0;
      }
      messagesInWindow += 1;
      if (messagesInWindow > RATE_LIMIT_MAX_MESSAGES) return;
      next();
    });
  }

  private guarded(socket: GameSocket, run: () => void): void {
    try {
      run();
    } catch (error) {
      this.reportFailure(error);
      this.sendError(socket, 'Erro interno do servidor.');
    }
  }

  private reportFailure(error: unknown): void {
    console.error('[Juiz] Erro inesperado:', error);
  }

  private sendError(socket: GameSocket, message: string): void {
    socket.emit('table:error', message);
  }

  private profileOfSocket(socketId: string): Profile | null {
    const profileId = this.profileIdBySocketId.get(socketId);
    return profileId === undefined ? null : (this.profiles.get(profileId) ?? null);
  }

  private bindSocket(socket: GameSocket, profile: Profile): void {
    this.profileIdBySocketId.set(socket.id, profile.id);
    profile.socketId = socket.id;
    profile.connected = true;
    profile.disconnectedAt = null;
  }

  private unbindSockets(profile: Profile): void {
    for (const [socketId, profileId] of [...this.profileIdBySocketId]) {
      if (profileId === profile.id) this.profileIdBySocketId.delete(socketId);
    }
    profile.socketId = null;
    profile.connected = false;
    profile.disconnectedAt ??= Date.now();
  }

  private findSocketIdOf(profile: Profile): string | null {
    for (const [socketId, profileId] of this.profileIdBySocketId) {
      if (profileId === profile.id) return socketId;
    }
    return null;
  }

  private handleDisconnect(socket: GameSocket): void {
    const profile = this.profileOfSocket(socket.id);
    this.profileIdBySocketId.delete(socket.id);
    if (!profile) return;

    profile.socketId = this.findSocketIdOf(profile);
    if (profile.socketId !== null) return;

    profile.connected = false;
    profile.disconnectedAt = Date.now();
    if (profile.seat === null) {
      this.discardProfile(profile);
      return;
    }
    this.publish({ kind: 'info' }, narrateDisconnect(profile.name));
    this.shortenTurnOfDisconnectedPlayer(profile.seat);
  }

  // ---------------------------------------------------------------- joining

  private admit(socket: GameSocket, rawRequest: unknown): Admission {
    const parsed = parseJoinRequest(rawRequest);
    if ('error' in parsed) return { response: { ok: false, error: parsed.error } };

    const existing = this.profilesByToken.get(parsed.token);
    const alreadyBound = this.profileOfSocket(socket.id);
    if (alreadyBound && alreadyBound !== existing) {
      return { response: { ok: false, error: 'Você já está nesta mesa.' } };
    }
    if (existing?.isBot) {
      return { response: { ok: false, error: 'Identificador de sessão inválido. Recarregue a página.' } };
    }
    return existing ? this.reclaimProfile(socket, existing, parsed) : this.admitNewcomer(socket, parsed);
  }

  private reclaimProfile(socket: GameSocket, profile: Profile, details: JoinDetails): Admission {
    const wasDisconnected = !profile.connected;
    const isRepeat = !wasDisconnected && this.profileOfSocket(socket.id) === profile;
    // A leave is only pending until the hand ends, so coming back cancels it. Someone who left saw the lobby and
    // may have picked another identity there, whereas a plain reconnect always keeps the one already on the table.
    if (profile.leaving) this.adoptIdentity(profile, details);
    this.bindSocket(socket, profile);
    profile.leaving = false;
    return { response: this.toJoinResponse(profile), profile, reclaimed: { wasDisconnected, isRepeat } };
  }

  private adoptIdentity(profile: Profile, details: JoinDetails): void {
    profile.name = this.uniqueName(details.name, profile);
    profile.color = details.color;
    profile.avatar = details.avatar;
  }

  private admitNewcomer(socket: GameSocket, details: JoinDetails): Admission {
    const seat = this.firstFreeSeat();
    if (seat === null && this.spectatorCount() >= MAX_SPECTATORS) {
      return { response: { ok: false, error: 'A mesa e a plateia estão lotadas.' } };
    }

    const profile: Profile = {
      id: randomUUID(),
      token: details.token,
      name: this.uniqueName(details.name),
      color: details.color,
      avatar: details.avatar,
      isBot: false,
      seat: null,
      socketId: null,
      connected: false,
      disconnectedAt: null,
      leaving: false,
    };
    this.profiles.set(profile.id, profile);
    this.profilesByToken.set(profile.token, profile);

    if (seat !== null) this.seatProfile(profile, seat);
    this.bindSocket(socket, profile);
    return { response: this.toJoinResponse(profile), profile };
  }

  private spectatorCount(): number {
    return [...this.profiles.values()].filter((profile) => profile.seat === null).length;
  }

  private announceArrival(socket: GameSocket, admission: Admission): void {
    const { profile, reclaimed } = admission;
    if (!profile) return;

    socket.emit('table:backlog', this.buildBacklog());
    // The socket already holds its personal view and nothing changed for anyone, so a broadcast would only
    // make every client redraw (and let one client flood the table by repeating its join).
    if (reclaimed?.isRepeat) return;

    if (reclaimed) {
      if (reclaimed.wasDisconnected && profile.seat !== null) this.restoreTurnOfReturningPlayer(profile.seat);
      const narration = reclaimed.wasDisconnected ? narrateReconnect(profile.name) : null;
      this.publish({ kind: 'info' }, narration);
    } else if (profile.seat !== null) {
      this.publish({ kind: 'playerJoined', seat: profile.seat }, narrateJoin(profile.name));
    } else {
      this.publish({ kind: 'info' }, narrateSpectator(profile.name));
    }
    this.resumeIfIdle();
  }

  private toJoinResponse(profile: Profile): JoinResponse {
    return { ok: true, playerId: profile.id, seat: profile.seat, spectator: profile.seat === null };
  }

  private uniqueName(baseName: string, renamedProfile?: Profile): string {
    const takenSkeletons = new Set(
      [...this.profiles.values()]
        .filter((profile) => profile !== renamedProfile)
        .map((profile) => nameSkeleton(profile.name)),
    );
    return makeNameUnique(baseName, takenSkeletons);
  }

  private firstFreeSeat(): number | null {
    return SEAT_ASSIGNMENT_ORDER.find((seat) => this.seats[seat] === null) ?? null;
  }

  private seatProfile(profile: Profile, seat: number): void {
    profile.seat = seat;
    this.seats[seat] = profile;
    this.engine.seatPlayer(seat, profile.id, this.config.startingStack);
  }

  private seatedEntries(): { profile: Profile; seat: number }[] {
    const entries: { profile: Profile; seat: number }[] = [];
    this.seats.forEach((profile, seat) => {
      if (profile) entries.push({ profile, seat });
    });
    return entries;
  }

  // ---------------------------------------------------------------- host controls

  private requireSeatedHuman(socket: GameSocket): { profile: Profile; seat: number } | null {
    const profile = this.profileOfSocket(socket.id);
    if (!profile || profile.isBot || profile.seat === null) {
      this.sendError(socket, 'Apenas jogadores sentados à mesa podem fazer isso.');
      return null;
    }
    return { profile, seat: profile.seat };
  }

  private handleAddBot(socket: GameSocket): void {
    if (!this.requireSeatedHuman(socket)) return;
    const seat = this.firstFreeSeat();
    if (seat === null) {
      this.sendError(socket, 'A mesa está cheia.');
      return;
    }
    const bot = this.createBotProfile();
    this.profiles.set(bot.id, bot);
    this.profilesByToken.set(bot.token, bot);
    this.botIdsInJoinOrder.push(bot.id);
    this.seatProfile(bot, seat);
    this.publish({ kind: 'playerJoined', seat }, narrateJoin(bot.name));
    this.resumeIfIdle();
  }

  private createBotProfile(): Profile {
    const botNamesInUse = new Set(
      this.botIdsInJoinOrder.map((id) => this.profiles.get(id)?.personality?.name).filter(Boolean),
    );
    const personality =
      BOT_PERSONALITIES.find((candidate) => !botNamesInUse.has(candidate.name)) ??
      BOT_PERSONALITIES[this.botIdsInJoinOrder.length % BOT_PERSONALITIES.length];
    const usedAvatars = new Set([...this.profiles.values()].map((profile) => profile.avatar));
    const usedColors = new Set([...this.profiles.values()].map((profile) => profile.color));
    const avatar =
      PLAYER_AVATARS.find((candidate) => !usedAvatars.has(candidate)) ??
      PLAYER_AVATARS[this.botIdsInJoinOrder.length % PLAYER_AVATARS.length];
    const color =
      PLAYER_COLORS.find((candidate) => !usedColors.has(candidate)) ??
      PLAYER_COLORS[this.botIdsInJoinOrder.length % PLAYER_COLORS.length];

    return {
      id: randomUUID(),
      token: `bot-${randomUUID()}`,
      name: this.uniqueName(`${personality.name} (Bot)`),
      color,
      avatar,
      isBot: true,
      personality,
      seat: null,
      socketId: null,
      connected: true,
      disconnectedAt: null,
      leaving: false,
    };
  }

  private handleRemoveBot(socket: GameSocket): void {
    if (!this.requireSeatedHuman(socket)) return;
    const removableId = [...this.botIdsInJoinOrder].reverse().find((id) => !this.profiles.get(id)?.leaving);
    const bot = removableId === undefined ? undefined : this.profiles.get(removableId);
    if (!bot) {
      this.sendError(socket, 'Não há bots na mesa.');
      return;
    }
    this.requestLeave(bot);
  }

  private handleStart(socket: GameSocket, requestedConfig: unknown): void {
    if (!this.requireSeatedHuman(socket)) return;
    if (this.phase !== 'lobby') {
      this.sendError(socket, 'A partida já começou.');
      return;
    }
    const resolution = resolveStartConfig(this.config, requestedConfig);
    if ('error' in resolution) {
      this.sendError(socket, resolution.error);
      return;
    }

    this.config = resolution.config;
    this.engine.setConfig({ smallBlind: this.config.smallBlind, bigBlind: this.config.bigBlind });
    this.resetStacksToStartingStack();
    this.botMemory.reset();
    this.phase = 'running';
    this.publish({ kind: 'info' }, narrateGameStart(this.config));
    this.resumeIfIdle(NEXT_HAND_DELAY_MS);
  }

  private resetStacksToStartingStack(): void {
    for (const { profile, seat } of this.seatedEntries()) {
      this.engine.removePlayer(seat);
      this.engine.seatPlayer(seat, profile.id, this.config.startingStack);
    }
  }

  private handleRebuy(socket: GameSocket): void {
    const seated = this.requireSeatedHuman(socket);
    if (!seated) return;
    const player = this.engine.getPlayer(seated.seat);
    if (!player) return;
    if (this.isInCurrentHand(seated.seat)) {
      this.sendError(socket, 'Aguarde o fim da mão para recomprar.');
      return;
    }
    if (player.chips > 0) {
      this.sendError(socket, 'Você ainda tem fichas na mesa.');
      return;
    }

    this.engine.addChips(seated.seat, this.config.startingStack);
    this.publish(
      { kind: 'rebuy', seat: seated.seat, amount: this.config.startingStack },
      narrateRebuy(seated.profile.name, this.config.startingStack),
    );
    this.resumeIfIdle();
  }

  private handleLeave(socket: GameSocket): void {
    const profile = this.profileOfSocket(socket.id);
    if (!profile) return;
    if (profile.seat === null) {
      this.profileIdBySocketId.delete(socket.id);
      this.discardProfile(profile);
      return;
    }
    // Detach every socket first so the leaver stops receiving a seat-bound view while the removal is pending.
    this.unbindSockets(profile);
    this.requestLeave(profile);
  }

  // ---------------------------------------------------------------- leaving and removal

  private requestLeave(profile: Profile): void {
    const seat = profile.seat;
    if (seat === null) {
      this.discardProfile(profile);
      return;
    }
    if (!this.isInCurrentHand(seat)) {
      this.removeSeatedProfile(profile, seat);
      return;
    }
    profile.leaving = true;
    this.foldLeavingPlayerWhileBetting(seat);
  }

  private isInCurrentHand(seat: number): boolean {
    return this.hand.active && this.engine.getPlayer(seat)?.inHand === true;
  }

  /**
   * Only a live betting round can take the fold now. After the betting is over the player stays in the
   * showdown (their chips are already in the pot); all-in players keep their claim on the pots.
   */
  private foldLeavingPlayerWhileBetting(seat: number): void {
    if (this.hand.stage !== 'betting') return;
    const player = this.engine.getPlayer(seat);
    if (!player || player.folded || player.allIn) return;

    if (this.turn?.seat === seat) {
      this.applyAction(seat, { type: 'fold' }, false);
      return;
    }
    const outcome = this.engine.foldOutOfTurn(seat);
    // The engine never folds the last live player (the hand is already decided in their favour).
    if (this.engine.getPlayer(seat)?.folded !== true) return;
    this.hand.lastActions.set(seat, describeAction('fold', 0, 0));
    this.botMemory.recordAction({ seat, street: this.engine.street, action: 'fold', amount: 0, totalBet: player.streetBet });
    this.publish(
      { kind: 'action', seat, action: 'fold', amount: 0, totalBet: player.streetBet, timedOut: false },
      narrateAction(this.nameOf(seat), 'fold', 0, player.streetBet, false),
    );
    // Without a live turn, the pending step re-reads the engine and notices the new state by itself.
    if (this.turn && (outcome.handComplete || outcome.roundComplete)) {
      this.cancelTurn();
      this.afterAction(outcome);
    }
  }

  private removeSeatedProfile(profile: Profile, seat: number): void {
    this.engine.removePlayer(seat);
    this.seats[seat] = null;
    this.clearLeftoversOfSeat(seat);
    this.discardProfile(profile);
    this.publish({ kind: 'playerLeft', seat }, narrateLeave(profile.name));
  }

  /** Hole cards, reveal flag and last action are keyed by seat; the next occupant must not inherit them. */
  private clearLeftoversOfSeat(seat: number): void {
    this.leftover?.holeCards.delete(seat);
    this.hand.revealed.delete(seat);
    this.hand.lastActions.delete(seat);
  }

  private discardProfile(profile: Profile): void {
    this.unbindSockets(profile);
    this.profiles.delete(profile.id);
    this.profilesByToken.delete(profile.token);
    const botIndex = this.botIdsInJoinOrder.indexOf(profile.id);
    if (botIndex >= 0) this.botIdsInJoinOrder.splice(botIndex, 1);
    this.botMemory.forgetPlayer(profile.id);
  }

  private removeLeavingPlayers(): void {
    for (const { profile, seat } of this.seatedEntries()) {
      if (profile.leaving) this.removeSeatedProfile(profile, seat);
    }
  }

  private sweepAbsentPlayers(): void {
    const now = Date.now();
    for (const profile of [...this.profiles.values()]) {
      if (profile.isBot || profile.connected || profile.leaving || profile.disconnectedAt === null) continue;
      if (now - profile.disconnectedAt > DISCONNECT_REMOVAL_MS) this.requestLeave(profile);
    }
  }

  private shortenTurnOfDisconnectedPlayer(seat: number): void {
    const turn = this.turn;
    if (!turn || turn.seat !== seat || turn.deadline - Date.now() <= DISCONNECTED_TURN_MS) return;

    turn.deadline = Date.now() + DISCONNECTED_TURN_MS;
    turn.durationMs = DISCONNECTED_TURN_MS;
    this.turnTimers.clear();
    this.turnTimers.schedule(DISCONNECTED_TURN_MS, () => this.handleTurnTimeout(turn.token));
    this.publish({ kind: 'turn', seat, deadline: turn.deadline, durationMs: turn.durationMs });
  }

  /** Never extends past the original deadline, so dropping and returning cannot buy extra time. */
  private restoreTurnOfReturningPlayer(seat: number): void {
    const turn = this.turn;
    if (!turn || turn.seat !== seat || turn.deadline >= turn.fullDeadline) return;

    turn.deadline = turn.fullDeadline;
    turn.durationMs = turn.fullDurationMs;
    this.turnTimers.clear();
    this.turnTimers.schedule(Math.max(0, turn.deadline - Date.now()), () => this.handleTurnTimeout(turn.token));
    this.publish({ kind: 'turn', seat, deadline: turn.deadline, durationMs: turn.durationMs });
  }

  // ---------------------------------------------------------------- hand loop: start of hand

  /** Schedules the next hand unless one is running or already scheduled. */
  private resumeIfIdle(delayMs = IDLE_RESUME_DELAY_MS): void {
    if (this.stopped || this.phase !== 'running' || this.hand.active || this.nextHandTimers.pending) return;
    this.nextHandTimers.schedule(delayMs, () => this.beginHand());
  }

  private beginHand(): void {
    if (this.stopped || this.phase !== 'running' || this.hand.active) return;
    this.prepareSeatsForDeal();
    // Bots alone at an empty table would play forever, so a hand needs someone watching or playing.
    if (!this.engine.canStartHand() || this.profileIdBySocketId.size === 0) {
      this.announceWaiting();
      return;
    }
    this.waitingAnnounced = false;
    this.startHand();
  }

  private prepareSeatsForDeal(): void {
    for (const { profile, seat } of this.seatedEntries()) {
      const player = this.engine.getPlayer(seat);
      if (!player) continue;
      if (profile.isBot && player.chips === 0 && !profile.leaving) {
        this.engine.addChips(seat, this.config.startingStack);
        this.publish(
          { kind: 'rebuy', seat, amount: this.config.startingStack },
          narrateRebuy(profile.name, this.config.startingStack),
        );
      }
      this.engine.setSittingOut(seat, !profile.isBot && !profile.connected);
    }
  }

  private announceWaiting(): void {
    if (this.waitingAnnounced) return;
    this.waitingAnnounced = true;
    this.publish({ kind: 'info' }, narrateWaiting());
  }

  private startHand(): void {
    this.flowTimers.clear();
    const start = this.engine.startHand();
    this.botMemory.beginHand(describeHandStart(start, (seat) => this.engine.getPlayer(seat)?.playerId, this.config.bigBlind));
    this.hand = {
      ...createIdleHandState(),
      active: true,
      stage: 'staging',
      pendingBlinds: new Map(start.blinds.map((blind) => [blind.seat, blind.amount])),
    };
    this.leftover = null;
    this.turn = null;

    this.publish(
      {
        kind: 'handStart',
        handNumber: start.handNumber,
        dealerSeat: start.dealerSeat,
        smallBlindSeat: start.smallBlindSeat,
        bigBlindSeat: start.bigBlindSeat,
      },
      narrateHandStart(start.handNumber, this.nameOf(start.dealerSeat), this.config.smallBlind, this.config.bigBlind),
    );
    const blindsInOrder = [...start.blinds].sort(
      (first, second) => Number(first.blind === 'big') - Number(second.blind === 'big'),
    );
    this.flowTimers.schedule(BLIND_GAP_MS, () => this.postBlind(start, blindsInOrder, 0));
  }

  private postBlind(start: HandStartResult, blinds: HandStartResult['blinds'], index: number): void {
    const blind = blinds[index];
    if (!blind) {
      this.dealHoleCards(start);
      return;
    }
    this.hand.pendingBlinds.delete(blind.seat);
    this.hand.lastActions.set(blind.seat, blind.blind === 'small' ? 'SB' : 'BB');
    this.publish(
      { kind: 'blind', seat: blind.seat, amount: blind.amount, blind: blind.blind },
      narrateBlind(this.nameOf(blind.seat), blind.amount, blind.blind),
    );
    this.flowTimers.schedule(BLIND_GAP_MS, () => this.postBlind(start, blinds, index + 1));
  }

  private dealHoleCards(start: HandStartResult): void {
    this.hand.cardsDealt = true;
    this.publish({ kind: 'dealHole', seats: [...start.dealOrder] }, narrateDeal());
    const dealingWait =
      DEALING_PADDING_MS + start.dealOrder.length * 2 * DEALING_STAGGER_MS + DEALING_PADDING_MS;
    this.flowTimers.schedule(dealingWait, () => this.promptNextActor());
  }

  // ---------------------------------------------------------------- hand loop: betting

  /** Reads the engine at fire time, so seats that folded or left while the step waited are handled. */
  private promptNextActor(): void {
    this.flowTimers.clear();
    const acting = this.engine.actingSeat;
    if (acting === null || this.engine.nonFoldedSeats().length <= 1) {
      this.closeBettingRound();
      return;
    }
    this.beginTurn(acting);
  }

  private closeBettingRound(): void {
    this.hand.stage = 'resolving';
    this.flowTimers.clear();
    this.flowTimers.schedule(ROUND_END_DELAY_MS, () => this.collectBets());
  }

  private beginTurn(seat: number): void {
    this.cancelTurn();
    this.hand.stage = 'betting';
    const profile = this.seats[seat];
    if (!profile || profile.leaving) {
      this.applyAction(seat, { type: 'fold' }, false);
      return;
    }
    const legal = this.engine.getLegalActions(seat);
    if (!legal) {
      this.reportFailure(new Error(`O motor não reconhece o assento ${seat} como o jogador da vez.`));
      return;
    }

    const isAbsentHuman = !profile.isBot && !profile.connected;
    const fullDurationMs = this.config.turnSeconds * 1000;
    const durationMs = isAbsentHuman ? DISCONNECTED_TURN_MS : fullDurationMs;
    const startedAt = Date.now();
    this.turnCounter += 1;
    const turn: ActiveTurn = {
      seat,
      token: this.turnCounter,
      deadline: startedAt + durationMs,
      durationMs,
      fullDeadline: startedAt + fullDurationMs,
      fullDurationMs,
    };
    this.turn = turn;
    this.publish({ kind: 'turn', seat, deadline: turn.deadline, durationMs });

    this.turnTimers.schedule(durationMs, () => this.handleTurnTimeout(turn.token));
    if (profile.isBot) this.scheduleBotDecision(turn, profile, legal);
  }

  private scheduleBotDecision(turn: ActiveTurn, profile: Profile, legal: LegalActions): void {
    const context = this.buildBotContext(turn.seat, profile, legal);
    const thinkMs = context ? botThinkTimeMs(context) : 0;
    const boundedThinkMs = Math.min(thinkMs, Math.max(0, turn.durationMs - BOT_DECISION_MARGIN_MS));
    this.turnTimers.schedule(boundedThinkMs, () => this.handleBotTurn(turn.token));
  }

  /** The bot gets its own cards and public facts only; the engine itself never reaches the bot brain. */
  private buildBotContext(seat: number, profile: Profile, legal: LegalActions): BotContext | null {
    if (!profile.personality) return null;
    return briefBot(this.engine, seat, profile.personality, legal, this.config.bigBlind, this.botMemory);
  }

  private isCurrentTurn(token: number): ActiveTurn | null {
    return this.turn !== null && this.turn.token === token ? this.turn : null;
  }

  private handleBotTurn(token: number): void {
    const turn = this.isCurrentTurn(token);
    if (!turn) return;
    this.actAutomatically(turn, this.chooseBotRequest(turn.seat), false);
  }

  private handleTurnTimeout(token: number): void {
    const turn = this.isCurrentTurn(token);
    if (!turn) return;
    this.actAutomatically(turn, fallbackRequest(this.engine.getLegalActions(turn.seat)), true);
  }

  private chooseBotRequest(seat: number): PlayerActionRequest {
    const legal = this.engine.getLegalActions(seat);
    const profile = this.seats[seat];
    if (!legal || !profile) return fallbackRequest(legal);
    try {
      const context = this.buildBotContext(seat, profile, legal);
      return context ? decideBotAction(context) : fallbackRequest(legal);
    } catch (error) {
      this.reportFailure(error);
      return fallbackRequest(legal);
    }
  }

  private actAutomatically(turn: ActiveTurn, request: PlayerActionRequest, timedOut: boolean): void {
    try {
      this.applyAction(turn.seat, request, timedOut);
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      this.applyAction(turn.seat, fallbackRequest(this.engine.getLegalActions(turn.seat)), timedOut);
    }
  }

  private handleAction(socket: GameSocket, rawRequest: unknown): void {
    const profile = this.profileOfSocket(socket.id);
    if (!profile || profile.seat === null) {
      this.sendError(socket, 'Você está assistindo e não pode jogar.');
      return;
    }
    const request = parseActionRequest(rawRequest);
    if (!request) {
      this.sendError(socket, 'Jogada inválida.');
      return;
    }
    if (!this.turn || this.turn.seat !== profile.seat) {
      this.sendError(socket, 'Não é a sua vez.');
      return;
    }
    try {
      this.applyAction(profile.seat, interpretCallAsCheck(request, this.engine.getLegalActions(profile.seat)), false);
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      this.sendError(socket, `Jogada inválida: ${error.message}`);
    }
  }

  /** Single entry point for every action; the engine throws before anything else changes. */
  private applyAction(seat: number, request: PlayerActionRequest, timedOut: boolean): void {
    const street = this.engine.street;
    const result = this.engine.act(seat, request);
    this.botMemory.recordAction(actionFactsOf(street, result));
    this.cancelTurn();
    this.hand.lastActions.set(seat, describeAction(result.action, result.amount, result.totalBet));
    this.publish(
      {
        kind: 'action',
        seat,
        action: result.action,
        amount: result.amount,
        totalBet: result.totalBet,
        timedOut,
      },
      narrateAction(this.nameOf(seat), result.action, result.amount, result.totalBet, timedOut),
    );
    this.afterAction(result);
  }

  private afterAction(outcome: RoundOutcome): void {
    if (outcome.handComplete || outcome.roundComplete || outcome.nextActor === null) {
      this.closeBettingRound();
      return;
    }
    this.flowTimers.clear();
    this.flowTimers.schedule(ACTION_GAP_MS, () => this.promptNextActor());
  }

  private cancelTurn(): void {
    this.turnTimers.clear();
    this.turn = null;
  }

  // ---------------------------------------------------------------- hand loop: streets and showdown

  private collectBets(): void {
    this.flowTimers.clear();
    const collected = this.engine.collectBets();
    for (const [seat, label] of [...this.hand.lastActions]) {
      if (!PERSISTENT_ACTION_LABELS.has(label)) this.hand.lastActions.delete(seat);
    }
    this.publish({
      kind: 'collect',
      returned: collected.returned.map((entry) => ({ seat: entry.seat, amount: entry.amount })),
      pots: collected.pots.map(toPotView),
    });
    const movedChips = collected.collected > 0 || collected.returned.length > 0;
    this.flowTimers.schedule(movedChips ? COLLECT_DURATION_MS : EMPTY_COLLECT_DURATION_MS, () =>
      this.resolveAfterCollect(),
    );
  }

  private resolveAfterCollect(): void {
    this.flowTimers.clear();
    if (this.engine.nonFoldedSeats().length <= 1) {
      this.awardPots();
    } else if (this.engine.street === 'river') {
      this.startShowdown();
    } else if (this.engine.isAllInRunout()) {
      this.startRunout();
    } else {
      this.dealStreet();
    }
  }

  private dealStreet(): void {
    const dealt = this.engine.dealNextStreet();
    this.publishCommunity(dealt.street, dealt.cards);
    this.flowTimers.schedule(STREET_WAIT_MS[dealt.street], () => this.openStreetBetting());
  }

  private openStreetBetting(): void {
    this.flowTimers.clear();
    const firstActor = this.engine.beginBettingRound();
    if (firstActor === null) {
      this.resolveAfterCollect();
      return;
    }
    this.beginTurn(firstActor);
  }

  private startRunout(): void {
    if (this.hand.revealed.size > 0) {
      this.runoutNextStreet();
      return;
    }
    this.revealHands(true);
    this.flowTimers.schedule(RUNOUT_REVEAL_WAIT_MS, () => this.runoutNextStreet());
  }

  private runoutNextStreet(): void {
    this.flowTimers.clear();
    const dealt = this.engine.dealNextStreet();
    this.publishCommunity(dealt.street, dealt.cards);
    const nextStep = dealt.street === 'river' ? () => this.awardPots() : () => this.runoutNextStreet();
    this.flowTimers.schedule(RUNOUT_STREET_WAIT_MS, nextStep);
  }

  private publishCommunity(street: 'flop' | 'turn' | 'river', cards: Card[]): void {
    this.publish(
      { kind: 'community', street, cards: [...cards] },
      narrateStreet(street, cards, this.engine.community),
    );
  }

  private startShowdown(): void {
    this.hand.showdownStreet = true;
    this.revealHands(false);
    this.flowTimers.schedule(SHOWDOWN_REVEAL_TO_AWARD_MS, () => this.awardPots());
  }

  private revealHands(allIn: boolean): void {
    const board = this.engine.community;
    const hands: { seat: number; cards: Card[]; handName: string | null }[] = [];
    for (const seat of this.engine.nonFoldedSeats()) {
      const player = this.engine.getPlayer(seat);
      if (!player) continue;
      hands.push({ seat, cards: [...player.holeCards], handName: this.describeHand(player.holeCards, board) });
    }
    this.hand.revealed = new Set(hands.map((hand) => hand.seat));
    this.botMemory.recordShowdown(hands);
    this.publish({ kind: 'reveal', hands, allIn }, narrateReveal(allIn));
  }

  private describeHand(holeCards: readonly Card[], board: readonly Card[]): string | null {
    if (holeCards.length !== 2) return null;
    if (board.length >= 3) return evaluateHand([...holeCards, ...board]).name;
    return describeStartingHand(holeCards);
  }

  // ---------------------------------------------------------------- hand loop: award and end

  private awardPots(): void {
    this.flowTimers.clear();
    const board = [...this.engine.community];
    const settlement = this.engine.settle();
    this.botMemory.finishHand(board, settlement.showdown);
    this.hand.potsSettled = true;
    this.hand.showdownStreet = settlement.showdown;

    const awards = settlement.awards.map((award) => this.toAwardView(award));
    const narrations = settlement.awards.map((award, index) =>
      narrateAward(
        {
          amount: award.amount,
          winners: award.winners.map((winner) => ({
            name: this.nameOf(winner.seat),
            amount: winner.amount,
            handName: winner.hand?.name ?? null,
          })),
        },
        describePotLabel(index, settlement.awards.length),
        settlement.showdown,
      ),
    );
    const summary = this.buildHandSummary(settlement, board);

    this.publish({ kind: 'award', awards, showdown: settlement.showdown }, narrations[0] ?? null);
    const waitBeforeHandEnd = settlement.showdown ? AWARD_TO_HAND_END_MS : UNCONTESTED_AWARD_TO_HAND_END_MS;
    this.announceRemainingAwards(narrations, 1, summary, waitBeforeHandEnd);
  }

  private announceRemainingAwards(
    narrations: Narration[],
    index: number,
    summary: HandSummary,
    waitBeforeHandEnd: number,
  ): void {
    if (index >= narrations.length) {
      this.flowTimers.schedule(waitBeforeHandEnd, () => this.finishHand(summary));
      return;
    }
    this.flowTimers.schedule(EXTRA_POT_NARRATION_GAP_MS, () => {
      this.publish({ kind: 'info' }, narrations[index]);
      this.announceRemainingAwards(narrations, index + 1, summary, waitBeforeHandEnd);
    });
  }

  private toAwardView(award: SettleResult['awards'][number]): AwardView {
    return {
      potIndex: award.potIndex,
      amount: award.amount,
      winners: award.winners.map((winner) => ({
        seat: winner.seat,
        amount: winner.amount,
        handName: winner.hand?.name ?? null,
        bestFive: winner.hand ? [...winner.hand.bestFive] : [],
      })),
    };
  }

  private buildHandSummary(settlement: SettleResult, board: Card[]): HandSummary {
    const totalsBySeat = new Map<number, { amount: number; handName: string | null }>();
    let potTotal = 0;
    for (const award of settlement.awards) {
      potTotal += award.amount;
      for (const winner of award.winners) {
        const entry = totalsBySeat.get(winner.seat) ?? { amount: 0, handName: null };
        entry.amount += winner.amount;
        entry.handName ??= winner.hand?.name ?? null;
        totalsBySeat.set(winner.seat, entry);
      }
    }
    return {
      handNumber: this.engine.handNumber,
      board,
      potTotal,
      winners: [...totalsBySeat].map(([seat, entry]) => ({
        name: this.nameOf(seat),
        amount: entry.amount,
        handName: entry.handName,
      })),
    };
  }

  private finishHand(summary: HandSummary): void {
    this.flowTimers.clear();
    this.cancelTurn();
    this.leftover = this.captureLeftoverDisplay();
    const bustedSeats = this.engine.endHand();
    this.hand.active = false;
    this.hand.stage = 'idle';
    this.hand.showdownStreet = false;

    this.handSummaries.push(summary);
    if (this.handSummaries.length > HAND_HISTORY_LIMIT) this.handSummaries.shift();
    this.publish({ kind: 'handEnd', summary });

    for (const seat of bustedSeats) {
      const profile = this.seats[seat];
      if (profile) this.publish({ kind: 'info' }, narrateBust(profile.name));
    }
    this.removeLeavingPlayers();
    this.resumeIfIdle(NEXT_HAND_DELAY_MS);
  }

  private captureLeftoverDisplay(): LeftoverDisplay {
    const holeCards = new Map<number, { cards: Card[]; folded: boolean }>();
    for (const player of this.engine.getPlayers()) {
      if (player.inHand) holeCards.set(player.seat, { cards: [...player.holeCards], folded: player.folded });
    }
    return { community: [...this.engine.community], holeCards };
  }

  // ---------------------------------------------------------------- views

  private nameOf(seat: number): string {
    return this.seats[seat]?.name ?? `Assento ${seat + 1}`;
  }

  private buildBacklog(): Backlog {
    return { log: [...this.log], hands: [...this.handSummaries] };
  }

  private recordNarration(narration: Narration, time: number): void {
    this.log.push({ time, text: narration.text, tone: narration.tone });
    if (this.log.length > LOG_LIMIT) this.log.shift();
  }

  private publish(event: GameEvent, narration: Narration | null = null): void {
    this.seq += 1;
    const serverTime = Date.now();
    if (narration) this.recordNarration(narration, serverTime);

    const shared = this.captureSharedView();
    for (const socket of this.io.sockets.sockets.values()) {
      socket.emit('table:update', {
        seq: this.seq,
        serverTime,
        event,
        narration,
        state: this.personalize(shared, this.profileOfSocket(socket.id)),
      });
    }
  }

  /** A fresh connection learns the table (and the LAN URLs) before it joins; it reuses the latest seq. */
  private sendSnapshot(socket: GameSocket): void {
    socket.emit('table:update', {
      seq: this.seq,
      serverTime: Date.now(),
      event: { kind: 'snapshot' },
      narration: null,
      state: this.personalize(this.captureSharedView(), null),
    });
  }

  private captureSharedView(): SharedView {
    const players = new Map<number, EnginePlayerState>();
    for (const player of this.engine.getPlayers()) players.set(player.seat, player);

    const privateCards = new Map<number, Card[]>();
    const seats = this.seats.map((profile, seat) =>
      profile ? this.buildSeatView(profile, seat, players.get(seat) ?? null, privateCards) : null,
    );
    return {
      seats,
      privateCards,
      community: this.hand.active ? [...this.engine.community] : [...(this.leftover?.community ?? this.engine.community)],
      pots: this.hand.potsSettled ? [] : this.engine.pots.map(toPotView),
      street: this.hand.showdownStreet ? 'showdown' : this.engine.street,
      currentBet: this.visibleCurrentBet(seats),
      turnLegal: this.turn ? this.engine.getLegalActions(this.turn.seat) : null,
      handNames: new Map(),
    };
  }

  /** The engine already holds the big blind as the bet to match; the table must not reveal it before the blind event. */
  private visibleCurrentBet(seats: (SeatView | null)[]): number {
    if (this.hand.pendingBlinds.size === 0) return this.engine.currentBet;
    return Math.max(0, ...seats.map((seat) => seat?.bet ?? 0));
  }

  private buildSeatView(
    profile: Profile,
    seat: number,
    player: EnginePlayerState | null,
    privateCards: Map<number, Card[]>,
  ): SeatView {
    const hiddenBlind = this.hand.pendingBlinds.get(seat) ?? 0;
    const heldCards = this.heldCards(seat, player);
    if (heldCards) privateCards.set(seat, heldCards);
    const isRevealed = heldCards !== null && this.hand.revealed.has(seat);

    return {
      seat,
      playerId: profile.id,
      name: profile.name,
      color: profile.color,
      avatar: profile.avatar,
      isBot: profile.isBot,
      connected: profile.isBot || profile.connected,
      chips: (player?.chips ?? 0) + hiddenBlind,
      bet: (player?.streetBet ?? 0) - hiddenBlind,
      status: this.seatStatus(profile, player),
      cardCount: heldCards?.length ?? 0,
      cards: isRevealed ? [...heldCards] : null,
      lastAction: this.hand.lastActions.get(seat) ?? null,
    };
  }

  /** The hole cards physically in front of the seat, whether or not the viewer may see them. */
  private heldCards(seat: number, player: EnginePlayerState | null): Card[] | null {
    if (this.hand.active) {
      if (!this.hand.cardsDealt || !player || !player.inHand || player.folded) return null;
      return [...player.holeCards];
    }
    const remaining = this.leftover?.holeCards.get(seat);
    return remaining && !remaining.folded ? [...remaining.cards] : null;
  }

  private seatStatus(profile: Profile, player: EnginePlayerState | null): PlayerStatus {
    if (player && this.hand.active && player.inHand) {
      if (player.folded) return 'folded';
      return player.allIn ? 'allIn' : 'active';
    }
    if (!player || player.chips === 0) return 'busted';
    if (!profile.isBot && !profile.connected) return 'sittingOut';
    return this.phase === 'lobby' || this.hand.active ? 'waiting' : 'active';
  }

  private personalize(shared: SharedView, viewer: Profile | null): TableView {
    const viewerSeat = viewer?.seat ?? null;
    const seats = shared.seats.map((seat, index) => {
      const ownCards = index === viewerSeat ? shared.privateCards.get(index) : undefined;
      return seat && ownCards ? { ...seat, cards: [...ownCards] } : seat;
    });

    return {
      phase: this.phase,
      handNumber: this.engine.handNumber,
      street: shared.street,
      seats,
      dealerSeat: this.engine.dealerSeat,
      smallBlindSeat: this.engine.smallBlindSeat,
      bigBlindSeat: this.engine.bigBlindSeat,
      community: shared.community,
      pots: shared.pots,
      currentBet: shared.currentBet,
      actingSeat: this.turn?.seat ?? null,
      turnDeadline: this.turn?.deadline ?? null,
      turnDurationMs: this.turn?.durationMs ?? this.config.turnSeconds * 1000,
      config: { ...this.config },
      lanUrls: [...this.options.lanUrls()],
      self: {
        playerId: viewer?.id ?? null,
        seat: viewerSeat,
        isSpectator: viewerSeat === null,
        legal: viewerSeat !== null && viewerSeat === this.turn?.seat ? shared.turnLegal : null,
        handName: viewerSeat === null ? null : this.viewerHandName(shared, viewerSeat),
      },
    };
  }

  private viewerHandName(shared: SharedView, seat: number): string | null {
    const holeCards = shared.privateCards.get(seat);
    if (!holeCards || !this.hand.active) return null;
    if (!shared.handNames.has(seat)) {
      shared.handNames.set(seat, this.describeHand(holeCards, shared.community));
    }
    return shared.handNames.get(seat) ?? null;
  }
}
