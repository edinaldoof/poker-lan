import { describe, expect, it } from 'vitest';
import { createOrderedDeck, type Card } from '../src/shared/cards';
import { shuffledDeck } from '../src/server/game/Deck';
import type { Pot } from '../src/server/game/pots';
import { EngineError, TableEngine, type EngineConfig, type SettleResult } from '../src/server/game/TableEngine';
import type { LegalActions, PlayerActionRequest } from '../src/shared/protocol';

type HoleCards = [Card, Card];
type Board = [Card, Card, Card, Card, Card];

const BLINDS: EngineConfig = { smallBlind: 10, bigBlind: 20 };

// ---------------------------------------------------------------- helpers

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Builds a full deck whose first cards are laid out exactly as the engine consumes them. */
function scriptedDeck(dealOrder: number[], holes: Record<number, HoleCards>, board: Board): Card[] {
  const firstRound = dealOrder.map((seat) => holes[seat][0]);
  const secondRound = dealOrder.map((seat) => holes[seat][1]);
  const scripted = [...firstRound, ...secondRound, ...board];
  expect(new Set(scripted).size, 'scripted cards must be unique').toBe(scripted.length);
  const remaining = createOrderedDeck().filter((card) => !scripted.includes(card));
  return [...scripted, ...remaining];
}

/** On the first hand the dealer is the lowest seat, so cards start at the seat after it. */
function firstHandDealOrder(seats: number[]): number[] {
  const sorted = [...seats].sort((a, b) => a - b);
  return [...sorted.slice(1), sorted[0]];
}

function createEngine(
  stacks: Record<number, number>,
  decks: Card[][] = [],
  config: EngineConfig = BLINDS,
): TableEngine {
  const random = seededRandom(7);
  let handIndex = 0;
  const engine = new TableEngine(config, () => {
    const scripted = decks[handIndex];
    handIndex += 1;
    return scripted ?? shuffledDeck((maxExclusive) => Math.floor(random() * maxExclusive));
  });
  for (const [seat, chips] of Object.entries(stacks)) {
    engine.seatPlayer(Number(seat), `player-${seat}`, chips);
  }
  return engine;
}

function startScriptedHand(
  stacks: Record<number, number>,
  holes: Record<number, HoleCards>,
  board: Board,
  config: EngineConfig = BLINDS,
): TableEngine {
  const seats = Object.keys(stacks).map(Number);
  const engine = createEngine(stacks, [scriptedDeck(firstHandDealOrder(seats), holes, board)], config);
  engine.startHand();
  return engine;
}

function startHand(stacks: Record<number, number>, config: EngineConfig = BLINDS): TableEngine {
  const engine = createEngine(stacks, [], config);
  engine.startHand();
  return engine;
}

const fold = (engine: TableEngine, seat: number) => engine.act(seat, { type: 'fold' });
const check = (engine: TableEngine, seat: number) => engine.act(seat, { type: 'check' });
const call = (engine: TableEngine, seat: number) => engine.act(seat, { type: 'call' });
const raiseTo = (engine: TableEngine, seat: number, amount: number) => engine.act(seat, { type: 'raise', amount });
const allIn = (engine: TableEngine, seat: number) => engine.act(seat, { type: 'allIn' });

function legalForActor(engine: TableEngine): LegalActions {
  const seat = engine.actingSeat;
  if (seat === null) throw new Error('nobody is acting');
  const legal = engine.getLegalActions(seat);
  if (legal === null) throw new Error('the acting seat has no legal actions');
  return legal;
}

function legalFor(engine: TableEngine, seat: number): LegalActions {
  const legal = engine.getLegalActions(seat);
  if (legal === null) throw new Error(`seat ${seat} is not acting`);
  return legal;
}

function stackOf(engine: TableEngine, seat: number): number {
  const player = engine.getPlayer(seat);
  if (player === null) throw new Error(`seat ${seat} is empty`);
  return player.chips;
}

function totalChips(engine: TableEngine): number {
  return engine.getPlayers().reduce((sum, player) => sum + player.chips, 0) + engine.totalPot();
}

function winByFolding(engine: TableEngine): void {
  while (engine.actingSeat !== null) fold(engine, engine.actingSeat);
  engine.collectBets();
  engine.settle();
  engine.endHand();
}

/** Everybody still live checks every remaining street; assumes the current round is already closed. */
function checkDownToRiver(engine: TableEngine): void {
  while (engine.street !== 'river') {
    engine.collectBets();
    engine.dealNextStreet();
    engine.beginBettingRound();
    while (engine.actingSeat !== null) check(engine, engine.actingSeat);
  }
  engine.collectBets();
}

function dealRunout(engine: TableEngine): void {
  engine.collectBets();
  while (engine.street !== 'river') {
    engine.dealNextStreet();
    expect(engine.beginBettingRound()).toBeNull();
  }
}

// ---------------------------------------------------------------- seating

