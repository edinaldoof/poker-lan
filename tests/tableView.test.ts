import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { ChipPlacement } from '../src/client/scene/ChipFactory';
import { playerStackChips } from '../src/client/scene/playerStackLayout';
import { FELT_Y, getSeatAnchor, slotForSeat } from '../src/client/scene/SeatLayout';
import { TableView, type TableViewDeps } from '../src/client/scene/TableView';
import type { Card } from '../src/shared/cards';
import { describeStartingHand, evaluateHand } from '../src/shared/handEvaluator';
import {
  DEFAULT_CONFIG,
  MAX_SEATS,
  type GameEvent,
  type SeatView,
  type TableView as TableState,
} from '../src/shared/protocol';

// The dealer and blind pucks paint a canvas texture, which needs a DOM this suite does not have.
vi.mock('../src/client/scene/TableButtons', async () => {
  const three = await import('three');
  // Base on y = 0, like the real pucks.
  const createPuck = (): THREE.Mesh => new three.Mesh(new three.BoxGeometry(0.05, 0.01, 0.05).translate(0, 0.005, 0));
  return { createDealerButton: createPuck, createBlindButton: createPuck };
});

// Timelines run this many times faster than the real animation so each play settles within milliseconds.
const TEST_SPEED = 100;
const VIEWER_SEAT = 0;
const OPPONENT_SEAT = 4;
const VIEWER_CARDS: Card[] = ['9c', '2c'];
const OPPONENT_CARDS: Card[] = ['Ah', 'Kd'];
const FLOP: Card[] = ['3d', '6c', '7s'];
const TURN: Card[] = [...FLOP, 'Ks'];
const RIVER: Card[] = [...TURN, 'Tc'];

class StubCard extends THREE.Group {
  card: Card | null;

  constructor(card: Card | null) {
    super();
    this.card = card;
  }

  setFace(card: Card | null): void {
    this.card = card;
  }

  setHighlight(): void {}
  setInHand(): void {}

  dispose(): void {
    this.removeFromParent();
  }
}

class StubStack extends THREE.Group {
  amount: number;
  readonly topY = 0;
  /** The exact chips it was told to show, when it holds a pushed player stack. */
  shownChips: ChipPlacement[] | null = null;

  constructor(amount: number) {
    super();
    this.amount = amount;
  }

  setAmount(amount: number): void {
    this.amount = amount;
    this.shownChips = null;
  }

  showChips(amount: number, chips: readonly ChipPlacement[]): void {
    this.amount = amount;
    this.shownChips = [...chips];
  }

  dispose(): void {
    this.removeFromParent();
  }
}

/** Bet and pot stacks as plain groups; the players' stacks get real (geometry-less) instanced meshes. */
function stubChips(): { createStack: (amount: number) => StubStack; createInstancedChips: (denomination: number, capacity: number) => THREE.InstancedMesh } {
  return {
    createStack: (amount) => new StubStack(amount),
    createInstancedChips: (_denomination, capacity) => {
      const chips = new THREE.InstancedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial(), capacity);
      chips.count = 0;
      return chips;
    },
  };
}

interface ViewHarness {
  view: TableView;
  handLabels: () => (string | null)[];
}

function createView(): ViewHarness {
  const labels = new Map<number, string | null>();
  const deps = {
    stage: {
      tableRoot: new THREE.Group(),
      resetCamera: () => Promise.resolve(),
      shake: () => undefined,
      dramaticZoom: () => Promise.resolve(),
    },
    table: {},
    cards: { createCard: (code: Card | null) => new StubCard(code) },
    chips: stubChips(),
    audio: { play: () => undefined },
    plates: {
      setHandLabel: (seat: number, label: string | null) => labels.set(seat, label),
      setBetLabel: () => undefined,
      setPotLabel: () => undefined,
      flashWin: () => undefined,
    },
  } as unknown as TableViewDeps;
  const handLabels = (): (string | null)[] => Array.from({ length: MAX_SEATS }, (_, seat) => labels.get(seat) ?? null);
  return { view: new TableView(deps), handLabels };
}

function seatView(seat: number, cards: Card[] | null): SeatView {
  return {
    seat,
    playerId: `player-${seat}`,
    name: `Jogador ${seat}`,
    color: '#ffffff',
    avatar: 'fox',
    isBot: false,
    connected: true,
    chips: 0,
    bet: 0,
    status: 'allIn',
    cardCount: 2,
    cards,
    lastAction: null,
  };
}

function createState(community: Card[], opponentRevealed: boolean): TableState {
  const seats: (SeatView | null)[] = Array.from({ length: MAX_SEATS }, () => null);
  seats[VIEWER_SEAT] = seatView(VIEWER_SEAT, VIEWER_CARDS);
  seats[OPPONENT_SEAT] = seatView(OPPONENT_SEAT, opponentRevealed ? OPPONENT_CARDS : null);
  return {
    phase: 'running',
    handNumber: 1,
    street: 'flop',
    seats,
    dealerSeat: null,
    smallBlindSeat: null,
    bigBlindSeat: null,
    community,
    pots: [],
    currentBet: 0,
    actingSeat: null,
    turnDeadline: null,
    turnDurationMs: 0,
    config: DEFAULT_CONFIG,
    lanUrls: [],
    self: { playerId: `player-${VIEWER_SEAT}`, seat: VIEWER_SEAT, isSpectator: false, legal: null, handName: null },
  };
}

