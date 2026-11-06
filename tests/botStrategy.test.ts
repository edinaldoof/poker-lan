import { describe, expect, it } from 'vitest';
import { type Card, createOrderedDeck } from '../src/shared/cards';
import type { PlayerActionRequest } from '../src/shared/protocol';
import { type BotContext, decideBotAction } from '../src/server/game/BotBrain';
import { boardStrengthTable } from '../src/server/game/bots/boardStrength';
import {
  CLASS_NAMES,
  COMBO_CLASS,
  COMBO_COUNT,
  COMBO_FIRST,
  COMBO_SECOND,
  cardToCode,
  codeToCard,
  comboIndexOf,
} from '../src/server/game/bots/cardCodes';
import { SHOWN_BLUFF_PERCENTILE } from '../src/server/game/bots/handStats';
import {
  type TableScenario,
  countMatching,
  createSeededRandom,
  observedPlayer,
  personalityNamed,
  startScenario,
  withStats,
} from './botTestKit';

const isAggressive = (request: PlayerActionRequest) => request.type === 'raise' || request.type === 'allIn';

/** One combo of every starting-hand class, so loops cover the whole range of hands evenly by class. */
const ONE_COMBO_PER_CLASS: [Card, Card][] = (() => {
  const chosen = new Map<number, [Card, Card]>();
  for (let combo = 0; combo < COMBO_COUNT; combo++) {
    if (!chosen.has(COMBO_CLASS[combo])) chosen.set(COMBO_CLASS[combo], [codeToCard(COMBO_FIRST[combo]), codeToCard(COMBO_SECOND[combo])]);
  }
  expect(chosen.size).toBe(CLASS_NAMES.length);
  return [...chosen.values()];
})();

function holeCardsAround(hero: [Card, Card], heroIndex: number, players: number): [Card, Card][] {
  const others = createOrderedDeck().filter((card) => !hero.includes(card));
  return Array.from({ length: players }, (_, index) =>
    index === heroIndex ? hero : ([others[index * 2], others[index * 2 + 1]] as [Card, Card]),
  );
}

describe('preflop position', () => {
  it('opens more hands on the button than under the gun', () => {
    const otto = personalityNamed('Otto');
    let earlyOpens = 0;
    let buttonOpens = 0;
    for (const hero of ONE_COMBO_PER_CLASS) {
      const early = startScenario([0, 1, 2, 3, 4, 5], holeCardsAround(hero, 3, 6), []);
      if (isAggressive(decideBotAction(early.contextFor(otto), createSeededRandom(1)))) earlyOpens++;

      const button = startScenario([0, 1, 2, 3, 4, 5], holeCardsAround(hero, 0, 6), []);
      for (let fold = 0; fold < 3; fold++) button.act({ type: 'fold' });
      if (isAggressive(decideBotAction(button.contextFor(otto), createSeededRandom(1)))) buttonOpens++;
    }
    expect(earlyOpens).toBeGreaterThan(10);
    expect(buttonOpens).toBeGreaterThan(earlyOpens * 2);
  });

  it('defends the big blind wider against a button steal than against an early-position raise', () => {
    const caio = personalityNamed('Caio');
    let defendsSteal = 0;
    let defendsEarlyRaise = 0;
    for (const [index, hero] of ONE_COMBO_PER_CLASS.entries()) {
      const steal = startScenario([0, 1, 2, 3, 4, 5], holeCardsAround(hero, 2, 6), []);
      for (let fold = 0; fold < 3; fold++) steal.act({ type: 'fold' });
      steal.act({ type: 'raise', amount: 50 });
      steal.act({ type: 'fold' });
      if (decideBotAction(steal.contextFor(caio), createSeededRandom(index)).type !== 'fold') defendsSteal++;

      const early = startScenario([0, 1, 2, 3, 4, 5], holeCardsAround(hero, 2, 6), []);
      early.act({ type: 'raise', amount: 60 });
      for (let fold = 0; fold < 4; fold++) early.act({ type: 'fold' });
      if (decideBotAction(early.contextFor(caio), createSeededRandom(index)).type !== 'fold') defendsEarlyRaise++;
    }
    expect(defendsSteal).toBeGreaterThan(defendsEarlyRaise * 1.3);
  });
});

