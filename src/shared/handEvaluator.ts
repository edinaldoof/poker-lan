import { type Card, rankName, rankValue, suitName, suitOf, type SuitChar } from './cards';

export enum HandCategory {
  HighCard = 0,
  OnePair = 1,
  TwoPair = 2,
  ThreeOfAKind = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  FourOfAKind = 7,
  StraightFlush = 8,
  RoyalFlush = 9,
}

export const CATEGORY_NAMES: Record<HandCategory, string> = {
  [HandCategory.HighCard]: 'Carta Alta',
  [HandCategory.OnePair]: 'Par',
  [HandCategory.TwoPair]: 'Dois Pares',
  [HandCategory.ThreeOfAKind]: 'Trinca',
  [HandCategory.Straight]: 'Sequência',
  [HandCategory.Flush]: 'Flush',
  [HandCategory.FullHouse]: 'Full House',
  [HandCategory.FourOfAKind]: 'Quadra',
  [HandCategory.StraightFlush]: 'Straight Flush',
  [HandCategory.RoyalFlush]: 'Royal Flush',
};

export interface HandResult {
  category: HandCategory;
  /** Higher is better; equal scores tie. */
  score: number;
  /** The five cards that make the hand, most significant first. */
  bestFive: Card[];
  /** Full PT-BR description, e.g. "Full House de Ases e Reis". */
  name: string;
}

interface ParsedCard {
  card: Card;
  rank: number;
  suit: SuitChar;
}

const RANK_BASE = 15;
const CATEGORY_WEIGHT = RANK_BASE ** 5;

export function evaluateHand(cards: readonly Card[]): HandResult {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`evaluateHand expects 5 to 7 cards, received ${cards.length}`);
  }
  const parsed = cards
    .map((card) => ({ card, rank: rankValue(card), suit: suitOf(card) }))
    .sort((a, b) => b.rank - a.rank);

  const flushCards = findFlushCards(parsed);
  if (flushCards) {
    const straightFlush = findStraight(flushCards);
    if (straightFlush) {
      const category = straightFlush.high === 14 ? HandCategory.RoyalFlush : HandCategory.StraightFlush;
      return buildResult(category, [straightFlush.high], straightFlush.cards);
    }
  }

  const rankGroups = groupByRank(parsed);
  const [firstGroup, secondGroup] = rankGroups;

  if (firstGroup.length === 4) {
    const kicker = parsed.find((card) => card.rank !== firstGroup[0].rank)!;
    return buildResult(HandCategory.FourOfAKind, [firstGroup[0].rank, kicker.rank], [...firstGroup, kicker]);
  }

  if (firstGroup.length === 3 && secondGroup && secondGroup.length >= 2) {
    const pair = secondGroup.slice(0, 2);
    return buildResult(HandCategory.FullHouse, [firstGroup[0].rank, pair[0].rank], [...firstGroup, ...pair]);
  }

  if (flushCards) {
    const five = flushCards.slice(0, 5);
    return buildResult(
      HandCategory.Flush,
      five.map((card) => card.rank),
      five,
    );
  }

  const straight = findStraight(parsed);
  if (straight) {
    return buildResult(HandCategory.Straight, [straight.high], straight.cards);
  }

  if (firstGroup.length === 3) {
    const kickers = parsed.filter((card) => card.rank !== firstGroup[0].rank).slice(0, 2);
    return buildResult(
      HandCategory.ThreeOfAKind,
      [firstGroup[0].rank, ...kickers.map((card) => card.rank)],
      [...firstGroup, ...kickers],
    );
  }

  if (firstGroup.length === 2 && secondGroup && secondGroup.length === 2) {
    const kicker = parsed.find((card) => card.rank !== firstGroup[0].rank && card.rank !== secondGroup[0].rank)!;
    return buildResult(
      HandCategory.TwoPair,
      [firstGroup[0].rank, secondGroup[0].rank, kicker.rank],
      [...firstGroup, ...secondGroup, kicker],
    );
  }

  if (firstGroup.length === 2) {
    const kickers = parsed.filter((card) => card.rank !== firstGroup[0].rank).slice(0, 3);
    return buildResult(
      HandCategory.OnePair,
      [firstGroup[0].rank, ...kickers.map((card) => card.rank)],
      [...firstGroup, ...kickers],
    );
  }

  const five = parsed.slice(0, 5);
  return buildResult(
    HandCategory.HighCard,
    five.map((card) => card.rank),
    five,
  );
}