/** Same wording the server puts in the reveal event: the made hand from the flop on, the starting hand before. */
function handName(holeCards: Card[], board: Card[]): string {
  return board.length >= 3 ? evaluateHand([...holeCards, ...board]).name : describeStartingHand(holeCards);
}

function revealEvent(board: Card[]): GameEvent {
  return {
    kind: 'reveal',
    allIn: true,
    hands: [
      { seat: VIEWER_SEAT, cards: VIEWER_CARDS, handName: handName(VIEWER_CARDS, board) },
      { seat: OPPONENT_SEAT, cards: OPPONENT_CARDS, handName: handName(OPPONENT_CARDS, board) },
    ],
  };
}

function communityEvent(street: 'flop' | 'turn' | 'river', cards: Card[]): GameEvent {
  return { kind: 'community', street, cards };
}

function labelsAfterRebuild(state: TableState): (string | null)[] {
  const rebuilt = createView();
  rebuilt.view.sync(state, VIEWER_SEAT);
  return rebuilt.handLabels();
}

describe('TableView hand labels during an all-in runout', () => {
  it.each([
    { motion: 'full motion', reduced: false },
    { motion: 'reduced motion', reduced: true },
  ])('keeps every plate equal to what a rebuilt table shows after each street ($motion)', async ({ reduced }) => {
    const { view, handLabels } = createView();
    view.setReducedMotion(reduced);
    const flopHidden = createState(FLOP, false);
    const flopRevealed = createState(FLOP, true);
    const turnRevealed = createState(TURN, true);
    const riverRevealed = createState(RIVER, true);

    view.sync(flopHidden, VIEWER_SEAT);
    await view.play(revealEvent(FLOP), flopHidden, flopRevealed, TEST_SPEED);
    expect(handLabels()[VIEWER_SEAT]).toBe(handName(VIEWER_CARDS, FLOP));

    await view.play(communityEvent('turn', ['Ks']), flopRevealed, turnRevealed, TEST_SPEED);
    expect(handLabels()[VIEWER_SEAT]).toBe(handName(VIEWER_CARDS, TURN));
    expect(handLabels()[OPPONENT_SEAT]).toBe(handName(OPPONENT_CARDS, TURN));
    expect(handLabels()).toEqual(labelsAfterRebuild(turnRevealed));

    await view.play(communityEvent('river', ['Tc']), turnRevealed, riverRevealed, TEST_SPEED);
    expect(handLabels()[VIEWER_SEAT]).toBe(handName(VIEWER_CARDS, RIVER));
    expect(handLabels()[OPPONENT_SEAT]).toBe(handName(OPPONENT_CARDS, RIVER));
    expect(handLabels()).toEqual(labelsAfterRebuild(riverRevealed));
  });

  it('relabels the hands dealt before the flop with the made hand once the board appears', async () => {
    const { view, handLabels } = createView();
    const preflopHidden = createState([], false);
    const preflopRevealed = createState([], true);
    const flopRevealed = createState(FLOP, true);

    view.sync(preflopHidden, VIEWER_SEAT);
    await view.play(revealEvent([]), preflopHidden, preflopRevealed, TEST_SPEED);
    expect(handLabels()[OPPONENT_SEAT]).not.toBe(handName(OPPONENT_CARDS, FLOP));

    await view.play(communityEvent('flop', FLOP), preflopRevealed, flopRevealed, TEST_SPEED);

    expect(handLabels()[OPPONENT_SEAT]).toBe(handName(OPPONENT_CARDS, FLOP));
    expect(handLabels()).toEqual(labelsAfterRebuild(flopRevealed));
  });

  it('shows no hand name on a street dealt while the other hands are still hidden', async () => {
    const { view, handLabels } = createView();
    const preflop = createState([], false);
    const flop = createState(FLOP, false);

    view.sync(preflop, VIEWER_SEAT);
    await view.play(communityEvent('flop', FLOP), preflop, flop, TEST_SPEED);

    expect(handLabels()).toEqual(Array.from({ length: MAX_SEATS }, () => null));
  });
});

interface DealerCalls {
  looks: (THREE.Vector3 | null)[];
  deals: THREE.Vector3[];
  collects: number;
  pushes: THREE.Vector3[];
  points: THREE.Vector3[];
  nods: number;
  gripReads: number;
  activities: string[];
  attentions: { seatCount: number; hasPot: boolean }[];
  welcomes: THREE.Vector3[];
  deckListeners: ((held: boolean) => void)[];
}

interface DealerHarness extends ViewHarness {
  calls: DealerCalls;
  actions: { seat: number; action: string; amount: number; totalBet: number }[];
}

const DEALER_HAND = new THREE.Vector3(0.1, 0.9, -0.5);