describe('seating and configuration', () => {
  it('rejects occupied seats, out-of-range seats and invalid stacks', () => {
    const engine = new TableEngine(BLINDS);
    engine.seatPlayer(3, 'a', 500);

    expect(() => engine.seatPlayer(3, 'b', 500)).toThrow(EngineError);
    expect(() => engine.seatPlayer(8, 'b', 500)).toThrow(EngineError);
    expect(() => engine.seatPlayer(-1, 'b', 500)).toThrow(EngineError);
    expect(() => engine.seatPlayer(1.5, 'b', 500)).toThrow(EngineError);
    expect(() => engine.seatPlayer(1, 'b', -5)).toThrow(EngineError);
    expect(() => engine.seatPlayer(1, 'b', 10.5)).toThrow(EngineError);
  });

  it('rejects invalid blind configurations', () => {
    expect(() => new TableEngine({ smallBlind: 0, bigBlind: 20 })).toThrow(EngineError);
    expect(() => new TableEngine({ smallBlind: 10.5, bigBlind: 20 })).toThrow(EngineError);
    expect(() => new TableEngine({ smallBlind: 30, bigBlind: 20 })).toThrow(EngineError);
  });

  it('returns defensive copies of player state', () => {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 1000 });
    const copy = engine.getPlayer(0);
    const listCopy = engine.getPlayers();

    copy?.holeCards.push('2c');
    if (copy) copy.chips = 1;
    listCopy[1].chips = 5;
    listCopy[1].holeCards.length = 0;

    expect(engine.getPlayer(0)?.holeCards).toHaveLength(2);
    expect(stackOf(engine, 0)).toBe(1000);
    expect(stackOf(engine, 1)).toBe(990);
    expect(engine.getPlayer(1)?.holeCards).toHaveLength(2);
    expect(engine.getPlayer(7)).toBeNull();
  });

  it('returns defensive copies of the board and the pots', () => {
    const engine = startHand({ 0: 1000, 1: 1000 });
    call(engine, 0);
    check(engine, 1);
    engine.collectBets();
    engine.dealNextStreet();

    engine.community.push('2c');
    engine.pots.push({ amount: 1, eligibleSeats: [0] });
    engine.pots[0].eligibleSeats.push(5);

    expect(engine.community).toHaveLength(3);
    expect(engine.pots).toEqual([{ amount: 40, eligibleSeats: [0, 1] }]);
  });

  it('treats only seated players with chips who are not sitting out as eligible', () => {
    const engine = createEngine({ 0: 1000, 1: 1000, 2: 0, 3: 1000, 5: 1000 });
    engine.setSittingOut(5, true);

    expect(engine.eligibleSeats()).toEqual([0, 1, 3]);
    expect(engine.canStartHand()).toBe(true);
    expect(engine.getPlayer(5)?.sittingOut).toBe(true);
  });

  it('refuses to start a hand without two eligible players or during a hand', () => {
    const engine = createEngine({ 0: 1000, 1: 0 });
    expect(engine.canStartHand()).toBe(false);
    expect(() => engine.startHand()).toThrow(EngineError);

    engine.addChips(1, 500);
    expect(engine.canStartHand()).toBe(true);
    engine.startHand();
    expect(engine.canStartHand()).toBe(false);
    expect(engine.isHandInProgress()).toBe(true);
    expect(() => engine.startHand()).toThrow(EngineError);
  });

  it('refuses a deck that is too short and leaves the engine untouched', () => {
    const engine = new TableEngine(BLINDS, () => createOrderedDeck().slice(0, 8));
    engine.seatPlayer(0, 'a', 1000);
    engine.seatPlayer(1, 'b', 1000);

    expect(() => engine.startHand()).toThrow(EngineError);

    expect(engine.isHandInProgress()).toBe(false);
    expect(engine.handNumber).toBe(0);
    expect(stackOf(engine, 0)).toBe(1000);
  });

  it('does not modify the deck returned by the deck factory', () => {
    const deck = createOrderedDeck();
    const engine = new TableEngine(BLINDS, () => deck);
    engine.seatPlayer(0, 'a', 1000);
    engine.seatPlayer(1, 'b', 1000);

    engine.startHand();

    expect(deck).toEqual(createOrderedDeck());
  });

  it('forbids changing blinds during a hand and applies new blinds to the next one', () => {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 1000 });

    expect(() => engine.setConfig({ smallBlind: 20, bigBlind: 40 })).toThrow(EngineError);
    winByFolding(engine);
    engine.setConfig({ smallBlind: 20, bigBlind: 40 });
    const start = engine.startHand();

    expect(start.blinds.map((blind) => blind.amount)).toEqual([20, 40]);
    expect(engine.currentBet).toBe(40);
    expect(legalForActor(engine).minRaiseTo).toBe(80);
  });

  it('only lets a player leave mid-hand after folding, and keeps their chips in the pot', () => {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 1000 });
    raiseTo(engine, 0, 100);
    fold(engine, 1);
    call(engine, 2);

    expect(() => engine.removePlayer(0)).toThrow(EngineError);
    expect(engine.totalPot()).toBe(210);
    engine.removePlayer(1);
    expect(engine.getPlayer(1)).toBeNull();
    expect(engine.totalPot()).toBe(210);

    const chipsStillInPlay = totalChips(engine);
    expect(chipsStillInPlay).toBe(900 + 900 + 210);
    expect(engine.collectBets().pots).toEqual([{ amount: 210, eligibleSeats: [0, 2] }]);
    checkDownToRiver(engine);
    engine.settle();

    expect(totalChips(engine)).toBe(chipsStillInPlay);
    engine.endHand();
    expect(engine.totalPot()).toBe(0);
  });

  it('adds chips between hands and for players who are not playing the hand', () => {
    const engine = createEngine({ 0: 1000, 1: 1000, 2: 0 });
    engine.startHand();

    expect(() => engine.addChips(0, 100)).toThrow(EngineError);
    engine.addChips(2, 300);
    expect(stackOf(engine, 2)).toBe(300);
    expect(engine.getPlayer(2)?.inHand).toBe(false);
    expect(() => engine.addChips(2, 0)).toThrow(EngineError);
    expect(() => engine.addChips(2, -5)).toThrow(EngineError);
    expect(() => engine.addChips(2, 1.5)).toThrow(EngineError);
    expect(() => engine.addChips(6, 100)).toThrow(EngineError);

    winByFolding(engine);
    engine.addChips(0, 100);
    expect(stackOf(engine, 0)).toBe(1090);
  });

  it('lets a player who already folded rebuy without changing the pot', () => {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 1000 });
    raiseTo(engine, 0, 100);
    fold(engine, 1);

    engine.addChips(1, 500);

    expect(engine.getPlayer(1)).toMatchObject({ chips: 1490, contribution: 10, folded: true });
    expect(engine.totalPot()).toBe(100 + 10 + 20);
  });

  it('refuses to remove or rebuy a winner between settle and endHand, then allows both', () => {
    const engine = startScriptedHand(
      { 0: 1000, 1: 1000 },
      { 0: ['As', 'Ah'], 1: ['2c', '3d'] },
      ['9s', 'Td', '4h', 'Jc', '8d'],
    );
    call(engine, 0);
    check(engine, 1);
    checkDownToRiver(engine);
    engine.settle();

    expect(() => engine.removePlayer(0)).toThrow(EngineError);
    expect(() => engine.addChips(1, 100)).toThrow(EngineError);

    engine.endHand();
    engine.addChips(1, 100);
    engine.removePlayer(0);
    expect(stackOf(engine, 1)).toBe(980 + 100);
    expect(engine.getPlayer(0)).toBeNull();
  });

  it('seats a player mid-hand without dealing them in until the next hand', () => {
    const engine = startHand({ 0: 1000, 1: 1000 });
    engine.seatPlayer(4, 'late', 1000);

    expect(engine.getPlayer(4)?.inHand).toBe(false);
    expect(engine.getPlayer(4)?.holeCards).toEqual([]);
    winByFolding(engine);
    const start = engine.startHand();
    expect(start.dealOrder).toHaveLength(3);
    expect(engine.getPlayer(4)?.holeCards).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- button, blinds, dealing

describe('button, blinds and dealing', () => {
  it('puts the first button on the lowest eligible seat with blinds to its left', () => {
    const engine = createEngine({ 2: 1000, 4: 1000, 6: 1000 });

    const start = engine.startHand();

    expect(start).toEqual({
      handNumber: 1,
      dealerSeat: 2,
      smallBlindSeat: 4,
      bigBlindSeat: 6,
      blinds: [
        { seat: 4, amount: 10, blind: 'small' },
        { seat: 6, amount: 20, blind: 'big' },
      ],
      dealOrder: [4, 6, 2],
    });
    expect(engine.street).toBe('preflop');
    expect(engine.dealerSeat).toBe(2);
    expect(engine.smallBlindSeat).toBe(4);
    expect(engine.bigBlindSeat).toBe(6);
    expect(engine.currentBet).toBe(20);
    expect(engine.totalPot()).toBe(30);
    expect(engine.pots).toEqual([]);
    expect(engine.actingSeat).toBe(2);
    expect(engine.getPlayer(4)).toMatchObject({ chips: 990, streetBet: 10, contribution: 10, inHand: true });
    expect(engine.getPlayer(6)).toMatchObject({ chips: 980, streetBet: 20, contribution: 20, inHand: true });
    expect(engine.getPlayer(2)).toMatchObject({ chips: 1000, streetBet: 0, contribution: 0, inHand: true });
  });

  it('heads-up: the dealer posts the small blind and acts first preflop, last postflop', () => {
    const engine = createEngine({ 1: 1000, 5: 1000 });

    const start = engine.startHand();

    expect(start.dealerSeat).toBe(1);
    expect(start.smallBlindSeat).toBe(1);
    expect(start.bigBlindSeat).toBe(5);
    expect(start.dealOrder).toEqual([5, 1]);
    expect(engine.actingSeat).toBe(1);

    const dealerCall = call(engine, 1);
    expect(dealerCall).toMatchObject({ amount: 10, totalBet: 20, nextActor: 5, roundComplete: false });
    expect(legalFor(engine, 5)).toMatchObject({ canCheck: true, canRaise: true, minRaiseTo: 40 });
    const bigBlindCheck = check(engine, 5);
    expect(bigBlindCheck).toMatchObject({ roundComplete: true, nextActor: null, handComplete: false });

    engine.collectBets();
    engine.dealNextStreet();
    expect(engine.beginBettingRound()).toBe(5);
    expect(check(engine, 5).nextActor).toBe(1);
    expect(check(engine, 1).roundComplete).toBe(true);
  });

  it('heads-up: the button alternates between the two players', () => {
    const engine = createEngine({ 1: 1000, 5: 1000 });

    const dealers: (number | null)[] = [];
    for (let hand = 0; hand < 4; hand++) {
      engine.startHand();
      dealers.push(engine.dealerSeat);
      expect(engine.smallBlindSeat).toBe(engine.dealerSeat);
      expect(engine.actingSeat).toBe(engine.dealerSeat);
      winByFolding(engine);
    }

    expect(dealers).toEqual([1, 5, 1, 5]);
  });

  it('with four players the seat after the big blind opens the action and play goes clockwise', () => {
    const engine = createEngine({ 0: 1000, 1: 1000, 2: 1000, 3: 1000 });
    const start = engine.startHand();

    expect(start).toMatchObject({ dealerSeat: 0, smallBlindSeat: 1, bigBlindSeat: 2, dealOrder: [1, 2, 3, 0] });
    expect(engine.actingSeat).toBe(3);

    expect(call(engine, 3)).toEqual({
      seat: 3,
      action: 'call',
      amount: 20,
      totalBet: 20,
      allIn: false,
      roundComplete: false,
      handComplete: false,
      nextActor: 0,
    });
    expect(call(engine, 0).nextActor).toBe(1);
    expect(call(engine, 1)).toMatchObject({ amount: 10, totalBet: 20, nextActor: 2 });
    expect(check(engine, 2)).toMatchObject({ roundComplete: true, nextActor: null });
    expect(engine.actingSeat).toBeNull();
  });

  it('postflop the first live seat after the dealer acts first', () => {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 1000, 3: 1000 });
    call(engine, 3);
    call(engine, 0);
    fold(engine, 1);
    check(engine, 2);
    engine.collectBets();
    engine.dealNextStreet();

    expect(engine.beginBettingRound()).toBe(2);
    expect(check(engine, 2).nextActor).toBe(3);
    expect(check(engine, 3).nextActor).toBe(0);
    expect(check(engine, 0)).toMatchObject({ roundComplete: true, nextActor: null });
  });

  it('deals two hole cards per player in dealOrder and then the board without burn cards', () => {
    const holes: Record<number, HoleCards> = {
      0: ['As', 'Ks'],
      1: ['2c', '3d'],
      2: ['4h', '5s'],
    };
    const board: Board = ['Td', 'Jc', 'Qh', '9s', '8d'];
    const engine = startScriptedHand({ 0: 1000, 1: 1000, 2: 1000 }, holes, board);

    expect(engine.getPlayer(0)?.holeCards).toEqual(['As', 'Ks']);
    expect(engine.getPlayer(1)?.holeCards).toEqual(['2c', '3d']);
    expect(engine.getPlayer(2)?.holeCards).toEqual(['4h', '5s']);
    expect(engine.community).toEqual([]);

    call(engine, 0);
    call(engine, 1);
    check(engine, 2);
    engine.collectBets();
    expect(engine.dealNextStreet()).toEqual({ street: 'flop', cards: ['Td', 'Jc', 'Qh'] });
    expect(engine.street).toBe('flop');
    engine.beginBettingRound();
    while (engine.actingSeat !== null) check(engine, engine.actingSeat);
    engine.collectBets();
    expect(engine.dealNextStreet()).toEqual({ street: 'turn', cards: ['9s'] });
    engine.beginBettingRound();
    while (engine.actingSeat !== null) check(engine, engine.actingSeat);
    engine.collectBets();
    expect(engine.dealNextStreet()).toEqual({ street: 'river', cards: ['8d'] });
    expect(engine.community).toEqual(board);
    expect(() => engine.dealNextStreet()).toThrow(EngineError);
  });

  it('increments the hand number on every startHand', () => {
    const engine = createEngine({ 0: 1000, 1: 1000, 2: 1000 });

    const numbers: number[] = [];
    for (let hand = 0; hand < 3; hand++) {
      numbers.push(engine.startHand().handNumber);
      expect(engine.handNumber).toBe(hand + 1);
      winByFolding(engine);
    }

    expect(numbers).toEqual([1, 2, 3]);
  });

  it('rotates the button clockwise, skipping sitting-out and chipless seats', () => {
    const engine = createEngine({ 0: 1000, 1: 1000, 2: 1000, 3: 1000, 4: 0 });

    const hands: { dealer: number | null; smallBlind: number | null; bigBlind: number | null }[] = [];
    const playHand = () => {
      engine.startHand();
      hands.push({ dealer: engine.dealerSeat, smallBlind: engine.smallBlindSeat, bigBlind: engine.bigBlindSeat });
      winByFolding(engine);
    };

    playHand();
    engine.setSittingOut(1, true);
    playHand();
    engine.setSittingOut(1, false);
    playHand();
    playHand();
    playHand();

    expect(hands).toEqual([
      { dealer: 0, smallBlind: 1, bigBlind: 2 },
      { dealer: 2, smallBlind: 3, bigBlind: 0 },
      { dealer: 3, smallBlind: 0, bigBlind: 1 },
      { dealer: 0, smallBlind: 1, bigBlind: 2 },
      { dealer: 1, smallBlind: 2, bigBlind: 3 },
    ]);
  });

  it('does not deal cards to sitting-out players', () => {
    const engine = createEngine({ 0: 1000, 1: 1000, 2: 1000 });
    engine.setSittingOut(1, true);

    const start = engine.startHand();

    expect(start.dealOrder).toEqual([2, 0]);
    expect(engine.getPlayer(1)).toMatchObject({ inHand: false, holeCards: [] });
  });

  it('lets a short stack post part of the small blind and go all-in', () => {
    const engine = startHand({ 0: 1000, 1: 4, 2: 1000 });

    expect(engine.getPlayer(1)).toMatchObject({ chips: 0, streetBet: 4, contribution: 4, allIn: true });
    expect(engine.currentBet).toBe(20);
    expect(engine.actingSeat).toBe(0);
    expect(legalFor(engine, 0)).toMatchObject({ callAmount: 20, minRaiseTo: 40 });
  });

  it('keeps the nominal big blind as the bet to match when the big blind posts less', () => {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 8 });

    expect(engine.getPlayer(2)).toMatchObject({ chips: 0, streetBet: 8, allIn: true });
    expect(engine.currentBet).toBe(20);
    expect(legalFor(engine, 0)).toMatchObject({ callAmount: 20, minRaiseTo: 40 });
    call(engine, 0);
    expect(legalFor(engine, 1)).toMatchObject({ callAmount: 10 });
    expect(call(engine, 1)).toMatchObject({ roundComplete: true, nextActor: null });

    expect(engine.collectBets()).toEqual({
      returned: [],
      collected: 48,
      pots: [
        { amount: 24, eligibleSeats: [0, 1, 2] },
        { amount: 24, eligibleSeats: [0, 1] },
      ],
    });
  });

  it('skips the pointless big blind option when everybody else is all-in', () => {
    const engine = startHand({ 0: 5, 1: 1000 });

    expect(engine.getPlayer(0)).toMatchObject({ chips: 0, streetBet: 5, allIn: true });
    expect(engine.actingSeat).toBeNull();
    expect(engine.isAllInRunout()).toBe(true);
    expect(engine.collectBets()).toEqual({
      returned: [{ seat: 1, amount: 15 }],
      collected: 10,
      pots: [{ amount: 10, eligibleSeats: [0, 1] }],
    });
    expect(stackOf(engine, 1)).toBe(995);
  });

  it('runs the hand out when the small blind already covers an all-in short big blind', () => {
    const engine = startHand({ 0: 1000, 4: 5 });

    expect(engine.getPlayer(0)).toMatchObject({ chips: 990, streetBet: 10 });
    expect(engine.getPlayer(4)).toMatchObject({ chips: 0, streetBet: 5, allIn: true });
    expect(engine.currentBet).toBe(20);
    expect(engine.actingSeat).toBeNull();
    expect(engine.isAllInRunout()).toBe(true);
    expect(engine.collectBets()).toEqual({
      returned: [{ seat: 0, amount: 5 }],
      collected: 10,
      pots: [{ amount: 10, eligibleSeats: [0, 4] }],
    });
    expect(stackOf(engine, 0)).toBe(995);
  });

  it('closes the round for a blind that covers the short big blind once the others fold', () => {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 5 });

    expect(engine.actingSeat).toBe(0);
    expect(fold(engine, 0)).toMatchObject({ roundComplete: true, handComplete: false, nextActor: null });
    expect(engine.actingSeat).toBeNull();
    expect(engine.collectBets().returned).toEqual([{ seat: 1, amount: 5 }]);
  });

  it('still asks the small blind to act when the all-in big blind posted more than it did', () => {
    const engine = startHand({ 0: 1000, 4: 15 });

    expect(engine.getPlayer(4)).toMatchObject({ chips: 0, streetBet: 15, allIn: true });
    expect(engine.actingSeat).toBe(0);
    expect(legalForActor(engine)).toMatchObject({ canCheck: false, canCall: true, callAmount: 10 });
    expect(call(engine, 0)).toMatchObject({ roundComplete: true, nextActor: null });
  });
});

