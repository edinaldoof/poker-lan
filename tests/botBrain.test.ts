import { describe, expect, it } from 'vitest';
import { type Card, createOrderedDeck } from '../src/shared/cards';
import type { LegalActions, PlayerActionRequest, Street } from '../src/shared/protocol';
import {
  BOT_PERSONALITIES,
  type BotContext,
  type BotPersonality,
  botThinkTimeMs,
  chenScore,
  decideBotAction,
  estimateEquity,
} from '../src/server/game/BotBrain';

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function pickOne<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)];
}

function shuffled(cards: Card[], random: () => number): Card[] {
  const copy = [...cards];
  for (let index = copy.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

const COMMUNITY_SIZE_BY_STREET: Partial<Record<Street, number>> = { preflop: 0, flop: 3, turn: 4, river: 5 };

/** Builds a context whose legal actions follow the engine's rules, with randomly chosen stacks and bets. */
function createRandomContext(random: () => number): BotContext {
  const street = pickOne<Street>(['preflop', 'flop', 'turn', 'river'], random);
  const deck = shuffled(createOrderedDeck(), random);
  const communitySize = COMMUNITY_SIZE_BY_STREET[street] ?? 0;
  const bigBlind = pickOne([2, 10, 20, 50, 100, 200], random);

  const chips = 1 + Math.floor(random() ** 2 * bigBlind * 300);
  const currentBet = random() < 0.35 ? 0 : 1 + Math.floor(random() ** 2 * bigBlind * 30);
  const streetBet = random() < 0.5 ? 0 : Math.floor(random() * (currentBet + 1));
  const amountToCall = currentBet - streetBet;
  const maxRaiseTo = streetBet + chips;
  const lastRaiseIncrement = bigBlind * (1 + Math.floor(random() * 3));
  const raiseIsOpen = maxRaiseTo > currentBet && random() < 0.85;

  const legal: LegalActions = {
    canFold: true,
    canCheck: amountToCall === 0,
    canCall: amountToCall > 0,
    callAmount: amountToCall > 0 ? Math.min(amountToCall, chips) : 0,
    canRaise: raiseIsOpen,
    minRaiseTo: Math.min(currentBet === 0 ? bigBlind : currentBet + lastRaiseIncrement, maxRaiseTo),
    maxRaiseTo,
    isOpeningBet: currentBet === 0,
  };

  return {
    holeCards: deck.slice(0, 2),
    community: deck.slice(2, 2 + communitySize),
    street,
    chips,
    streetBet,
    currentBet,
    pot: currentBet + streetBet + Math.floor(random() * bigBlind * 40),
    legal,
    bigBlind,
    opponents: 1 + Math.floor(random() * 7),
    personality: pickOne(BOT_PERSONALITIES, random),
  };
}

function describeIllegality(request: PlayerActionRequest, legal: LegalActions): string | null {
  switch (request.type) {
    case 'check':
      return legal.canCheck ? null : 'check while a bet is pending';
    case 'call':
      return legal.canCall ? null : 'call without a bet to call';
    case 'fold':
      if (!legal.canFold) return 'fold when folding is not allowed';
      return legal.canCheck ? 'fold when checking is free' : null;
    case 'allIn':
      return legal.canRaise ? null : 'all-in when raising is not allowed';
    case 'raise': {
      if (!legal.canRaise) return 'raise when raising is not allowed';
      const amount = request.amount;
      if (amount === undefined || !Number.isInteger(amount)) return `raise amount is not an integer: ${amount}`;
      if (amount < legal.minRaiseTo || amount > legal.maxRaiseTo) {
        return `raise to ${amount} outside [${legal.minRaiseTo}, ${legal.maxRaiseTo}]`;
      }
      return null;
    }
  }
}

function createContext(overrides: Partial<BotContext> & { personality: BotPersonality }): BotContext {
  const legal: LegalActions = {
    canFold: true,
    canCheck: false,
    canCall: true,
    callAmount: 20,
    canRaise: true,
    minRaiseTo: 40,
    maxRaiseTo: 2000,
    isOpeningBet: false,
    ...overrides.legal,
  };
  return {
    holeCards: ['As', 'Ah'],
    community: [],
    street: 'preflop',
    chips: 2000,
    streetBet: 0,
    currentBet: 20,
    pot: 30,
    bigBlind: 20,
    opponents: 1,
    ...overrides,
    legal,
  };
}

const personalityNamed = (name: string): BotPersonality => BOT_PERSONALITIES.find((bot) => bot.name === name)!;

describe('BOT_PERSONALITIES', () => {
  it('offers eight distinct Portuguese personalities with parameters in 0..1', () => {
    expect(BOT_PERSONALITIES).toHaveLength(8);
    expect(new Set(BOT_PERSONALITIES.map((bot) => bot.name)).size).toBe(8);
    expect(BOT_PERSONALITIES.map((bot) => bot.name)).toEqual(
      expect.arrayContaining(['Bia', 'Caio', 'Duda', 'Leo', 'Nina', 'Otto', 'Tati', 'Vini']),
    );
    const fingerprints = BOT_PERSONALITIES.map((bot) => [bot.aggression, bot.looseness, bot.bluff].join('/'));
    expect(new Set(fingerprints).size).toBe(8);
    for (const bot of BOT_PERSONALITIES) {
      expect(bot.style.length).toBeGreaterThan(0);
      for (const value of [bot.aggression, bot.looseness, bot.bluff]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('chenScore', () => {
  it('rates starting hands on the Chen scale', () => {
    expect(chenScore(['As', 'Ah'])).toBe(20);
    expect(chenScore(['As', 'Ks'])).toBe(12);
    expect(chenScore(['Ad', 'Kc'])).toBe(10);
    expect(chenScore(['2c', '2d'])).toBe(5);
    expect(chenScore(['Th', '9h'])).toBe(8);
    expect(chenScore(['7c', '2d'])).toBe(-1);
  });
});

describe('estimateEquity', () => {
  it('gives pocket aces about 85% against one random hand preflop', () => {
    const equity = estimateEquity(['As', 'Ah'], [], 1, 6000, createSeededRandom(11));
    expect(equity).toBeGreaterThan(0.8);
    expect(equity).toBeLessThan(0.9);
  });

  it('gives seven-deuce offsuit about 35% against one random hand preflop', () => {
    const equity = estimateEquity(['7c', '2d'], [], 1, 6000, createSeededRandom(12));
    expect(equity).toBeGreaterThan(0.3);
    expect(equity).toBeLessThan(0.4);
  });

  it('is almost certain to win with the nut flush on the river', () => {
    const equity = estimateEquity(['As', 'Ks'], ['Qs', '7s', '2s', '9d', '3c'], 1, 1000, createSeededRandom(13));
    expect(equity).toBeGreaterThan(0.9);
  });

  it('shrinks as more opponents join the pot', () => {
    const headsUp = estimateEquity(['As', 'Ah'], [], 1, 3000, createSeededRandom(14));
    const sixHanded = estimateEquity(['As', 'Ah'], [], 5, 3000, createSeededRandom(15));
    expect(sixHanded).toBeLessThan(headsUp - 0.2);
  });

  it('splits the pot evenly when the board plays for everybody', () => {
    const equity = estimateEquity(['2c', '3d'], ['As', 'Ks', 'Qs', 'Js', 'Ts'], 1, 200, createSeededRandom(16));
    expect(equity).toBe(0.5);
  });

  it('counts a hand against no opponents as a certain win', () => {
    expect(estimateEquity(['7c', '2d'], [], 0, 10, createSeededRandom(17))).toBe(1);
  });

  it('fits a 400-iteration estimate inside the 40 ms budget', () => {
    const random = createSeededRandom(18);
    const scenarios: { hole: Card[]; board: Card[]; opponents: number }[] = [
      { hole: ['Kd', 'Qd'], board: [], opponents: 1 },
      { hole: ['9h', '9c'], board: ['9d', '4s', 'Jc'], opponents: 3 },
      { hole: ['Ac', 'Jh'], board: ['Ts', 'Kd', '2c', '7h'], opponents: 7 },
    ];
    for (const { hole, board, opponents } of scenarios) {
      estimateEquity(hole, board, opponents, 400, random);
      const runDurationsMs = Array.from({ length: 15 }, () => {
        const startedAt = performance.now();
        estimateEquity(hole, board, opponents, 400, random);
        return performance.now() - startedAt;
      });
      // The fastest run ignores CPU spikes from test files running in parallel,
      // yet a genuinely slow implementation would exceed the budget on every run.
      expect(Math.min(...runDurationsMs)).toBeLessThan(40);
    }
  });
});

describe('decideBotAction legality', () => {
  it('always returns a legal action across 3000 random contexts', () => {
    const random = createSeededRandom(2024);
    const violations: string[] = [];
    for (let attempt = 0; attempt < 3000; attempt++) {
      const context = createRandomContext(random);
      const request = decideBotAction(context, random);
      const problem = describeIllegality(request, context.legal);
      if (problem) violations.push(`${problem} (${JSON.stringify(request)}) in ${JSON.stringify(context)}`);
    }
    expect(violations).toEqual([]);
  }, 120_000);

  it('stays legal when the random source is stuck at its extremes', () => {
    const contextRandom = createSeededRandom(77);
    const violations: string[] = [];
    for (const stuckValue of [0, 0.5, 0.999999, 1]) {
      for (let attempt = 0; attempt < 150; attempt++) {
        const context = createRandomContext(contextRandom);
        const request = decideBotAction(context, () => stuckValue);
        const problem = describeIllegality(request, context.legal);
        if (problem) violations.push(`${problem} with random()=${stuckValue}`);
      }
    }
    expect(violations).toEqual([]);
  }, 60_000);

  it('never folds when it can check, for every personality', () => {
    const random = createSeededRandom(31);
    for (const personality of BOT_PERSONALITIES) {
      for (const street of ['preflop', 'flop', 'river'] as const) {
        const context = createContext({
          personality,
          street,
          holeCards: ['7c', '2d'],
          community: street === 'preflop' ? [] : street === 'flop' ? ['Ah', 'Kd', 'Qs'] : ['Ah', 'Kd', 'Qs', '9c', '4h'],
          legal: { canCheck: true, canCall: false, callAmount: 0, canRaise: true, minRaiseTo: 20, maxRaiseTo: 2000 } as LegalActions,
          currentBet: 0,
        });
        for (let attempt = 0; attempt < 20; attempt++) {
          expect(decideBotAction(context, random).type).not.toBe('fold');
        }
      }
    }
  });

  it('only calls when a call is possible and never raises when raising is closed', () => {
    const random = createSeededRandom(32);
    const closedRaise: Partial<LegalActions> = { canRaise: false, canCheck: false, canCall: true, callAmount: 150 };
    for (const personality of BOT_PERSONALITIES) {
      const context = createContext({ personality, legal: closedRaise as LegalActions, currentBet: 150 });
      for (let attempt = 0; attempt < 20; attempt++) {
        expect(['call', 'fold']).toContain(decideBotAction(context, random).type);
      }
    }
  });

  it('treats raising as closed when the reported minimum raise exceeds the maximum', () => {
    const random = createSeededRandom(33);
    const violations: string[] = [];
    for (let attempt = 0; attempt < 500; attempt++) {
      const consistent = createRandomContext(random);
      const legal: LegalActions = {
        ...consistent.legal,
        canRaise: true,
        minRaiseTo: consistent.legal.maxRaiseTo + 1 + Math.floor(random() * 50),
      };
      const request = decideBotAction({ ...consistent, legal }, random);
      const problem = describeIllegality(request, { ...legal, canRaise: false });
      if (problem) violations.push(`${problem} (${JSON.stringify(request)}) with min ${legal.minRaiseTo} above max ${legal.maxRaiseTo}`);
    }
    expect(violations).toEqual([]);
  });

  it('falls back to a call instead of a clamped shove when the minimum raise exceeds the stack', () => {
    const context = createContext({
      personality: personalityNamed('Bia'),
      chips: 60,
      legal: { callAmount: 20, minRaiseTo: 100, maxRaiseTo: 60 } as LegalActions,
    });
    expect(decideBotAction(context, () => 0.99)).toEqual({ type: 'call' });
  });

  it('is repeatable for the same random sequence', () => {
    const context = createRandomContext(createSeededRandom(5));
    const first = decideBotAction(context, createSeededRandom(99));
    const second = decideBotAction(context, createSeededRandom(99));
    expect(second).toEqual(first);
  });
});

/** Postflop decisions need a real random source: a constant one makes every Monte-Carlo sample identical. */
function decideRepeatedly(context: BotContext, trials: number, seed: number): PlayerActionRequest[] {
  const random = createSeededRandom(seed);
  return Array.from({ length: trials }, () => decideBotAction(context, random));
}

describe('decideBotAction strategy', () => {
  const steadyRandom = () => 0.99;

  it('never throws away pocket aces preflop', () => {
    for (const personality of BOT_PERSONALITIES) {
      const context = createContext({ personality, currentBet: 60, pot: 90, legal: { callAmount: 60 } as LegalActions });
      expect(decideBotAction(context, steadyRandom).type).not.toBe('fold');
    }
  });

  it('folds seven-deuce offsuit for a conservative bot facing a big preflop raise', () => {
    const context = createContext({
      personality: personalityNamed('Leo'),
      holeCards: ['7c', '2d'],
      currentBet: 200,
      pot: 230,
      legal: { callAmount: 200 } as LegalActions,
    });
    expect(decideBotAction(context, () => 0.5).type).toBe('fold');
  });

  it('shoves all-in when a raise would commit more than 70% of a short stack', () => {
    const context = createContext({
      personality: personalityNamed('Bia'),
      chips: 60,
      legal: { callAmount: 20, minRaiseTo: 40, maxRaiseTo: 60 } as LegalActions,
    });
    expect(decideBotAction(context, steadyRandom)).toEqual({ type: 'allIn' });
  });

  it('bets quads for value with an integer amount inside the sensible range', () => {
    const context = createContext({
      personality: personalityNamed('Otto'),
      holeCards: ['Ad', 'Ah'],
      community: ['As', 'Ac', '7d'],
      street: 'flop',
      currentBet: 0,
      pot: 200,
      chips: 5000,
      legal: { canCheck: true, canCall: false, callAmount: 0, minRaiseTo: 20, maxRaiseTo: 5000, isOpeningBet: true } as LegalActions,
    });
    const requests = decideRepeatedly(context, 40, 501);
    const bets = requests.filter((request) => request.type === 'raise');
    expect(bets.length).toBeGreaterThan(30);
    for (const bet of bets) {
      expect(Number.isInteger(bet.amount)).toBe(true);
      expect(bet.amount).toBeGreaterThanOrEqual(100);
      expect(bet.amount).toBeLessThanOrEqual(200);
    }
  });

  it('folds air on the river to a pot-sized bet', () => {
    const context = createContext({
      personality: personalityNamed('Tati'),
      holeCards: ['7c', '2d'],
      community: ['As', 'Kh', 'Qd', '9c', '4h'],
      street: 'river',
      currentBet: 300,
      pot: 600,
      chips: 3000,
      legal: { callAmount: 300, minRaiseTo: 600, maxRaiseTo: 3000 } as LegalActions,
    });
    const folds = decideRepeatedly(context, 40, 502).filter((request) => request.type === 'fold');
    expect(folds.length).toBeGreaterThan(36);
  });

  it('calls with the nut flush when facing a bet it cannot raise', () => {
    const context = createContext({
      personality: personalityNamed('Caio'),
      holeCards: ['As', 'Ks'],
      community: ['Qs', '7s', '2s', '9d', '3c'],
      street: 'river',
      currentBet: 400,
      pot: 800,
      chips: 1000,
      legal: { callAmount: 400, canRaise: false } as LegalActions,
    });
    expect(decideRepeatedly(context, 20, 503)).toEqual(Array(20).fill({ type: 'call' }));
  });

  it('plays visibly different ranges for the loosest and the tightest bot', () => {
    const random = createSeededRandom(404);
    const deck = createOrderedDeck();
    let looseContinues = 0;
    let tightContinues = 0;
    const trials = 400;
    for (let trial = 0; trial < trials; trial++) {
      const [first, second] = shuffled(deck, random);
      const base = { holeCards: [first, second], currentBet: 60, pot: 90, legal: { callAmount: 60 } as LegalActions };
      const loose = decideBotAction(createContext({ ...base, personality: personalityNamed('Vini') }), random);
      const tight = decideBotAction(createContext({ ...base, personality: personalityNamed('Leo') }), random);
      if (loose.type !== 'fold') looseContinues++;
      if (tight.type !== 'fold') tightContinues++;
    }
    expect(looseContinues).toBeGreaterThan(tightContinues + trials * 0.15);
  });
});

describe('botThinkTimeMs', () => {
  it('stays between 700 and 2600 ms for random contexts and extreme random values', () => {
    const random = createSeededRandom(8);
    for (let attempt = 0; attempt < 2000; attempt++) {
      const context = createRandomContext(random);
      for (const randomValue of [random(), 0, 0.999999]) {
        const thinkTime = botThinkTimeMs(context, () => randomValue);
        expect(thinkTime).toBeGreaterThanOrEqual(700);
        expect(thinkTime).toBeLessThanOrEqual(2600);
      }
    }
  });

  it('thinks longer when a large share of the stack is at risk', () => {
    const personality = personalityNamed('Caio');
    const cheap = createContext({ personality, chips: 5000, legal: { callAmount: 20 } as LegalActions });
    const costly = createContext({ personality, chips: 500, legal: { callAmount: 500 } as LegalActions });
    expect(botThinkTimeMs(costly, () => 0.5)).toBeGreaterThan(botThinkTimeMs(cheap, () => 0.5));
  });
});
