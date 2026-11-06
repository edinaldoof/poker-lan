import { type CardCode, rankOfCode, suitOfCode } from './cardCodes';

/**
 * A score-only hand evaluator for the bots' simulations. `evaluateHand` builds names and card lists, which costs
 * too much inside thousands of Monte-Carlo trials; this one only needs the ordering, so it works on small integers.
 * Scores are comparable only with other scores from this module: higher wins, equal ties.
 */

const CATEGORY_SHIFT = 1 << 20;
const STRAIGHT_FLUSH = 8;
const FOUR_OF_A_KIND = 7;
const FULL_HOUSE = 6;
const FLUSH = 5;
const STRAIGHT = 4;
const THREE_OF_A_KIND = 3;
const TWO_PAIR = 2;
const ONE_PAIR = 1;
const HIGH_CARD = 0;

const WHEEL_MASK = 0b1_0000_0000_1111;
const FIVE_HIGH_STRAIGHT = 3;

const rankCounts = new Uint8Array(13);
const suitCounts = new Uint8Array(4);
const suitMasks = new Uint16Array(4);
const kickerScratch = new Uint8Array(3);

export const HAND_CATEGORY_HIGH_CARD = HIGH_CARD;
export const HAND_CATEGORY_STRAIGHT = STRAIGHT;
export const HAND_CATEGORY_FLUSH = FLUSH;

export function categoryOfScore(score: number): number {
  return Math.floor(score / CATEGORY_SHIFT);
}

/** Scores `board[0..boardLength)` plus two hole cards (5 to 7 cards in total). */
export function scoreWithHole(board: ArrayLike<CardCode>, boardLength: number, first: CardCode, second: CardCode): number {
  rankCounts.fill(0);
  suitCounts.fill(0);
  suitMasks.fill(0);
  addCard(first);
  addCard(second);
  for (let index = 0; index < boardLength; index++) addCard(board[index]);
  return scoreAddedCards();
}

/** Scores 5 to 7 cards given as codes. */
export function scoreCodes(cards: ArrayLike<CardCode>): number {
  rankCounts.fill(0);
  suitCounts.fill(0);
  suitMasks.fill(0);
  for (let index = 0; index < cards.length; index++) addCard(cards[index]);
  return scoreAddedCards();
}

function addCard(code: CardCode): void {
  const rank = rankOfCode(code);
  const suit = suitOfCode(code);
  rankCounts[rank]++;
  suitCounts[suit]++;
  suitMasks[suit] |= 1 << rank;
}

function scoreAddedCards(): number {
  const flushSuit = findFlushSuit();
  if (flushSuit >= 0) {
    const straightFlushHigh = straightHighOf(suitMasks[flushSuit]);
    if (straightFlushHigh >= 0) return encode(STRAIGHT_FLUSH, straightFlushHigh, 0, 0, 0, 0);
  }

  let quads = -1;
  let firstTrips = -1;
  let secondTrips = -1;
  let firstPair = -1;
  let secondPair = -1;
  let rankMask = 0;
  for (let rank = 12; rank >= 0; rank--) {
    const count = rankCounts[rank];
    if (count === 0) continue;
    rankMask |= 1 << rank;
    if (count === 4) quads = rank;
    else if (count === 3) {
      if (firstTrips < 0) firstTrips = rank;
      else if (secondTrips < 0) secondTrips = rank;
    } else if (count === 2) {
      if (firstPair < 0) firstPair = rank;
      else if (secondPair < 0) secondPair = rank;
    }
  }

  if (quads >= 0) return encodeWithKickers(FOUR_OF_A_KIND, quads, -1, rankMask, 1);
  if (firstTrips >= 0 && (secondTrips >= 0 || firstPair >= 0)) {
    return encode(FULL_HOUSE, firstTrips, Math.max(secondTrips, firstPair), 0, 0, 0);
  }
  if (flushSuit >= 0) return encodeTopFive(FLUSH, suitMasks[flushSuit]);

  const straightHigh = straightHighOf(rankMask);
  if (straightHigh >= 0) return encode(STRAIGHT, straightHigh, 0, 0, 0, 0);
  if (firstTrips >= 0) return encodeWithKickers(THREE_OF_A_KIND, firstTrips, -1, rankMask, 2);
  if (firstPair >= 0 && secondPair >= 0) return encodeWithKickers(TWO_PAIR, firstPair, secondPair, rankMask, 1);
  if (firstPair >= 0) return encodeWithKickers(ONE_PAIR, firstPair, -1, rankMask, 3);
  return encodeTopFive(HIGH_CARD, rankMask);
}

function findFlushSuit(): number {
  for (let suit = 0; suit < 4; suit++) {
    if (suitCounts[suit] >= 5) return suit;
  }
  return -1;
}

function straightHighOf(mask: number): number {
  for (let high = 12; high >= 4; high--) {
    if (((mask >> (high - 4)) & 0b11111) === 0b11111) return high;
  }
  return (mask & WHEEL_MASK) === WHEEL_MASK ? FIVE_HIGH_STRAIGHT : -1;
}

/** Made ranks first (`secondMade` is -1 when there is only one), then the best remaining ranks as kickers. */
function encodeWithKickers(
  category: number,
  firstMade: number,
  secondMade: number,
  rankMask: number,
  kickerCount: number,
): number {
  let remaining = rankMask & ~(1 << firstMade);
  if (secondMade >= 0) remaining &= ~(1 << secondMade);
  const kickers = kickerScratch.fill(0);
  let found = 0;
  for (let rank = 12; rank >= 0 && found < kickerCount; rank--) {
    if (remaining & (1 << rank)) kickers[found++] = rank;
  }
  if (secondMade >= 0) return encode(category, firstMade, secondMade, kickers[0], 0, 0);
  return encode(category, firstMade, kickers[0], kickers[1], kickers[2], 0);
}

function encodeTopFive(category: number, mask: number): number {
  let score = category * CATEGORY_SHIFT;
  let weight = 65536;
  for (let rank = 12; rank >= 0 && weight >= 1; rank--) {
    if (mask & (1 << rank)) {
      score += rank * weight;
      weight /= 16;
    }
  }
  return score;
}

function encode(category: number, first: number, second: number, third: number, fourth: number, fifth: number): number {
  return category * CATEGORY_SHIFT + first * 65536 + second * 4096 + third * 256 + fourth * 16 + fifth;
}