function createViewWithDealer(): DealerHarness {
  const calls: DealerCalls = { looks: [], deals: [], collects: 0, pushes: [], points: [], nods: 0, gripReads: 0, activities: [], attentions: [], welcomes: [], deckListeners: [] };
  const actions: DealerHarness['actions'] = [];
  const dealer = {
    lookAt: (target: THREE.Vector3 | null) => calls.looks.push(target ? target.clone() : null),
    gripWorldPosition: (_side: string, out: THREE.Vector3) => {
      calls.gripReads += 1;
      return out.copy(DEALER_HAND);
    },
    grippedCardScale: 0.6,
    setActivity: (activity: string) => calls.activities.push(activity),
    setAttention: (attention: { seatPoints: THREE.Vector3[]; potPoint: THREE.Vector3 | null }) =>
      calls.attentions.push({ seatCount: attention.seatPoints.length, hasPot: attention.potPoint !== null }),
    welcomeSeat: (point: THREE.Vector3) => calls.welcomes.push(point.clone()),
    onDeckHeldChange: (listener: (held: boolean) => void) => calls.deckListeners.push(listener),
    gestureDeal: (target: THREE.Vector3) => {
      calls.deals.push(target.clone());
      return Promise.resolve();
    },
    gestureCollect: () => {
      calls.collects += 1;
      return Promise.resolve();
    },
    gesturePush: (target: THREE.Vector3) => {
      calls.pushes.push(target.clone());
      return Promise.resolve();
    },
    gesturePoint: (target: THREE.Vector3) => calls.points.push(target.clone()),
    nod: () => {
      calls.nods += 1;
    },
  };
  const labels = new Map<number, string | null>();
  const deps = {
    stage: {
      tableRoot: new THREE.Group(),
      resetCamera: () => Promise.resolve(),
      shake: () => undefined,
      dramaticZoom: () => Promise.resolve(),
    },
    table: {},
    cards: { createCard: (code: Card | null) => new StubCard(code) },
    chips: stubChips(),
    audio: { play: () => undefined },
    plates: {
      setHandLabel: (seat: number, label: string | null) => labels.set(seat, label),
      setBetLabel: () => undefined,
      setPotLabel: () => undefined,
      flashWin: () => undefined,
      showAction: (seat: number, action: string, amount: number, totalBet: number) => actions.push({ seat, action, amount, totalBet }),
    },
    dealer,
  } as unknown as TableViewDeps;
  return { view: new TableView(deps), handLabels: () => [], calls, actions };
}

function dealtState(): TableState {
  const state = createState([], false);
  state.seats[OPPONENT_SEAT] = { ...seatView(OPPONENT_SEAT, null), isBot: true };
  return state;
}

