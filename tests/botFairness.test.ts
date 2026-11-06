import { describe, expect, it } from 'vitest';
import type { Card } from '../src/shared/cards';
import { decideBotAction } from '../src/server/game/BotBrain';
import { createSeededRandom, personalityNamed, startScenario } from './botTestKit';

const BOARD: Card[] = ['Kh', '9d', '4c', '2s', '7h'];

/** UTG opens, everybody folds to the big blind, who calls; on the flop the big blind checks to the opener. */
function flopAfterOpen(holeCards: [Card, Card][]) {
  const scenario = startScenario([0, 1, 2, 3, 4, 5], holeCards, BOARD);
  scenario.act({ type: 'raise', amount: 60 });
  for (let fold = 0; fold < 4; fold++) scenario.act({ type: 'fold' });
  scenario.act({ type: 'call' });
  scenario.nextStreet();
  scenario.act({ type: 'check' });
  return scenario;
}

const HERO_CARDS: [Card, Card] = ['As', 'Qs'];
const TABLE_A: [Card, Card][] = [
  ['3c', '3d'],
  ['8c', '8d'],
  ['Jc', 'Td'],
  HERO_CARDS,
  ['5c', '6d'],
  ['Qc', 'Qd'],
];
// Same public story, different hidden cards for every opponent.
const TABLE_B: [Card, Card][] = [
  ['2c', '2d'],
  ['Th', 'Ts'],
  ['Ah', 'Ad'],
  HERO_CARDS,
  ['6h', '5s'],
  ['Kc', 'Ks'],
];

describe('bot fairness', () => {
  it('briefs a bot with its own hole cards and public facts only', () => {
    const scenario = flopAfterOpen(TABLE_A);
    const context = scenario.contextFor(personalityNamed('Otto'));
    const briefing = JSON.stringify(context);

    expect(context.holeCards).toEqual(HERO_CARDS);
    expect(context.community).toEqual(BOARD.slice(0, 3));
    for (const [index, cards] of TABLE_A.entries()) {
      if (index === 3) continue;
      for (const card of cards) expect(briefing).not.toContain(`"${card}"`);
    }
    for (const card of BOARD.slice(3)) expect(briefing).not.toContain(`"${card}"`);
  });

  it('decides exactly the same way whatever the opponents secretly hold', () => {
    for (const name of ['Otto', 'Nina', 'Vini']) {
      const personality = personalityNamed(name);
      for (let seed = 1; seed <= 25; seed++) {
        const first = decideBotAction(flopAfterOpen(TABLE_A).contextFor(personality), createSeededRandom(seed));
        const second = decideBotAction(flopAfterOpen(TABLE_B).contextFor(personality), createSeededRandom(seed));
        expect(second).toEqual(first);
      }
    }
  });

  it('remembers shown cards only as statistics, never as cards', () => {
    const scenario = startScenario([0, 1], [['6c', '5c'], ['Kd', 'Qd']], BOARD);
    scenario.act({ type: 'raise', amount: 60 });
    scenario.act({ type: 'call' });
    for (const street of ['flop', 'turn', 'river'] as const) {
      scenario.nextStreet();
      scenario.act({ type: 'check' });
      if (street === 'river') {
        scenario.act({ type: 'raise', amount: 100 });
        scenario.act({ type: 'call' });
      } else {
        scenario.act({ type: 'check' });
      }
    }
    scenario.memory.recordShowdown([
      { seat: 0, cards: ['6c', '5c'] },
      { seat: 1, cards: ['Kd', 'Qd'] },
    ]);
    scenario.engine.collectBets();
    scenario.memory.finishHand(scenario.engine.community, true);

    const stats = scenario.memory.statsOf('player-0')!;
    expect(stats.shownRiverBets).toBe(1);
    expect(stats.shownRiverBluffs).toBe(1);
    expect(JSON.stringify(stats)).not.toMatch(/"[2-9TJQKA][cdhs]"/);
  });
});