export function compareHands(a: HandResult, b: HandResult): number {
  return a.score - b.score;
}

/**
 * Describes a two-card starting hand, e.g. "Par de Ases" or "Ás e Rei do mesmo naipe".
 * Returns an empty string, by design, when the holder has no two hole cards (spectators,
 * players sitting out): callers use it as "no label to show" instead of handling an error.
 */
export function describeStartingHand(cards: readonly Card[]): string {
  if (cards.length !== 2) return '';
  const [first, second] = [...cards].sort((a, b) => rankValue(b) - rankValue(a));
  const highRank = rankValue(first);
  const lowRank = rankValue(second);
  if (highRank === lowRank) return `Par de ${rankName(highRank).plural}`;
  const suited = suitOf(first) === suitOf(second) ? ' do mesmo naipe' : '';
  return `${rankName(highRank).singular} e ${rankName(lowRank).singular}${suited}`;
}

function findFlushCards(sortedCards: ParsedCard[]): ParsedCard[] | null {
  const bySuit = new Map<SuitChar, ParsedCard[]>();
  for (const card of sortedCards) {
    const group = bySuit.get(card.suit) ?? [];
    group.push(card);
    bySuit.set(card.suit, group);
  }
  for (const group of bySuit.values()) {
    if (group.length >= 5) return group;
  }
  return null;
}

function findStraight(sortedCards: ParsedCard[]): { high: number; cards: ParsedCard[] } | null {
  const firstCardOfRank = new Map<number, ParsedCard>();
  for (const card of sortedCards) {
    if (!firstCardOfRank.has(card.rank)) firstCardOfRank.set(card.rank, card);
  }
  for (let high = 14; high >= 5; high--) {
    const sequence: ParsedCard[] = [];
    for (let rank = high; rank > high - 5; rank--) {
      // The ace also plays low in the wheel (5-4-3-2-A).
      const card = firstCardOfRank.get(rank === 1 ? 14 : rank);
      if (!card) break;
      sequence.push(card);
    }
    if (sequence.length === 5) return { high, cards: sequence };
  }
  return null;
}

function groupByRank(sortedCards: ParsedCard[]): ParsedCard[][] {
  const byRank = new Map<number, ParsedCard[]>();
  for (const card of sortedCards) {
    const group = byRank.get(card.rank) ?? [];
    group.push(card);
    byRank.set(card.rank, group);
  }
  return [...byRank.values()].sort((a, b) => b.length - a.length || b[0].rank - a[0].rank);
}

function buildResult(category: HandCategory, tiebreakers: number[], cards: ParsedCard[]): HandResult {
  let score = category * CATEGORY_WEIGHT;
  for (let index = 0; index < 5; index++) {
    score += (tiebreakers[index] ?? 0) * RANK_BASE ** (4 - index);
  }
  return {
    category,
    score,
    bestFive: cards.map((card) => card.card),
    name: describeHand(category, tiebreakers, cards),
  };
}

function describeHand(category: HandCategory, tiebreakers: number[], cards: ParsedCard[]): string {
  const [primary, secondary] = tiebreakers;
  switch (category) {
    case HandCategory.RoyalFlush:
      return `Royal Flush de ${suitName(cards[0].suit)}`;
    case HandCategory.StraightFlush:
      return `Straight Flush até ${withArticle(primary)}`;
    case HandCategory.FourOfAKind:
      return `Quadra de ${rankName(primary).plural}`;
    case HandCategory.FullHouse:
      return `Full House de ${rankName(primary).plural} e ${rankName(secondary).plural}`;
    case HandCategory.Flush:
      return `Flush de ${suitName(cards[0].suit)}, ${rankName(primary).singular} ${rankName(primary).feminine ? 'alta' : 'alto'}`;
    case HandCategory.Straight:
      return `Sequência até ${withArticle(primary)}`;
    case HandCategory.ThreeOfAKind:
      return `Trinca de ${rankName(primary).plural}`;
    case HandCategory.TwoPair:
      return `Dois Pares, ${rankName(primary).plural} e ${rankName(secondary).plural}`;
    case HandCategory.OnePair:
      return `Par de ${rankName(primary).plural}`;
    case HandCategory.HighCard:
      return `Carta Alta: ${rankName(primary).singular}`;
  }
}

function withArticle(rank: number): string {
  const name = rankName(rank);
  return `${name.feminine ? 'a' : 'o'} ${name.singular}`;
}