describe('TableView with the dealer', () => {
  it('pitches every hole card from the dealer right hand toward its seat', async () => {
    const { view, calls } = createViewWithDealer();
    const state = dealtState();

    await view.play({ kind: 'dealHole', seats: [VIEWER_SEAT, OPPONENT_SEAT] }, state, state, TEST_SPEED);

    expect(calls.deals).toHaveLength(4);
    // Each card is picked up at the fingertips when the fingers close and read once more as it leaves them.
    expect(calls.gripReads).toBeGreaterThanOrEqual(8);
    expect(calls.looks.at(-1)).toBeNull();
  });

  it('pitches the community cards from the dealer hand to their slots', async () => {
    const { view, calls } = createViewWithDealer();
    const flopHidden = dealtState();
    const flop = { ...flopHidden, community: FLOP };
    view.sync(flopHidden, VIEWER_SEAT);

    await view.play(communityEvent('flop', FLOP), flopHidden, flop, TEST_SPEED);

    expect(calls.deals).toHaveLength(3);
    expect(calls.gripReads).toBeGreaterThanOrEqual(6);
    const distinctSlots = new Set(calls.deals.map((target) => target.x.toFixed(3)));
    expect(distinctSlots.size).toBe(3);
  });

  it('keeps the cards on the deck and skips every gesture under reduced motion', async () => {
    const { view, calls } = createViewWithDealer();
    const state = dealtState();
    view.setReducedMotion(true);

    await view.play({ kind: 'dealHole', seats: [VIEWER_SEAT, OPPONENT_SEAT] }, state, state, TEST_SPEED);

    expect(calls.deals).toHaveLength(0);
    expect(calls.gripReads).toBe(0);
  });

  it('sweeps the bets with both arms when the street ends', async () => {
    const { view, calls } = createViewWithDealer();
    const state = dealtState();
    view.sync(state, VIEWER_SEAT);

    await view.play({ kind: 'collect', returned: [], pots: [{ amount: 40, eligibleSeats: [0, 4] }] }, state, state, TEST_SPEED);

    expect(calls.collects).toBe(1);
  });

  it('pushes the pot toward the first winner and looks at that seat', async () => {
    const { view, calls } = createViewWithDealer();
    const state = dealtState();
    view.sync(state, VIEWER_SEAT);

    await view.play(
      { kind: 'award', showdown: false, awards: [{ potIndex: 0, amount: 40, winners: [{ seat: OPPONENT_SEAT, amount: 40, handName: null, bestFive: [] }] }] },
      state,
      state,
      TEST_SPEED,
    );

    expect(calls.pushes).toHaveLength(1);
    expect(calls.looks.some((target) => target !== null)).toBe(true);
    expect(calls.looks.at(-1)).toBeNull();
  });

  it('looks at the acting opponent and points at a human, but only looks at a bot', async () => {
    const { view, calls } = createViewWithDealer();
    const human = createState([], false);
    const bot = dealtState();
    view.sync(human, VIEWER_SEAT);

    await view.play({ kind: 'turn', seat: OPPONENT_SEAT, deadline: 0, durationMs: 0 }, human, human, TEST_SPEED);
    expect(calls.points).toHaveLength(1);
    expect(calls.looks.at(-1)).not.toBeNull();

    await view.play({ kind: 'turn', seat: OPPONENT_SEAT, deadline: 0, durationMs: 0 }, bot, bot, TEST_SPEED);
    expect(calls.points).toHaveLength(1);
  });

  it('looks at the viewer own cards when it is the viewer turn', async () => {
    const { view, calls } = createViewWithDealer();
    const state = dealtState();
    view.sync(state, VIEWER_SEAT);

    await view.play({ kind: 'turn', seat: VIEWER_SEAT, deadline: 0, durationMs: 0 }, state, state, TEST_SPEED);

    expect(calls.points).toHaveLength(0);
    const target = calls.looks.at(-1);
    expect(target).not.toBeNull();
    expect(target?.y).toBeGreaterThan(0.75);
  });

  it('nods when a player checks', async () => {
    const { view, calls } = createViewWithDealer();
    const state = dealtState();
    view.sync(state, VIEWER_SEAT);

    await view.play({ kind: 'action', seat: OPPONENT_SEAT, action: 'check', amount: 0, totalBet: 0, timedOut: false }, state, state, TEST_SPEED);

    expect(calls.nods).toBe(1);
  });

  it('shows a callout over the seat for every blind and action', async () => {
    const { view, actions } = createViewWithDealer();
    const state = dealtState();
    view.sync(state, VIEWER_SEAT);

    await view.play({ kind: 'blind', seat: VIEWER_SEAT, amount: 10, blind: 'small' }, state, state, TEST_SPEED);
    await view.play({ kind: 'blind', seat: OPPONENT_SEAT, amount: 20, blind: 'big' }, state, state, TEST_SPEED);
    await view.play({ kind: 'action', seat: VIEWER_SEAT, action: 'raise', amount: 80, totalBet: 100, timedOut: false }, state, state, TEST_SPEED);

    expect(actions).toEqual([
      { seat: VIEWER_SEAT, action: 'smallBlind', amount: 10, totalBet: 10 },
      { seat: OPPONENT_SEAT, action: 'bigBlind', amount: 20, totalBet: 20 },
      { seat: VIEWER_SEAT, action: 'raise', amount: 80, totalBet: 100 },
    ]);
  });

  it('keeps the dealer discreet during a hand and lets him be busy in the waiting room and the lobby', () => {
    const { view, calls } = createViewWithDealer();
    const waiting = { ...dealtState(), phase: 'lobby' as const };
    const lobby = { ...waiting, self: { ...waiting.self, seat: null } };

    view.sync(dealtState(), VIEWER_SEAT);
    view.sync(waiting, VIEWER_SEAT);
    view.sync(lobby, null);

    expect(calls.activities).toEqual(['hand', 'waiting', 'lobby']);
  });

  it('tells the dealer which seats are occupied and whether there is a pot to check', () => {
    const { view, calls } = createViewWithDealer();
    const withPot = { ...dealtState(), pots: [{ amount: 40, eligibleSeats: [VIEWER_SEAT, OPPONENT_SEAT] }] };
    const empty = { ...dealtState(), seats: dealtState().seats.map(() => null) };

    view.sync(withPot, VIEWER_SEAT);
    view.sync(empty, VIEWER_SEAT);

    expect(calls.attentions[0]).toEqual({ seatCount: 2, hasPot: true });
    expect(calls.attentions[1]).toEqual({ seatCount: MAX_SEATS, hasPot: false });
  });

  it('has the dealer welcome the seat of a player who just sat down', async () => {
    const { view, calls } = createViewWithDealer();
    const state = dealtState();
    view.sync(state, VIEWER_SEAT);

    await view.play({ kind: 'playerJoined', seat: OPPONENT_SEAT }, state, state, TEST_SPEED);

    expect(calls.welcomes).toHaveLength(1);
  });

  it('hides the deck on the felt while the dealer holds a deck in his hands', () => {
    const { view, calls } = createViewWithDealer();
    const feltDeck = (view as unknown as { deck: THREE.Group }).deck;

    calls.deckListeners[0](true);
    expect(feltDeck.visible).toBe(false);
    calls.deckListeners[0](false);
    expect(feltDeck.visible).toBe(true);
  });
});

interface StackHarness {
  view: TableView;
  /** Bet, pot and flying stacks the view created, in creation order. */
  createdStacks: StubStack[];
}

function createStackView(): StackHarness {
  const createdStacks: StubStack[] = [];
  const chips = stubChips();
  const deps = {
    stage: {
      tableRoot: new THREE.Group(),
      resetCamera: () => Promise.resolve(),
      shake: () => undefined,
      dramaticZoom: () => Promise.resolve(),
    },
    table: {},
    cards: { createCard: (code: Card | null) => new StubCard(code) },
    chips: {
      ...chips,
      createStack: (amount: number) => {
        const stack = chips.createStack(amount);
        createdStacks.push(stack);
        return stack;
      },
    },
    audio: { play: () => undefined },
    plates: {
      setHandLabel: () => undefined,
      setBetLabel: () => undefined,
      setPotLabel: () => undefined,
      flashWin: () => undefined,
      showAction: () => undefined,
    },
  } as unknown as TableViewDeps;
  return { view: new TableView(deps), createdStacks };
}

/** What each seat's stack on the felt shows right now. */
function stackAmounts(view: TableView): Record<number, number> {
  const stacks = (view as unknown as { playerStacks: { amounts(): Map<number, number> } }).playerStacks;
  return Object.fromEntries(stacks.amounts());
}

/** The given seats sitting with those chips (and street bets); every other seat empty. */
function tableWith(chips: Record<number, number>, bets: Record<number, number> = {}, pots: number[] = []): TableState {
  const state = createState([], false);
  state.seats = state.seats.map((_, seat) =>
    seat in chips ? { ...seatView(seat, null), status: 'active', chips: chips[seat], bet: bets[seat] ?? 0 } : null,
  );
  state.pots = pots.map((amount) => ({ amount, eligibleSeats: Object.keys(chips).map(Number) }));
  return state;
}

