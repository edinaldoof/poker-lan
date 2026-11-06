/**
 * Everything a bot may know about a hand. Every field here is something any player at the table could see or
 * remember: no type in this module can carry another player's hidden hole cards, the deck or server-only state.
 * Opponent hole cards only ever enter the bots' memory through showdowns, as aggregated statistics.
 */

export type BettingStreet = 'preflop' | 'flop' | 'turn' | 'river';

export const POSTFLOP_STREETS = ['flop', 'turn', 'river'] as const;
export type PostflopStreet = (typeof POSTFLOP_STREETS)[number];

export type PublicActionKind = 'fold' | 'check' | 'call' | 'bet' | 'raise';

export interface PublicAction {
  readonly seat: number;
  readonly street: BettingStreet;
  /** All-in moves are reported as the call, bet or raise they amount to. */
  readonly kind: PublicActionKind;
  readonly allIn: boolean;
  readonly chipsAdded: number;
  /** The player's bet on this street after acting. */
  readonly totalBet: number;
  /** Every chip in the middle before the action, street bets included. */
  readonly potBefore: number;
  readonly toCall: number;
  /** The highest bet on this street before the action (the big blind before any raise preflop). */
  readonly betLevelBefore: number;
  /** Bets and raises already made on this street; the blinds do not count. */
  readonly raisesBefore: number;
}

export interface PublicSeat {
  readonly seat: number;
  readonly playerId: string;
  readonly chips: number;
  readonly streetBet: number;
  readonly folded: boolean;
  readonly allIn: boolean;
}

/** Raw counts of what a player did in earlier hands, kept from public actions and showdowns only. */
export interface PlayerStatCounts {
  hands: number;
  vpip: number;
  pfr: number;
  threeBetChances: number;
  threeBets: number;
  /** Calls (without re-raising) when facing a single raise preflop. */
  flatCalls: number;
  foldToThreeBetChances: number;
  foldsToThreeBet: number;
  stealDefenseChances: number;
  foldsToSteal: number;
  postflopAggressive: number;
  postflopCalls: number;
  postflopChecks: number;
  postflopFolds: number;
  cbetChances: number;
  cbets: number;
  foldToCbetChances: number;
  foldsToCbet: number;
  /** Facing a single bet on the flop, turn and river. */
  facedBets: [number, number, number];
  foldsToBets: [number, number, number];
  /** Facing a single bet on the turn and the river after calling a bet on the street before: a condensed range. */
  facedBetsAfterCall: [number, number];
  foldsToBetsAfterCall: [number, number];
  /** Facing a single bet (a donk or probe bet) after making the last bet or raise on the street before. */
  facedBetsWithInitiative: number;
  foldsToBetsWithInitiative: number;
  facedRaises: number;
  foldsToRaises: number;
  barrelChances: number;
  barrels: number;
  shownRiverBets: number;
  shownRiverBluffs: number;
  /** Flop and turn bets or raises later shown down, and how many of them were made with nothing (no pair, no draw). */
  shownEarlyBets: number;
  shownEarlyBluffs: number;
  /** Bets or raises on any street later shown down holding a middling made hand (thin value or protection). */
  shownMediumBets: number;
}

export interface PublicHandView {
  readonly heroSeat: number;
  readonly buttonSeat: number;
  readonly smallBlindSeat: number;
  readonly bigBlindSeat: number;
  /** Players dealt into this hand, clockwise starting with the seat after the button. */
  readonly seats: readonly PublicSeat[];
  /** This hand's actions in order; posting the blinds is not an action. */
  readonly actions: readonly PublicAction[];
  /** What the table has seen of each player in earlier hands, keyed by player id (the hero included). */
  readonly statsByPlayer: Readonly<Record<string, Readonly<PlayerStatCounts>>>;
}

export function createEmptyStatCounts(): PlayerStatCounts {
  return {
    hands: 0,
    vpip: 0,
    pfr: 0,
    threeBetChances: 0,
    threeBets: 0,
    flatCalls: 0,
    foldToThreeBetChances: 0,
    foldsToThreeBet: 0,
    stealDefenseChances: 0,
    foldsToSteal: 0,
    postflopAggressive: 0,
    postflopCalls: 0,
    postflopChecks: 0,
    postflopFolds: 0,
    cbetChances: 0,
    cbets: 0,
    foldToCbetChances: 0,
    foldsToCbet: 0,
    facedBets: [0, 0, 0],
    foldsToBets: [0, 0, 0],
    facedBetsAfterCall: [0, 0],
    foldsToBetsAfterCall: [0, 0],
    facedBetsWithInitiative: 0,
    foldsToBetsWithInitiative: 0,
    facedRaises: 0,
    foldsToRaises: 0,
    barrelChances: 0,
    barrels: 0,
    shownRiverBets: 0,
    shownRiverBluffs: 0,
    shownEarlyBets: 0,
    shownEarlyBluffs: 0,
    shownMediumBets: 0,
  };
}

export function postflopStreetIndex(street: PostflopStreet): 0 | 1 | 2 {
  return street === 'flop' ? 0 : street === 'turn' ? 1 : 2;
}

export function isAggressive(kind: PublicActionKind): boolean {
  return kind === 'bet' || kind === 'raise';
}

/** The player who made the last bet or raise on the street before `street`. */
export function lastAggressorBefore(street: BettingStreet, actions: readonly PublicAction[]): number | null {
  const previous = previousStreet(street);
  if (!previous) return null;
  let aggressor: number | null = null;
  for (const action of actions) {
    if (action.street === previous && isAggressive(action.kind)) aggressor = action.seat;
  }
  return aggressor;
}

function previousStreet(street: BettingStreet): BettingStreet | null {
  if (street === 'flop') return 'preflop';
  if (street === 'turn') return 'flop';
  if (street === 'river') return 'turn';
  return null;
}