// ---------------------------------------------------------------- betting rules

describe('legal actions', () => {
  it('only reports legal actions for the acting seat', () => {
    const engine = createEngine({ 0: 1000, 1: 1000, 2: 1000 });
    expect(engine.getLegalActions(0)).toBeNull();
    engine.startHand();

    expect(engine.getLegalActions(1)).toBeNull();
    expect(engine.getLegalActions(2)).toBeNull();
    expect(engine.getLegalActions(5)).toBeNull();
    expect(engine.getLegalActions(0)).not.toBeNull();
  });

  it('describes the first decision preflop', () => {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 1000, 3: 1000 });

    expect(engine.getLegalActions(3)).toEqual({
      canFold: true,
      canCheck: false,
      canCall: true,
      callAmount: 20,
      canRaise: true,
      minRaiseTo: 40,
      maxRaiseTo: 1000,
      isOpeningBet: false,
    });
  });

  it('caps the call amount at the stack and the raise at stack plus street bet', () => {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 50 });
    raiseTo(engine, 0, 200);

    expect(engine.getLegalActions(1)).toMatchObject({ callAmount: 190, maxRaiseTo: 1000, minRaiseTo: 380 });
    fold(engine, 1);
    // 50 chips in total cannot even match the 200 bet, so the only options are a partial call or a fold.
    expect(engine.getLegalActions(2)).toMatchObject({
      callAmount: 30,
      canCall: true,
      maxRaiseTo: 50,
      minRaiseTo: 50,
      canRaise: false,
    });
  });

  it('gives the big blind the option to raise after everybody limps', () => {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 1000 });
    call(engine, 0);
    call(engine, 1);

    expect(engine.actingSeat).toBe(2);
    expect(legalFor(engine, 2)).toEqual({
      canFold: true,
      canCheck: true,
      canCall: false,
      callAmount: 0,
      canRaise: true,
      minRaiseTo: 40,
      maxRaiseTo: 1000,
      isOpeningBet: false,
    });

    expect(raiseTo(engine, 2, 60)).toMatchObject({
      action: 'raise',
      amount: 40,
      totalBet: 60,
      roundComplete: false,
      nextActor: 0,
    });
    expect(call(engine, 0)).toMatchObject({ amount: 40, nextActor: 1 });
    expect(call(engine, 1)).toMatchObject({ amount: 40, roundComplete: true, nextActor: null });
  });

  it('lets the big blind check the option to close the round', () => {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 1000 });
    call(engine, 0);
    call(engine, 1);

    expect(check(engine, 2)).toMatchObject({ action: 'check', amount: 0, totalBet: 20, roundComplete: true });
    expect(engine.actingSeat).toBeNull();
  });

  it('sizes the minimum raise from the last full raise', () => {
    const engine = startHand({ 0: 5000, 1: 5000, 2: 5000 });

    expect(raiseTo(engine, 0, 60)).toMatchObject({ action: 'raise', amount: 60, totalBet: 60 });
    expect(legalFor(engine, 1)).toMatchObject({ callAmount: 50, minRaiseTo: 100, maxRaiseTo: 5000 });

    raiseTo(engine, 1, 100);
    expect(legalFor(engine, 2)).toMatchObject({ callAmount: 80, minRaiseTo: 140 });

    raiseTo(engine, 2, 300);
    expect(legalFor(engine, 0)).toMatchObject({ callAmount: 240, minRaiseTo: 500 });
    expect(() => raiseTo(engine, 0, 499)).toThrow(EngineError);
    expect(raiseTo(engine, 0, 500)).toMatchObject({ action: 'raise', totalBet: 500, amount: 440 });
  });

  it('labels the first postflop raise as a bet, with the big blind as minimum', () => {
    const engine = startHand({ 0: 1000, 1: 1000 });
    call(engine, 0);
    check(engine, 1);
    engine.collectBets();
    engine.dealNextStreet();
    engine.beginBettingRound();

    expect(legalFor(engine, 1)).toEqual({
      canFold: true,
      canCheck: true,
      canCall: false,
      callAmount: 0,
      canRaise: true,
      minRaiseTo: 20,
      maxRaiseTo: 980,
      isOpeningBet: true,
    });
    expect(() => raiseTo(engine, 1, 10)).toThrow(EngineError);

    expect(raiseTo(engine, 1, 50)).toMatchObject({ action: 'bet', amount: 50, totalBet: 50 });
    expect(legalFor(engine, 0)).toMatchObject({ isOpeningBet: false, callAmount: 50, minRaiseTo: 100 });
    expect(raiseTo(engine, 0, 150)).toMatchObject({ action: 'raise', amount: 150, totalBet: 150 });
    expect(legalFor(engine, 1)).toMatchObject({ callAmount: 100, minRaiseTo: 250 });
  });

  it('resets the minimum raise to the big blind on every new street', () => {
    const engine = startHand({ 0: 1000, 1: 1000 });
    raiseTo(engine, 0, 200);
    call(engine, 1);
    engine.collectBets();
    engine.dealNextStreet();
    engine.beginBettingRound();

    expect(engine.currentBet).toBe(0);
    expect(legalFor(engine, 1).minRaiseTo).toBe(20);
  });

  it('lets a short stack raise only by going all-in', () => {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 70 });
    raiseTo(engine, 0, 60);
    call(engine, 1);

    expect(legalFor(engine, 2)).toMatchObject({ canRaise: true, minRaiseTo: 70, maxRaiseTo: 70, callAmount: 40 });
    expect(() => raiseTo(engine, 2, 65)).toThrow(EngineError);
    expect(raiseTo(engine, 2, 70)).toMatchObject({ action: 'allIn', amount: 50, totalBet: 70, allIn: true });
    // The 10-chip increment is not a full raise, so the players who already acted may only call or fold.
    expect(legalFor(engine, 0)).toMatchObject({ canRaise: false, callAmount: 10 });
  });

  it('forbids raising when nobody can respond, and turns all-in into a call', () => {
    const engine = startHand({ 0: 200, 1: 1000 });
    expect(allIn(engine, 0)).toMatchObject({ action: 'allIn', amount: 190, totalBet: 200, allIn: true });

    const legal = legalFor(engine, 1);
    expect(legal).toMatchObject({ canRaise: false, canCall: true, callAmount: 180 });
    expect(() => raiseTo(engine, 1, 500)).toThrow(EngineError);

    expect(allIn(engine, 1)).toMatchObject({
      action: 'call',
      amount: 180,
      totalBet: 200,
      allIn: false,
      roundComplete: true,
    });
    expect(engine.isAllInRunout()).toBe(true);
  });

  it('turns an all-in request into a raise to the full stack when raising is allowed', () => {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 1000 });

    expect(allIn(engine, 0)).toMatchObject({
      action: 'allIn',
      amount: 1000,
      totalBet: 1000,
      allIn: true,
      nextActor: 1,
    });
    expect(engine.currentBet).toBe(1000);
    // The small blind can at most match the shove, so a raise is impossible.
    expect(legalFor(engine, 1)).toMatchObject({ callAmount: 990, canRaise: false, maxRaiseTo: 1000 });
  });
});

