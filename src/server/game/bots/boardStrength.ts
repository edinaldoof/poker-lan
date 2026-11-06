import { COMBO_COUNT, COMBO_FIRST, COMBO_SECOND, type CardCode, rankOfCode, suitOfCode } from './cardCodes';
import { HAND_CATEGORY_FLUSH, HAND_CATEGORY_HIGH_CARD, HAND_CATEGORY_STRAIGHT, categoryOfScore, scoreWithHole } from './fastEvaluator';

export const DRAW_FLUSH = 1;
export const DRAW_NUT_FLUSH = 2;
export const DRAW_OPEN_ENDED = 4;
export const DRAW_GUTSHOT = 8;
export const DRAW_OVERCARDS = 16;
export const DRAW_BACKDOOR_FLUSH = 32;
const STRONG_DRAWS = DRAW_FLUSH | DRAW_OPEN_ENDED;

/** Strength of every two-card combination on one board, as the bots and their models read it. */
export interface BoardStrengthTable {
  /** Share of the other combos this one beats right now (ties count half); -1 when the board blocks the combo. */
  readonly madePercentile: Float32Array;
  /** Made strength raised by draw potential: what a sensible player treats the combo as worth, 0..1. */
  readonly strength: Float32Array;
  readonly drawFlags: Uint8Array;
  /** Combos the board does not block, weakest `strength` first. */
  readonly ascendingOrder: Uint16Array;
}

/** Draw potential expressed as the made-hand percentile it plays like, per street (flop, turn). */
const DRAW_STRENGTH = {
  flop: { comboDraw: 0.8, nutFlush: 0.7, flush: 0.64, openEnded: 0.6, gutshot: 0.46, overcards: 0.44 },
  turn: { comboDraw: 0.7, nutFlush: 0.6, flush: 0.55, openEnded: 0.53, gutshot: 0.38, overcards: 0.36 },
} as const;
const PAIR_WITH_DRAW_BONUS = 0.06;
const BACKDOOR_BONUS = 0.02;

const CACHE_LIMIT = 256;
const cache = new Map<string, BoardStrengthTable>();

export function boardStrengthTable(board: readonly CardCode[]): BoardStrengthTable {
  if (board.length < 3 || board.length > 5) throw new RangeError(`Board must have 3 to 5 cards, received ${board.length}`);
  const key = board.join(',');
  const cached = cache.get(key);
  if (cached) return cached;
  const table = buildTable(board);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, table);
  return table;
}

function buildTable(board: readonly CardCode[]): BoardStrengthTable {
  const blocked = new Uint8Array(52);
  for (const card of board) blocked[card] = 1;

  const scores = new Float64Array(COMBO_COUNT);
  const madeCategory = new Uint8Array(COMBO_COUNT);
  const liveCombos: number[] = [];
  for (let combo = 0; combo < COMBO_COUNT; combo++) {
    if (blocked[COMBO_FIRST[combo]] || blocked[COMBO_SECOND[combo]]) continue;
    const score = scoreWithHole(board, board.length, COMBO_FIRST[combo], COMBO_SECOND[combo]);
    scores[combo] = score;
    madeCategory[combo] = categoryOfScore(score);
    liveCombos.push(combo);
  }

  const madePercentile = rankPercentiles(liveCombos, scores);
  const drawFlags = new Uint8Array(COMBO_COUNT);
  const strength = new Float32Array(COMBO_COUNT).fill(-1);
  const drawStrength = board.length === 3 ? DRAW_STRENGTH.flop : board.length === 4 ? DRAW_STRENGTH.turn : null;
  const boardShape = describeBoard(board);

  for (const combo of liveCombos) {
    const made = madePercentile[combo];
    if (!drawStrength) {
      strength[combo] = made;
      continue;
    }
    const flags = drawFlagsOf(COMBO_FIRST[combo], COMBO_SECOND[combo], boardShape, madeCategory[combo], board.length);
    drawFlags[combo] = flags;
    strength[combo] = Math.min(1, combineMadeAndDraw(made, flags, drawStrength));
  }
  return { madePercentile, strength, drawFlags, ascendingOrder: sortByStrength(liveCombos, strength) };
}

export function sortByStrength(combos: readonly number[], strength: Float32Array): Uint16Array {
  return Uint16Array.from([...combos].sort((first, second) => strength[first] - strength[second]));
}

function rankPercentiles(liveCombos: number[], scores: Float64Array): Float32Array {
  const percentiles = new Float32Array(COMBO_COUNT).fill(-1);
  const sorted = [...liveCombos].sort((first, second) => scores[first] - scores[second]);
  const total = sorted.length;
  let start = 0;
  while (start < total) {
    let end = start;
    while (end + 1 < total && scores[sorted[end + 1]] === scores[sorted[start]]) end++;
    const tiedCount = end - start + 1;
    const percentile = (start + (tiedCount - 1) / 2) / Math.max(1, total - 1);
    for (let index = start; index <= end; index++) percentiles[sorted[index]] = percentile;
    start = end + 1;
  }
  return percentiles;
}

