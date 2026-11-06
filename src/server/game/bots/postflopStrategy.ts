import { type AggressivePlan, type OpponentRead, chooseBySoftmax, deadCardsOf, simulatePlans, type ScoredIntent } from './actionValues';
import { boardStrengthTable, hasStrongDraw } from './boardStrength';
import { comboIndexOf } from './cardCodes';
import { type FoldEstimate, NEVER_FOLDS, type StrengthScale, foldAgainstBettorImage } from './foldModel';
import { applyActionLikelihood, readRange } from './handReading';
import { GIVE_UP, type Intent, PASSIVE, canRaiseNow, raiseIntent } from './intents';
import { POPULATION_PRIORS, type StreetAfterCall, populationFoldToBet, populationFoldToBetAfterCall } from './opponentModel';
import { type PostflopStreet, type PublicAction, lastAggressorBefore } from './publicInfo';
import type { Situation } from './situation';
import { chooseBetFraction, chooseRaiseTo, raisesThisStreet } from './sizing';

/** Hands at least this likely to win may be slow-played against opponents who bet when checked to. */
const TRAP_EQUITY = 0.85;
/** Below this showdown equity an aggressive play is mostly a bluff: it must clear the style's bluff edge. */
const BLUFF_EQUITY = 0.35;
const FLOAT_MIN_EQUITY = 0.12;
const FLOAT_MAX_BET_FRACTION = 0.8;
/** Share of the pot a float expects to keep when the bettor gives up and then folds: the later bet still costs. */
const FLOAT_TAKEAWAY_SHARE = 0.4;

/**
 * Flop, turn and river: every option is valued in the same weighted simulation against the opponents' read ranges.
 * Bets and raises earn the pot whenever the fold model says everybody folds, and play the hand out otherwise,
 * so bluffs, semi-bluffs and value bets all come from one comparison instead of separate dice rolls.
 */
export function decidePostflop(situation: Situation): Intent {
  const table = boardStrengthTable(situation.board);
  const scale: StrengthScale = { strength: table.strength, ascendingOrder: table.ascendingOrder };
  const { context, style, view, reader } = situation;
  const opponents: OpponentRead[] = situation.liveOpponents.map((seat) => ({
    seat,
    range: readRange(seat.seat, view.actions, reader),
  }));
  const facingBet = context.legal.canCall && context.legal.callAmount > 0;
  const plan = canRaiseNow(context.legal) ? planAggression(situation, opponents, scale, facingBet) : null;
  const result = simulatePlans(situation, opponents, plan ? [plan] : [], scale, style.simulationIterations);

  const heroDraws = table.drawFlags[comboIndexOf(situation.hole[0], situation.hole[1])];
  if (!facingBet && shouldTrap(situation, opponents, result.equity)) return PASSIVE;

  const pot = context.pot;
  const realization = realizationFactor(situation, opponents, heroDraws);
  const options: ScoredIntent[] = [];
  if (facingBet) {
    const call = context.legal.callAmount;
    options.push({ intent: GIVE_UP, value: 0 });
    const callValue = realization * result.equity * (pot + call) - call;
    options.push({ intent: PASSIVE, value: callValue + style.callBias * pot + floatValue(situation, opponents, result.equity) });
  } else {
    options.push({ intent: PASSIVE, value: realization * result.equity * pot });
  }
  const isBluff = result.equity < BLUFF_EQUITY;
  if (plan && (!isBluff || situation.random() < style.bluffWillingness)) {
    const styleBias = isBluff ? style.bluffBias : style.aggressionBias;
    options.push({ intent: raiseIntent(plan.raiseTo, 'passive'), value: result.optionEv[0] + styleBias * pot });
  }
  return chooseBySoftmax(options, style.temperature * Math.max(pot, context.bigBlind), situation.random);
}

function planAggression(
  situation: Situation,
  opponents: readonly OpponentRead[],
  scale: StrengthScale,
  facingBet: boolean,
): AggressivePlan {
  const { context } = situation;
  const raiseTo = facingBet ? chooseRaiseTo(situation) : context.currentBet + chooseBetFraction(situation) * context.pot;
  const heroImage = imageAfterAggression(situation, raiseTo);
  const dead = deadCardsOf(situation);
  const heroCost = Math.max(0, raiseTo - context.streetBet);
  const foldEstimates = opponents.map((opponent): FoldEstimate => {
    const { seat } = opponent;
    if (seat.allIn || seat.chips === 0) return NEVER_FOLDS;
    const opponentCost = Math.min(raiseTo - seat.streetBet, seat.chips);
    const rates = foldRates(situation, seat.seat, seat.streetBet > 0, isContinuationBet(situation, facingBet));
    return foldAgainstBettorImage({
      scale,
      opponentWeights: opponent.range,
      bettorImage: heroImage,
      requiredEquity: opponentCost / Math.max(1, context.pot + heroCost + opponentCost),
      observedFoldRate: rates.observed,
      populationFoldRate: rates.population,
      blocked: dead,
    });
  });
  return { raiseTo, foldEstimates };
}

