import { COMBO_COUNT, COMBO_FIRST, COMBO_SECOND } from './cardCodes';
import { sortByStrength } from './boardStrength';
import { COMBO_PREFLOP_PERCENTILE } from './preflopChart';

/** Per-combo strength with the combos listed weakest first, so weighted quantiles are a single pass. */
export interface StrengthScale {
  readonly strength: Float32Array;
  readonly ascendingOrder: Uint16Array;
}

export const PREFLOP_SCALE: StrengthScale = (() => {
  const strength = new Float32Array(COMBO_COUNT);
  const combos: number[] = [];
  for (let combo = 0; combo < COMBO_COUNT; combo++) {
    strength[combo] = 1 - COMBO_PREFLOP_PERCENTILE[combo];
    combos.push(combo);
  }
  return { strength, ascendingOrder: sortByStrength(combos, strength) };
})();

/** A player facing a bet folds the combos whose strength is below `threshold`. */
export interface FoldEstimate {
  readonly threshold: number;
}

export const NEVER_FOLDS: FoldEstimate = { threshold: Number.NEGATIVE_INFINITY };

const MAX_FOLD_SHARE = 0.95;

/** The strength where the weakest `share` of the weighted range ends; combos touching `blocked` cards are skipped. */
export function weightedQuantile(scale: StrengthScale, weights: Float64Array, share: number, blocked: Uint8Array | null): number {
  if (share <= 0) return Number.NEGATIVE_INFINITY;
  const total = liveWeight(scale, weights, blocked);
  if (total <= 0) return Number.NEGATIVE_INFINITY;
  const target = Math.min(share, 1) * total;
  let accumulated = 0;
  for (const combo of scale.ascendingOrder) {
    if (isBlocked(combo, blocked)) continue;
    accumulated += weights[combo];
    if (accumulated >= target) return scale.strength[combo] + 1e-6;
  }
  return Number.POSITIVE_INFINITY;
}

/** Share of the weighted range whose strength is below `threshold`. */
export function shareBelow(scale: StrengthScale, weights: Float64Array, threshold: number, blocked: Uint8Array | null): number {
  let below = 0;
  let total = 0;
  for (const combo of scale.ascendingOrder) {
    if (isBlocked(combo, blocked)) continue;
    total += weights[combo];
    if (scale.strength[combo] < threshold) below += weights[combo];
  }
  return total > 0 ? below / total : 0;
}

/** Folds the weakest `foldShare` of the range: used when only the player's observed habits are known. */
export function foldByShare(scale: StrengthScale, weights: Float64Array, foldShare: number, blocked: Uint8Array): FoldEstimate {
  return { threshold: weightedQuantile(scale, weights, clamp(foldShare, 0, MAX_FOLD_SHARE), blocked) };
}

export interface RangeAwareFoldInput {
  readonly scale: StrengthScale;
  readonly opponentWeights: Float64Array;
  /** How the bettor's range looks to the table after this bet. */
  readonly bettorImage: Float64Array;
  /** Pot odds the opponent is offered. */
  readonly requiredEquity: number;
  /** How often this player folds in this kind of spot (bet, c-bet, raise, bet after calling), smoothed with the prior. */
  readonly observedFoldRate: number;
  /** How often the population folds in the same kind of spot. */
  readonly populationFoldRate: number;
  readonly blocked: Uint8Array;
}

/**
 * A sensible opponent continues with the combos that beat enough of the bettor's believable range to justify the
 * price. That share is shifted, in log-odds, by how much more or less often this player folds than the population,
 * so a nit facing a strong-looking line folds more and a station hardly ever. The result never goes far above the
 * player's observed rate for this kind of spot: the range model alone was measured expecting 60-70% folds where
 * players folded 30-45%, which turned break-even bluffs into apparent winners.
 */
export function foldAgainstBettorImage(input: RangeAwareFoldInput): FoldEstimate {
  const neededShareOfImage = clamp(input.requiredEquity - CALLING_SLACK, 0, 1);
  const continueFrom = weightedQuantile(input.scale, input.bettorImage, neededShareOfImage, null);
  const rationalFoldShare = shareBelow(input.scale, input.opponentWeights, continueFrom, input.blocked);
  const habitShift = logit(input.observedFoldRate) - logit(input.populationFoldRate);
  const modelled = logistic(logit(rationalFoldShare) + habitShift) * OVERCONFIDENCE_CORRECTION;
  const foldShare = Math.min(modelled, input.observedFoldRate * FOLD_CEILING_MARGIN);
  return foldByShare(input.scale, input.opponentWeights, foldShare, input.blocked);
}

/** People call a little lighter than the pot odds say: curiosity and the fear of being bluffed. */
const CALLING_SLACK = 0.04;
/**
 * Measured over thousands of simulated bets, the uncorrected model expected about 15% more folds than it got
 * (the bets it chooses are the ones it is most optimistic about), so its fold estimates are scaled down.
 */
const OVERCONFIDENCE_CORRECTION = 0.85;
/** How far above the observed fold rate a weak-looking range may push the prediction. */
const FOLD_CEILING_MARGIN = 1.15;

function liveWeight(scale: StrengthScale, weights: Float64Array, blocked: Uint8Array | null): number {
  let total = 0;
  for (const combo of scale.ascendingOrder) if (!isBlocked(combo, blocked)) total += weights[combo];
  return total;
}

function isBlocked(combo: number, blocked: Uint8Array | null): boolean {
  return blocked !== null && (blocked[COMBO_FIRST[combo]] === 1 || blocked[COMBO_SECOND[combo]] === 1);
}

function logit(probability: number): number {
  const bounded = clamp(probability, 0.005, 0.995);
  return Math.log(bounded / (1 - bounded));
}

function logistic(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
