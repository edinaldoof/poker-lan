import { describe, expect, it } from 'vitest';
import { type Card, createOrderedDeck } from '../src/shared/cards';
import { evaluateHand } from '../src/shared/handEvaluator';
import { boardStrengthTable } from '../src/server/game/bots/boardStrength';
import { COMBO_COUNT, cardToCode } from '../src/server/game/bots/cardCodes';
import { scoreCodes } from '../src/server/game/bots/fastEvaluator';
import { readRange } from '../src/server/game/bots/handReading';
import { SHOWN_BLUFF_PERCENTILE } from '../src/server/game/bots/handStats';
import { estimateTendencies } from '../src/server/game/bots/opponentModel';
import { assignPositions } from '../src/server/game/bots/positions';
import { COMBO_PREFLOP_PERCENTILE } from '../src/server/game/bots/preflopChart';
import { type PlayerStatCounts, type PublicAction, createEmptyStatCounts } from '../src/server/game/bots/publicInfo';
import { createSeededRandom, observedPlayer, startScenario } from './botTestKit';

describe('fast evaluator', () => {
  it('orders random hands exactly like the reference hand evaluator', () => {
    const random = createSeededRandom(5);
    const deck = createOrderedDeck();
    const drawHand = (size: number): Card[] => {
      const copy = [...deck];
      for (let index = 0; index < size; index++) {
        const swap = index + Math.floor(random() * (copy.length - index));
        [copy[index], copy[swap]] = [copy[swap], copy[index]];
      }
      return copy.slice(0, size);
    };
    for (let trial = 0; trial < 20000; trial++) {
      const size = 5 + (trial % 3);
      const first = drawHand(size);
      const second = drawHand(size);
      const reference = Math.sign(evaluateHand(first).score - evaluateHand(second).score);
      const fast = Math.sign(scoreCodes(first.map(cardToCode)) - scoreCodes(second.map(cardToCode)));
      expect(fast).toBe(reference);
    }
  });
});

describe('positions', () => {
  it('names six-max positions from the button', () => {
    const positions = assignPositions([1, 2, 3, 4, 5, 0], 0, 2);
    expect([0, 1, 2, 3, 4, 5].map((seat) => positions.get(seat)!.name)).toEqual([
      'button',
      'smallBlind',
      'bigBlind',
      'early',
      'hijack',
      'cutoff',
    ]);
    expect(positions.get(0)!.postflopOrder).toBe(5);
    expect(positions.get(1)!.postflopOrder).toBe(0);
  });

  it('lets the heads-up button act last after the flop', () => {
    const positions = assignPositions([1, 0], 0, 1);
    expect(positions.get(0)).toEqual({ name: 'button', postflopOrder: 1 });
    expect(positions.get(1)).toEqual({ name: 'bigBlind', postflopOrder: 0 });
  });
});

