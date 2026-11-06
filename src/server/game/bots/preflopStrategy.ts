import { type AggressivePlan, type OpponentRead, deadCardsOf, simulatePlans } from './actionValues';
import { type FoldEstimate, NEVER_FOLDS, PREFLOP_SCALE, foldByShare } from './foldModel';
import { rankOfCode, suitOfCode } from './cardCodes';
import { readRange } from './handReading';
import { GIVE_UP, type Intent, PASSIVE, canRaiseNow, raiseIntent } from './intents';
import { POPULATION_PRIORS } from './opponentModel';
import { type PositionName, STANDARD_OPEN_WIDTH, isLatePosition } from './positions';
import { isPocketPair, isReraiseBluffCandidate, isSpeculativeHand, preflopPercentile } from './preflopChart';
import { type PublicAction, isAggressive } from './publicInfo';
import type { Situation } from './situation';
import { chooseOpenTo, chooseReraiseTo } from './sizing';

const HEADS_UP_BUTTON_WIDTH = 0.7;
const ISOLATION_SHARE = 0.7;
const POPULATION_FOLD_TO_STEAL = POPULATION_PRIORS.foldToSteal.rate;
const POPULATION_THREE_BET = POPULATION_PRIORS.threeBet.rate;
const POPULATION_VPIP = POPULATION_PRIORS.vpip.rate;
/** Hands this far behind the raiser's range are dominated: cheap calls with them lose more after the flop. */
const MIN_CALLING_EQUITY = 0.3;

export function decidePreflop(situation: Situation): Intent {
  const actions = situation.view.actions.filter((action) => action.street === 'preflop');
  const raises = actions.filter((action) => isAggressive(action.kind));
  const facingRaise = raises.length > 0 && situation.context.legal.canCall;
  if (facingRaise) return decideFacingRaise(situation, actions, raises);
  return decideUnopened(situation, actions, preflopPercentile(situation.hole[0], situation.hole[1]));
}

// ---------------------------------------------------------------- nobody raised yet

function decideUnopened(situation: Situation, actions: readonly PublicAction[], percentile: number): Intent {
  const { context, style } = situation;
  const position = heroPosition(situation);
  const limpers = actions.filter((action) => action.kind === 'call' && action.seat !== situation.heroSeat).map((action) => action.seat);
  const limperLooseness = averageOver(limpers, (seat) => situation.tendenciesOf(seat).vpip, POPULATION_VPIP);
  const isolationFactor = clamp(1 + 1.2 * (limperLooseness - POPULATION_VPIP), 0.8, 1.6);

  if (context.legal.canCheck) {
    const isolationWidth = STANDARD_OPEN_WIDTH.bigBlind * style.openScale * 0.6 * isolationFactor;
    return percentile <= isolationWidth ? raiseIntent(chooseOpenTo(situation, limpers.length), 'passive') : PASSIVE;
  }

  const width = openWidth(situation, position);
  if (limpers.length > 0) {
    if (percentile <= width * ISOLATION_SHARE * isolationFactor) {
      return raiseIntent(chooseOpenTo(situation, limpers.length), 'passive');
    }
    const cheapSpeculation = isSpeculativeHand(situation.hole[0], situation.hole[1]) && percentile <= width * 1.3;
    return cheapSpeculation && (isLatePosition(position) || position === 'smallBlind') ? PASSIVE : GIVE_UP;
  }
  if (percentile <= width) return raiseIntent(chooseOpenTo(situation, 0), 'passive');
  const completesSmallBlind =
    position === 'smallBlind' &&
    context.personality.looseness >= 0.5 &&
    percentile <= width * 1.35 &&
    isSpeculativeHand(situation.hole[0], situation.hole[1]);
  return completesSmallBlind ? PASSIVE : GIVE_UP;
}

/** Opening range for the position, widened against blinds that fold too much and narrowed against 3-bettors. */
function openWidth(situation: Situation, position: PositionName): number {
  const headsUp = situation.view.seats.length === 2;
  const base = headsUp && position === 'button' ? HEADS_UP_BUTTON_WIDTH : STANDARD_OPEN_WIDTH[position];
  const blindSeats = [situation.view.smallBlindSeat, situation.view.bigBlindSeat].filter(
    (seat) => seat !== situation.heroSeat && situation.liveOpponents.some((opponent) => opponent.seat === seat),
  );
  let stealFactor = 1;
  if (isLatePosition(position) || position === 'smallBlind') {
    const foldToSteal = averageOver(blindSeats, (seat) => situation.tendenciesOf(seat).foldToSteal, POPULATION_FOLD_TO_STEAL);
    const threeBet = averageOver(blindSeats, (seat) => situation.tendenciesOf(seat).threeBet, POPULATION_THREE_BET);
    stealFactor = clamp(1 + 1.6 * (foldToSteal - POPULATION_FOLD_TO_STEAL), 0.75, 1.6);
    stealFactor *= clamp(1 - 2 * (threeBet - POPULATION_THREE_BET), 0.8, 1.1);
  }
  return Math.min(0.95, base * situation.style.openScale * stealFactor);
}

// ---------------------------------------------------------------- facing a raise