/** How the hero's range looks to the table once it makes this bet: its earlier line plus the bet itself. */
function imageAfterAggression(situation: Situation, raiseTo: number): Float64Array {
  const { view, reader, context, street, heroSeat } = situation;
  const image = readRange(heroSeat, view.actions, reader);
  const raisesBefore = raisesThisStreet(situation);
  const bet: PublicAction = {
    seat: heroSeat,
    street,
    kind: raisesBefore === 0 ? 'bet' : 'raise',
    allIn: raiseTo >= context.legal.maxRaiseTo,
    chipsAdded: raiseTo - context.streetBet,
    totalBet: raiseTo,
    potBefore: context.pot,
    toCall: context.legal.callAmount,
    betLevelBefore: context.currentBet,
    raisesBefore,
  };
  applyActionLikelihood(image, bet, view.actions, reader);
  return image;
}

/** How often this opponent, and the population, fold in this kind of spot. */
function foldRates(
  situation: Situation,
  seat: number,
  facesRaiseOfOwnBet: boolean,
  continuationBet: boolean,
): { observed: number; population: number } {
  const tendencies = situation.tendenciesOf(seat);
  if (facesRaiseOfOwnBet) return { observed: tendencies.foldToRaise, population: POPULATION_PRIORS.foldToRaise.rate };
  if (continuationBet) return { observed: tendencies.foldToCbet, population: POPULATION_PRIORS.foldToCbet.rate };
  const street = situation.street as PostflopStreet;
  if (lastAggressorBefore(street, situation.view.actions) === seat) {
    return { observed: tendencies.foldToBetWithInitiative, population: POPULATION_PRIORS.foldToBetWithInitiative.rate };
  }
  if (street !== 'flop' && calledLastStreet(situation, seat, street)) {
    return { observed: tendencies.foldToBetAfterCall[street], population: populationFoldToBetAfterCall(street) };
  }
  return { observed: tendencies.foldToBet[street], population: populationFoldToBet(street) };
}

function calledLastStreet(situation: Situation, seat: number, street: StreetAfterCall): boolean {
  const previous = street === 'turn' ? 'flop' : 'turn';
  return situation.view.actions.some((action) => action.street === previous && action.seat === seat && action.kind === 'call');
}

/** The preflop raiser's first bet on the flop, before anybody else bet. */
function isContinuationBet(situation: Situation, facingBet: boolean): boolean {
  return situation.street === 'flop' && !facingBet && lastAggressorBefore('flop', situation.view.actions) === situation.heroSeat;
}

function realizationFactor(situation: Situation, opponents: readonly OpponentRead[], heroDraws: number): number {
  const { context, street } = situation;
  const noMoreBetting = opponents.every((opponent) => opponent.seat.allIn) || context.legal.callAmount >= context.chips;
  if (street === 'river' || noMoreBetting) return 1;
  let factor = situation.heroInPosition ? (street === 'flop' ? 0.95 : 0.98) : street === 'flop' ? 0.82 : 0.9;
  const deep = context.chips - context.legal.callAmount >= context.pot;
  if (hasStrongDraw(heroDraws) && deep) factor += 0.08;
  if (opponents.length >= 2) factor -= 0.04;
  return factor - pressureAhead(situation, opponents);
}

/** Opponents who keep betting make a middling hand pay again on later streets, so it keeps less of its equity. */
function pressureAhead(situation: Situation, opponents: readonly OpponentRead[]): number {
  if (opponents.length === 0) return 0;
  const relative = relativeAggression(situation, opponents) - 1;
  return Math.min(0.08, Math.max(-0.04, 0.12 * relative));
}

/** The opponents' average postflop aggression divided by the population's. */
function relativeAggression(situation: Situation, opponents: readonly OpponentRead[]): number {
  const total = opponents.reduce((sum, opponent) => sum + situation.tendenciesOf(opponent.seat.seat).aggression, 0);
  return total / opponents.length / POPULATION_PRIORS.aggression.rate;
}

/**
 * Calling in position with a little equity to take the pot away later: worth more against players who bet once and
 * then give up, and who fold when bet into.
 */
function floatValue(situation: Situation, opponents: readonly OpponentRead[], equity: number): number {
  const { context, street, style } = situation;
  if (!situation.heroInPosition || opponents.length !== 1 || street === 'river' || equity < FLOAT_MIN_EQUITY) return 0;
  const call = context.legal.callAmount;
  const betFraction = call / Math.max(1, context.pot - call);
  if (betFraction > FLOAT_MAX_BET_FRACTION) return 0;
  const tendencies = situation.tendenciesOf(opponents[0].seat.seat);
  const givesUp = street === 'flop' ? 1 - tendencies.barrel : 1 - tendencies.aggression;
  const foldsLater = tendencies.foldToBet[street === 'flop' ? 'turn' : 'river'];
  return style.floatAppetite * givesUp * foldsLater * (context.pot + call) * FLOAT_TAKEAWAY_SHARE;
}

/** Slow-plays are mixed in only against opponents who tend to bet when checked to, and never on the river. */
function shouldTrap(situation: Situation, opponents: readonly OpponentRead[], equity: number): boolean {
  if (situation.street === 'river' || equity < TRAP_EQUITY || opponents.length === 0) return false;
  const aggressionFactor = Math.min(1.8, Math.max(0.3, relativeAggression(situation, opponents)));
  return situation.random() < situation.style.trapRate * aggressionFactor;
}
