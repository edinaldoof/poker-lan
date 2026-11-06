import { DECK_SIZE } from './cardCodes';
import type { FoldEstimate, StrengthScale } from './foldModel';
import type { Intent } from './intents';
import type { PublicSeat } from './publicInfo';
import { type SimulationResult, simulateHand } from './rangeEquity';
import type { Situation } from './situation';

export interface OpponentRead {
  readonly seat: PublicSeat;
  readonly range: Float64Array;
}

/** A bet or raise the hero considers, with how each opponent is expected to answer it. */
export interface AggressivePlan {
  /** The hero's total bet on this street after the action. */
  readonly raiseTo: number;
  readonly foldEstimates: readonly FoldEstimate[];
}

export function deadCardsOf(situation: Situation): Uint8Array {
  const dead = new Uint8Array(DECK_SIZE);
  dead[situation.hole[0]] = 1;
  dead[situation.hole[1]] = 1;
  for (const card of situation.board) dead[card] = 1;
  return dead;
}

export function simulatePlans(
  situation: Situation,
  opponents: readonly OpponentRead[],
  plans: readonly AggressivePlan[],
  scale: StrengthScale,
  iterations: number,
): SimulationResult {
  const heroStreetBet = situation.context.streetBet;
  return simulateHand({
    hole: situation.hole,
    board: situation.board,
    strength: scale.strength,
    pot: situation.context.pot,
    iterations: affordableIterations(iterations, opponents.length),
    random: situation.random,
    options: plans.map((plan) => ({ heroCost: Math.max(0, plan.raiseTo - heroStreetBet) })),
    opponents: opponents.map((opponent, index) => ({
      weights: opponent.range,
      foldBelow: plans.map((plan) => plan.foldEstimates[index].threshold),
      continueCost: plans.map((plan) => Math.max(0, Math.min(plan.raiseTo - opponent.seat.streetBet, opponent.seat.chips))),
      matchesHeroChips: plans.map(() => Math.max(0, opponent.seat.streetBet + opponent.seat.chips - heroStreetBet)),
    })),
  });
}

/**
 * Every sample evaluates every live hand, so big multiway pots would cost several times a heads-up decision: up to
 * this many players the simulation runs in full, beyond it the samples shrink to keep the cost about the same.
 */
const FULL_SIMULATION_PLAYERS = 4;

function affordableIterations(iterations: number, opponents: number): number {
  return Math.max(1, Math.round(iterations * Math.min(1, FULL_SIMULATION_PLAYERS / (opponents + 1))));
}

export interface ScoredIntent {
  readonly intent: Intent;
  readonly value: number;
}

/**
 * Picks among the options with probabilities that fall off exponentially with their shortfall from the best one.
 * The temperature is the personality's discipline: near zero always takes the best value, higher drifts more.
 */
export function chooseBySoftmax(options: readonly ScoredIntent[], temperatureInChips: number, random: () => number): Intent {
  const best = Math.max(...options.map((option) => option.value));
  const temperature = Math.max(temperatureInChips, 1e-9);
  const weights = options.map((option) => Math.exp((option.value - best) / temperature));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let target = Math.min(random(), 1 - 1e-12) * total;
  for (let index = 0; index < options.length; index++) {
    target -= weights[index];
    if (target < 0) return options[index].intent;
  }
  return options[options.length - 1].intent;
}