describe('reopening the action after short all-in raises', () => {
  const stacks = { 0: 1000, 1: 1000, 2: 1000, 3: 1000, 4: 80 };

  it('does not let a player who already acted re-raise, but a player yet to act may', () => {
    const engine = startHand(stacks);
    expect(engine.actingSeat).toBe(3);

    raiseTo(engine, 3, 60);
    expect(allIn(engine, 4)).toMatchObject({ action: 'allIn', amount: 80, totalBet: 80, nextActor: 0 });

    expect(legalFor(engine, 0)).toMatchObject({ canRaise: true, minRaiseTo: 120, callAmount: 80 });
    call(engine, 0);
    call(engine, 1);
    expect(call(engine, 2)).toMatchObject({ nextActor: 3, roundComplete: false });

    expect(legalFor(engine, 3)).toMatchObject({ canRaise: false, canCall: true, callAmount: 20 });
    expect(() => raiseTo(engine, 3, 200)).toThrow(EngineError);
    expect(allIn(engine, 3)).toMatchObject({
      action: 'call',
      amount: 20,
      totalBet: 80,
      allIn: false,
      roundComplete: true,
      nextActor: null,
    });
  });

  it('reopens the action for everybody when a player yet to act makes a full raise', () => {
    const engine = startHand(stacks);
    raiseTo(engine, 3, 60);
    allIn(engine, 4);

    expect(raiseTo(engine, 0, 120)).toMatchObject({ action: 'raise', nextActor: 1 });
    call(engine, 1);
    call(engine, 2);

    expect(engine.actingSeat).toBe(3);
    expect(legalFor(engine, 3)).toMatchObject({ canRaise: true, callAmount: 60, minRaiseTo: 160 });
    expect(raiseTo(engine, 3, 160)).toMatchObject({ action: 'raise', totalBet: 160 });
  });

  it('reopens the action when several short all-ins add up to a full raise', () => {
    const engine = startHand({ ...stacks, 0: 100 });
    raiseTo(engine, 3, 60);
    allIn(engine, 4);
    expect(allIn(engine, 0)).toMatchObject({ action: 'allIn', totalBet: 100, nextActor: 1 });
    call(engine, 1);
    fold(engine, 2);

    expect(engine.actingSeat).toBe(3);
    expect(legalFor(engine, 3)).toMatchObject({ canRaise: true, callAmount: 40, minRaiseTo: 140 });
  });

  it('keeps the minimum raise at the last full raise after a short all-in', () => {
    const engine = startHand(stacks);
    raiseTo(engine, 3, 60);
    allIn(engine, 4);

    expect(legalFor(engine, 0).minRaiseTo).toBe(80 + 40);
  });

});