const RIVER_BOARD: Card[] = ['Kh', '9d', '4c', '2s', '7h'];

/**
 * Heads-up: the hero raised preflop on the button and bet the flop, the turn went check-check and the big blind
 * checks the river to the hero.
 */
function riverCheckedToHero(hero: [Card, Card]): TableScenario {
  const scenario = startScenario([0, 1], [hero, ['Qs', 'Js']], RIVER_BOARD);
  scenario.act({ type: 'raise', amount: 60 });
  scenario.act({ type: 'call' });
  scenario.nextStreet();
  scenario.act({ type: 'check' });
  scenario.act({ type: 'raise', amount: 60 });
  scenario.act({ type: 'call' });
  scenario.nextStreet();
  scenario.act({ type: 'check' });
  scenario.act({ type: 'check' });
  scenario.nextStreet();
  scenario.act({ type: 'check' });
  return scenario;
}

/** Three-handed, the hero raised on the button: either only the big blind calls, or both blinds call; the flop is checked to the hero. */
function flopCheckedToRaiser(hero: [Card, Card], callers: 1 | 2): TableScenario {
  const scenario = startScenario([0, 1, 2], [hero, ['Qs', 'Js'], ['8s', '8d']], RIVER_BOARD);
  scenario.act({ type: 'raise', amount: 60 });
  scenario.act({ type: callers === 2 ? 'call' : 'fold' });
  scenario.act({ type: 'call' });
  scenario.nextStreet();
  for (let check = 0; check < callers; check++) scenario.act({ type: 'check' });
  return scenario;
}

const AIR: [Card, Card] = ['6c', '5c'];
const NUTS: [Card, Card] = ['Kd', 'Kc'];

function bets(context: BotContext, trials: number, seed: number): number {
  return countMatching(trials, seed, (random) => isAggressive(decideBotAction(context, random)));
}

describe('bluffing', () => {
  it('bluffs a busted hand more against a player who folds a lot than against a calling station', () => {
    const base = riverCheckedToHero(AIR).contextFor(personalityNamed('Nina'));
    const againstFolder = withStats(base, { 'player-1': observedPlayer({ foldToBetRate: 0.7 }) });
    const againstStation = withStats(base, { 'player-1': observedPlayer({ foldToBetRate: 0.05 }) });
    const folderBluffs = bets(againstFolder, 120, 11);
    const stationBluffs = bets(againstStation, 120, 11);
    expect(folderBluffs).toBeGreaterThan(60);
    expect(stationBluffs).toBeLessThan(15);
  });

  it('continuation-bets air less into two opponents than into one', () => {
    const nina = personalityNamed('Nina');
    const air: [Card, Card] = ['Jc', '3d'];
    const headsUp = bets(flopCheckedToRaiser(air, 1).contextFor(nina), 120, 12);
    const multiway = bets(flopCheckedToRaiser(air, 2).contextFor(nina), 120, 12);
    expect(multiway).toBeLessThan(headsUp * 0.6);
  });

  it('leaves most bluffs to the bluffer: the conservative bot bluffs far less in the same spot', () => {
    const folder = { 'player-1': observedPlayer({ foldToBetRate: 0.6 }) };
    const leo = bets(withStats(riverCheckedToHero(AIR).contextFor(personalityNamed('Leo')), folder), 120, 13);
    const nina = bets(withStats(riverCheckedToHero(AIR).contextFor(personalityNamed('Nina')), folder), 120, 13);
    expect(nina).toBeGreaterThan(leo * 2);
  });

  it('bets the same amount with the nuts and with a bluff in the same spot', () => {
    const folder = { 'player-1': observedPlayer({ foldToBetRate: 0.7 }) };
    const bluffContext = withStats(riverCheckedToHero(AIR).contextFor(personalityNamed('Nina')), folder);
    const valueContext = withStats(riverCheckedToHero(NUTS).contextFor(personalityNamed('Nina')), folder);
    let comparedPairs = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const bluff = decideBotAction(bluffContext, createSeededRandom(seed));
      const value = decideBotAction(valueContext, createSeededRandom(seed));
      if (!isAggressive(bluff) || !isAggressive(value)) continue;
      comparedPairs++;
      expect(bluff).toEqual(value);
    }
    expect(comparedPairs).toBeGreaterThan(20);
  });

  it('continuation-bets air more on an ace-high board, which favours the raiser, than on a low connected one', () => {
    const cutoffOpenBigBlindCalls = (board: Card[]) => {
      const scenario = startScenario([0, 1, 2, 3], [['3d', '3h'], ['8c', '8h'], ['Qh', 'Th'], ['Jc', 'Tc']], board);
      scenario.act({ type: 'raise', amount: 50 });
      scenario.act({ type: 'fold' });
      scenario.act({ type: 'fold' });
      scenario.act({ type: 'call' });
      scenario.nextStreet();
      scenario.act({ type: 'check' });
      return scenario.contextFor(personalityNamed('Otto'));
    };
    const aceHigh = bets(cutoffOpenBigBlindCalls(['Ad', '7h', '2s', '9c', '3s']), 150, 14);
    const lowConnected = bets(cutoffOpenBigBlindCalls(['6d', '5h', '4s', '9c', '3s']), 150, 14);
    expect(aceHigh).toBeGreaterThan(lowConnected + 20);
  });
});

