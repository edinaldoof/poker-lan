import { describe, expect, it } from 'vitest';
import { type Card, createOrderedDeck, isCard, rankValue } from '../src/shared/cards';
import { CATEGORY_NAMES, describeStartingHand, evaluateHand, HandCategory } from '../src/shared/handEvaluator';
import { buildPots, splitPot } from '../src/server/game/pots';
import {
  cardAtlasCell,
  cardBackgroundPosition,
  filterGlossary,
  formatProbability,
  GLOSSARY,
  HAND_RANKING,
  handNameToCategory,
  isManualSection,
  MANUAL_SECTION_IDS,
  MANUAL_SECTIONS,
  type ManualCard,
  ODD_CHIP_EXAMPLE,
  parseInlineMarkup,
  probabilityBarRatio,
  SIDE_POT_EXAMPLE,
  WHEEL_EXAMPLE,
} from '../src/client/manual/manualContent';

function createSeededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function collectStrings(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, found);
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, found);
  return found;
}

function collectCardLists(value: unknown, found: ManualCard[][] = []): ManualCard[][] {
  if (Array.isArray(value)) {
    for (const item of value) collectCardLists(item, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'cards' && Array.isArray(item)) found.push(item as ManualCard[]);
      else collectCardLists(item, found);
    }
  }
  return found;
}

