import { describe, expect, it } from 'vitest';
import type { Card } from '../src/shared/cards';
import {
  CATEGORY_NAMES,
  compareHands,
  describeStartingHand,
  evaluateHand,
  HandCategory,
} from '../src/shared/handEvaluator';

function sortedCards(cards: readonly Card[]): Card[] {
  return [...cards].sort();
}

describe('evaluateHand categories', () => {
  it('detects a high card hand and names its highest card', () => {
    const result = evaluateHand(['2c', '5d', '7h', '9s', 'Jc']);

    expect(result.category).toBe(HandCategory.HighCard);
    expect(result.name).toBe('Carta Alta: Valete');
  });

  it('detects a pair and names it in the plural', () => {
    const result = evaluateHand(['As', 'Ad', '2c', '5h', '9s']);

    expect(result.category).toBe(HandCategory.OnePair);
    expect(result.name).toBe('Par de Ases');
  });

  it('detects two pair with the higher pair first', () => {
    const result = evaluateHand(['Ks', 'Kd', '4c', '4h', '9s']);

    expect(result.category).toBe(HandCategory.TwoPair);
    expect(result.name).toBe('Dois Pares, Reis e Quatros');
  });

  it('detects three of a kind', () => {
    const result = evaluateHand(['7c', '7d', '7h', 'Ks', '2c']);

    expect(result.category).toBe(HandCategory.ThreeOfAKind);
    expect(result.name).toBe('Trinca de Setes');
  });

  it('detects a straight and names its top card', () => {
    const result = evaluateHand(['5c', '6d', '7h', '8s', '9c']);

    expect(result.category).toBe(HandCategory.Straight);
    expect(result.name).toBe('Sequência até o Nove');
  });

  it('detects a flush and names its highest card by gender', () => {
    const result = evaluateHand(['2h', '5h', '9h', 'Jh', 'Kh']);

    expect(result.category).toBe(HandCategory.Flush);
    expect(result.name).toBe('Flush de Copas, Rei alto');
  });

  it('uses the feminine ending for a flush led by a queen', () => {
    const result = evaluateHand(['2s', '5s', '9s', 'Js', 'Qs']);

    expect(result.name).toBe('Flush de Espadas, Dama alta');
  });

  it('detects a full house and names both ranks', () => {
    const result = evaluateHand(['Ac', 'Ad', 'Ah', 'Ks', 'Kd']);

    expect(result.category).toBe(HandCategory.FullHouse);
    expect(result.name).toBe('Full House de Ases e Reis');
  });

  it('detects four of a kind and names the quad rank', () => {
    const result = evaluateHand(['9c', '9d', '9h', '9s', '2c']);

    expect(result.category).toBe(HandCategory.FourOfAKind);
    expect(result.name).toBe('Quadra de Noves');
  });

  it('detects a straight flush and names its top card', () => {
    const result = evaluateHand(['5h', '6h', '7h', '8h', '9h']);

    expect(result.category).toBe(HandCategory.StraightFlush);
    expect(result.name).toBe('Straight Flush até o Nove');
  });

  it('detects a royal flush and names its suit', () => {
    const result = evaluateHand(['Ts', 'Js', 'Qs', 'Ks', 'As']);

    expect(result.category).toBe(HandCategory.RoyalFlush);
    expect(result.name).toBe('Royal Flush de Espadas');
  });

  it('exposes a PT-BR name for every category', () => {
    expect(CATEGORY_NAMES[HandCategory.HighCard]).toBe('Carta Alta');
    expect(CATEGORY_NAMES[HandCategory.OnePair]).toBe('Par');
    expect(CATEGORY_NAMES[HandCategory.TwoPair]).toBe('Dois Pares');
    expect(CATEGORY_NAMES[HandCategory.ThreeOfAKind]).toBe('Trinca');
    expect(CATEGORY_NAMES[HandCategory.Straight]).toBe('Sequência');
    expect(CATEGORY_NAMES[HandCategory.Flush]).toBe('Flush');
    expect(CATEGORY_NAMES[HandCategory.FullHouse]).toBe('Full House');
    expect(CATEGORY_NAMES[HandCategory.FourOfAKind]).toBe('Quadra');
    expect(CATEGORY_NAMES[HandCategory.StraightFlush]).toBe('Straight Flush');
    expect(CATEGORY_NAMES[HandCategory.RoyalFlush]).toBe('Royal Flush');
  });
});