describe('table memory', () => {
  it('turns public actions into per-player statistics at the end of the hand', () => {
    const scenario = startScenario([0, 1, 2], [['Ac', 'Kc'], ['7d', '6d'], ['9s', '2h']], ['Qh', '8s', '3c', '4d', '5s']);
    scenario.act({ type: 'raise', amount: 60 });
    scenario.act({ type: 'call' });
    scenario.act({ type: 'fold' });
    scenario.nextStreet();
    scenario.act({ type: 'check' });
    scenario.act({ type: 'raise', amount: 70 });
    scenario.act({ type: 'fold' });
    scenario.engine.collectBets();
    scenario.memory.finishHand(scenario.engine.community, false);

    const raiser = scenario.memory.statsOf('player-0')!;
    const caller = scenario.memory.statsOf('player-1')!;
    const folder = scenario.memory.statsOf('player-2')!;
    expect(raiser).toMatchObject({ hands: 1, vpip: 1, pfr: 1, cbetChances: 1, cbets: 1 });
    expect(caller).toMatchObject({ hands: 1, vpip: 1, pfr: 0, flatCalls: 1, foldToCbetChances: 1, foldsToCbet: 1 });
    expect(caller.facedBets).toEqual([1, 0, 0]);
    expect(caller.foldsToBets).toEqual([1, 0, 0]);
    expect(folder).toMatchObject({ hands: 1, vpip: 0, pfr: 0, threeBetChances: 1, threeBets: 0 });
  });

  it('tells folds after calling the last street apart from folds to a bet into the last aggressor', () => {
    const barrelled = startScenario([0, 1], [['Ac', 'Kc'], ['7d', '6d']], ['Qh', '8s', '3c', '4d', '5s']);
    barrelled.act({ type: 'raise', amount: 60 });
    barrelled.act({ type: 'call' });
    barrelled.nextStreet();
    barrelled.act({ type: 'check' });
    barrelled.act({ type: 'raise', amount: 60 });
    barrelled.act({ type: 'call' });
    barrelled.nextStreet();
    barrelled.act({ type: 'check' });
    barrelled.act({ type: 'raise', amount: 120 });
    barrelled.act({ type: 'fold' });
    barrelled.engine.collectBets();
    barrelled.memory.finishHand(barrelled.engine.community, false);
    const caller = barrelled.memory.statsOf('player-1')!;
    expect(caller.facedBetsAfterCall).toEqual([1, 0]);
    expect(caller.foldsToBetsAfterCall).toEqual([1, 0]);
    expect(caller.facedBetsWithInitiative).toBe(0);

    const donked = startScenario([0, 1], [['Ac', 'Kc'], ['7d', '6d']], ['Qh', '8s', '3c', '4d', '5s']);
    donked.act({ type: 'raise', amount: 60 });
    donked.act({ type: 'call' });
    donked.nextStreet();
    donked.act({ type: 'raise', amount: 60 });
    donked.act({ type: 'fold' });
    donked.engine.collectBets();
    donked.memory.finishHand(donked.engine.community, false);
    const raiser = donked.memory.statsOf('player-0')!;
    expect(raiser).toMatchObject({ facedBetsWithInitiative: 1, foldsToBetsWithInitiative: 1 });
    expect(raiser.facedBetsAfterCall).toEqual([0, 0]);
  });

  it('forgets a player who leaves and everything after a reset', () => {
    const scenario = startScenario([0, 1], [['Ac', 'Kc'], ['7d', '6d']], []);
    scenario.act({ type: 'fold' });
    scenario.engine.collectBets();
    scenario.memory.finishHand([], false);
    expect(scenario.memory.statsOf('player-0')?.hands).toBe(1);
    scenario.memory.forgetPlayer('player-0');
    expect(scenario.memory.statsOf('player-0')).toBeUndefined();
    scenario.memory.reset();
    expect(scenario.memory.statsOf('player-1')).toBeUndefined();
  });
});

describe('opponent model', () => {
  it('trusts the population read until a player has shown enough hands', () => {
    const unknown = estimateTendencies(undefined, 1);
    const fewHands = estimateTendencies({ ...createEmptyStatCounts(), facedBets: [3, 0, 0], foldsToBets: [3, 0, 0] }, 1);
    const station = estimateTendencies(observedPlayer({ foldToBetRate: 0.05 }), 1);
    expect(unknown.foldToBet.flop).toBeCloseTo(0.42, 5);
    expect(fewHands.foldToBet.flop).toBeLessThan(0.6);
    expect(station.foldToBet.flop).toBeLessThan(0.1);
  });

  it('adapts faster for observant personalities', () => {
    const counts = { ...createEmptyStatCounts(), facedBets: [12, 0, 0] as [number, number, number], foldsToBets: [12, 0, 0] as [number, number, number] };
    const fast = estimateTendencies(counts, 0.5).foldToBet.flop;
    const slow = estimateTendencies(counts, 1.5).foldToBet.flop;
    expect(fast).toBeGreaterThan(slow + 0.1);
  });
});

