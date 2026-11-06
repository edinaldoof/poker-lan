import { type Card, rankValue, suitOf } from '../../shared/cards';
import type { PlayerActionRequest } from '../../shared/protocol';
import type { BotContext } from './bots/botTypes';
import { COMBO_COUNT, cardToCode } from './bots/cardCodes';
import { PREFLOP_SCALE } from './bots/foldModel';
import { passiveRequest, resolveIntent } from './bots/intents';
import { decidePostflop } from './bots/postflopStrategy';
import { decidePreflop } from './bots/preflopStrategy';
import { simulateHand } from './bots/rangeEquity';
import { buildSituation } from './bots/situation';

export type { BotContext, BotPersonality } from './bots/botTypes';
export type { PublicAction, PublicHandView, PublicSeat, PlayerStatCounts } from './bots/publicInfo';
export { BOT_PERSONALITIES } from './bots/styles';

const BOARD_SIZE = 5;

const MIN_THINK_MS = 700;
const MAX_THINK_MS = 2600;


/**
 * Monte-Carlo equity of `holeCards` against `opponents` random hands, in 0..1.
 * Ties count as an equal share of the pot.
 */
export function estimateEquity(
  holeCards: readonly Card[],
  community: readonly Card[],
  opponents: number,
  iterations: number,
  random: () => number = Math.random,
): number {
  if (holeCards.length !== 2) {
    throw new RangeError(`estimateEquity expects 2 hole cards, received ${holeCards.length}`);
  }
  if (community.length > BOARD_SIZE) {
    throw new RangeError(`estimateEquity expects at most ${BOARD_SIZE} community cards, received ${community.length}`);
  }
  if (opponents < 1) return 1;
  const unseenCards = 52 - 2 - community.length;
  const opponentCount = Math.min(Math.floor(opponents), Math.floor((unseenCards - (BOARD_SIZE - community.length)) / 2));
  const anyHand = new Float64Array(COMBO_COUNT).fill(1);
  return simulateHand({
    hole: [cardToCode(holeCards[0]), cardToCode(holeCards[1])],
    board: community.map(cardToCode),
    opponents: Array.from({ length: opponentCount }, () => ({
      weights: anyHand,
      foldBelow: [],
      continueCost: [],
      matchesHeroChips: [],
    })),
    strength: PREFLOP_SCALE.strength,
    options: [],
    pot: 0,
    iterations,
    random,
  }).equity;
}

/** Chen formula for a two-card starting hand: -1 (worst) to 20 (pocket aces). */
export function chenScore(holeCards: readonly Card[]): number {
  const [highRank, lowRank] = holeCards.map(rankValue).sort((a, b) => b - a);
  const highPoints = chenHighCardPoints(highRank);
  if (highRank === lowRank) return Math.max(5, highPoints * 2);

  const gap = highRank - lowRank - 1;
  let score = highPoints;
  if (suitOf(holeCards[0]) === suitOf(holeCards[1])) score += 2;
  score -= chenGapPenalty(gap);
  const queenRank = 12;
  if (gap <= 1 && highRank < queenRank) score += 1;
  return Math.ceil(score);
}

/**
 * Always returns an action that is legal for `context.legal`; never folds when checking is free.
 * The bot sees only `context`: its own cards, the board and what the table publicly knows (`context.table`).
 */
export function decideBotAction(context: BotContext, random: () => number = Math.random): PlayerActionRequest {
  if (context.holeCards.length !== 2) return passiveRequest(context.legal);
  const street = context.street;
  if (street !== 'preflop' && street !== 'flop' && street !== 'turn' && street !== 'river') {
    return passiveRequest(context.legal);
  }
  const situation = buildSituation(context, street, random);
  const intent = street === 'preflop' ? decidePreflop(situation) : decidePostflop(situation);
  return resolveIntent(intent, context);
}

/**
 * How long the bot pretends to think: 700..2600 ms, longer when more of its stack is at risk. It reads only the
 * price of the decision, never the bot's cards, so the pause cannot give the hand away.
 */
export function botThinkTimeMs(context: BotContext, random: () => number = Math.random): number {
  const stackAtRisk = context.legal.canCall ? Math.min(1, context.legal.callAmount / Math.max(context.chips, 1)) : 0;
  const postflopExtraMs = context.street === 'preflop' ? 0 : 150;
  const cautionExtraMs = (1 - context.personality.aggression) * 200;
  const thinkMs = MIN_THINK_MS + random() * 700 + stackAtRisk * 800 + postflopExtraMs + cautionExtraMs;
  return Math.round(clamp(thinkMs, MIN_THINK_MS, MAX_THINK_MS));
}

function chenHighCardPoints(rank: number): number {
  const faceCardPoints: Record<number, number> = { 14: 10, 13: 8, 12: 7, 11: 6 };
  return faceCardPoints[rank] ?? rank / 2;
}

function chenGapPenalty(gap: number): number {
  if (gap <= 2) return gap;
  return gap === 3 ? 4 : 5;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