describe('TableView player stacks', () => {
  it('rebuilds every stack from the seat chips at once on sync, and clears empty seats', () => {
    const { view } = createStackView();

    view.sync(tableWith({ [VIEWER_SEAT]: 1_500, [OPPONENT_SEAT]: 2_400 }), VIEWER_SEAT);
    expect(stackAmounts(view)).toEqual({ [VIEWER_SEAT]: 1_500, [OPPONENT_SEAT]: 2_400 });

    view.sync(tableWith({ [OPPONENT_SEAT]: 900 }), VIEWER_SEAT);
    expect(stackAmounts(view)).toEqual({ [OPPONENT_SEAT]: 900 });
  });

  it('takes a bet off the player stack and flies it from the top of that stack to the bet spot', async () => {
    const { view, createdStacks } = createStackView();
    const before = tableWith({ [VIEWER_SEAT]: 2_000, [OPPONENT_SEAT]: 2_000 });
    const after = tableWith({ [VIEWER_SEAT]: 1_900, [OPPONENT_SEAT]: 2_000 }, { [VIEWER_SEAT]: 100 });
    view.sync(before, VIEWER_SEAT);

    await view.play({ kind: 'action', seat: VIEWER_SEAT, action: 'bet', amount: 100, totalBet: 100, timedOut: false }, before, after, TEST_SPEED);

    expect(stackAmounts(view)).toEqual({ [VIEWER_SEAT]: 1_900, [OPPONENT_SEAT]: 2_000 });
    const flight = createdStacks.find((stack) => stack.amount === 100 && stack.parent === null);
    expect(flight).toBeDefined();
  });

  it('leaves an empty spot after an all-in', async () => {
    const { view } = createStackView();
    const before = tableWith({ [VIEWER_SEAT]: 2_000, [OPPONENT_SEAT]: 750 });
    const after = tableWith({ [VIEWER_SEAT]: 2_000, [OPPONENT_SEAT]: 0 }, { [OPPONENT_SEAT]: 750 });
    view.sync(before, VIEWER_SEAT);

    await view.play({ kind: 'action', seat: OPPONENT_SEAT, action: 'allIn', amount: 750, totalBet: 750, timedOut: false }, before, after, TEST_SPEED);

    expect(stackAmounts(view)).toEqual({ [VIEWER_SEAT]: 2_000 });
  });

  it('returns an uncalled bet onto its owner stack', async () => {
    const { view } = createStackView();
    const before = tableWith({ [VIEWER_SEAT]: 1_700, [OPPONENT_SEAT]: 1_900 }, { [VIEWER_SEAT]: 300, [OPPONENT_SEAT]: 100 });
    const after = tableWith({ [VIEWER_SEAT]: 1_900, [OPPONENT_SEAT]: 1_900 }, {}, [200]);
    view.sync(before, VIEWER_SEAT);

    await view.play(
      { kind: 'collect', returned: [{ seat: VIEWER_SEAT, amount: 200 }], pots: [{ amount: 200, eligibleSeats: [VIEWER_SEAT, OPPONENT_SEAT] }] },
      before,
      after,
      TEST_SPEED,
    );

    expect(stackAmounts(view)).toEqual({ [VIEWER_SEAT]: 1_900, [OPPONENT_SEAT]: 1_900 });
  });

  it('drops each share of a split pot onto its winner stack', async () => {
    const { view } = createStackView();
    const before = tableWith({ [VIEWER_SEAT]: 500, [OPPONENT_SEAT]: 700 }, {}, [1_000]);
    const after = tableWith({ [VIEWER_SEAT]: 1_000, [OPPONENT_SEAT]: 1_200 });
    const split = [
      { seat: VIEWER_SEAT, amount: 500, handName: null, bestFive: [] },
      { seat: OPPONENT_SEAT, amount: 500, handName: null, bestFive: [] },
    ];
    view.sync(before, VIEWER_SEAT);

    await view.play({ kind: 'award', showdown: false, awards: [{ potIndex: 0, amount: 1_000, winners: split }] }, before, after, TEST_SPEED);

    expect(stackAmounts(view)).toEqual({ [VIEWER_SEAT]: 1_000, [OPPONENT_SEAT]: 1_200 });
  });

  it('hands the pot over without a flight under reduced motion', async () => {
    const { view, createdStacks } = createStackView();
    const before = tableWith({ [VIEWER_SEAT]: 500, [OPPONENT_SEAT]: 700 }, {}, [400]);
    const after = tableWith({ [VIEWER_SEAT]: 900, [OPPONENT_SEAT]: 700 });
    view.setReducedMotion(true);
    view.sync(before, VIEWER_SEAT);
    const pot = createdStacks[createdStacks.length - 1];
    const potSpot = pot.position.clone();

    await view.play(
      { kind: 'award', showdown: false, awards: [{ potIndex: 0, amount: 400, winners: [{ seat: VIEWER_SEAT, amount: 400, handName: null, bestFive: [] }] }] },
      before,
      after,
      TEST_SPEED,
    );

    expect(pot.parent).toBeNull();
    expect(pot.position.equals(potSpot)).toBe(true);
    expect(stackAmounts(view)).toEqual({ [VIEWER_SEAT]: 900, [OPPONENT_SEAT]: 700 });
  });

  it('updates the stacks without animation when players join, rebuy and leave', async () => {
    const { view } = createStackView();
    const alone = tableWith({ [VIEWER_SEAT]: 2_000 });
    const joined = tableWith({ [VIEWER_SEAT]: 2_000, [OPPONENT_SEAT]: 2_000 });
    const busted = tableWith({ [VIEWER_SEAT]: 4_000, [OPPONENT_SEAT]: 0 });
    const rebought = tableWith({ [VIEWER_SEAT]: 4_000, [OPPONENT_SEAT]: 2_000 });
    const left = tableWith({ [VIEWER_SEAT]: 4_000 });
    view.sync(alone, VIEWER_SEAT);

    await view.play({ kind: 'playerJoined', seat: OPPONENT_SEAT }, alone, joined, TEST_SPEED);
    expect(stackAmounts(view)).toEqual({ [VIEWER_SEAT]: 2_000, [OPPONENT_SEAT]: 2_000 });

    view.sync(busted, VIEWER_SEAT);
    expect(stackAmounts(view)).toEqual({ [VIEWER_SEAT]: 4_000 });

    await view.play({ kind: 'rebuy', seat: OPPONENT_SEAT, amount: 2_000 }, busted, rebought, TEST_SPEED);
    expect(stackAmounts(view)).toEqual({ [VIEWER_SEAT]: 4_000, [OPPONENT_SEAT]: 2_000 });

    await view.play({ kind: 'playerLeft', seat: OPPONENT_SEAT }, rebought, left, TEST_SPEED);
    expect(stackAmounts(view)).toEqual({ [VIEWER_SEAT]: 4_000 });
  });

  it('stacks the small blind on the dealer button when heads-up gives one seat both', async () => {
    const { view } = createStackView();
    const state = tableWith({ [VIEWER_SEAT]: 2_000, [OPPONENT_SEAT]: 2_000 });
    view.sync(state, VIEWER_SEAT);

    await view.play({ kind: 'handStart', handNumber: 2, dealerSeat: VIEWER_SEAT, smallBlindSeat: VIEWER_SEAT, bigBlindSeat: OPPONENT_SEAT }, state, state, TEST_SPEED);

    const pucks = (view as unknown as { pucks: Record<'dealer' | 'smallBlind', THREE.Mesh> }).pucks;
    expect(pucks.smallBlind.position.x).toBeCloseTo(pucks.dealer.position.x, 6);
    expect(pucks.smallBlind.position.z).toBeCloseTo(pucks.dealer.position.z, 6);
    expect(pucks.smallBlind.position.y).toBeGreaterThan(pucks.dealer.position.y + 0.009);
  });
});

