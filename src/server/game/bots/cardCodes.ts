import { type Card, RANKS, SUITS } from '../../../shared/cards';

/** A card as a small integer: rank index (0 = deuce .. 12 = ace) * 4 + suit index. */
export type CardCode = number;

export const DECK_SIZE = 52;
export const COMBO_COUNT = 1326;

const CODE_BY_CARD = new Map<Card, CardCode>();
const CARD_BY_CODE: Card[] = [];
for (let rank = 0; rank < RANKS.length; rank++) {
  for (let suit = 0; suit < SUITS.length; suit++) {
    const card = `${RANKS[rank]}${SUITS[suit]}` as Card;
    const code = rank * 4 + suit;
    CODE_BY_CARD.set(card, code);
    CARD_BY_CODE[code] = card;
  }
}

export function cardToCode(card: Card): CardCode {
  const code = CODE_BY_CARD.get(card);
  if (code === undefined) throw new RangeError(`Unknown card: ${card}`);
  return code;
}

export function codeToCard(code: CardCode): Card {
  return CARD_BY_CODE[code];
}

export function rankOfCode(code: CardCode): number {
  return code >> 2;
}

export function suitOfCode(code: CardCode): number {
  return code & 3;
}

/** Both cards of every two-card combination, indexed 0..1325; the first card always has the lower code. */
export const COMBO_FIRST = new Uint8Array(COMBO_COUNT);
export const COMBO_SECOND = new Uint8Array(COMBO_COUNT);
const COMBO_INDEX_BY_PAIR = new Int16Array(DECK_SIZE * DECK_SIZE).fill(-1);
{
  let index = 0;
  for (let first = 0; first < DECK_SIZE; first++) {
    for (let second = first + 1; second < DECK_SIZE; second++) {
      COMBO_FIRST[index] = first;
      COMBO_SECOND[index] = second;
      COMBO_INDEX_BY_PAIR[first * DECK_SIZE + second] = index;
      COMBO_INDEX_BY_PAIR[second * DECK_SIZE + first] = index;
      index++;
    }
  }
}

export function comboIndexOf(first: CardCode, second: CardCode): number {
  return COMBO_INDEX_BY_PAIR[first * DECK_SIZE + second];
}

/** 169 starting-hand classes: pairs, suited and offsuit hands, e.g. "AKs", "T9o", "77". */
export const HAND_CLASS_COUNT = 169;
export const COMBO_CLASS = new Uint8Array(COMBO_COUNT);
export const CLASS_NAMES: string[] = [];
const CLASS_INDEX_BY_NAME = new Map<string, number>();

for (let high = 12; high >= 0; high--) {
  for (let low = high; low >= 0; low--) {
    if (high === low) registerClass(`${RANKS[high]}${RANKS[low]}`);
    else {
      registerClass(`${RANKS[high]}${RANKS[low]}s`);
      registerClass(`${RANKS[high]}${RANKS[low]}o`);
    }
  }
}
for (let combo = 0; combo < COMBO_COUNT; combo++) {
  COMBO_CLASS[combo] = CLASS_INDEX_BY_NAME.get(classNameOfCodes(COMBO_FIRST[combo], COMBO_SECOND[combo]))!;
}

function registerClass(name: string): void {
  CLASS_INDEX_BY_NAME.set(name, CLASS_NAMES.length);
  CLASS_NAMES.push(name);
}

function classNameOfCodes(first: CardCode, second: CardCode): string {
  const firstRank = rankOfCode(first);
  const secondRank = rankOfCode(second);
  const high = Math.max(firstRank, secondRank);
  const low = Math.min(firstRank, secondRank);
  if (high === low) return `${RANKS[high]}${RANKS[low]}`;
  const suited = suitOfCode(first) === suitOfCode(second);
  return `${RANKS[high]}${RANKS[low]}${suited ? 's' : 'o'}`;
}

export function classIndexOfName(name: string): number {
  const index = CLASS_INDEX_BY_NAME.get(name);
  if (index === undefined) throw new RangeError(`Unknown hand class: ${name}`);
  return index;
}

export function combosInClass(name: string): number {
  if (name.length === 2) return 6;
  return name.endsWith('s') ? 4 : 12;
}
