import { type CardCode, rankOfCode, suitOfCode } from './cardCodes';
import { populationFoldToBet } from './opponentModel';
import { isLatePosition } from './positions';
import { isAggressive, lastAggressorBefore } from './publicInfo';
import type { Situation } from './situation';

/**
 * Bet sizes depend only on the spot (street, board, players, line) and the personality, never on the hero's cards,
 * so value bets and bluffs in the same spot look identical. The overbet is drawn the same way: when a spot allows
 * it, strong hands and bluffs take it alike.
 */

const OVERBET_FRACTION = 1.3;
const MIN_STANDARD_FRACTION = 0.5;
const MAX_STANDARD_FRACTION = 1;

export function chooseBetFraction(situation: Situation): number {
  const { style, street, random } = situation;
  const wetness = boardWetness(situation.board);
  const headsUp = situation.liveOpponents.length === 1;
  if (street !== 'flop' && headsUp && isPolarisingSpot(situation) && random() < style.overbetRate) {
    return OVERBET_FRACTION;
  }
  const base = street === 'flop' ? 0.5 + 0.2 * wetness : street === 'turn' ? 0.6 + 0.15 * wetness : 0.7;
  const multiwayExtra = headsUp ? 0 : 0.05;
  const jitter = (random() - 0.5) * 2 * style.sizeJitter;
  const fraction = (base + multiwayExtra) * style.sizeScale * stickinessFactor(situation) + jitter;
  return clamp(fraction, MIN_STANDARD_FRACTION, MAX_STANDARD_FRACTION);
}

/**
 * Bigger bets against players who rarely fold (value gets paid), smaller ones against players who fold a lot
 * (bluffs cost less). It reads the opponents, not the hero's cards, so it still says nothing about the hand.
 */
function stickinessFactor(situation: Situation): number {
  if (situation.liveOpponents.length === 0) return 1;
  const street = situation.street === 'preflop' ? 'flop' : situation.street;
  const averageFold =
    situation.liveOpponents.reduce((sum, seat) => sum + situation.tendenciesOf(seat.seat).foldToBet[street], 0) /
    situation.liveOpponents.length;
  return clamp(populationFoldToBet(street) / Math.max(0.05, averageFold), 0.85, 1.3);
}

/** Raise sizes: about three times the bet, never less than three quarters of the pot on top. */
export function chooseRaiseTo(situation: Situation): number {
  const { context, style } = situation;
  const potAfterCall = context.pot + context.legal.callAmount;
  const multiple = situation.heroInPosition ? 2.8 : 3.3;
  const byMultiple = context.currentBet * multiple;
  const byPot = context.currentBet + 0.75 * potAfterCall;
  return Math.max(byMultiple, byPot) * (0.9 + 0.2 * (style.sizeScale - 0.85) / 0.3);
}

/** Preflop opening size in chips: smaller from late position, plus one big blind per limper. */
export function chooseOpenTo(situation: Situation, limpers: number): number {
  const { context, style } = situation;
  const position = situation.positions.get(situation.heroSeat)?.name ?? 'hijack';
  const bigBlinds = (isLatePosition(position) || position === 'smallBlind' ? 2.5 : 3) * style.sizeScale + limpers;
  return bigBlinds * context.bigBlind;
}

/** 3-bets are about three times the raise in position and nearly four out of position; 4-bets 2.3 times. */
export function chooseReraiseTo(situation: Situation, raiseCount: number, lastRaiseTo: number, callers: number): number {
  if (raiseCount >= 3) return situation.context.legal.maxRaiseTo;
  if (raiseCount === 2) return lastRaiseTo * 2.3 * situation.style.sizeScale;
  const multiple = situation.heroInPosition ? 3 : 3.7;
  return (lastRaiseTo * multiple + callers * lastRaiseTo) * situation.style.sizeScale;
}

/**
 * Spots where the hero's believable range holds both the nuts and air: it kept the initiative on the previous
 * street, or the opponent showed weakness by checking to it.
 */
function isPolarisingSpot(situation: Situation): boolean {
  const { view, street, heroSeat } = situation;
  if (lastAggressorBefore(street, view.actions) === heroSeat) return true;
  const thisStreet = view.actions.filter((action) => action.street === street);
  return thisStreet.length > 0 && thisStreet.every((action) => action.kind === 'check');
}

/** 0 for a dry rainbow board, towards 1 for monotone and connected ones. */
function boardWetness(board: readonly CardCode[]): number {
  if (board.length === 0) return 0;
  const suitCounts = [0, 0, 0, 0];
  let rankMask = 0;
  for (const card of board) {
    suitCounts[suitOfCode(card)]++;
    rankMask |= 1 << rankOfCode(card);
  }
  const flushiness = Math.max(...suitCounts) >= 3 ? 1 : Math.max(...suitCounts) === 2 ? 0.5 : 0;
  let connected = 0;
  for (let rank = 0; rank < 12; rank++) {
    if (rankMask & (1 << rank) && rankMask & (1 << (rank + 1))) connected++;
    if (rankMask & (1 << rank) && rankMask & (1 << (rank + 2))) connected += 0.5;
  }
  return clamp(0.55 * flushiness + 0.3 * Math.min(1, connected / 2), 0, 1);
}

export function raisesThisStreet(situation: Situation): number {
  return situation.view.actions.filter((action) => action.street === situation.street && isAggressive(action.kind)).length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