interface PlayerStacksProbe {
  amounts(): Map<number, number>;
  amountOf(seat: number): number;
  heightOf(seat: number): number;
  chipsOf(seat: number): ChipPlacement[];
}

function playerStacksOf(view: TableView): PlayerStacksProbe {
  return (view as unknown as { playerStacks: PlayerStacksProbe }).playerStacks;
}

function betStacksOf(view: TableView): Map<number, StubStack> {
  return (view as unknown as { betStacks: Map<number, StubStack> }).betStacks;
}

/** The timeline of the play just started, paused before its first frame so the test moves its playhead. */
function takeOverTimeline(view: TableView): gsap.core.Timeline {
  const running = (view as unknown as { running: Set<{ timeline: gsap.core.Timeline }> }).running;
  const timeline = [...running][running.size - 1].timeline;
  timeline.pause();
  return timeline;
}

/** Steps the playhead forward until `changed` holds; returns that time (Infinity if it never does, even at the end). */
function firstTimeWhen(timeline: gsap.core.Timeline, changed: () => boolean, step = 0.01): number {
  const steps = Math.ceil(timeline.duration() / step);
  for (let index = 0; index <= steps; index++) {
    const time = Math.min(index * step, timeline.duration());
    timeline.time(time);
    if (changed()) return time;
  }
  return Infinity;
}

/** From here on only the animation itself can change the stacks: the end-of-play reconciliation is switched off. */
function withoutReconciliation(view: TableView): void {
  vi.spyOn(view as unknown as { reconcilePlayerStacks: () => void }, 'reconcilePlayerStacks').mockImplementation(() => undefined);
}

function stackSpot(seat: number): THREE.Vector3 {
  const anchor = getSeatAnchor(slotForSeat(seat, VIEWER_SEAT));
  return new THREE.Vector3(anchor.stack.x, FELT_Y, anchor.stack.z);
}