interface BoardShape {
  suitCounts: number[];
  rankMask: number;
  highestRank: number;
}

function describeBoard(board: readonly CardCode[]): BoardShape {
  const suitCounts = [0, 0, 0, 0];
  let rankMask = 0;
  let highestRank = 0;
  for (const card of board) {
    suitCounts[suitOfCode(card)]++;
    rankMask |= 1 << rankOfCode(card);
    highestRank = Math.max(highestRank, rankOfCode(card));
  }
  return { suitCounts, rankMask, highestRank };
}

function drawFlagsOf(first: CardCode, second: CardCode, board: BoardShape, category: number, boardLength: number): number {
  let flags = 0;
  if (category < HAND_CATEGORY_FLUSH) flags |= flushDrawFlags(first, second, board, boardLength);
  if (category < HAND_CATEGORY_STRAIGHT) flags |= straightDrawFlags(first, second, board.rankMask);
  if (category === HAND_CATEGORY_HIGH_CARD && Math.min(rankOfCode(first), rankOfCode(second)) > board.highestRank) {
    flags |= DRAW_OVERCARDS;
  }
  return flags;
}

function flushDrawFlags(first: CardCode, second: CardCode, board: BoardShape, boardLength: number): number {
  let flags = 0;
  for (let suit = 0; suit < 4; suit++) {
    const holeCount = Number(suitOfCode(first) === suit) + Number(suitOfCode(second) === suit);
    if (holeCount === 0) continue;
    const total = board.suitCounts[suit] + holeCount;
    if (total === 4) {
      flags |= DRAW_FLUSH;
      if (holdsNutCardOfSuit(first, second, suit, board)) flags |= DRAW_NUT_FLUSH;
    } else if (total === 3 && boardLength === 3) {
      flags |= DRAW_BACKDOOR_FLUSH;
    }
  }
  return flags;
}

function holdsNutCardOfSuit(first: CardCode, second: CardCode, suit: number, board: BoardShape): boolean {
  const ace = 12;
  const king = 11;
  const holdsRank = (rank: number) =>
    (suitOfCode(first) === suit && rankOfCode(first) === rank) || (suitOfCode(second) === suit && rankOfCode(second) === rank);
  // The board's suit counts do not say which ranks are on it, so a king only counts as the nuts with an ace on board.
  return holdsRank(ace) || (holdsRank(king) && (board.rankMask & (1 << ace)) !== 0);
}

function straightDrawFlags(first: CardCode, second: CardCode, boardMask: number): number {
  const handMask = boardMask | (1 << rankOfCode(first)) | (1 << rankOfCode(second));
  let outs = 0;
  for (let rank = 0; rank < 13; rank++) {
    const bit = 1 << rank;
    if (handMask & bit) continue;
    if (hasStraight(handMask | bit) && !hasStraight(boardMask | bit)) outs++;
  }
  if (outs >= 2) return DRAW_OPEN_ENDED;
  return outs === 1 ? DRAW_GUTSHOT : 0;
}

function hasStraight(mask: number): boolean {
  for (let high = 12; high >= 4; high--) {
    if (((mask >> (high - 4)) & 0b11111) === 0b11111) return true;
  }
  const wheel = 0b1_0000_0000_1111;
  return (mask & wheel) === wheel;
}

function combineMadeAndDraw(
  made: number,
  flags: number,
  drawStrength: (typeof DRAW_STRENGTH)[keyof typeof DRAW_STRENGTH],
): number {
  let draw = 0;
  if ((flags & DRAW_FLUSH) && (flags & (DRAW_OPEN_ENDED | DRAW_GUTSHOT))) draw = drawStrength.comboDraw;
  else if (flags & DRAW_NUT_FLUSH) draw = drawStrength.nutFlush;
  else if (flags & DRAW_FLUSH) draw = drawStrength.flush;
  else if (flags & DRAW_OPEN_ENDED) draw = drawStrength.openEnded;
  else if (flags & DRAW_GUTSHOT) draw = drawStrength.gutshot;
  else if (flags & DRAW_OVERCARDS) draw = drawStrength.overcards;
  if (flags & DRAW_BACKDOOR_FLUSH) draw += BACKDOOR_BONUS;
  if (draw === 0) return made;
  const pairedWithDraw = made >= 0.5 && (flags & STRONG_DRAWS) !== 0;
  return Math.max(made, draw) + (pairedWithDraw ? PAIR_WITH_DRAW_BONUS : 0);
}

export function hasStrongDraw(flags: number): boolean {
  return (flags & STRONG_DRAWS) !== 0;
}