describe('category ordering', () => {
  const handsFromWeakestToStrongest: { category: HandCategory; cards: Card[] }[] = [
    { category: HandCategory.HighCard, cards: ['2c', '5d', '7h', '9s', 'Jc'] },
    { category: HandCategory.OnePair, cards: ['2c', '2d', '5h', '9s', 'Jc'] },
    { category: HandCategory.TwoPair, cards: ['2c', '2d', '5h', '5s', 'Jc'] },
    { category: HandCategory.ThreeOfAKind, cards: ['2c', '2d', '2h', '5s', 'Jc'] },
    { category: HandCategory.Straight, cards: ['5c', '6d', '7h', '8s', '9c'] },
    { category: HandCategory.Flush, cards: ['2h', '5h', '9h', 'Jh', 'Kh'] },
    { category: HandCategory.FullHouse, cards: ['2c', '2d', '2h', '5s', '5c'] },
    { category: HandCategory.FourOfAKind, cards: ['2c', '2d', '2h', '2s', 'Jc'] },
    { category: HandCategory.StraightFlush, cards: ['5h', '6h', '7h', '8h', '9h'] },
    { category: HandCategory.RoyalFlush, cards: ['Ts', 'Js', 'Qs', 'Ks', 'As'] },
  ];

  it('scores each category strictly above the category before it', () => {
    const results = handsFromWeakestToStrongest.map(({ cards }) => evaluateHand(cards));

    results.forEach((result, index) => {
      expect(result.category).toBe(handsFromWeakestToStrongest[index].category);
      if (index > 0) {
        expect(compareHands(result, results[index - 1])).toBeGreaterThan(0);
      }
    });
  });

  it('ranks a flush above a straight even when both are present', () => {
    const flushAndStraight = evaluateHand(['2h', '3h', '4h', '5h', '9h', '6c', '7d']);

    expect(flushAndStraight.category).toBe(HandCategory.Flush);
  });

  it('ranks a full house above three of a kind and a flush draw', () => {
    const fullHouse = evaluateHand(['Ah', 'Ad', 'Ac', 'Kh', 'Kd', '2h', '7h']);
    const threeOfAKind = evaluateHand(['Ah', 'Ad', 'Ac', 'Kh', 'Qd', '2h', '7h']);

    expect(fullHouse.category).toBe(HandCategory.FullHouse);
    expect(compareHands(fullHouse, threeOfAKind)).toBeGreaterThan(0);
  });
});

describe('ties and kickers', () => {
  it('breaks a pair tie with the first kicker', () => {
    const betterKicker = evaluateHand(['As', 'Ad', 'Kc', '7h', '4s']);
    const worseKicker = evaluateHand(['Ah', 'Ac', 'Qd', '7s', '4d']);

    expect(compareHands(betterKicker, worseKicker)).toBeGreaterThan(0);
  });

  it('breaks a pair tie with the second kicker when the first kicker matches', () => {
    const higherSecondKicker = evaluateHand(['As', 'Ad', 'Kc', '7h', '4s']);
    const lowerSecondKicker = evaluateHand(['Ah', 'Ac', 'Kd', '6s', '4d']);

    expect(compareHands(higherSecondKicker, lowerSecondKicker)).toBeGreaterThan(0);
  });

  it('breaks a two pair tie with the kicker', () => {
    const higherKicker = evaluateHand(['Ks', 'Kd', '5c', '5h', '9s']);
    const lowerKicker = evaluateHand(['Kc', 'Kh', '5d', '5s', '8c']);

    expect(compareHands(higherKicker, lowerKicker)).toBeGreaterThan(0);
  });

  it('compares two pair by the higher pair before the lower pair', () => {
    const higherTopPair = evaluateHand(['Ks', 'Kd', '5c', '5h', '2s']);
    const lowerTopPair = evaluateHand(['Qc', 'Qh', 'Jd', 'Js', 'Ac']);

    expect(compareHands(higherTopPair, lowerTopPair)).toBeGreaterThan(0);
  });

  it('compares flushes card by card from the highest card', () => {
    const higherFlush = evaluateHand(['Ah', 'Jh', '8h', '6h', '2h']);
    const lowerFlush = evaluateHand(['Ac', 'Jc', '8c', '6c', '3c']);

    expect(compareHands(lowerFlush, higherFlush)).toBeGreaterThan(0);
  });

  it('breaks a three of a kind tie with the kickers', () => {
    const higherKickers = evaluateHand(['Ks', 'Kd', 'Kh', '9c', '2s']);
    const lowerKickers = evaluateHand(['Kc', 'Kh', 'Kd', '9d', '3s']);

    expect(compareHands(lowerKickers, higherKickers)).toBeGreaterThan(0);
  });

  it('breaks a four of a kind tie with the board kicker', () => {
    const higherKicker = evaluateHand(['Qs', 'Qd', 'Qh', 'Qc', 'Td']);
    const lowerKicker = evaluateHand(['Qs', 'Qd', 'Qh', 'Qc', '9d']);

    expect(compareHands(higherKicker, lowerKicker)).toBeGreaterThan(0);
  });

  it('ties identical five card boards that are played by both hands', () => {
    const board: Card[] = ['5c', '6d', '7h', '8s', '9c'];
    const firstHand = evaluateHand([...board, '2h', '3d']);
    const secondHand = evaluateHand([...board, 'Kh', 'Kc']);

    expect(compareHands(firstHand, secondHand)).toBe(0);
    expect(firstHand.name).toBe(secondHand.name);
  });

  it('ties two hands that share the same royal flush board', () => {
    const board: Card[] = ['Ts', 'Js', 'Qs', 'Ks', 'As'];
    const firstHand = evaluateHand([...board, '2h', '3d']);
    const secondHand = evaluateHand([...board, '4h', '5d']);

    expect(compareHands(firstHand, secondHand)).toBe(0);
  });
});