/** Made-hand percentile of the hero's cards on the full board (what showdown statistics call a bluff below 0.45). */
function madePercentile(hero: [Card, Card], board: Card[]): number {
  const table = boardStrengthTable(board.map(cardToCode));
  return table.madePercentile[comboIndexOf(cardToCode(hero[0]), cardToCode(hero[1]))];
}

function shuffledDeck(random: () => number): Card[] {
  const deck = createOrderedDeck();
  for (let index = deck.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [deck[index], deck[swap]] = [deck[swap], deck[index]];
  }
  return deck;
}

/**
 * Heads-up barrel line on random deals: the bot opens the button, the big blind (who folds 42% of the time to bets)
 * calls, then checks and calls every bet on the flop and the turn and checks the river. Returns the river bets the
 * bot made and how many of them were air.
 */
function riverBarrels(name: string, deals: number, seed: number): { bets: number; air: number } {
  const random = createSeededRandom(seed);
  const average = { 'player-1': observedPlayer({ foldToBetRate: 0.42 }) };
  let bets = 0;
  let air = 0;
  for (let deal = 0; deal < deals; deal++) {
    const deck = shuffledDeck(random);
    const hero: [Card, Card] = [deck[0], deck[1]];
    const board = deck.slice(4, 9);
    const scenario = startScenario([0, 1], [hero, [deck[2], deck[3]]], board);
    const decide = () => decideBotAction(withStats(scenario.contextFor(personalityNamed(name)), average), random);
    const open = decide();
    if (!isAggressive(open)) continue;
    scenario.act(open);
    scenario.act({ type: 'call' });
    let barrelled = true;
    for (let street = 0; street < 2 && barrelled; street++) {
      scenario.nextStreet();
      scenario.act({ type: 'check' });
      const bet = decide();
      barrelled = bet.type === 'raise';
      if (barrelled) {
        scenario.act(bet);
        scenario.act({ type: 'call' });
      }
    }
    if (!barrelled) continue;
    scenario.nextStreet();
    scenario.act({ type: 'check' });
    if (!isAggressive(decide())) continue;
    bets++;
    if (madePercentile(hero, board) < SHOWN_BLUFF_PERCENTILE) air++;
  }
  return { bets, air };
}

