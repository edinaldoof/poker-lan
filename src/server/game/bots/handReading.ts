import { type BoardStrengthTable, boardStrengthTable, hasStrongDraw } from './boardStrength';
import { COMBO_COUNT, type CardCode } from './cardCodes';
import { SHOWN_BLUFF_PERCENTILE } from './handStats';
import { type PlayerTendencies, POPULATION_PRIORS, populationFoldToBet } from './opponentModel';
import { type PositionName, STANDARD_OPEN_WIDTH } from './positions';
import { COMBO_IS_RERAISE_BLUFF, COMBO_PREFLOP_PERCENTILE } from './preflopChart';
import { type BettingStreet, type PostflopStreet, type PublicAction, isAggressive, lastAggressorBefore } from './publicInfo';

/** What a reader needs to turn a player's public actions into a weighted range of hole-card combos. */
export interface RangeReader {
  /** The community cards dealt so far; earlier streets use its first 3 or 4 cards. */
  readonly board: readonly CardCode[];
  readonly positionOf: (seat: number) => PositionName;
  readonly tendenciesOf: (seat: number) => PlayerTendencies;
  /** 0..1: how much the reader trusts what actions reveal (1 = full Bayesian update, 0 = ignores them). */
  readonly sharpness: number;
}

/** Likelihoods never drop below this, so misreads and unusual plays never make a holding impossible. */
const LIKELIHOOD_FLOOR = 0.02;

const BASE_VPIP_WIDTH: Record<PositionName, number> = {
  early: 0.2,
  hijack: 0.25,
  cutoff: 0.33,
  button: 0.45,
  smallBlind: 0.42,
  bigBlind: 0.55,
};
/** How much wider than average each position flats a raise (the big blind is getting a discount). */
const FLAT_POSITION_FACTOR: Record<PositionName, number> = {
  early: 0.7,
  hijack: 0.8,
  cutoff: 1,
  button: 1.3,
  smallBlind: 0.9,
  bigBlind: 1.7,
};
const AVERAGE_OPEN_WIDTH = 0.27;

/** Bets of at least this share of the pot read as polarised: more bluffs and nuts, fewer middling hands. */
const POLARISED_SIZE = 0.9;
const POLARISED_BLUFF_SHARE_FACTOR = 1.2;
const RAISE_BLUFF_SHARE_FACTOR = 0.5;
const MIN_BLUFF_SHARE = 0.02;
const MAX_BLUFF_SHARE = 0.6;

/** The combos `seat` may hold given every public action it took in `actions` (folds are ignored). */
export function readRange(seat: number, actions: readonly PublicAction[], reader: RangeReader): Float64Array {
  const weights = new Float64Array(COMBO_COUNT).fill(1);
  actions.forEach((action, index) => {
    if (action.seat !== seat || action.kind === 'fold') return;
    applyActionLikelihood(weights, action, actions.slice(0, index), reader);
  });
  return weights;
}

/** Narrows `weights` in place as if `seat` now took `action` (used to imagine how a bet will look to others). */
export function applyActionLikelihood(
  weights: Float64Array,
  action: PublicAction,
  earlierActions: readonly PublicAction[],
  reader: RangeReader,
): void {
  const tendencies = reader.tendenciesOf(action.seat);
  if (action.street === 'preflop') {
    const position = reader.positionOf(action.seat);
    applyLikelihood(weights, reader.sharpness, (combo) =>
      preflopLikelihood(action, COMBO_PREFLOP_PERCENTILE[combo], combo, position, tendencies),
    );
    return;
  }
  const table = tableForStreet(reader.board, action.street);
  if (!table) return;
  const context = describePostflopAction(action, earlierActions, tendencies);
  const bluff = isAggressive(action.kind) ? bluffLikelihood(context, weights, table) : 0;
  applyLikelihood(weights, reader.sharpness, (combo) => {
    const strength = table.strength[combo];
    return strength < 0 ? 0 : postflopLikelihood(context, strength, table.drawFlags[combo], bluff);
  });
}

