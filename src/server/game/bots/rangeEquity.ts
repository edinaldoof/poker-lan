import { COMBO_COUNT, COMBO_FIRST, COMBO_SECOND, type CardCode, DECK_SIZE } from './cardCodes';
import { scoreWithHole } from './fastEvaluator';

const BOARD_SIZE = 5;
const SAMPLE_RETRIES = 8;
/** Keeps `random() * total` strictly below the total even when a random source returns exactly 1. */
const LARGEST_UNIT = 1 - 1e-12;

export interface SimulatedOpponent {
  readonly weights: Float64Array;
  /** Per aggressive option: combos whose strength is below this fold; -Infinity means the player never folds. */
  readonly foldBelow: readonly number[];
  /** Per aggressive option: chips this player adds when continuing. */
  readonly continueCost: readonly number[];
  /** Per aggressive option: how many of the hero's new chips this player can match (all-in players match less). */
  readonly matchesHeroChips: readonly number[];
}

export interface AggressiveOption {
  /** Chips the hero adds with this bet or raise. */
  readonly heroCost: number;
}

export interface SimulationInput {
  readonly hole: readonly [CardCode, CardCode];
  readonly board: readonly CardCode[];
  readonly opponents: readonly SimulatedOpponent[];
  /** Per-combo strength the opponents use to decide whether to fold (board strength, or preflop rank). */
  readonly strength: Float32Array;
  readonly options: readonly AggressiveOption[];
  /** Every chip in the middle now, street bets included. */
  readonly pot: number;
  readonly iterations: number;
  readonly random: () => number;
}

export interface SimulationResult {
  /** Share of the pot won at showdown against every live opponent, 0..1. */
  readonly equity: number;
  /** Expected chips won by each aggressive option compared with folding now. */
  readonly optionEv: number[];
}

interface Sampler {
  readonly cumulative: Float64Array;
  readonly total: number;
}

/**
 * Weighted Monte Carlo: every trial draws each opponent's hand from its range (cards the hero can see are excluded),
 * deals the rest of the board, and scores every option in that same world so the comparisons share their noise.
 */
export function simulateHand(input: SimulationInput): SimulationResult {
  const dead = new Uint8Array(DECK_SIZE);
  dead[input.hole[0]] = 1;
  dead[input.hole[1]] = 1;
  for (const card of input.board) dead[card] = 1;

  const samplers = input.opponents.map((opponent) => buildSampler(opponent.weights, dead));
  const remainingDeck: CardCode[] = [];
  for (let card = 0; card < DECK_SIZE; card++) if (!dead[card]) remainingDeck.push(card);

  const opponentCount = input.opponents.length;
  const optionCount = input.options.length;
  const usedByOpponents = new Uint8Array(DECK_SIZE);
  const sampledCombos = new Int32Array(opponentCount);
  const opponentScores = new Float64Array(opponentCount);
  const fullBoard = new Uint8Array(BOARD_SIZE);
  input.board.forEach((card, index) => (fullBoard[index] = card));
  const missingCards = BOARD_SIZE - input.board.length;

  let equitySum = 0;
  const evSums = new Float64Array(optionCount);
  const trials = Math.max(1, Math.floor(input.iterations));

  for (let trial = 0; trial < trials; trial++) {
    for (let index = 0; index < opponentCount; index++) {
      const combo = sampleCombo(samplers[index], usedByOpponents, dead, input.random);
      sampledCombos[index] = combo;
      usedByOpponents[COMBO_FIRST[combo]] = 1;
      usedByOpponents[COMBO_SECOND[combo]] = 1;
    }
    dealRunout(remainingDeck, usedByOpponents, fullBoard, input.board.length, missingCards, input.random);

    const heroScore = scoreWithHole(fullBoard, BOARD_SIZE, input.hole[0], input.hole[1]);
    for (let index = 0; index < opponentCount; index++) {
      const combo = sampledCombos[index];
      opponentScores[index] = scoreWithHole(fullBoard, BOARD_SIZE, COMBO_FIRST[combo], COMBO_SECOND[combo]);
    }
    equitySum += heroShare(heroScore, opponentScores, null);

    for (let option = 0; option < optionCount; option++) {
      evSums[option] += optionPayoff(input, option, heroScore, opponentScores, sampledCombos);
    }
    for (let index = 0; index < opponentCount; index++) {
      const combo = sampledCombos[index];
      usedByOpponents[COMBO_FIRST[combo]] = 0;
      usedByOpponents[COMBO_SECOND[combo]] = 0;
    }
  }

  return {
    equity: opponentCount === 0 ? 1 : equitySum / trials,
    optionEv: Array.from(evSums, (sum) => sum / trials),
  };
}

