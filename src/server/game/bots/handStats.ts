import { boardStrengthTable, hasStrongDraw } from './boardStrength';
import { type CardCode, comboIndexOf } from './cardCodes';
import { type PositionName, assignPositions, isLatePosition } from './positions';
import {
  type PlayerStatCounts,
  type PostflopStreet,
  type PublicAction,
  isAggressive,
  lastAggressorBefore,
  postflopStreetIndex,
} from './publicInfo';

/** A finished hand as the whole table saw it. */
export interface CompletedHand {
  readonly buttonSeat: number;
  readonly bigBlindSeat: number;
  readonly seatsFromButtonNext: readonly number[];
  readonly playerIdBySeat: ReadonlyMap<number, string>;
  readonly actions: readonly PublicAction[];
  /** Hole cards turned face up at showdown or in an all-in runout. */
  readonly shownCards: ReadonlyMap<number, readonly [CardCode, CardCode]>;
  readonly board: readonly CardCode[];
  readonly showdown: boolean;
}

/** A river bet shown down with a hand that beats less than this share of all combos counts as a bluff. */
export const SHOWN_BLUFF_PERCENTILE = 0.45;
const SHOWN_MEDIUM_PERCENTILE = 0.72;

export function addHandToStats(hand: CompletedHand, statsOf: (playerId: string) => PlayerStatCounts): void {
  const statsBySeat = new Map<number, PlayerStatCounts>();
  for (const seat of hand.seatsFromButtonNext) {
    const playerId = hand.playerIdBySeat.get(seat);
    if (playerId !== undefined) statsBySeat.set(seat, statsOf(playerId));
  }
  for (const stats of statsBySeat.values()) stats.hands++;

  const preflopAggressor = countPreflop(hand, statsBySeat);
  countPostflop(hand, statsBySeat, preflopAggressor);
  countShowdown(hand, statsBySeat);
}

function countPreflop(hand: CompletedHand, statsBySeat: Map<number, PlayerStatCounts>): number | null {
  const preflop = hand.actions.filter((action) => action.street === 'preflop');
  const positions = assignPositions(hand.seatsFromButtonNext, hand.buttonSeat, hand.bigBlindSeat);
  const voluntary = new Set<number>();
  const raised = new Set<number>();
  const facedOpen = new Set<number>();
  const openerFacedThreeBet = new Set<number>();
  let openerSeat: number | null = null;
  let isSteal = false;
  let lastRaiser: number | null = null;

  for (const action of preflop) {
    const stats = statsBySeat.get(action.seat);
    if (!stats) continue;
    if (action.kind === 'call' || action.kind === 'raise' || action.kind === 'bet') voluntary.add(action.seat);
    if (isAggressive(action.kind)) raised.add(action.seat);

    if (action.raisesBefore === 0 && isAggressive(action.kind) && openerSeat === null) {
      openerSeat = action.seat;
      const unopenedBefore = preflop.slice(0, preflop.indexOf(action)).every((earlier) => earlier.kind === 'fold');
      isSteal = unopenedBefore && isStealPosition(positions.get(action.seat)?.name);
    }
    if (action.raisesBefore === 1 && action.seat !== openerSeat && !facedOpen.has(action.seat)) {
      facedOpen.add(action.seat);
      stats.threeBetChances++;
      if (isAggressive(action.kind)) stats.threeBets++;
      if (action.kind === 'call') stats.flatCalls++;
      const defendsBlind = action.seat === hand.bigBlindSeat || positions.get(action.seat)?.name === 'smallBlind';
      if (isSteal && defendsBlind) {
        stats.stealDefenseChances++;
        if (action.kind === 'fold') stats.foldsToSteal++;
      }
    }
    if (action.seat === openerSeat && action.raisesBefore === 2 && !openerFacedThreeBet.has(action.seat)) {
      openerFacedThreeBet.add(action.seat);
      stats.foldToThreeBetChances++;
      if (action.kind === 'fold') stats.foldsToThreeBet++;
    }
    if (isAggressive(action.kind)) lastRaiser = action.seat;
  }
  for (const seat of voluntary) statsBySeat.get(seat)!.vpip++;
  for (const seat of raised) statsBySeat.get(seat)!.pfr++;
  return lastRaiser;
}

function isStealPosition(name: PositionName | undefined): boolean {
  return name !== undefined && (name === 'smallBlind' || isLatePosition(name));
}