describe('hand reading', () => {
  const action = (seat: number, kind: PublicAction['kind'], raisesBefore: number, totalBet: number): PublicAction => ({
    seat,
    street: 'preflop',
    kind,
    allIn: false,
    chipsAdded: totalBet,
    totalBet,
    potBefore: 30,
    toCall: 20,
    betLevelBefore: 20,
    raisesBefore,
  });
  const reader = {
    board: [],
    positionOf: () => 'cutoff' as const,
    tendenciesOf: () => estimateTendencies(undefined, 1),
    sharpness: 1,
  };
  /** Share of the range's weight on hands whose preflop percentile lies in [from, to). */
  const shareBetween = (weights: Float64Array, from: number, to: number) => {
    let total = 0;
    let inside = 0;
    for (let combo = 0; combo < COMBO_COUNT; combo++) {
      total += weights[combo];
      const percentile = COMBO_PREFLOP_PERCENTILE[combo];
      if (percentile >= from && percentile < to) inside += weights[combo];
    }
    return inside / total;
  };

  it('reads a 3-bettor as holding more premium hands than a flat caller, and a caller as holding little trash', () => {
    const actions = [action(1, 'raise', 0, 60), action(2, 'raise', 1, 180), action(3, 'call', 1, 60)];
    const threeBettor = readRange(2, actions, reader);
    const caller = readRange(3, actions, reader);
    const unknown = readRange(4, actions, reader);
    expect(shareBetween(threeBettor, 0, 0.05)).toBeGreaterThan(2 * shareBetween(caller, 0, 0.05));
    expect(shareBetween(caller, 0.6, 1)).toBeLessThan(shareBetween(unknown, 0.6, 1) / 3);
  });

  describe('a bet on every street', () => {
    const board = (['Kh', '9d', '4c', '2s', '7h'] as Card[]).map(cardToCode);
    const step = (
      seat: number,
      street: PublicAction['street'],
      kind: PublicAction['kind'],
      potBefore: number,
      toCall: number,
      totalBet: number,
    ): PublicAction => ({
      seat,
      street,
      kind,
      allIn: false,
      chipsAdded: totalBet,
      totalBet,
      potBefore,
      toCall,
      betLevelBefore: toCall,
      raisesBefore: kind === 'call' ? 1 : 0,
    });
    const tripleBarrel = [
      step(1, 'preflop', 'raise', 30, 20, 60),
      step(2, 'preflop', 'call', 90, 40, 60),
      step(2, 'flop', 'check', 130, 0, 0),
      step(1, 'flop', 'bet', 130, 0, 80),
      step(2, 'flop', 'call', 210, 80, 80),
      step(2, 'turn', 'check', 290, 0, 0),
      step(1, 'turn', 'bet', 290, 0, 200),
      step(2, 'turn', 'call', 490, 200, 200),
      step(2, 'river', 'check', 690, 0, 0),
      step(1, 'river', 'bet', 690, 0, 500),
    ];
    /** Share of the bettor's river range that would count as a bluff at showdown. */
    const bluffShareOf = (stats: PlayerStatCounts | undefined) => {
      const weights = readRange(1, tripleBarrel, {
        board,
        positionOf: () => 'cutoff',
        tendenciesOf: () => estimateTendencies(stats, 1),
        sharpness: 1,
      });
      const table = boardStrengthTable(board);
      let weak = 0;
      let total = 0;
      for (let combo = 0; combo < COMBO_COUNT; combo++) {
        if (table.strength[combo] < 0) continue;
        total += weights[combo];
        if (table.madePercentile[combo] < SHOWN_BLUFF_PERCENTILE) weak += weights[combo];
      }
      return weak / total;
    };

    it('still holds a realistic share of bluffs from a player the table does not know yet', () => {
      expect(bluffShareOf(undefined)).toBeGreaterThan(0.12);
      expect(bluffShareOf(undefined)).toBeLessThan(0.4);
    });

    it('holds far fewer bluffs from an aggressive player whose bets were always shown down with value', () => {
      const honestAggressor = {
        ...createEmptyStatCounts(),
        postflopAggressive: 120,
        postflopCalls: 40,
        postflopChecks: 60,
        postflopFolds: 30,
        shownRiverBets: 25,
        shownEarlyBets: 25,
      };
      expect(bluffShareOf(honestAggressor)).toBeLessThan(bluffShareOf(undefined) * 0.6);
    });
  });
});