export function tableForStreet(board: readonly CardCode[], street: BettingStreet): BoardStrengthTable | null {
  const size = street === 'flop' ? 3 : street === 'turn' ? 4 : street === 'river' ? 5 : 0;
  if (size === 0 || board.length < size) return null;
  return boardStrengthTable(board.slice(0, size));
}

function applyLikelihood(weights: Float64Array, sharpness: number, likelihoodOf: (combo: number) => number): void {
  for (let combo = 0; combo < COMBO_COUNT; combo++) {
    if (weights[combo] === 0) continue;
    const likelihood = Math.max(LIKELIHOOD_FLOOR, likelihoodOf(combo));
    weights[combo] *= sharpness === 1 ? likelihood : likelihood ** sharpness;
  }
}

// ---------------------------------------------------------------- preflop

function preflopLikelihood(
  action: PublicAction,
  percentile: number,
  combo: number,
  position: PositionName,
  tendencies: PlayerTendencies,
): number {
  const openWidth = estimatedOpenWidth(position, tendencies);
  const vpipWidth = clamp(BASE_VPIP_WIDTH[position] * (tendencies.vpip / POPULATION_PRIORS.vpip.rate), 0.05, 1);

  if (action.kind === 'check') return percentile < openWidth * 0.5 ? 0.4 : 1;
  if (action.kind === 'call' && action.raisesBefore === 0) {
    const passiveShare = 1 - clamp(tendencies.pfr / Math.max(tendencies.vpip, 0.01), 0, 1);
    return percentile < openWidth ? 0.15 + 0.6 * passiveShare : below(percentile, vpipWidth);
  }
  if (action.kind === 'call') {
    const reraiseWidth = clamp(tendencies.threeBet * 1.1, 0.02, 0.4) * (action.raisesBefore === 1 ? 1 : 0.5);
    const callWidth =
      action.raisesBefore === 1
        ? clamp(tendencies.flatCall * FLAT_POSITION_FACTOR[position] + reraiseWidth, 0.02, 0.9)
        : clamp(openWidth * (1 - tendencies.foldToThreeBet), 0.02, 0.5);
    return percentile < reraiseWidth ? 0.35 : below(percentile, callWidth);
  }
  if (action.raisesBefore === 0) return below(percentile, openWidth);
  return reraiseLikelihood(action, percentile, combo, tendencies);
}

/**
 * Opening range read from the player's raise frequency. Only half of the usual positional spread is assumed,
 * because many home-game players open the same hands from every seat.
 */
function estimatedOpenWidth(position: PositionName, tendencies: PlayerTendencies): number {
  const positionalWidth = 0.5 * STANDARD_OPEN_WIDTH[position] + 0.5 * AVERAGE_OPEN_WIDTH;
  return clamp(positionalWidth * (tendencies.pfr / POPULATION_PRIORS.pfr.rate), 0.03, 0.9);
}

function reraiseLikelihood(action: PublicAction, percentile: number, combo: number, tendencies: PlayerTendencies): number {
  const tightening = action.raisesBefore === 1 ? 1.15 : 0.5 ** (action.raisesBefore - 1);
  const allInTightening = action.allIn ? 0.75 : 1;
  const width = clamp(tendencies.threeBet * tightening * allInTightening, 0.015, 0.45);
  const aggressionFactor = clamp(tendencies.aggression / POPULATION_PRIORS.aggression.rate, 0.3, 2);
  const bluff = COMBO_IS_RERAISE_BLUFF[combo] ? 0.25 * aggressionFactor * (action.raisesBefore === 1 ? 1 : 0.4) : 0.03;
  return Math.max(below(percentile, width), bluff);
}

/** About 1 for percentiles inside `width`, falling smoothly to 0 just outside it. */
function below(percentile: number, width: number): number {
  return sigmoid((width - percentile) / (0.06 * width + 0.01));
}

// ---------------------------------------------------------------- postflop