describe('all-in for less than the call', () => {
  it('lets a short stack call all-in for less and builds a side pot', () => {
    const engine = startHand({ 0: 1000, 1: 50, 2: 1000 });
    raiseTo(engine, 0, 200);

    expect(legalFor(engine, 1)).toMatchObject({ callAmount: 40, canCall: true });
    expect(call(engine, 1)).toMatchObject({
      action: 'allIn',
      amount: 40,
      totalBet: 50,
      allIn: true,
      nextActor: 2,
      roundComplete: false,
    });
    expect(call(engine, 2)).toMatchObject({ amount: 180, roundComplete: true });

    expect(engine.collectBets()).toEqual({
      returned: [],
      collected: 450,
      pots: [
        { amount: 150, eligibleSeats: [0, 1, 2] },
        { amount: 300, eligibleSeats: [0, 2] },
      ],
    });
  });

  it('treats an all-in request below the call amount as a call for less', () => {
    const engine = startHand({ 0: 1000, 1: 50, 2: 1000 });
    raiseTo(engine, 0, 200);

    expect(allIn(engine, 1)).toMatchObject({ action: 'allIn', amount: 40, totalBet: 50 });
    expect(engine.currentBet).toBe(200);
  });
});

describe('illegal actions', () => {
  it('throws EngineError and leaves the state untouched', () => {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 1000 });
    const attempt = (seat: number, request: unknown) => () => engine.act(seat, request as PlayerActionRequest);

    expect(attempt(1, { type: 'fold' })).toThrow(EngineError);
    expect(attempt(2, { type: 'call' })).toThrow(EngineError);
    expect(attempt(5, { type: 'check' })).toThrow(EngineError);
    expect(attempt(0, { type: 'check' })).toThrow(EngineError);
    expect(attempt(0, { type: 'raise', amount: 39 })).toThrow(EngineError);
    expect(attempt(0, { type: 'raise', amount: 1001 })).toThrow(EngineError);
    expect(attempt(0, { type: 'raise', amount: 100.5 })).toThrow(EngineError);
    expect(attempt(0, { type: 'raise', amount: Number.NaN })).toThrow(EngineError);
    expect(attempt(0, { type: 'raise', amount: Number.POSITIVE_INFINITY })).toThrow(EngineError);
    expect(attempt(0, { type: 'raise', amount: '100' })).toThrow(EngineError);
    expect(attempt(0, { type: 'raise' })).toThrow(EngineError);
    expect(attempt(0, { type: 'bet', amount: 100 })).toThrow(EngineError);
    expect(attempt(0, { type: 'dance' })).toThrow(EngineError);

    expect(engine.actingSeat).toBe(0);
    expect(engine.totalPot()).toBe(30);
    expect(stackOf(engine, 0)).toBe(1000);
  });

  it('reports user-facing reasons in Portuguese', () => {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 1000 });

    expect(() => check(engine, 0)).toThrow(/check/);
    expect(() => raiseTo(engine, 0, 30)).toThrow(/mínimo/);
    expect(() => raiseTo(engine, 0, 5000)).toThrow(/1\.000/);
    expect(() => call(engine, 1)).toThrow(/vez/);
  });

  it('rejects calling when there is nothing to call', () => {
    const engine = startHand({ 0: 1000, 1: 1000 });
    call(engine, 0);

    expect(() => call(engine, 1)).toThrow(EngineError);
  });

  it('rejects actions when no hand is running or the betting is over', () => {
    const idle = createEngine({ 0: 1000, 1: 1000 });
    expect(() => check(idle, 0)).toThrow(EngineError);

    const engine = startHand({ 0: 1000, 1: 1000 });
    fold(engine, 0);
    expect(engine.actingSeat).toBeNull();
    expect(() => check(engine, 1)).toThrow(EngineError);
  });

  it('rejects out-of-order lifecycle calls', () => {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 1000 });

    expect(() => engine.collectBets()).toThrow(EngineError);
    expect(() => engine.dealNextStreet()).toThrow(EngineError);
    expect(() => engine.beginBettingRound()).toThrow(EngineError);
    expect(() => engine.settle()).toThrow(EngineError);
    expect(() => engine.endHand()).toThrow(EngineError);

    call(engine, 0);
    call(engine, 1);
    check(engine, 2);
    expect(() => engine.dealNextStreet()).toThrow(EngineError);
    expect(() => engine.settle()).toThrow(EngineError);
    engine.collectBets();
    expect(() => engine.settle()).toThrow(EngineError);
    engine.dealNextStreet();
    expect(engine.beginBettingRound()).not.toBeNull();
    expect(() => engine.beginBettingRound()).toThrow(EngineError);
  });

  it('refuses to settle or end a hand twice', () => {
    const engine = startHand({ 0: 1000, 1: 1000 });
    fold(engine, 0);
    engine.collectBets();
    engine.settle();

    expect(() => engine.settle()).toThrow(EngineError);
    expect(() => engine.collectBets()).toThrow(EngineError);
    engine.endHand();
    expect(() => engine.endHand()).toThrow(EngineError);
  });
});

// ---------------------------------------------------------------- pots and settlement