const continuingScratch: boolean[] = [];

function optionPayoff(
  input: SimulationInput,
  option: number,
  heroScore: number,
  opponentScores: Float64Array,
  sampledCombos: Int32Array,
): number {
  let continuing = 0;
  let matchedHeroChips = 0;
  let opponentChips = 0;
  for (let index = 0; index < input.opponents.length; index++) {
    const opponent = input.opponents[index];
    const continues = input.strength[sampledCombos[index]] >= opponent.foldBelow[option];
    continuingScratch[index] = continues;
    if (!continues) continue;
    continuing++;
    matchedHeroChips = Math.max(matchedHeroChips, opponent.matchesHeroChips[option]);
    opponentChips += opponent.continueCost[option];
  }
  if (continuing === 0) return input.pot;

  const heroInvestment = Math.min(input.options[option].heroCost, matchedHeroChips);
  const finalPot = input.pot + heroInvestment + opponentChips;
  const share = heroShare(heroScore, opponentScores, continuingScratch);
  return share * finalPot - heroInvestment;
}

/** The hero's share of the pot against the opponents still in (all of them when `continuing` is null). */
function heroShare(heroScore: number, opponentScores: Float64Array, continuing: boolean[] | null): number {
  let playersSharing = 1;
  for (let index = 0; index < opponentScores.length; index++) {
    if (continuing && !continuing[index]) continue;
    if (opponentScores[index] > heroScore) return 0;
    if (opponentScores[index] === heroScore) playersSharing++;
  }
  return 1 / playersSharing;
}

function buildSampler(weights: Float64Array, dead: Uint8Array): Sampler {
  const cumulative = new Float64Array(COMBO_COUNT);
  let total = 0;
  for (let combo = 0; combo < COMBO_COUNT; combo++) {
    const blocked = dead[COMBO_FIRST[combo]] || dead[COMBO_SECOND[combo]];
    if (!blocked) total += weights[combo];
    cumulative[combo] = total;
  }
  return { cumulative, total };
}

function sampleCombo(sampler: Sampler, used: Uint8Array, dead: Uint8Array, random: () => number): number {
  if (sampler.total > 0) {
    for (let attempt = 0; attempt < SAMPLE_RETRIES; attempt++) {
      const combo = findCumulative(sampler.cumulative, Math.min(random(), LARGEST_UNIT) * sampler.total);
      if (!used[COMBO_FIRST[combo]] && !used[COMBO_SECOND[combo]]) return combo;
    }
  }
  // A stuck or unlucky random source keeps hitting taken cards: walk the range from a random start instead.
  const start = Math.min(COMBO_COUNT - 1, Math.floor(random() * COMBO_COUNT));
  const fallback = scanForCombo(sampler, used, dead, start, true);
  return fallback >= 0 ? fallback : scanForCombo(sampler, used, dead, start, false);
}

function scanForCombo(sampler: Sampler, used: Uint8Array, dead: Uint8Array, start: number, needsWeight: boolean): number {
  for (let step = 0; step < COMBO_COUNT; step++) {
    const combo = (start + step) % COMBO_COUNT;
    const first = COMBO_FIRST[combo];
    const second = COMBO_SECOND[combo];
    if (dead[first] || dead[second] || used[first] || used[second]) continue;
    const weight = sampler.cumulative[combo] - (combo > 0 ? sampler.cumulative[combo - 1] : 0);
    if (!needsWeight || weight > 0) return combo;
  }
  return -1;
}

function findCumulative(cumulative: Float64Array, target: number): number {
  let low = 0;
  let high = COMBO_COUNT - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (cumulative[middle] > target) high = middle;
    else low = middle + 1;
  }
  return low;
}

function dealRunout(
  remainingDeck: CardCode[],
  usedByOpponents: Uint8Array,
  board: Uint8Array,
  firstMissing: number,
  missingCards: number,
  random: () => number,
): void {
  let dealt = 0;
  for (let cursor = 0; dealt < missingCards && cursor < remainingDeck.length; cursor++) {
    const swapIndex = Math.min(remainingDeck.length - 1, cursor + Math.floor(random() * (remainingDeck.length - cursor)));
    const card = remainingDeck[swapIndex];
    remainingDeck[swapIndex] = remainingDeck[cursor];
    remainingDeck[cursor] = card;
    if (!usedByOpponents[card]) board[firstMissing + dealt++] = card;
  }
}