describe('hand ranking content', () => {
  it('lists the 10 categories from strongest to weakest', () => {
    expect(HAND_RANKING).toHaveLength(10);
    expect(HAND_RANKING.map((entry) => entry.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(HAND_RANKING[0].category).toBe(HandCategory.RoyalFlush);
    expect(HAND_RANKING[9].category).toBe(HandCategory.HighCard);

    for (let index = 1; index < HAND_RANKING.length; index++) {
      expect(HAND_RANKING[index].category).toBeLessThan(HAND_RANKING[index - 1].category);
    }
  });

  it('names every entry like the evaluator does', () => {
    for (const entry of HAND_RANKING) {
      expect(entry.name).toBe(CATEGORY_NAMES[entry.category]);
    }
  });

  it('gives every entry five distinct valid example cards', () => {
    for (const entry of HAND_RANKING) {
      expect(entry.cards).toHaveLength(5);
      expect(entry.cards.every((card) => isCard(card))).toBe(true);
      expect(new Set(entry.cards).size).toBe(5);
    }
  });

  it('shows examples that the evaluator classifies as the entry category', () => {
    for (const entry of HAND_RANKING) {
      const result = evaluateHand(entry.cards);
      expect(result.category, entry.name).toBe(entry.category);
      expect(result.bestFive, entry.name).toEqual([...entry.cards]);
    }
  });

  it('marks as kickers only trailing cards that are not part of the combination', () => {
    const expectedKickers: Record<HandCategory, number> = {
      [HandCategory.RoyalFlush]: 0,
      [HandCategory.StraightFlush]: 0,
      [HandCategory.FourOfAKind]: 1,
      [HandCategory.FullHouse]: 0,
      [HandCategory.Flush]: 0,
      [HandCategory.Straight]: 0,
      [HandCategory.ThreeOfAKind]: 2,
      [HandCategory.TwoPair]: 1,
      [HandCategory.OnePair]: 3,
      [HandCategory.HighCard]: 4,
    };

    for (const entry of HAND_RANKING) {
      expect(entry.kickerCount, entry.name).toBe(expectedKickers[entry.category]);
      const combination = entry.cards.slice(0, 5 - entry.kickerCount);
      const kickers = entry.cards.slice(5 - entry.kickerCount);
      const combinationRanks = new Set(combination.map(rankValue));
      expect(kickers.some((kicker) => combinationRanks.has(rankValue(kicker))), entry.name).toBe(false);
    }
  });

  it('has probabilities that add up to about 100 %', () => {
    const total = HAND_RANKING.reduce((sum, entry) => sum + entry.probabilityPercent, 0);
    expect(total).toBeGreaterThan(99.5);
    expect(total).toBeLessThan(100.5);
    expect(HAND_RANKING.map((entry) => entry.probabilityPercent)).toEqual([0.0032, 0.028, 0.17, 2.6, 3.0, 4.6, 4.8, 23.5, 43.8, 17.4]);
  });

  it('describes every entry and how ties are broken', () => {
    for (const entry of HAND_RANKING) {
      expect(entry.description.trim().length, entry.name).toBeGreaterThan(0);
      expect(entry.tiebreak.trim().length, entry.name).toBeGreaterThan(0);
    }
  });

  it('keeps the wheel example a five-high straight', () => {
    const result = evaluateHand(WHEEL_EXAMPLE);
    expect(result.category).toBe(HandCategory.Straight);
    expect(result.name).toBe('Sequência até o Cinco');
  });
});

describe('probability formatting', () => {
  const normalize = (text: string): string => text.replace(/ /g, ' ');

  it('uses the Brazilian decimal comma', () => {
    expect(normalize(formatProbability(0.0032))).toBe('0,0032 %');
    expect(normalize(formatProbability(0.028))).toBe('0,028 %');
    expect(normalize(formatProbability(0.17))).toBe('0,17 %');
    expect(normalize(formatProbability(2.6))).toBe('2,6 %');
    expect(normalize(formatProbability(3.0))).toBe('3,0 %');
    expect(normalize(formatProbability(43.8))).toBe('43,8 %');
  });

  it('keeps the percent sign attached to the number with a non-breaking space', () => {
    expect(formatProbability(23.5)).toContain(' %');
  });

  it('draws a log-scale bar that grows with the probability and stays visible', () => {
    const ratios = [...HAND_RANKING].sort((a, b) => a.probabilityPercent - b.probabilityPercent).map((entry) => probabilityBarRatio(entry.probabilityPercent));
    for (let index = 1; index < ratios.length; index++) {
      expect(ratios[index]).toBeGreaterThan(ratios[index - 1]);
    }
    expect(ratios[0]).toBeGreaterThan(0);
    expect(ratios[ratios.length - 1]).toBeLessThanOrEqual(1);
    expect(probabilityBarRatio(0.0000001)).toBeGreaterThan(0);
    expect(probabilityBarRatio(1000)).toBeCloseTo(1, 10);
  });
});

describe('handNameToCategory', () => {
  it('maps the names shown in the HUD', () => {
    expect(handNameToCategory('Par de Reis')).toBe(HandCategory.OnePair);
    expect(handNameToCategory('Full House de Ases e Reis')).toBe(HandCategory.FullHouse);
    expect(handNameToCategory('Carta Alta: Ás')).toBe(HandCategory.HighCard);
    expect(handNameToCategory('Ás e Rei do mesmo naipe')).toBe(HandCategory.HighCard);
    expect(handNameToCategory('Par de Ases')).toBe(HandCategory.OnePair);
  });

  it('does not confuse categories that share words', () => {
    expect(handNameToCategory('Straight Flush até o Nove')).toBe(HandCategory.StraightFlush);
    expect(handNameToCategory('Royal Flush de Espadas')).toBe(HandCategory.RoyalFlush);
    expect(handNameToCategory('Flush de Copas, Ás alto')).toBe(HandCategory.Flush);
    expect(handNameToCategory('Dois Pares, Ases e Reis')).toBe(HandCategory.TwoPair);
    expect(handNameToCategory('Quadra de Damas')).toBe(HandCategory.FourOfAKind);
    expect(handNameToCategory('Trinca de Setes')).toBe(HandCategory.ThreeOfAKind);
  });

  it('ignores case and accents', () => {
    expect(handNameToCategory('sequencia ate o dez')).toBe(HandCategory.Straight);
    expect(handNameToCategory('  SEQUÊNCIA até o Dez ')).toBe(HandCategory.Straight);
  });

  it('returns null when there is no hand to highlight', () => {
    expect(handNameToCategory(null)).toBeNull();
    expect(handNameToCategory(undefined)).toBeNull();
    expect(handNameToCategory('')).toBeNull();
    expect(handNameToCategory('   ')).toBeNull();
    expect(handNameToCategory('Aguardando jogadores…')).toBeNull();
  });

  it('recognises the name of every example hand', () => {
    for (const entry of HAND_RANKING) {
      expect(handNameToCategory(evaluateHand(entry.cards).name), entry.name).toBe(entry.category);
    }
  });

  it('recognises the evaluator name of random 7-card hands', () => {
    const random = createSeededRandom(20240607);
    const seenCategories = new Set<HandCategory>();

    for (let round = 0; round < 3000; round++) {
      const deck = createOrderedDeck();
      for (let index = deck.length - 1; index > 0; index--) {
        const swapIndex = Math.floor(random() * (index + 1));
        [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
      }
      const result = evaluateHand(deck.slice(0, 7));
      seenCategories.add(result.category);
      expect(handNameToCategory(result.name), result.name).toBe(result.category);
    }
    expect(seenCategories.size).toBeGreaterThanOrEqual(7);
  });

  it('recognises every possible starting hand', () => {
    const deck = createOrderedDeck();
    let checked = 0;
    for (let first = 0; first < deck.length; first++) {
      for (let second = first + 1; second < deck.length; second++) {
        const hole: Card[] = [deck[first], deck[second]];
        const expected = rankValue(hole[0]) === rankValue(hole[1]) ? HandCategory.OnePair : HandCategory.HighCard;
        expect(handNameToCategory(describeStartingHand(hole)), hole.join(' ')).toBe(expected);
        checked++;
      }
    }
    expect(checked).toBe(1326);
  });

  it('recognises hands with the rarest categories drawn from seven cards', () => {
    expect(handNameToCategory(evaluateHand(['As', 'Ks', 'Qs', 'Js', 'Ts', '2d', '3c']).name)).toBe(HandCategory.RoyalFlush);
    expect(handNameToCategory(evaluateHand(['9h', '8h', '7h', '6h', '5h', 'Ah', 'Kd']).name)).toBe(HandCategory.StraightFlush);
    expect(handNameToCategory(evaluateHand(['Ad', '2d', '3d', '4d', '5d', 'Kc', 'Kh']).name)).toBe(HandCategory.StraightFlush);
  });
});

describe('manual sections', () => {
  it('has the five sections in tab order', () => {
    expect(MANUAL_SECTIONS.map((section) => section.id)).toEqual(['como-jogar', 'ranking', 'juiz', 'controles', 'glossario']);
    expect([...MANUAL_SECTION_IDS]).toEqual(MANUAL_SECTIONS.map((section) => section.id));
    expect(new Set(MANUAL_SECTIONS.map((section) => section.title)).size).toBe(5);
  });

  it('validates section ids', () => {
    expect(isManualSection('juiz')).toBe(true);
    expect(isManualSection('inexistente')).toBe(false);
    expect(isManualSection(undefined)).toBe(false);
  });

  it('fills every section with non-empty content', () => {
    for (const section of MANUAL_SECTIONS) {
      expect(section.title.trim().length, section.id).toBeGreaterThan(0);
      expect(section.summary.trim().length, section.id).toBeGreaterThan(0);
      expect(section.glyph.trim().length, section.id).toBeGreaterThan(0);
      expect(section.blocks.length, section.id).toBeGreaterThan(0);
      for (const text of collectStrings(section.blocks)) {
        expect(text.trim().length, `${section.id} has a blank string`).toBeGreaterThan(0);
      }
    }
  });

  it('wires the ranking and glossary blocks into their sections', () => {
    const kindsOf = (id: string): string[] => MANUAL_SECTIONS.find((section) => section.id === id)!.blocks.map((block) => block.kind);
    expect(kindsOf('ranking')).toContain('ranking');
    expect(kindsOf('glossario')).toContain('glossary');
  });

  it('only references real cards or the card back', () => {
    const lists = MANUAL_SECTIONS.flatMap((section) => collectCardLists(section.blocks));
    expect(lists.length).toBeGreaterThan(0);
    for (const cards of lists) {
      for (const card of cards) {
        expect(card === 'back' || isCard(card), String(card)).toBe(true);
      }
    }
  });

  it('keeps the inline markup balanced', () => {
    for (const section of MANUAL_SECTIONS) {
      for (const text of collectStrings(section.blocks)) {
        const plain = parseInlineMarkup(text)
          .map((token) => token.text)
          .join('');
        expect(plain, text).not.toMatch(/\*\*|`/);
      }
    }
  });

  it('covers the topics the manual promises', () => {
    const allText = MANUAL_SECTIONS.flatMap((section) => collectStrings(section.blocks)).join('\n');
    for (const topic of ['Fold', 'Check', 'Pagar', 'Apostar', 'Aumentar', 'All-In', 'big blind', 'side pot', 'Recomprar', 'Heads-up']) {
      expect(allText.toLowerCase(), topic).toContain(topic.toLowerCase());
    }
    for (const topic of ['2× BB', '½ Pote', 'Pote', 'Enter', 'Zoom', 'Duplo clique', 'Wi-Fi', 'Reconexão', 'Completa', 'Essencial', 'Desligada']) {
      expect(allText, topic).toContain(topic);
    }
  });
});

describe('worked examples', () => {
  const [short, medium, long] = SIDE_POT_EXAMPLE.players;

  it('matches the side pots the server builds for the same stacks', () => {
    const calledByEveryone = Math.min(long.stack, medium.stack);
    const pots = buildPots([
      { seat: 0, contribution: short.stack, folded: false },
      { seat: 1, contribution: medium.stack, folded: false },
      { seat: 2, contribution: calledByEveryone, folded: false },
    ]);

    expect(pots).toEqual([
      { amount: SIDE_POT_EXAMPLE.mainPot, eligibleSeats: [0, 1, 2] },
      { amount: SIDE_POT_EXAMPLE.sidePot, eligibleSeats: [1, 2] },
    ]);
    expect(long.stack - calledByEveryone).toBe(SIDE_POT_EXAMPLE.returned);
  });

  it('shows the uncalled excess as a pot only its owner can win', () => {
    const pots = buildPots([
      { seat: 0, contribution: short.stack, folded: false },
      { seat: 1, contribution: medium.stack, folded: false },
      { seat: 2, contribution: long.stack, folded: false },
    ]);

    expect(pots.map((pot) => pot.amount)).toEqual([SIDE_POT_EXAMPLE.mainPot, SIDE_POT_EXAMPLE.sidePot, SIDE_POT_EXAMPLE.returned]);
    expect(pots[2].eligibleSeats).toEqual([2]);
  });

  it('mentions the side pot figures in the copy', () => {
    const text = collectStrings(MANUAL_SECTIONS[0].blocks).join('\n');
    expect(text).toContain(String(SIDE_POT_EXAMPLE.mainPot));
    expect(text).toContain(String(SIDE_POT_EXAMPLE.sidePot));
    expect(text).toContain(String(SIDE_POT_EXAMPLE.returned));
    expect(text).toContain(String(SIDE_POT_EXAMPLE.mainPot + SIDE_POT_EXAMPLE.sidePot));
  });

  it('splits the odd chip toward the first winner after the dealer', () => {
    const shares = splitPot(ODD_CHIP_EXAMPLE.pot, [3, 5]);
    expect(shares.get(3)).toBe(ODD_CHIP_EXAMPLE.firstShare);
    expect(shares.get(5)).toBe(ODD_CHIP_EXAMPLE.secondShare);
  });
});

describe('glossary', () => {
  it('defines at least 20 distinct terms, in alphabetical order', () => {
    expect(GLOSSARY.length).toBeGreaterThanOrEqual(20);
    expect(new Set(GLOSSARY.map((entry) => entry.term)).size).toBe(GLOSSARY.length);

    const terms = GLOSSARY.map((entry) => entry.term);
    const sorted = [...terms].sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
    expect(terms).toEqual(sorted);
    for (const entry of GLOSSARY) {
      expect(entry.definition.trim().length, entry.term).toBeGreaterThan(0);
    }
  });

  it('includes the terms players hear most', () => {
    const required = [
      'Blinds',
      'Button',
      'Stack',
      'Pote',
      'Side pot',
      'Flop',
      'Turn',
      'River',
      'Showdown',
      'Kicker',
      'Nuts',
      'Muck',
      'Limp',
      'Check-raise',
      'Pot odds',
      'All-in',
      'Heads-up',
      'Bad beat',
      'Bluff',
      'Rebuy',
    ];
    for (const term of required) {
      expect(
        GLOSSARY.some((entry) => entry.term.toLowerCase().startsWith(term.toLowerCase())),
        term,
      ).toBe(true);
    }
  });

  it('filters by term, alias or definition without caring about accents or case', () => {
    expect(filterGlossary(GLOSSARY, '')).toHaveLength(GLOSSARY.length);
    expect(filterGlossary(GLOSSARY, 'blefe').map((entry) => entry.term)).toContain('Bluff');
    expect(filterGlossary(GLOSSARY, 'RIVER').map((entry) => entry.term)).toContain('River');
    expect(filterGlossary(GLOSSARY, 'ultima').map((entry) => entry.term)).toContain('River');
    expect(filterGlossary(GLOSSARY, 'zzzz-nao-existe')).toEqual([]);
  });
});

describe('card atlas helpers', () => {
  it('places cards on the 13 x 5 atlas: columns A,2..10,J,Q,K and rows c,d,h,s', () => {
    expect(cardAtlasCell('Ac')).toEqual({ column: 0, row: 0 });
    expect(cardAtlasCell('2c')).toEqual({ column: 1, row: 0 });
    expect(cardAtlasCell('Td')).toEqual({ column: 9, row: 1 });
    expect(cardAtlasCell('Jh')).toEqual({ column: 10, row: 2 });
    expect(cardAtlasCell('Qs')).toEqual({ column: 11, row: 3 });
    expect(cardAtlasCell('Ks')).toEqual({ column: 12, row: 3 });
    expect(cardAtlasCell('back')).toEqual({ column: 0, row: 4 });
  });

  it('gives every card of the deck its own cell', () => {
    const cells = createOrderedDeck().map((card) => {
      const { column, row } = cardAtlasCell(card);
      return `${column}:${row}`;
    });
    expect(new Set(cells).size).toBe(52);
  });

  it('computes background-position as column / 12 and row / 4', () => {
    expect(cardBackgroundPosition('Ac')).toBe('0% 0%');
    expect(cardBackgroundPosition('As')).toBe('0% 75%');
    expect(cardBackgroundPosition('Kh')).toBe('100% 50%');
    expect(cardBackgroundPosition('2c')).toBe('8.3333% 0%');
    expect(cardBackgroundPosition('back')).toBe('0% 100%');
  });
});

describe('parseInlineMarkup', () => {
  it('returns plain text untouched', () => {
    expect(parseInlineMarkup('texto simples')).toEqual([{ kind: 'text', text: 'texto simples' }]);
  });

  it('splits bold and code runs', () => {
    expect(parseInlineMarkup('Use **Fold** ou `F` agora')).toEqual([
      { kind: 'text', text: 'Use ' },
      { kind: 'strong', text: 'Fold' },
      { kind: 'text', text: ' ou ' },
      { kind: 'code', text: 'F' },
      { kind: 'text', text: ' agora' },
    ]);
  });

  it('keeps unmatched markers as text and never produces HTML', () => {
    expect(parseInlineMarkup('2 * 3 ** 4')).toEqual([{ kind: 'text', text: '2 * 3 ** 4' }]);
    expect(parseInlineMarkup('<b>x</b>')).toEqual([{ kind: 'text', text: '<b>x</b>' }]);
    expect(parseInlineMarkup('')).toEqual([]);
  });
});