describe('uncalled bets', () => {
  it('returns the unmatched part of a bet when everybody folds', () => {
    const engine = startHand({ 0: 1000, 1: 1000 });

    expect(raiseTo(engine, 0, 100)).toMatchObject({ action: 'raise', totalBet: 100 });
    expect(fold(engine, 1)).toMatchObject({ handComplete: true, roundComplete: true, nextActor: null });

    expect(engine.collectBets()).toEqual({
      returned: [{ seat: 0, amount: 80 }],
      collected: 40,
      pots: [{ amount: 40, eligibleSeats: [0] }],
    });
    expect(engine.getPlayer(0)).toMatchObject({ chips: 980, streetBet: 0, contribution: 20 });
    expect(engine.currentBet).toBe(0);
  });

  it('returns the excess when an all-in is called for less', () => {
    const engine = startHand({ 0: 1000, 1: 300 });
    allIn(engine, 0);
    expect(call(engine, 1)).toMatchObject({ action: 'allIn', amount: 280, totalBet: 300, roundComplete: true });

    expect(engine.collectBets()).toEqual({
      returned: [{ seat: 0, amount: 700 }],
      collected: 600,
      pots: [{ amount: 600, eligibleSeats: [0, 1] }],
    });
    expect(stackOf(engine, 0)).toBe(700);
  });

  it('returns nothing when the two highest bets are equal', () => {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 1000 });
    raiseTo(engine, 0, 100);
    call(engine, 1);
    call(engine, 2);

    expect(engine.collectBets().returned).toEqual([]);
  });

  /** Seat 1 raises on the flop, seat 2 calls all-in for less, and seat 1 leaves before seat 0 folds. */
  function flopRaiseThenRaiserLeaves(): TableEngine {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 200 });
    raiseTo(engine, 0, 100);
    call(engine, 1);
    call(engine, 2);
    engine.collectBets();
    engine.dealNextStreet();
    expect(engine.beginBettingRound()).toBe(1);
    raiseTo(engine, 1, 300);
    allIn(engine, 2);
    expect(engine.actingSeat).toBe(0);

    engine.foldOutOfTurn(1);
    return engine;
  }

  it('refunds the unmatched part of a bet even when its owner folded by leaving the table', () => {
    const engine = flopRaiseThenRaiserLeaves();
    expect(fold(engine, 0)).toMatchObject({ handComplete: true });

    expect(engine.collectBets()).toEqual({
      returned: [{ seat: 1, amount: 200 }],
      collected: 200,
      pots: [{ amount: 500, eligibleSeats: [2] }],
    });
    expect(engine.getPlayer(1)).toMatchObject({ chips: 800, contribution: 200, folded: true });
    engine.settle();
    expect(stackOf(engine, 2)).toBe(500);
    expect(totalChips(engine)).toBe(2200);
  });

  it('keeps the surplus in the pot when the folded bettor was already removed from the table', () => {
    const engine = flopRaiseThenRaiserLeaves();
    engine.removePlayer(1);
    expect(fold(engine, 0)).toMatchObject({ handComplete: true });

    expect(engine.collectBets()).toEqual({
      returned: [],
      collected: 400,
      pots: [{ amount: 700, eligibleSeats: [2] }],
    });
    engine.settle();
    expect(stackOf(engine, 2)).toBe(700);
    expect(totalChips(engine)).toBe(2200 - 600);
  });
});

describe('side pots and settlement', () => {
  const board: Board = ['Ks', 'Kd', '7c', '7d', '2h'];
  const stacks = { 0: 500, 1: 100, 2: 300, 3: 1000 };

  function fourWayAllIn(holes: Record<number, HoleCards>): TableEngine {
    const engine = startScriptedHand(stacks, holes, board);
    raiseTo(engine, 3, 500);
    allIn(engine, 0);
    allIn(engine, 1);
    expect(allIn(engine, 2)).toMatchObject({ roundComplete: true, nextActor: null, handComplete: false });
    return engine;
  }

  it('builds a main pot and two side pots with the right eligibility', () => {
    const engine = fourWayAllIn({
      0: ['As', 'Ah'],
      1: ['Kh', 'Kc'],
      2: ['7h', '7s'],
      3: ['Qs', 'Qd'],
    });

    expect(engine.isAllInRunout()).toBe(true);
    expect(engine.collectBets()).toEqual({
      returned: [],
      collected: 1400,
      pots: [
        { amount: 400, eligibleSeats: [0, 1, 2, 3] },
        { amount: 600, eligibleSeats: [0, 2, 3] },
        { amount: 400, eligibleSeats: [0, 3] },
      ],
    });
    expect(engine.totalPot()).toBe(1400);
  });

  it('pays every pot to the best hand among the players eligible for it', () => {
    const engine = fourWayAllIn({
      0: ['As', 'Ah'], // two pair, aces and kings
      1: ['Kh', 'Kc'], // four kings, short stack
      2: ['7h', '7s'], // four sevens
      3: ['Qs', 'Qd'], // two pair, kings and queens
    });
    dealRunout(engine);

    const settlement = engine.settle();

    expect(settlement.showdown).toBe(true);
    expect(settlement.awards.map((award) => [award.potIndex, award.amount])).toEqual([
      [0, 400],
      [1, 600],
      [2, 400],
    ]);
    expect(settlement.awards.map((award) => award.winners.map((winner) => [winner.seat, winner.amount]))).toEqual([
      [[1, 400]],
      [[2, 600]],
      [[0, 400]],
    ]);
    expect(settlement.awards[0].winners[0].hand?.name).toBe('Quadra de Reis');
    expect([...settlement.hands.keys()].sort()).toEqual([0, 1, 2, 3]);
    expect([0, 1, 2, 3].map((seat) => stackOf(engine, seat))).toEqual([400, 400, 600, 500]);
    expect(engine.pots).toEqual([]);
    expect(engine.totalPot()).toBe(0);
    expect(engine.street).toBe('showdown');
  });

  it('lets the best hand overall scoop every pot it is eligible for', () => {
    const engine = fourWayAllIn({
      0: ['As', 'Ah'],
      1: ['2s', '2d'], // full house, twos full of kings
      2: ['7h', '7s'], // four sevens
      3: ['Kh', 'Kc'], // four kings
    });
    dealRunout(engine);

    const settlement = engine.settle();

    expect(settlement.awards.map((award) => award.winners.map((winner) => winner.seat))).toEqual([[3], [3], [3]]);
    expect([0, 1, 2, 3].map((seat) => stackOf(engine, seat))).toEqual([0, 0, 0, 1900]);
    expect(engine.endHand()).toEqual([0, 1, 2]);
  });

  it('gives the main pot to a short stack that wins while a bigger stack wins the side pot', () => {
    const engine = startScriptedHand(
      { 0: 100, 1: 400, 2: 400 },
      { 0: ['Kh', 'Kc'], 1: ['As', 'Ah'], 2: ['Qs', 'Qd'] },
      ['Ks', 'Kd', '7c', '7d', '2h'],
    );
    allIn(engine, 0);
    allIn(engine, 1);
    allIn(engine, 2);
    dealRunout(engine);

    const settlement = engine.settle();

    expect(settlement.awards.map((award) => [award.amount, award.winners.map((winner) => winner.seat)])).toEqual([
      [300, [0]],
      [600, [1]],
    ]);
  });

  it('splits a pot with the odd chip going to the first winner left of the dealer', () => {
    const config: EngineConfig = { smallBlind: 5, bigBlind: 10 };
    const royalBoard: Board = ['Ts', 'Js', 'Qs', 'Ks', 'As'];
    const engine = startScriptedHand(
      { 0: 1000, 1: 1000, 2: 1000 },
      { 0: ['2c', '3d'], 1: ['4h', '5d'], 2: ['6c', '7h'] },
      royalBoard,
      config,
    );
    call(engine, 0);
    fold(engine, 1);
    check(engine, 2);
    checkDownToRiver(engine);
    expect(engine.pots).toEqual([{ amount: 25, eligibleSeats: [0, 2] }]);

    const settlement = engine.settle();

    expect(settlement.awards).toHaveLength(1);
    expect(settlement.awards[0].winners.map((winner) => [winner.seat, winner.amount])).toEqual([
      [2, 13],
      [0, 12],
    ]);
    expect([0, 1, 2].map((seat) => stackOf(engine, seat))).toEqual([1002, 995, 1003]);
  });

  it('awards an uncontested pot without showdown when everybody else folds', () => {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 1000, 3: 1000 });
    expect(raiseTo(engine, 3, 60).nextActor).toBe(0);
    fold(engine, 0);
    fold(engine, 1);
    expect(fold(engine, 2)).toMatchObject({ handComplete: true, roundComplete: true, nextActor: null });

    expect(engine.collectBets()).toEqual({
      returned: [{ seat: 3, amount: 40 }],
      collected: 50,
      pots: [{ amount: 50, eligibleSeats: [3] }],
    });
    const settlement = engine.settle();

    expect(settlement).toEqual({
      showdown: false,
      awards: [{ potIndex: 0, amount: 50, winners: [{ seat: 3, amount: 50, hand: null }] }],
      hands: new Map(),
    });
    expect(engine.community).toEqual([]);
    expect(engine.street).not.toBe('showdown');
    expect([0, 1, 2, 3].map((seat) => stackOf(engine, seat))).toEqual([1000, 990, 980, 1030]);
  });

  it('awards the whole pot to the last player standing after a postflop fold', () => {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 1000 });
    call(engine, 0);
    call(engine, 1);
    check(engine, 2);
    engine.collectBets();
    engine.dealNextStreet();
    engine.beginBettingRound();
    raiseTo(engine, 1, 100);
    fold(engine, 2);
    expect(fold(engine, 0)).toMatchObject({ handComplete: true });

    expect(engine.collectBets().returned).toEqual([{ seat: 1, amount: 100 }]);
    const settlement = engine.settle();

    expect(settlement.showdown).toBe(false);
    expect(stackOf(engine, 1)).toBe(1040);
  });

  it('requires five community cards for a showdown', () => {
    const engine = startHand({ 0: 100, 1: 100 });
    allIn(engine, 0);
    allIn(engine, 1);
    engine.collectBets();

    expect(() => engine.settle()).toThrow(EngineError);
    expect(engine.isHandInProgress()).toBe(true);
  });

  it('reports the seats left without chips when the hand ends', () => {
    const engine = startScriptedHand(
      { 0: 100, 1: 1000 },
      { 0: ['2c', '3d'], 1: ['As', 'Ah'] },
      ['9s', 'Td', '4h', 'Jc', '8d'],
    );
    allIn(engine, 0);
    call(engine, 1);
    dealRunout(engine);
    engine.settle();

    expect(() => engine.settle()).toThrow(EngineError);
    expect(engine.endHand()).toEqual([0]);

    expect(engine.isHandInProgress()).toBe(false);
    expect(engine.street).toBe('idle');
    expect(engine.actingSeat).toBeNull();
    expect(engine.currentBet).toBe(0);
    expect(stackOf(engine, 0)).toBe(0);
    expect(stackOf(engine, 1)).toBe(1100);
    expect(engine.getPlayers().every((player) => !player.inHand && player.streetBet === 0)).toBe(true);
    expect(engine.canStartHand()).toBe(false);
    engine.addChips(0, 500);
    expect(engine.canStartHand()).toBe(true);
  });
});

