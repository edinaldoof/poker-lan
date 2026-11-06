export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;
export const SUITS = ['c', 'd', 'h', 's'] as const;

export type RankChar = (typeof RANKS)[number];
export type SuitChar = (typeof SUITS)[number];
export type Card = `${RankChar}${SuitChar}`;

interface RankName {
  singular: string;
  plural: string;
  feminine: boolean;
  short: string;
}

const RANK_NAMES: Record<number, RankName> = {
  2: { singular: 'Dois', plural: 'Dois', feminine: false, short: '2' },
  3: { singular: 'Três', plural: 'Três', feminine: false, short: '3' },
  4: { singular: 'Quatro', plural: 'Quatros', feminine: false, short: '4' },
  5: { singular: 'Cinco', plural: 'Cincos', feminine: false, short: '5' },
  6: { singular: 'Seis', plural: 'Seis', feminine: false, short: '6' },
  7: { singular: 'Sete', plural: 'Setes', feminine: false, short: '7' },
  8: { singular: 'Oito', plural: 'Oitos', feminine: false, short: '8' },
  9: { singular: 'Nove', plural: 'Noves', feminine: false, short: '9' },
  10: { singular: 'Dez', plural: 'Dez', feminine: false, short: '10' },
  11: { singular: 'Valete', plural: 'Valetes', feminine: false, short: 'J' },
  12: { singular: 'Dama', plural: 'Damas', feminine: true, short: 'Q' },
  13: { singular: 'Rei', plural: 'Reis', feminine: false, short: 'K' },
  14: { singular: 'Ás', plural: 'Ases', feminine: false, short: 'A' },
};

const SUIT_NAMES: Record<SuitChar, { name: string; symbol: string }> = {
  c: { name: 'Paus', symbol: '♣' },
  d: { name: 'Ouros', symbol: '♦' },
  h: { name: 'Copas', symbol: '♥' },
  s: { name: 'Espadas', symbol: '♠' },
};

export function rankValue(card: Card): number {
  return RANKS.indexOf(card[0] as RankChar) + 2;
}

export function suitOf(card: Card): SuitChar {
  return card[1] as SuitChar;
}

export function isCard(value: unknown): value is Card {
  return (
    typeof value === 'string' &&
    value.length === 2 &&
    (RANKS as readonly string[]).includes(value[0]) &&
    (SUITS as readonly string[]).includes(value[1])
  );
}

export function createOrderedDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(`${rank}${suit}`);
    }
  }
  return deck;
}

export function rankName(rank: number): RankName {
  return RANK_NAMES[rank];
}

export function suitName(suit: SuitChar): string {
  return SUIT_NAMES[suit].name;
}

/** Short label for logs and HUD, e.g. "A♠" or "10♥". */
export function cardLabel(card: Card): string {
  return `${RANK_NAMES[rankValue(card)].short}${SUIT_NAMES[suitOf(card)].symbol}`;
}

/** Spoken label for the voice narration, e.g. "Ás de Espadas". */
export function cardSpeech(card: Card): string {
  return `${RANK_NAMES[rankValue(card)].singular} de ${SUIT_NAMES[suitOf(card)].name}`;
}

export function isRedSuit(card: Card): boolean {
  const suit = suitOf(card);
  return suit === 'd' || suit === 'h';
}