describe('straights', () => {
  it('ranks the wheel A-2-3-4-5 as a five-high straight', () => {
    const wheel = evaluateHand(['Ac', '2d', '3h', '4s', '5c']);

    expect(wheel.category).toBe(HandCategory.Straight);
    expect(wheel.name).toBe('Sequência até o Cinco');
  });

  it('loses the wheel to a six-high straight', () => {
    const wheel = evaluateHand(['Ac', '2d', '3h', '4s', '5c']);
    const sixHigh = evaluateHand(['2c', '3d', '4h', '5s', '6c']);

    expect(compareHands(sixHigh, wheel)).toBeGreaterThan(0);
  });

  it('ranks an ace-high straight above a king-high straight', () => {
    const aceHigh = evaluateHand(['Ts', 'Jd', 'Qh', 'Kc', 'As']);
    const kingHigh = evaluateHand(['9s', 'Td', 'Jh', 'Qc', 'Ks']);

    expect(aceHigh.name).toBe('Sequência até o Ás');
    expect(compareHands(aceHigh, kingHigh)).toBeGreaterThan(0);
  });

  it('finds the highest straight among seven cards', () => {
    const result = evaluateHand(['5c', '6d', '7h', '8s', '9c', 'Td', 'Jh']);

    expect(result.category).toBe(HandCategory.Straight);
    expect(result.name).toBe('Sequência até o Valete');
  });

  it('detects a wheel straight flush and names its five-high', () => {
    const wheelStraightFlush = evaluateHand(['Ah', '2h', '3h', '4h', '5h']);

    expect(wheelStraightFlush.category).toBe(HandCategory.StraightFlush);
    expect(wheelStraightFlush.name).toBe('Straight Flush até o Cinco');
  });

  it('ranks a royal flush above a king-high straight flush', () => {
    const royalFlush = evaluateHand(['Th', 'Jh', 'Qh', 'Kh', 'Ah']);
    const kingHighStraightFlush = evaluateHand(['9h', 'Th', 'Jh', 'Qh', 'Kh']);

    expect(royalFlush.category).toBe(HandCategory.RoyalFlush);
    expect(compareHands(royalFlush, kingHighStraightFlush)).toBeGreaterThan(0);
  });
});

describe('full house and multiples', () => {
  it('uses the higher three of a kind when two trips are present', () => {
    const result = evaluateHand(['As', 'Ad', 'Ah', 'Kc', 'Kd', 'Ks', '2c']);

    expect(result.category).toBe(HandCategory.FullHouse);
    expect(result.name).toBe('Full House de Ases e Reis');
    expect(result.bestFive.filter((card) => card[0] === 'K')).toHaveLength(2);
  });

  it('uses the best pair when three of a kind and two pairs are present', () => {
    const result = evaluateHand(['Kc', 'Kd', 'Kh', '9c', '9d', '4s', '4h']);

    expect(result.category).toBe(HandCategory.FullHouse);
    expect(result.name).toBe('Full House de Reis e Noves');
  });

  it('uses the board kicker when quads are formed with two hole cards', () => {
    const result = evaluateHand(['Qs', 'Qd', 'Qh', 'Qc', '9h', '4s', '2d']);

    expect(result.category).toBe(HandCategory.FourOfAKind);
    expect(result.name).toBe('Quadra de Damas');
    expect(sortedCards(result.bestFive)).toEqual(sortedCards(['Qs', 'Qd', 'Qh', 'Qc', '9h']));
  });

  it('ranks four of a kind above a full house', () => {
    const quads = evaluateHand(['2c', '2d', '2h', '2s', '3c']);
    const fullHouse = evaluateHand(['Ac', 'Ad', 'Ah', 'Ks', 'Kd']);

    expect(compareHands(quads, fullHouse)).toBeGreaterThan(0);
  });
});