describe('bluffing frequency and selection', () => {
  it('keeps air to a minority of its heads-up river barrels against an opponent who folds an average amount', () => {
    for (const name of ['Otto', 'Nina']) {
      const { bets, air } = riverBarrels(name, 700, 41);
      expect(bets).toBeGreaterThan(60);
      expect(air).toBeGreaterThan(0);
      // A pure bluff-catcher breaks even against about a third of air at these sizes.
      expect(air / bets).toBeLessThanOrEqual(0.35);
    }
  }, 60_000);

  it('picks its river bluffs from the hands with the least showdown value', () => {
    const board: Card[] = ['Kh', '9d', '4c', '2s', '7h'];
    const villain: [Card, Card] = ['Jh', 'Js'];
    const bets = new Array<number>(10).fill(0);
    const hands = new Array<number>(10).fill(0);
    const average = { 'player-1': observedPlayer({ foldToBetRate: 0.42 }) };
    for (let combo = 0; combo < COMBO_COUNT; combo++) {
      const hero: [Card, Card] = [codeToCard(COMBO_FIRST[combo]), codeToCard(COMBO_SECOND[combo])];
      if ([...board, ...villain].some((card) => hero.includes(card))) continue;
      const scenario = startScenario([0, 1], [hero, villain], board);
      scenario.act({ type: 'raise', amount: 60 });
      scenario.act({ type: 'call' });
      for (const betTo of [60, 150]) {
        scenario.nextStreet();
        scenario.act({ type: 'check' });
        scenario.act({ type: 'raise', amount: betTo });
        scenario.act({ type: 'call' });
      }
      scenario.nextStreet();
      scenario.act({ type: 'check' });
      const decile = Math.min(9, Math.floor(madePercentile(hero, board) * 10));
      hands[decile]++;
      const context = withStats(scenario.contextFor(personalityNamed('Otto')), average);
      if (isAggressive(decideBotAction(context, createSeededRandom(combo)))) bets[decile]++;
    }
    const betRate = (decile: number) => bets[decile] / hands[decile];
    expect(betRate(0)).toBeGreaterThan(betRate(3) + 0.1);
    expect(betRate(0)).toBeLessThan(0.8);
    expect(betRate(9)).toBeGreaterThan(0.9);
  }, 60_000);
});

describe('personalities after the flop', () => {
  const BOARDS: Card[][] = [
    ['Kh', '9d', '4c', '2s', '7h'],
    ['8s', '7s', '3d', 'Qc', '2h'],
  ];
  const VILLAIN: [Card, Card] = ['Jh', 'Td'];

  /** Heads-up continuation bets over every starting-hand class on two flops checked to the button raiser. */
  function continuationBets(name: string): number {
    let spots = 0;
    let bets = 0;
    for (const board of BOARDS) {
      for (const hero of ONE_COMBO_PER_CLASS) {
        if ([...board, ...VILLAIN].some((card) => hero.includes(card))) continue;
        const scenario = startScenario([0, 1], [hero, VILLAIN], board);
        scenario.act({ type: 'raise', amount: 50 });
        scenario.act({ type: 'call' });
        scenario.nextStreet();
        scenario.act({ type: 'check' });
        spots++;
        if (isAggressive(decideBotAction(scenario.contextFor(personalityNamed(name)), createSeededRandom(spots)))) bets++;
      }
    }
    return bets;
  }

  it('bets far more often as the aggressive bot than as the conservative one in the same spots', () => {
    expect(continuationBets('Bia')).toBeGreaterThan(continuationBets('Leo') * 1.5);
  }, 60_000);

  it('bets more often as the kamikaze than as the patient bot in the same spots', () => {
    expect(continuationBets('Vini')).toBeGreaterThan(continuationBets('Tati') * 1.25);
  }, 60_000);
});

