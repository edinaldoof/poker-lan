import { randomInt as cryptoRandomInt } from 'node:crypto';
import { type Card, createOrderedDeck } from '../../shared/cards';

/** Fisher-Yates shuffle over a fresh 52-card deck; `randomInt` is injectable for deterministic tests. */
export function shuffledDeck(
  randomInt: (maxExclusive: number) => number = (maxExclusive) => cryptoRandomInt(maxExclusive),
): Card[] {
  const deck = createOrderedDeck();
  for (let index = deck.length - 1; index > 0; index--) {
    const swapIndex = randomInt(index + 1);
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }
  return deck;
}
