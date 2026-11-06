import { type Card, createOrderedDeck } from '../src/shared/cards';
import type { PlayerActionRequest } from '../src/shared/protocol';
import { BOT_PERSONALITIES, type BotContext, type BotPersonality, type PlayerStatCounts } from '../src/server/game/BotBrain';
import { BotTableMemory } from '../src/server/game/bots/TableMemory';
import { actionFactsOf, buildBotContext, describeHandStart } from '../src/server/game/bots/publicContext';
import { createEmptyStatCounts } from '../src/server/game/bots/publicInfo';
import { TableEngine } from '../src/server/game/TableEngine';

export const BIG_BLIND = 20;

export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export const personalityNamed = (name: string): BotPersonality => BOT_PERSONALITIES.find((bot) => bot.name === name)!;

/**
 * A deck whose top cards deal `holeCards` (listed in dealing order: first card of every player, then second cards)
 * followed by `board`; the remaining cards keep their usual order.
 */
export function stackedDeck(holeCardsInDealOrder: Card[], board: Card[]): Card[] {
  const top = [...holeCardsInDealOrder, ...board];
  return [...top, ...createOrderedDeck().filter((card) => !top.includes(card))];
}

export interface TableScenario {
  readonly engine: TableEngine;
  readonly memory: BotTableMemory;
  act(request: PlayerActionRequest): void;
  /** Collects bets and deals the next street, opening its betting round. */
  nextStreet(): void;
  contextFor(personality: BotPersonality): BotContext;
}

/**
 * A real engine and a real table memory wired exactly as the game controller wires them.
 * `holeCards[i]` belongs to `seats[i]`; the button is the first seat.
 */
export function startScenario(seats: number[], holeCards: [Card, Card][], board: Card[], stack = 2000): TableScenario {
  const dealOrder = [...seats.slice(1), seats[0]];
  const cardsBySeat = new Map(seats.map((seat, index) => [seat, holeCards[index]]));
  const dealt = [...dealOrder.map((seat) => cardsBySeat.get(seat)![0]), ...dealOrder.map((seat) => cardsBySeat.get(seat)![1])];
  const engine = new TableEngine({ smallBlind: BIG_BLIND / 2, bigBlind: BIG_BLIND }, () => stackedDeck(dealt, board));
  const memory = new BotTableMemory();
  for (const seat of seats) engine.seatPlayer(seat, `player-${seat}`, stack);
  // The engine gives the button to the first eligible seat on its first hand.
  const start = engine.startHand();
  memory.beginHand(describeHandStart(start, (seat) => engine.getPlayer(seat)?.playerId, BIG_BLIND));
  return {
    engine,
    memory,
    act(request) {
      const street = engine.street;
      const result = engine.act(engine.actingSeat!, request);
      memory.recordAction(actionFactsOf(street, result));
    },
    nextStreet() {
      engine.collectBets();
      engine.dealNextStreet();
      engine.beginBettingRound();
    },
    contextFor(personality) {
      const seat = engine.actingSeat!;
      return buildBotContext(engine, seat, personality, engine.getLegalActions(seat)!, BIG_BLIND, memory)!;
    },
  };
}

/** Statistics of a player observed for many hands, with the given fold rate against bets on every street. */
export function observedPlayer(overrides: Partial<PlayerStatCounts> & { foldToBetRate?: number }): PlayerStatCounts {
  const stats = createEmptyStatCounts();
  const hands = 400;
  const facing = 120;
  const folds = Math.round(facing * (overrides.foldToBetRate ?? 0.42));
  return {
    ...stats,
    hands,
    vpip: Math.round(hands * 0.25),
    pfr: Math.round(hands * 0.16),
    facedBets: [facing, facing, facing],
    foldsToBets: [folds, folds, folds],
    foldToCbetChances: facing,
    foldsToCbet: folds,
    facedRaises: facing,
    foldsToRaises: folds,
    ...overrides,
  };
}

/** Replaces what the table remembers about each player id, as if those hands had been played. */
export function withStats(context: BotContext, statsById: Record<string, PlayerStatCounts>): BotContext {
  return { ...context, table: { ...context.table!, statsByPlayer: statsById } };
}

export function countMatching(trials: number, seed: number, decide: (random: () => number) => boolean): number {
  const random = createSeededRandom(seed);
  let matching = 0;
  for (let trial = 0; trial < trials; trial++) if (decide(random)) matching++;
  return matching;
}