function countPostflop(hand: CompletedHand, statsBySeat: Map<number, PlayerStatCounts>, preflopAggressor: number | null): void {
  const seatsThatActed = new Set<string>();
  const answeredCbet = new Set<number>();
  let cbetMade = false;

  hand.actions.forEach((action, index) => {
    if (action.street === 'preflop') return;
    const stats = statsBySeat.get(action.seat);
    if (!stats) return;
    const street = action.street as PostflopStreet;
    const actedKey = `${street}:${action.seat}`;
    const firstOnStreet = !seatsThatActed.has(actedKey);
    seatsThatActed.add(actedKey);
    countActionKind(stats, action);

    if (action.seat === preflopAggressor && firstOnStreet && action.raisesBefore === 0) {
      if (street === 'flop') {
        stats.cbetChances++;
        if (action.kind === 'bet') {
          stats.cbets++;
          cbetMade = true;
        }
      } else if (street === 'turn' && cbetMade) {
        stats.barrelChances++;
        if (action.kind === 'bet') stats.barrels++;
      }
    }
    const facesCbet = street === 'flop' && cbetMade && action.raisesBefore === 1 && action.seat !== preflopAggressor;
    if (facesCbet && !answeredCbet.has(action.seat)) {
      answeredCbet.add(action.seat);
      stats.foldToCbetChances++;
      if (action.kind === 'fold') stats.foldsToCbet++;
    }
    countFacingBets(stats, action, street, hand.actions.slice(0, index));
  });
}

function countActionKind(stats: PlayerStatCounts, action: PublicAction): void {
  if (isAggressive(action.kind)) stats.postflopAggressive++;
  else if (action.kind === 'call') stats.postflopCalls++;
  else if (action.kind === 'check') stats.postflopChecks++;
  else stats.postflopFolds++;
}

function countFacingBets(
  stats: PlayerStatCounts,
  action: PublicAction,
  street: PostflopStreet,
  earlierActions: readonly PublicAction[],
): void {
  if (action.toCall <= 0) return;
  if (action.raisesBefore === 1) {
    const index = postflopStreetIndex(street);
    stats.facedBets[index]++;
    if (action.kind === 'fold') stats.foldsToBets[index]++;
    if (lastAggressorBefore(street, earlierActions) === action.seat) {
      stats.facedBetsWithInitiative++;
      if (action.kind === 'fold') stats.foldsToBetsWithInitiative++;
    }
    if (street !== 'flop' && calledOnStreet(action.seat, previousPostflopStreet(street), earlierActions)) {
      const afterCallIndex = street === 'turn' ? 0 : 1;
      stats.facedBetsAfterCall[afterCallIndex]++;
      if (action.kind === 'fold') stats.foldsToBetsAfterCall[afterCallIndex]++;
    }
    return;
  }
  const raisedEarlierThisStreet = earlierActions.some(
    (earlier) => earlier.street === street && earlier.seat === action.seat && isAggressive(earlier.kind),
  );
  if (raisedEarlierThisStreet) {
    stats.facedRaises++;
    if (action.kind === 'fold') stats.foldsToRaises++;
  }
}

function calledOnStreet(seat: number, street: PostflopStreet, actions: readonly PublicAction[]): boolean {
  return actions.some((action) => action.street === street && action.seat === seat && action.kind === 'call');
}

function previousPostflopStreet(street: 'turn' | 'river'): PostflopStreet {
  return street === 'turn' ? 'flop' : 'turn';
}

function countShowdown(hand: CompletedHand, statsBySeat: Map<number, PlayerStatCounts>): void {
  if (!hand.showdown || hand.board.length < 5) return;
  for (const [seat, cards] of hand.shownCards) {
    const stats = statsBySeat.get(seat);
    if (!stats) continue;
    const combo = comboIndexOf(cards[0], cards[1]);
    for (const street of ['flop', 'turn', 'river'] as const) {
      const bet = hand.actions.some((action) => action.street === street && action.seat === seat && isAggressive(action.kind));
      if (!bet) continue;
      const strength = shownBetStrength(hand.board, street, combo);
      countShownBet(stats, street, strength === 'bluff');
      if (strength === 'medium') stats.shownMediumBets++;
    }
  }
}

function countShownBet(stats: PlayerStatCounts, street: PostflopStreet, bluff: boolean): void {
  if (street === 'river') {
    stats.shownRiverBets++;
    if (bluff) stats.shownRiverBluffs++;
  } else {
    stats.shownEarlyBets++;
    if (bluff) stats.shownEarlyBluffs++;
  }
}

/** A bluff is a weak hand without a strong draw; a medium bet holds a middling made hand, on that street's board. */
function shownBetStrength(board: readonly CardCode[], street: PostflopStreet, combo: number): 'bluff' | 'medium' | 'other' {
  const table = boardStrengthTable(board.slice(0, street === 'flop' ? 3 : street === 'turn' ? 4 : 5));
  const percentile = table.madePercentile[combo];
  if (percentile < 0 || hasStrongDraw(table.drawFlags[combo])) return 'other';
  if (percentile < SHOWN_BLUFF_PERCENTILE) return 'bluff';
  return percentile < SHOWN_MEDIUM_PERCENTILE ? 'medium' : 'other';
}