describe('all-in runouts', () => {
  it('is false while two players can still bet', () => {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 1000 });

    expect(engine.isAllInRunout()).toBe(false);
    raiseTo(engine, 0, 100);
    fold(engine, 1);
    expect(engine.isAllInRunout()).toBe(false);
  });

  it('is false for a hand with a single live player', () => {
    const engine = startHand({ 0: 1000, 1: 1000 });
    fold(engine, 0);

    expect(engine.isAllInRunout()).toBe(false);
  });

  it('is false outside a hand', () => {
    expect(createEngine({ 0: 1000, 1: 1000 }).isAllInRunout()).toBe(false);
  });

  it('is true when at least two players are live and only one can still bet', () => {
    const engine = startHand({ 0: 300, 1: 300, 2: 1000 });
    allIn(engine, 0);
    expect(engine.isAllInRunout()).toBe(false);
    call(engine, 1);
    call(engine, 2);

    expect(engine.isAllInRunout()).toBe(true);
    expect(engine.actingSeat).toBeNull();
    engine.collectBets();
    engine.dealNextStreet();
    expect(engine.beginBettingRound()).toBeNull();
  });

  it('is true when every live player is all-in', () => {
    const engine = startHand({ 0: 100, 1: 200, 2: 1000 });
    allIn(engine, 0);
    allIn(engine, 1);
    fold(engine, 2);

    expect(engine.isAllInRunout()).toBe(true);
  });

  it('still bets the flop when two players have chips behind a third who is all-in', () => {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 100 });
    call(engine, 0);
    call(engine, 1);
    allIn(engine, 2);
    call(engine, 0);
    call(engine, 1);
    engine.collectBets();
    engine.dealNextStreet();

    expect(engine.beginBettingRound()).toBe(1);
  });
});

describe('players leaving mid-hand', () => {
  it('folds a waiting player without disturbing the acting seat', () => {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 1000, 3: 1000 });

    expect(engine.foldOutOfTurn(1)).toEqual({ handComplete: false, roundComplete: false, nextActor: 3 });
    expect(engine.getPlayer(1)?.folded).toBe(true);
    expect(call(engine, 3).nextActor).toBe(0);
    expect(call(engine, 0).nextActor).toBe(2);
  });

  it('folds the acting player and passes the turn on', () => {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 1000, 3: 1000 });

    expect(engine.foldOutOfTurn(3)).toEqual({ handComplete: false, roundComplete: false, nextActor: 0 });
    expect(engine.actingSeat).toBe(0);
  });

  it('completes the hand when only one live player remains', () => {
    const engine = startHand({ 0: 1000, 1: 1000 });

    expect(engine.foldOutOfTurn(1)).toEqual({ handComplete: true, roundComplete: true, nextActor: null });
    expect(engine.actingSeat).toBeNull();
    expect(engine.collectBets().returned).toEqual([{ seat: 1, amount: 10 }]);
    engine.settle();
    // The big blind who left only forfeits the 10 the dealer matched; the other 10 was never at risk.
    expect(stackOf(engine, 0)).toBe(1010);
    expect(stackOf(engine, 1)).toBe(990);
  });

  it('never folds the last live player', () => {
    const engine = startHand({ 0: 1000, 1: 1000 });
    engine.foldOutOfTurn(1);

    expect(engine.foldOutOfTurn(0)).toEqual({ handComplete: true, roundComplete: true, nextActor: null });
    expect(engine.getPlayer(0)?.folded).toBe(false);
  });

  it('is harmless for players who are not in the hand or already folded', () => {
    const engine = createEngine({ 0: 1000, 1: 1000, 2: 1000, 3: 0 });
    expect(engine.foldOutOfTurn(0).handComplete).toBe(false);
    engine.startHand();

    expect(engine.foldOutOfTurn(3)).toMatchObject({ handComplete: false, nextActor: 0 });
    engine.foldOutOfTurn(1);
    expect(engine.foldOutOfTurn(1)).toMatchObject({ handComplete: false, nextActor: 0 });
    expect(() => engine.foldOutOfTurn(6)).toThrow(EngineError);
  });

  it('closes the street when the only player who still had to act leaves', () => {
    const engine = startHand({ 0: 1000, 1: 1000, 2: 1000 });
    call(engine, 0);
    call(engine, 1);
    expect(engine.actingSeat).toBe(2);

    const result = engine.foldOutOfTurn(2);

    expect(result.handComplete).toBe(false);
    expect(result.roundComplete).toBe(true);
    expect(engine.actingSeat).toBeNull();
    engine.collectBets();
    engine.dealNextStreet();
    expect(engine.beginBettingRound()).toBe(1);
  });

  it('keeps a player who left out of the showdown but leaves their chips in the pot', () => {
    const engine = startScriptedHand(
      { 0: 1000, 1: 1000, 2: 1000 },
      { 0: ['2c', '3d'], 1: ['As', 'Ah'], 2: ['Kc', 'Kd'] },
      ['9s', 'Td', '4h', 'Jc', '8d'],
    );
    call(engine, 0);
    call(engine, 1);
    check(engine, 2);
    engine.collectBets();
    engine.foldOutOfTurn(1);
    engine.dealNextStreet();
    engine.beginBettingRound();
    while (engine.actingSeat !== null) check(engine, engine.actingSeat);
    checkDownToRiver(engine);

    const settlement = engine.settle();

    expect(settlement.awards[0].winners.map((winner) => winner.seat)).toEqual([2]);
    expect(settlement.awards[0].amount).toBe(60);
    expect(totalChips(engine)).toBe(3000);
  });
});

// ---------------------------------------------------------------- property test