interface PostflopActionContext {
  readonly kind: PublicAction['kind'];
  readonly street: BettingStreet;
  readonly raisesBefore: number;
  /** Bet or raise size as a share of the pot it was made into. */
  readonly sizeFraction: number;
  readonly requiredEquity: number;
  readonly wasAggressor: boolean;
  /** Nobody acted before the player on this street. */
  readonly firstToAct: boolean;
  readonly aggressionFactor: number;
  readonly tendencies: PlayerTendencies;
}

function describePostflopAction(
  action: PublicAction,
  earlierActions: readonly PublicAction[],
  tendencies: PlayerTendencies,
): PostflopActionContext {
  const potAfterCall = Math.max(1, action.potBefore + action.toCall);
  const raiseSize = Math.max(0, action.totalBet - action.betLevelBefore);
  return {
    kind: action.kind,
    street: action.street,
    raisesBefore: action.raisesBefore,
    sizeFraction: raiseSize / potAfterCall,
    requiredEquity: action.toCall / Math.max(1, action.potBefore + action.toCall),
    wasAggressor: lastAggressorBefore(action.street, earlierActions) === action.seat,
    firstToAct: !earlierActions.some((earlier) => earlier.street === action.street),
    aggressionFactor: clamp(tendencies.aggression / POPULATION_PRIORS.aggression.rate, 0.3, 2.5),
    tendencies,
  };
}

function postflopLikelihood(context: PostflopActionContext, strength: number, drawFlags: number, bluff: number): number {
  if (context.kind === 'call') return callLikelihood(context, strength);
  if (context.kind === 'check') return checkLikelihood(context, strength);
  if (strength < SHOWN_BLUFF_PERCENTILE) return Math.max(bluff, valueLikelihood(context, strength));
  return honestBetLikelihood(context, strength, drawFlags);
}

function valueThreshold(context: PostflopActionContext): number {
  const base = context.raisesBefore === 0 ? 0.7 : 0.82;
  return clamp(base - 0.12 * (context.aggressionFactor - 1), 0.5, 0.92);
}

function valueLikelihood(context: PostflopActionContext, strength: number): number {
  return sigmoid((strength - valueThreshold(context)) / 0.05);
}

/** How likely a bet is from a combo that is not a bluff: value, semi-bluffs and thin value with middling hands. */
function honestBetLikelihood(context: PostflopActionContext, strength: number, drawFlags: number): number {
  const isRaise = context.raisesBefore > 0;
  const semiBluff =
    context.street !== 'river' && hasStrongDraw(drawFlags) ? (isRaise ? 0.3 : 0.5) * Math.min(1, context.aggressionFactor) : 0;
  const medium = strength < valueThreshold(context) ? mediumBetLikelihood(context) : 0;
  return Math.max(valueLikelihood(context, strength), semiBluff, medium);
}

function mediumBetLikelihood(context: PostflopActionContext): number {
  const thinValueFactor = clamp(context.tendencies.mediumBetShare / POPULATION_PRIORS.mediumBetShare.rate, 0.4, 2.5);
  const medium = 0.22 * context.aggressionFactor * thinValueFactor * (context.raisesBefore > 0 ? 0.3 : 1);
  if (context.sizeFraction >= POLARISED_SIZE) return medium * 0.4;
  return context.sizeFraction <= 0.4 ? medium * 1.5 : medium;
}

/**
 * Likelihood that a weak combo (one that would count as a bluff at showdown) makes this bet. Continuation bets
 * follow the player's c-bet frequency. Every other bet gives the weak combos whatever likelihood makes them the
 * share of the betting range that the player's showdowns suggest: a fixed per-combo rate made a triple barrel look
 * almost bluff-free, far from how people (and the bots themselves) really barrel.
 */
