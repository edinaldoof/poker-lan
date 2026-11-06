import type { Card } from './cards';

export const MAX_SEATS = 8;
export const DEFAULT_PORT = 3000;

export type Street = 'idle' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
export type PlayerStatus = 'waiting' | 'active' | 'folded' | 'allIn' | 'sittingOut' | 'busted';
export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allIn';
export type RequestedActionType = 'fold' | 'check' | 'call' | 'raise' | 'allIn';

export interface PlayerActionRequest {
  type: RequestedActionType;
  /** For "raise": the total amount the player's street bet becomes (raise-to). */
  amount?: number;
}

export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  callAmount: number;
  canRaise: boolean;
  /** Raise-to totals for the current street. */
  minRaiseTo: number;
  maxRaiseTo: number;
  /** True when nobody has bet yet this street, so a raise is labelled "bet". */
  isOpeningBet: boolean;
}

export interface TableConfig {
  smallBlind: number;
  bigBlind: number;
  startingStack: number;
  turnSeconds: number;
}

export const DEFAULT_CONFIG: TableConfig = {
  smallBlind: 10,
  bigBlind: 20,
  startingStack: 2000,
  turnSeconds: 30,
};

export interface SeatView {
  seat: number;
  playerId: string;
  name: string;
  color: string;
  avatar: string;
  isBot: boolean;
  connected: boolean;
  chips: number;
  /** Chips committed on the current street, still in front of the player. */
  bet: number;
  status: PlayerStatus;
  /** Number of face-down cards the player holds (0 after folding). */
  cardCount: number;
  /** Visible only to the owner, or to everyone after a showdown reveal. */
  cards: Card[] | null;
  lastAction: string | null;
}

export interface PotView {
  amount: number;
  eligibleSeats: number[];
}

export interface HandSummary {
  handNumber: number;
  board: Card[];
  potTotal: number;
  winners: { name: string; amount: number; handName: string | null }[];
}

export interface SelfView {
  playerId: string | null;
  seat: number | null;
  isSpectator: boolean;
  legal: LegalActions | null;
  /** Current best hand description for the viewer, e.g. "Par de Reis". */
  handName: string | null;
}

export interface TableView {
  phase: 'lobby' | 'running';
  handNumber: number;
  street: Street;
  seats: (SeatView | null)[];
  dealerSeat: number | null;
  smallBlindSeat: number | null;
  bigBlindSeat: number | null;
  community: Card[];
  /** Pots already collected to the center (bets still in front of players are not included). */
  pots: PotView[];
  currentBet: number;
  actingSeat: number | null;
  /** Server epoch milliseconds when the acting player's time runs out. */
  turnDeadline: number | null;
  turnDurationMs: number;
  config: TableConfig;
  lanUrls: string[];
  self: SelfView;
}

export interface WinnerView {
  seat: number;
  amount: number;
  handName: string | null;
  bestFive: Card[];
}

export interface AwardView {
  potIndex: number;
  amount: number;
  winners: WinnerView[];
}

export type GameEvent =
  | { kind: 'snapshot' }
  | { kind: 'info' }
  | { kind: 'playerJoined'; seat: number }
  | { kind: 'playerLeft'; seat: number }
  | { kind: 'handStart'; handNumber: number; dealerSeat: number; smallBlindSeat: number; bigBlindSeat: number }
  | { kind: 'blind'; seat: number; amount: number; blind: 'small' | 'big' }
  | { kind: 'dealHole'; seats: number[] }
  | { kind: 'turn'; seat: number; deadline: number; durationMs: number }
  | { kind: 'action'; seat: number; action: ActionType; amount: number; totalBet: number; timedOut: boolean }
  | { kind: 'collect'; returned: { seat: number; amount: number }[]; pots: PotView[] }
  | { kind: 'community'; street: 'flop' | 'turn' | 'river'; cards: Card[] }
  | { kind: 'reveal'; hands: { seat: number; cards: Card[]; handName: string | null }[]; allIn: boolean }
  | { kind: 'award'; awards: AwardView[]; showdown: boolean }
  | { kind: 'handEnd'; summary: HandSummary }
  | { kind: 'rebuy'; seat: number; amount: number };

export type NarrationTone = 'info' | 'action' | 'street' | 'win' | 'warn' | 'alert';

export interface Narration {
  text: string;
  /** Spoken variant (card symbols spelled out); falls back to text. */
  speech?: string;
  tone: NarrationTone;
  /** 1 = essential (streets, all-ins, results), 2 = detail (checks, calls, folds). */
  priority: 1 | 2;
}

export interface TableUpdate {
  seq: number;
  serverTime: number;
  event: GameEvent;
  narration: Narration | null;
  state: TableView;
}

export interface LogEntry {
  time: number;
  text: string;
  tone: NarrationTone;
}

export interface Backlog {
  log: LogEntry[];
  hands: HandSummary[];
}

export interface JoinRequest {
  name: string;
  color: string;
  avatar: string;
  /** Random per-browser token so a refreshed page reclaims its seat. */
  token: string;
}

export interface JoinResponse {
  ok: boolean;
  error?: string;
  playerId?: string;
  seat?: number | null;
  spectator?: boolean;
}

export interface ServerToClientEvents {
  'table:update': (update: TableUpdate) => void;
  'table:backlog': (backlog: Backlog) => void;
  'table:error': (message: string) => void;
}

export interface ClientToServerEvents {
  'table:join': (request: JoinRequest, ack: (response: JoinResponse) => void) => void;
  'table:action': (request: PlayerActionRequest) => void;
  'table:addBot': () => void;
  'table:removeBot': () => void;
  'table:start': (config: Partial<TableConfig>) => void;
  'table:rebuy': () => void;
  'table:leave': () => void;
}

export const PLAYER_COLORS = ['#e4b363', '#e05a47', '#4fb3a9', '#6c8cff', '#c77dff', '#5fd068', '#ff8fab', '#f2f2f2'];
export const PLAYER_AVATARS = ['🦊', '🐺', '🦁', '🐯', '🐼', '🦉', '🐙', '🐸', '🦈', '🐲', '🦄', '🐻'];