describe('chip conservation', () => {
  interface Totals {
    expected: number;
  }

  /** Counts the interesting situations the random play actually reached, so the test cannot pass vacuously. */
  interface Coverage {
    hands: number;
    showdowns: number;
    uncontested: number;
    allInRunouts: number;
    multiPotHands: number;
    splitPots: number;
    uncalledReturns: number;
    reopenDenials: number;
  }

  function emptyCoverage(): Coverage {
    return {
      hands: 0,
      showdowns: 0,
      uncontested: 0,
      allInRunouts: 0,
      multiPotHands: 0,
      splitPots: 0,
      uncalledReturns: 0,
      reopenDenials: 0,
    };
  }

  /** `potsPaid` is true between settle() and endHand(): contributions are still recorded but the pots are empty. */
  function auditChips(engine: TableEngine, totals: Totals, potsPaid = false): void {
    const players = engine.getPlayers();
    for (const player of players) {
      expect(Number.isInteger(player.chips)).toBe(true);
      expect(player.chips).toBeGreaterThanOrEqual(0);
      expect(player.streetBet).toBeGreaterThanOrEqual(0);
    }
    expect(totalChips(engine)).toBe(totals.expected);
    if (!potsPaid) {
      expect(players.reduce((sum, player) => sum + player.contribution, 0)).toBe(engine.totalPot());
    }
  }

  function randomRequest(legal: LegalActions, random: () => number): PlayerActionRequest {
    const roll = random();
    if (legal.canRaise && roll < 0.3) {
      const choice = random();
      const span = legal.maxRaiseTo - legal.minRaiseTo;
      if (choice < 0.25) return { type: 'raise', amount: legal.minRaiseTo };
      if (choice < 0.4) return { type: 'raise', amount: legal.maxRaiseTo };
      return { type: 'raise', amount: legal.minRaiseTo + Math.floor(random() * (span + 1)) };
    }
    if (roll < 0.38) return { type: 'allIn' };
    if (roll < 0.52 && !legal.canCheck) return { type: 'fold' };
    if (roll < 0.54) return { type: 'fold' };
    return legal.canCheck ? { type: 'check' } : { type: 'call' };
  }

  function verifySettlement(settlement: SettleResult, potsBefore: Pot[]): void {
    for (const award of settlement.awards) {
      const pot = potsBefore[award.potIndex];
      expect(award.amount).toBe(pot.amount);
      expect(award.winners.reduce((sum, winner) => sum + winner.amount, 0)).toBe(award.amount);
      for (const winner of award.winners) {
        expect(pot.eligibleSeats).toContain(winner.seat);
      }
      if (settlement.showdown) {
        const bestScore = Math.max(
          ...pot.eligibleSeats.map((seat) => settlement.hands.get(seat)?.score ?? Number.NEGATIVE_INFINITY),
        );
        for (const winner of award.winners) {
          expect(winner.hand?.score).toBe(bestScore);
        }
      }
    }
  }

  function playRandomHand(engine: TableEngine, totals: Totals, coverage: Coverage, random: () => number): void {
    engine.startHand();
    coverage.hands += 1;
    auditChips(engine, totals);

    let steps = 0;
    for (;;) {
      while (engine.actingSeat !== null) {
        const seat = engine.actingSeat;
        const legal = engine.getLegalActions(seat);
        expect(legal).not.toBeNull();
        if (legal === null) return;

        const someoneCouldRespond = engine
          .getPlayers()
          .some((other) => other.seat !== seat && other.inHand && !other.folded && !other.allIn);
        if (!legal.canRaise && legal.maxRaiseTo > engine.currentBet && someoneCouldRespond) {
          coverage.reopenDenials += 1;
        }

        const result = engine.act(seat, randomRequest(legal, random));

        expect(result.seat).toBe(seat);
        expect(result.nextActor).toBe(engine.actingSeat);
        expect(result.roundComplete).toBe(result.nextActor === null);
        expect(result.handComplete).toBe(engine.nonFoldedSeats().length <= 1);
        auditChips(engine, totals);
        steps += 1;
        expect(steps).toBeLessThan(2000);
      }

      const collection = engine.collectBets();
      if (collection.returned.length > 0) coverage.uncalledReturns += 1;
      if (engine.isAllInRunout()) coverage.allInRunouts += 1;
      auditChips(engine, totals);
      if (engine.nonFoldedSeats().length <= 1 || engine.street === 'river') break;
      engine.dealNextStreet();
      engine.beginBettingRound();
    }

    const potsBefore = engine.pots;
    const potTotal = engine.totalPot();
    const settlement = engine.settle();
    verifySettlement(settlement, potsBefore);
    if (settlement.showdown) coverage.showdowns += 1;
    else coverage.uncontested += 1;
    if (settlement.awards.length > 1) coverage.multiPotHands += 1;
    if (settlement.awards.some((award) => award.winners.length > 1)) coverage.splitPots += 1;
    expect(settlement.awards.reduce((sum, award) => sum + award.amount, 0)).toBe(potTotal);
    auditChips(engine, totals, true);
    expect(engine.totalPot()).toBe(0);

    const expectedBusted = engine
      .getPlayers()
      .filter((player) => player.inHand && player.chips === 0)
      .map((player) => player.seat);
    expect(engine.endHand()).toEqual(expectedBusted);
    expect(engine.isHandInProgress()).toBe(false);
    auditChips(engine, totals);
  }

  const SHORT_STACKS = [15, 20, 35, 60, 150, 400, 1000, 2500];
  const DEEP_STACKS = [2000, 5000, 10000, 40000];

  function playRandomGame(
    random: () => number,
    handsToPlay: number,
    stackChoices: number[],
    coverage: Coverage,
  ): void {
    const pickStack = () => stackChoices[Math.floor(random() * stackChoices.length)];
    const engine = new TableEngine(BLINDS, () => shuffledDeck((maxExclusive) => Math.floor(random() * maxExclusive)));
    const totals: Totals = { expected: 0 };

    let occupied: number[] = [];
    while (occupied.length < 2) {
      occupied = [0, 1, 2, 3, 4, 5, 6, 7].filter(() => random() < 0.6);
    }
    for (const seat of occupied) {
      const chips = pickStack();
      engine.seatPlayer(seat, `player-${seat}`, chips);
      totals.expected += chips;
    }

    for (let hand = 0; hand < handsToPlay; hand++) {
      for (const player of engine.getPlayers()) {
        if (player.chips === 0) {
          const rebuy = pickStack();
          engine.addChips(player.seat, rebuy);
          totals.expected += rebuy;
        }
        engine.setSittingOut(player.seat, random() < 0.1);
      }
      if (engine.eligibleSeats().length < 2) {
        for (const player of engine.getPlayers()) engine.setSittingOut(player.seat, false);
      }
      playRandomHand(engine, totals, coverage, random);
    }
  }

  it('keeps every chip, never goes negative and always terminates over 300 random hands', () => {
    const random = seededRandom(20240607);
    const coverage = emptyCoverage();

    while (coverage.hands < 300) {
      playRandomGame(random, Math.min(10, 300 - coverage.hands), SHORT_STACKS, coverage);
    }

    expect(coverage.hands).toBe(300);
    // Guards against a generator that only ever folds around: every rule above must have been exercised.
    expect(coverage.showdowns).toBeGreaterThan(40);
    expect(coverage.uncontested).toBeGreaterThan(20);
    expect(coverage.allInRunouts).toBeGreaterThan(20);
    expect(coverage.multiPotHands).toBeGreaterThan(10);
    expect(coverage.splitPots).toBeGreaterThan(0);
    expect(coverage.uncalledReturns).toBeGreaterThan(20);
    expect(coverage.reopenDenials).toBeGreaterThan(0);
  });

  it('stays consistent with deep stacks, where long raising wars are possible', () => {
    const random = seededRandom(424242);
    const coverage = emptyCoverage();

    while (coverage.hands < 100) {
      playRandomGame(random, 5, DEEP_STACKS, coverage);
    }

    expect(coverage.hands).toBe(100);
    expect(coverage.showdowns).toBeGreaterThan(10);
  });
});