describe('reading opponents', () => {
  /** The hero (big blind) checked the river to a pot-sized bet after calling the flop with second pair. */
  function facingRiverBet(): BotContext {
    const scenario = startScenario([0, 1], [['Qs', 'Js'], ['9c', '8c']], RIVER_BOARD);
    scenario.act({ type: 'raise', amount: 60 });
    scenario.act({ type: 'call' });
    scenario.nextStreet();
    scenario.act({ type: 'check' });
    scenario.act({ type: 'raise', amount: 60 });
    scenario.act({ type: 'call' });
    scenario.nextStreet();
    scenario.act({ type: 'check' });
    scenario.act({ type: 'check' });
    scenario.nextStreet();
    scenario.act({ type: 'check' });
    scenario.act({ type: 'raise', amount: 240 });
    return scenario.contextFor(personalityNamed('Caio'));
  }

  it('calls a big river bet lighter against a maniac than against a nit', () => {
    const maniac = observedPlayer({
      postflopAggressive: 210,
      postflopCalls: 40,
      postflopChecks: 40,
      postflopFolds: 10,
      shownRiverBets: 40,
      shownRiverBluffs: 24,
      shownEarlyBets: 40,
      shownEarlyBluffs: 22,
    });
    const nit = observedPlayer({
      postflopAggressive: 30,
      postflopCalls: 60,
      postflopChecks: 150,
      postflopFolds: 60,
      shownRiverBets: 25,
      shownRiverBluffs: 0,
      shownEarlyBets: 25,
      shownEarlyBluffs: 0,
    });
    const context = facingRiverBet();
    const callsManiac = countMatching(100, 21, (random) =>
      decideBotAction(withStats(context, { 'player-0': maniac }), random).type !== 'fold',
    );
    const callsNit = countMatching(100, 21, (random) => decideBotAction(withStats(context, { 'player-0': nit }), random).type !== 'fold');
    expect(callsManiac).toBeGreaterThan(70);
    expect(callsNit).toBeLessThan(30);
  });
});

describe('decision time', () => {
  it('decides a six-way flop well inside the 40 ms budget', () => {
    const scenario = startScenario(
      [0, 1, 2, 3, 4, 5],
      [['2c', '2d'], ['Ah', 'Kh'], ['7c', '8c'], ['Qd', 'Qs'], ['Jc', 'Td'], ['5h', '5s']],
      ['Ks', '9h', '4h', '2s', '7d'],
    );
    for (let call = 0; call < 5; call++) scenario.act({ type: 'call' });
    scenario.act({ type: 'check' });
    scenario.nextStreet();
    const context = scenario.contextFor(personalityNamed('Otto'));
    const random = createSeededRandom(31);
    decideBotAction(context, random);
    const durations = Array.from({ length: 15 }, () => {
      const startedAt = performance.now();
      decideBotAction(context, random);
      return performance.now() - startedAt;
    }).sort((first, second) => first - second);
    // The median ignores CPU spikes from test files running in parallel.
    expect(durations[7]).toBeLessThan(40);
  });

  it('keeps the work of an eight-way decision close to that of a four-way one', () => {
    /** Everybody limps and checks to the button on the river; counts the random numbers the button's decision draws. */
    const drawsForRiverDecision = (players: number): number => {
      const seats = Array.from({ length: players }, (_, seat) => seat);
      const holeCards = Array.from({ length: players }, (_, index) => [`${'AKQJT98'[index]}c`, `${'AKQJT98'[index]}d`] as [Card, Card]);
      const scenario = startScenario(seats, holeCards, ['2s', '5h', '9s', 'Th', '3c']);
      for (let limp = 0; limp < players - 1; limp++) scenario.act({ type: 'call' });
      scenario.act({ type: 'check' });
      for (let street = 0; street < 3; street++) {
        scenario.nextStreet();
        if (street < 2) for (let check = 0; check < players; check++) scenario.act({ type: 'check' });
      }
      for (let check = 0; check < players - 1; check++) scenario.act({ type: 'check' });
      const random = createSeededRandom(7);
      let draws = 0;
      decideBotAction(scenario.contextFor(personalityNamed('Otto')), () => {
        draws++;
        return random();
      });
      return draws;
    };
    // Each sample deals every opponent a hand, so without the cut eight-way spots drew over three times as much.
    expect(drawsForRiverDecision(8)).toBeLessThan(drawsForRiverDecision(4) * 2);
  });
});