describe('best five cards', () => {
  it('returns the suited cards for a seven card flush', () => {
    const result = evaluateHand(['2h', '5h', '9h', 'Jh', 'Kh', 'Ac', 'Ad']);

    expect(sortedCards(result.bestFive)).toEqual(sortedCards(['2h', '5h', '9h', 'Jh', 'Kh']));
  });

  it('returns the top three kickers alongside the pair', () => {
    const result = evaluateHand(['As', 'Ad', '2c', '9h', 'Jd', '5s', '7c']);

    expect(sortedCards(result.bestFive)).toEqual(sortedCards(['As', 'Ad', 'Jd', '9h', '7c']));
  });

  it('returns the trips and the two best kickers for three of a kind', () => {
    const result = evaluateHand(['7c', '7d', '7h', 'Ks', '2c', 'Jd', '3h']);

    expect(sortedCards(result.bestFive)).toEqual(sortedCards(['7c', '7d', '7h', 'Ks', 'Jd']));
  });

  it('returns the top two pairs and the best kicker when three pairs are present', () => {
    const result = evaluateHand(['As', 'Ad', 'Ks', 'Kd', 'Qc', 'Qh', '2s']);

    expect(result.category).toBe(HandCategory.TwoPair);
    expect(result.name).toBe('Dois Pares, Ases e Reis');
    expect(result.bestFive.filter((card) => card[0] === 'Q')).toHaveLength(1);
    expect(result.bestFive).not.toContainEqual('2s');
  });

  it('returns exactly five cards for every input size', () => {
    expect(evaluateHand(['2c', '5d', '7h', '9s', 'Jc']).bestFive).toHaveLength(5);
    expect(evaluateHand(['2c', '5d', '7h', '9s', 'Jc', 'Kd']).bestFive).toHaveLength(5);
    expect(evaluateHand(['2c', '5d', '7h', '9s', 'Jc', 'Kd', 'Ah']).bestFive).toHaveLength(5);
  });
});

describe('input validation', () => {
  it('accepts five, six and seven card inputs', () => {
    expect(() => evaluateHand(['2c', '5d', '7h', '9s', 'Jc'])).not.toThrow();
    expect(() => evaluateHand(['2c', '5d', '7h', '9s', 'Jc', 'Kd'])).not.toThrow();
    expect(() => evaluateHand(['2c', '5d', '7h', '9s', 'Jc', 'Kd', 'Ah'])).not.toThrow();
  });

  it('throws for fewer than five cards', () => {
    expect(() => evaluateHand(['2c', '5d', '7h', '9s'])).toThrow(/5 to 7 cards, received 4/);
  });

  it('throws for more than seven cards', () => {
    expect(() => evaluateHand(['2c', '5d', '7h', '9s', 'Jc', 'Kd', 'Ah', 'Qs'])).toThrow(
      /5 to 7 cards, received 8/,
    );
  });

  it('throws for an empty input', () => {
    expect(() => evaluateHand([])).toThrow(/received 0/);
  });
});

describe('describeStartingHand', () => {
  it('describes a pocket pair in the plural', () => {
    expect(describeStartingHand(['As', 'Ad'])).toBe('Par de Ases');
  });

  it('describes suited cards and names the higher card first', () => {
    expect(describeStartingHand(['Kh', 'Ah'])).toBe('Ás e Rei do mesmo naipe');
  });

  it('describes offsuit cards without the suit clause', () => {
    expect(describeStartingHand(['Kd', 'Ah'])).toBe('Ás e Rei');
  });

  it('returns an empty label for viewers who hold no two hole cards', () => {
    expect(describeStartingHand([])).toBe('');
    expect(describeStartingHand(['As'])).toBe('');
    expect(describeStartingHand(['As', 'Ad', 'Ah'])).toBe('');
  });
});