function decideFacingRaise(situation: Situation, actions: readonly PublicAction[], raises: readonly PublicAction[]): Intent {
  const { context, style } = situation;
  const lastRaise = raises[raises.length - 1];
  const raiseCount = raises.length;
  const opponents = opponentsInPot(situation, actions);
  const callers = actions.filter((action) => action.kind === 'call' && action.raisesBefore === raiseCount).length;
  const facingAllIn = context.legal.callAmount >= context.chips || opponents.every((opponent) => opponent.seat.allIn);
  const canReraise = canRaiseNow(context.legal) && !facingAllIn;
  const plan = canReraise ? planReraise(situation, opponents, lastRaise, raiseCount, callers) : null;
  const result = simulatePlans(situation, opponents, plan ? [plan] : [], PREFLOP_SCALE, style.simulationIterations);

  const call = context.legal.callAmount;
  const potAfterCall = context.pot + call;
  if (facingAllIn) {
    return result.equity + style.preflopCallSlack >= call / potAfterCall ? PASSIVE : GIVE_UP;
  }
  const realization = preflopRealization(situation, opponents, callers);
  const implied = impliedOddsBonus(situation, opponents, call);
  const callValue = (realization * result.equity + implied + style.preflopCallSlack) * potAfterCall - call;

  if (plan && result.equity >= style.reraiseValueEquity + 0.04 * (raiseCount - 1)) {
    const flats = raiseCount === 1 && situation.random() < style.trapRate * 0.3;
    return flats ? PASSIVE : raiseIntent(plan.raiseTo, 'passive');
  }
  const lightReraise =
    plan !== null &&
    raiseCount <= 2 &&
    isReraiseBluffCandidate(situation.hole[0], situation.hole[1]) &&
    result.optionEv[0] > Math.max(0, callValue) &&
    situation.random() < style.reraiseBluffRate;
  if (lightReraise) return raiseIntent(plan.raiseTo, 'giveUp');
  return callValue >= 0 && result.equity >= MIN_CALLING_EQUITY ? PASSIVE : GIVE_UP;
}

/** Players who put chips in voluntarily; players still to act are left out (they mostly fold). */
function opponentsInPot(situation: Situation, actions: readonly PublicAction[]): OpponentRead[] {
  const voluntary = new Set(
    actions.filter((action) => action.kind === 'call' || isAggressive(action.kind)).map((action) => action.seat),
  );
  const seats = situation.liveOpponents.filter((seat) => voluntary.has(seat.seat));
  const chosen = seats.length > 0 ? seats : situation.liveOpponents;
  return chosen.map((seat) => ({ seat, range: readRange(seat.seat, situation.view.actions, situation.reader) }));
}

function planReraise(
  situation: Situation,
  opponents: readonly OpponentRead[],
  lastRaise: PublicAction,
  raiseCount: number,
  callers: number,
): AggressivePlan {
  const raiseTo = chooseReraiseTo(situation, raiseCount, lastRaise.totalBet, callers);
  const dead = deadCardsOf(situation);
  const foldEstimates = opponents.map((opponent): FoldEstimate => {
    if (opponent.seat.allIn || opponent.seat.chips === 0) return NEVER_FOLDS;
    const tendencies = situation.tendenciesOf(opponent.seat.seat);
    const isRaiser = opponent.seat.seat === lastRaise.seat;
    const foldShare = isRaiser
      ? tendencies.foldToThreeBet * (raiseCount === 1 ? 1 : 0.8)
      : clamp(0.85 - (tendencies.vpip - POPULATION_VPIP), 0.4, 0.95);
    return foldByShare(PREFLOP_SCALE, opponent.range, foldShare, dead);
  });
  return { raiseTo, foldEstimates };
}

/**
 * Share of its showdown equity a calling hand keeps once the betting goes on: less out of position, more for
 * suited hands that make strong draws, less for disconnected offsuit hands that mostly make one weak pair.
 */
function preflopRealization(situation: Situation, opponents: readonly OpponentRead[], callers: number): number {
  const heroOrder = situation.positions.get(situation.heroSeat)?.postflopOrder ?? 0;
  const inPosition = opponents.every((opponent) => (situation.positions.get(opponent.seat.seat)?.postflopOrder ?? 0) < heroOrder);
  let realization = inPosition ? 0.9 : heroPosition(situation) === 'bigBlind' ? 0.78 : 0.72;
  const [first, second] = situation.hole;
  const suited = suitOfCode(first) === suitOfCode(second);
  const gap = Math.abs(rankOfCode(first) - rankOfCode(second)) - 1;
  if (suited) realization += 0.05;
  else if (gap >= 2) realization -= 0.06;
  if (callers > 0) realization -= 0.05;
  return realization;
}

/** Pairs and suited hands win stacks when they hit, which pays for calls that the pot alone does not. */
function impliedOddsBonus(situation: Situation, opponents: readonly OpponentRead[], call: number): number {
  const deepest = Math.max(0, ...opponents.map((opponent) => opponent.seat.chips));
  const effectiveStack = Math.min(situation.context.chips - call, deepest);
  const stackToCall = effectiveStack / Math.max(1, call);
  const [first, second] = situation.hole;
  if (isPocketPair(first, second)) return stackToCall >= 15 ? 0.07 : 0;
  if (isSpeculativeHand(first, second)) return stackToCall >= 20 ? 0.03 : 0;
  return 0;
}

function heroPosition(situation: Situation): PositionName {
  return situation.positions.get(situation.heroSeat)?.name ?? 'hijack';
}

function averageOver(seats: readonly number[], valueOf: (seat: number) => number, fallback: number): number {
  if (seats.length === 0) return fallback;
  return seats.reduce((sum, seat) => sum + valueOf(seat), 0) / seats.length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