describe('TableView player stacks, frame by frame', () => {
  it('lifts the bet off the top of the stack, which shrinks the moment the chips leave and not when they land', async () => {
    const { view, createdStacks } = createStackView();
    const before = tableWith({ [VIEWER_SEAT]: 2_000, [OPPONENT_SEAT]: 2_000 });
    const after = tableWith({ [VIEWER_SEAT]: 1_800, [OPPONENT_SEAT]: 2_000 }, { [VIEWER_SEAT]: 200 });
    view.sync(before, VIEWER_SEAT);
    const topBefore = stackSpot(VIEWER_SEAT).setY(FELT_Y + playerStacksOf(view).heightOf(VIEWER_SEAT));

    withoutReconciliation(view);
    const playing = view.play({ kind: 'action', seat: VIEWER_SEAT, action: 'raise', amount: 200, totalBet: 200, timedOut: false }, before, after, 1);
    const timeline = takeOverTimeline(view);
    const flight = createdStacks[createdStacks.length - 1];
    expect(flight.amount).toBe(200);
    expect(flight.position.distanceTo(topBefore)).toBeLessThan(1e-9);

    timeline.time(0.001);
    expect(playerStacksOf(view).amountOf(VIEWER_SEAT)).toBe(1_800);
    const landing = firstTimeWhen(timeline, () => betStacksOf(view).has(VIEWER_SEAT));
    expect(landing).toBeGreaterThan(0.3);
    expect(landing).toBeLessThan(Infinity);
    expect(flight.parent).toBeNull();
    await playing;
  });

  it('grows each winner stack by its pot exactly when that pot lands on it', async () => {
    const { view, createdStacks } = createStackView();
    const before = tableWith({ [VIEWER_SEAT]: 500, [OPPONENT_SEAT]: 700 }, {}, [600, 200]);
    const after = tableWith({ [VIEWER_SEAT]: 700, [OPPONENT_SEAT]: 1_300 });
    view.sync(before, VIEWER_SEAT);
    const [mainPot, sidePot] = createdStacks.slice(-2);
    withoutReconciliation(view);

    const playing = view.play(
      {
        kind: 'award',
        showdown: false,
        awards: [
          { potIndex: 0, amount: 600, winners: [{ seat: OPPONENT_SEAT, amount: 600, handName: null, bestFive: [] }] },
          { potIndex: 1, amount: 200, winners: [{ seat: VIEWER_SEAT, amount: 200, handName: null, bestFive: [] }] },
        ],
      },
      before,
      after,
      1,
    );
    const timeline = takeOverTimeline(view);
    const distanceTo = (stack: StubStack, seat: number): number =>
      Math.hypot(stack.position.x - stackSpot(seat).x, stack.position.z - stackSpot(seat).z);
    let mainPotDistance = Infinity;
    const mainLanded = firstTimeWhen(timeline, () => {
      if (mainPot.parent) mainPotDistance = distanceTo(mainPot, OPPONENT_SEAT);
      return playerStacksOf(view).amountOf(OPPONENT_SEAT) !== 700;
    });

    expect(playerStacksOf(view).amountOf(OPPONENT_SEAT)).toBe(1_300);
    expect(playerStacksOf(view).amountOf(VIEWER_SEAT)).toBe(500);
    expect(mainPotDistance).toBeLessThan(0.05);
    expect(mainPot.parent).toBeNull();
    expect(mainLanded).toBeGreaterThan(1);

    let sidePotDistance = Infinity;
    firstTimeWhen(timeline, () => {
      if (sidePot.parent) sidePotDistance = distanceTo(sidePot, VIEWER_SEAT);
      return playerStacksOf(view).amountOf(VIEWER_SEAT) !== 500;
    });
    expect(playerStacksOf(view).amountOf(VIEWER_SEAT)).toBe(700);
    expect(sidePotDistance).toBeLessThan(0.05);
    await playing;
  });

  it('returns an uncalled bet into its owner stack as it lands', async () => {
    const { view, createdStacks } = createStackView();
    const before = tableWith({ [VIEWER_SEAT]: 1_700, [OPPONENT_SEAT]: 1_900 }, { [VIEWER_SEAT]: 300, [OPPONENT_SEAT]: 100 });
    const after = tableWith({ [VIEWER_SEAT]: 1_900, [OPPONENT_SEAT]: 1_900 }, {}, [200]);
    view.sync(before, VIEWER_SEAT);

    const playing = view.play(
      { kind: 'collect', returned: [{ seat: VIEWER_SEAT, amount: 200 }], pots: [{ amount: 200, eligibleSeats: [VIEWER_SEAT, OPPONENT_SEAT] }] },
      before,
      after,
      1,
    );
    withoutReconciliation(view);
    const timeline = takeOverTimeline(view);
    const refund = createdStacks.find((stack) => stack.amount === 200 && stack.parent !== null);
    let refundDistance = Infinity;
    const returned = firstTimeWhen(timeline, () => {
      if (refund?.parent) refundDistance = Math.hypot(refund.position.x - stackSpot(VIEWER_SEAT).x, refund.position.z - stackSpot(VIEWER_SEAT).z);
      return playerStacksOf(view).amountOf(VIEWER_SEAT) !== 1_700;
    });

    expect(refund).toBeDefined();
    expect(playerStacksOf(view).amountOf(VIEWER_SEAT)).toBe(1_900);
    expect(returned).toBeGreaterThan(0.3);
    expect(refundDistance).toBeLessThan(0.05);
    expect(refund?.parent).toBeNull();
    await playing;
  });

  it('pushes the very chips of the stack onto the bet spot on an all-in and keeps them there as the bet', async () => {
    const { view, createdStacks } = createStackView();
    const before = tableWith({ [VIEWER_SEAT]: 2_000, [OPPONENT_SEAT]: 750 });
    const after = tableWith({ [VIEWER_SEAT]: 2_000, [OPPONENT_SEAT]: 0 }, { [OPPONENT_SEAT]: 750 });
    view.sync(before, VIEWER_SEAT);
    const chipsOnFelt = playerStacksOf(view).chipsOf(OPPONENT_SEAT);
    withoutReconciliation(view);

    const playing = view.play({ kind: 'action', seat: OPPONENT_SEAT, action: 'allIn', amount: 750, totalBet: 750, timedOut: false }, before, after, 1);
    const timeline = takeOverTimeline(view);
    const pushed = createdStacks[createdStacks.length - 1];
    expect(pushed.shownChips).toEqual(chipsOnFelt);
    expect(pushed.position.distanceTo(stackSpot(OPPONENT_SEAT))).toBeLessThan(1e-9);
    expect(pushed.rotation.y).toBeCloseTo(getSeatAnchor(slotForSeat(OPPONENT_SEAT, VIEWER_SEAT)).stackYaw, 9);

    timeline.time(0.001);
    expect(playerStacksOf(view).amountOf(OPPONENT_SEAT)).toBe(0);
    timeline.progress(1);
    await playing;

    const betSpot = getSeatAnchor(slotForSeat(OPPONENT_SEAT, VIEWER_SEAT)).bet;
    expect(betStacksOf(view).get(OPPONENT_SEAT)).toBe(pushed);
    expect(pushed.parent).not.toBeNull();
    expect(Math.hypot(pushed.position.x - betSpot.x, pushed.position.z - betSpot.z)).toBeLessThan(1e-6);
    expect(pushed.amount).toBe(750);
  });

  it('gathers a blind already in front of the player into the pushed stack', async () => {
    const { view, createdStacks } = createStackView();
    const before = tableWith({ [VIEWER_SEAT]: 2_000, [OPPONENT_SEAT]: 730 }, { [OPPONENT_SEAT]: 20 });
    const after = tableWith({ [VIEWER_SEAT]: 2_000, [OPPONENT_SEAT]: 0 }, { [OPPONENT_SEAT]: 750 });
    view.sync(before, VIEWER_SEAT);
    const blind = betStacksOf(view).get(OPPONENT_SEAT);

    await view.play({ kind: 'action', seat: OPPONENT_SEAT, action: 'allIn', amount: 730, totalBet: 750, timedOut: false }, before, after, TEST_SPEED);

    const bet = betStacksOf(view).get(OPPONENT_SEAT);
    expect(bet).toBe(createdStacks[createdStacks.length - 1]);
    expect(bet?.amount).toBe(750);
    expect(bet?.shownChips).toEqual(playerStackChips(750, OPPONENT_SEAT));
    expect(blind?.parent).toBeNull();
  });

  it('lets a sync in the middle of a bet win over the killed play and leaves no flying chips behind', async () => {
    const { view, createdStacks } = createStackView();
    const before = tableWith({ [VIEWER_SEAT]: 2_000, [OPPONENT_SEAT]: 2_000 });
    const after = tableWith({ [VIEWER_SEAT]: 1_800, [OPPONENT_SEAT]: 2_000 }, { [VIEWER_SEAT]: 200 });
    view.sync(before, VIEWER_SEAT);

    const playing = view.play({ kind: 'action', seat: VIEWER_SEAT, action: 'raise', amount: 200, totalBet: 200, timedOut: false }, before, after, 1);
    const timeline = takeOverTimeline(view);
    const flight = createdStacks[createdStacks.length - 1];
    timeline.time(0.1);
    view.sync(tableWith({ [VIEWER_SEAT]: 3_000, [OPPONENT_SEAT]: 1_000 }), VIEWER_SEAT);
    await playing;

    expect(stackAmounts(view)).toEqual({ [VIEWER_SEAT]: 3_000, [OPPONENT_SEAT]: 1_000 });
    expect(flight.parent).toBeNull();
    expect(betStacksOf(view).size).toBe(0);
  });

  it('drops a half-pushed all-in stack when a sync interrupts it', async () => {
    const { view, createdStacks } = createStackView();
    const before = tableWith({ [VIEWER_SEAT]: 2_000, [OPPONENT_SEAT]: 750 });
    const after = tableWith({ [VIEWER_SEAT]: 2_000, [OPPONENT_SEAT]: 0 }, { [OPPONENT_SEAT]: 750 });
    view.sync(before, VIEWER_SEAT);

    const playing = view.play({ kind: 'action', seat: OPPONENT_SEAT, action: 'allIn', amount: 750, totalBet: 750, timedOut: false }, before, after, 1);
    const timeline = takeOverTimeline(view);
    const pushed = createdStacks[createdStacks.length - 1];
    timeline.time(0.2);
    view.sync(before, VIEWER_SEAT);
    await playing;

    expect(pushed.parent).toBeNull();
    expect(stackAmounts(view)).toEqual({ [VIEWER_SEAT]: 2_000, [OPPONENT_SEAT]: 750 });
  });

  it('never grows the winner of an award that a sync interrupted', async () => {
    const { view } = createStackView();
    const before = tableWith({ [VIEWER_SEAT]: 500, [OPPONENT_SEAT]: 700 }, {}, [600]);
    const after = tableWith({ [VIEWER_SEAT]: 500, [OPPONENT_SEAT]: 1_300 });
    view.sync(before, VIEWER_SEAT);

    const playing = view.play(
      { kind: 'award', showdown: false, awards: [{ potIndex: 0, amount: 600, winners: [{ seat: OPPONENT_SEAT, amount: 600, handName: null, bestFive: [] }] }] },
      before,
      after,
      1,
    );
    const timeline = takeOverTimeline(view);
    timeline.time(0.3);
    view.sync(tableWith({ [VIEWER_SEAT]: 900, [OPPONENT_SEAT]: 300 }), VIEWER_SEAT);
    await playing;

    expect(stackAmounts(view)).toEqual({ [VIEWER_SEAT]: 900, [OPPONENT_SEAT]: 300 });
    // Killed: detached from GSAP's root timeline, so no later frame can reach its landing and settling callbacks.
    expect(timeline.parent).toBeNull();
  });
});