function bluffLikelihood(context: PostflopActionContext, weights: Float64Array, table: BoardStrengthTable): number {
  if (context.wasAggressor && context.street === 'flop' && context.raisesBefore === 0) {
    return clamp(context.tendencies.cbet * 0.75, 0.08, 0.85) * Math.sqrt(shownBluffFactor(context));
  }
  let weakWeight = 0;
  let honestWeight = 0;
  for (let combo = 0; combo < COMBO_COUNT; combo++) {
    const strength = table.strength[combo];
    if (weights[combo] === 0 || strength < 0) continue;
    if (strength < SHOWN_BLUFF_PERCENTILE) weakWeight += weights[combo];
    else honestWeight += weights[combo] * honestBetLikelihood(context, strength, table.drawFlags[combo]);
  }
  if (weakWeight === 0) return LIKELIHOOD_FLOOR;
  const share = targetBluffShare(context);
  return clamp((share * honestWeight) / ((1 - share) * weakWeight), LIKELIHOOD_FLOOR, 1);
}

/**
 * Share of this bet's range expected to be bluffs: the share seen at showdown, raised for aggressive players while
 * their showdowns are still few, lower for raises and higher for polarised sizes.
 */
function targetBluffShare(context: PostflopActionContext): number {
  const { tendencies } = context;
  const shown = context.street === 'river' ? tendencies.riverBluffShare : tendencies.earlyBluffShare;
  const line = context.raisesBefore > 0 ? RAISE_BLUFF_SHARE_FACTOR : 1;
  const size = context.sizeFraction >= POLARISED_SIZE ? POLARISED_BLUFF_SHARE_FACTOR : 1;
  return clamp(shown * Math.sqrt(context.aggressionFactor) * line * size, MIN_BLUFF_SHARE, MAX_BLUFF_SHARE);
}

/** How the player's bets shown at showdown compare with the population's: honest bettors bluff less often. */
function shownBluffFactor(context: PostflopActionContext): number {
  const { tendencies } = context;
  const ratio =
    context.street === 'river'
      ? tendencies.riverBluffShare / POPULATION_PRIORS.riverBluffShare.rate
      : tendencies.earlyBluffShare / POPULATION_PRIORS.earlyBluffShare.rate;
  return clamp(ratio, 0.15, 2.5);
}

function callLikelihood(context: PostflopActionContext, strength: number): number {
  const street = context.street as PostflopStreet;
  const foldiness = context.tendencies.foldToBet[street] - populationFoldToBet(street);
  const threshold = clamp(0.28 + 0.65 * context.requiredEquity + 0.6 * foldiness, 0.05, 0.85);
  const continues = sigmoid((strength - threshold) / 0.07);
  const wouldOftenRaise = strength > 0.93 && context.tendencies.aggression > 0.15;
  return wouldOftenRaise ? continues * 0.65 : continues;
}

function checkLikelihood(context: PostflopActionContext, strength: number): number {
  const strongShare = sigmoid((strength - valueThreshold(context)) / 0.05);
  if (context.wasAggressor) return checkAfterInitiativeLikelihood(context, strength, strongShare);
  // Checking first to the last aggressor is routine even with strong hands; checking behind gives up more.
  const giveUpPressure = context.firstToAct ? 0.2 : 0.5;
  return Math.max(0.15, 1 - giveUpPressure * strongShare * Math.min(1, context.aggressionFactor));
}

/**
 * The last aggressor checking keeps the hands it chose not to bet: strong hands rarely, and the weak hands it did
 * not continuation-bet or barrel. A frequent c-bettor who checks is mostly holding middling hands, not air.
 */
function checkAfterInitiativeLikelihood(context: PostflopActionContext, strength: number, strongShare: number): number {
  if (strength >= SHOWN_BLUFF_PERCENTILE) {
    return Math.max(0.15, 1 - 0.75 * strongShare * Math.min(1, context.aggressionFactor));
  }
  const weakBetFrequency = context.street === 'flop' ? context.tendencies.cbet : context.tendencies.barrel;
  return Math.max(0.15, 1 - clamp(weakBetFrequency * 0.75, 0.08, 0.85));
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
