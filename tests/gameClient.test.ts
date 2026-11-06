import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameClient, type GameClientDeps } from '../src/client/GameClient';
import {
  DEFAULT_CONFIG,
  type GameEvent,
  type HandSummary,
  type Narration,
  type SelfView,
  type TableUpdate,
  type TableView as TableState,
} from '../src/shared/protocol';

// Enough microtask turns for the queue to settle across its internal awaits.
const MICROTASK_TURNS = 20;

const BLIND_EVENT: GameEvent = { kind: 'blind', seat: 0, amount: 10, blind: 'small' };
const ACTION_EVENT: GameEvent = { kind: 'action', seat: 0, action: 'check', amount: 0, totalBet: 0, timedOut: false };
const COLLECT_EVENT: GameEvent = { kind: 'collect', returned: [], pots: [] };
const INFO_EVENT: GameEvent = { kind: 'info' };

interface PlayCall {
  event: GameEvent;
  previous: TableState;
  next: TableState;
  speed: number;
}

interface RecordedCalls {
  plays: PlayCall[];
  syncs: { state: TableState; viewerSeat: number | null }[];
  renders: TableState[];
  plateUpdates: TableState[];
  announcements: Narration[];
  announcementTimes: (number | undefined)[];
  spoken: { text: string; priority: 1 | 2 }[];
  summaries: HandSummary[];
  backlogs: unknown[];
  cameraResets: number;
  bubbleLines: Narration[];
  bubbleClears: number;
}

interface HarnessOptions {
  withBubble?: boolean;
  bubbleThrows?: boolean;
}

interface Harness {
  client: GameClient;
  calls: RecordedCalls;
  maxConcurrentPlays: () => number;
}

function seatedSelf(seat: number): SelfView {
  return { playerId: 'player-1', seat, isSpectator: false, legal: null, handName: null };
}

function createState(overrides: Partial<TableState> = {}): TableState {
  return {
    phase: 'running',
    handNumber: 1,
    street: 'preflop',
    seats: [],
    dealerSeat: null,
    smallBlindSeat: null,
    bigBlindSeat: null,
    community: [],
    pots: [],
    currentBet: 0,
    actingSeat: null,
    turnDeadline: null,
    turnDurationMs: 0,
    config: DEFAULT_CONFIG,
    lanUrls: [],
    self: seatedSelf(0),
    ...overrides,
  };
}

function createUpdate(
  seq: number,
  event: GameEvent = INFO_EVENT,
  options: { serverTime?: number; narration?: Narration; state?: TableState } = {},
): TableUpdate {
  return {
    seq,
    serverTime: options.serverTime ?? Date.now(),
    event,
    narration: options.narration ?? null,
    state: options.state ?? createState(),
  };
}

function createSummary(handNumber: number): HandSummary {
  return { handNumber, board: [], potTotal: 10, winners: [] };
}

function createGates(): { wait: () => Promise<void>; openNext: () => void } {
  const resolvers: (() => void)[] = [];
  return {
    wait: () => new Promise<void>((resolve) => resolvers.push(resolve)),
    openNext: () => {
      resolvers.shift()?.();
    },
  };
}

function createHarness(onPlay?: (event: GameEvent) => Promise<void> | void, options: HarnessOptions = {}): Harness {
  const calls: RecordedCalls = {
    plays: [],
    syncs: [],
    renders: [],
    plateUpdates: [],
    announcements: [],
    announcementTimes: [],
    spoken: [],
    summaries: [],
    backlogs: [],
    cameraResets: 0,
    bubbleLines: [],
    bubbleClears: 0,
  };
  let concurrentPlays = 0;
  let maxConcurrentPlays = 0;

  const deps = {
    view: {
      sync: (state: TableState, viewerSeat: number | null) => calls.syncs.push({ state, viewerSeat }),
      play: async (event: GameEvent, previous: TableState, next: TableState, speed: number) => {
        calls.plays.push({ event, previous, next, speed });
        concurrentPlays += 1;
        maxConcurrentPlays = Math.max(maxConcurrentPlays, concurrentPlays);
        try {
          await onPlay?.(event);
        } finally {
          concurrentPlays -= 1;
        }
      },
    },
    hud: {
      render: (state: TableState) => calls.renders.push(state),
      announce: (narration: Narration, serverTime?: number) => {
        calls.announcements.push(narration);
        calls.announcementTimes.push(serverTime);
      },
      setBacklog: (backlog: unknown) => calls.backlogs.push(backlog),
      addHandSummary: (summary: HandSummary) => calls.summaries.push(summary),
    },
    plates: { update: (state: TableState) => calls.plateUpdates.push(state) },
    audio: { speak: (text: string, priority: 1 | 2) => calls.spoken.push({ text, priority }) },
    stage: {
      resetCamera: () => {
        calls.cameraResets += 1;
      },
    },
    bubble:
      options.withBubble === false
        ? undefined
        : {
            say: (narration: Narration) => {
              if (options.bubbleThrows === true) throw new Error('bubble exploded');
              calls.bubbleLines.push(narration);
            },
            clear: () => {
              calls.bubbleClears += 1;
            },
          },
  } as unknown as GameClientDeps;

  return { client: new GameClient(deps), calls, maxConcurrentPlays: () => maxConcurrentPlays };
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < MICROTASK_TURNS; turn += 1) {
    await Promise.resolve();
  }
}

interface PageVisibility {
  setHidden: (hidden: boolean) => void;
  visibilityListenerCount: () => number;
}

/** The suite runs in node, so the few document members GameClient touches are faked per test. */
function stubVisiblePage(): PageVisibility {
  const events = new EventTarget();
  let listenerCount = 0;
  const fakeDocument = {
    hidden: false,
    addEventListener: (type: string, listener: () => void) => {
      listenerCount += 1;
      events.addEventListener(type, listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listenerCount -= 1;
      events.removeEventListener(type, listener);
    },
  };
  vi.stubGlobal('document', fakeDocument);
  return {
    setHidden: (hidden) => {
      fakeDocument.hidden = hidden;
      events.dispatchEvent(new Event('visibilitychange'));
    },
    visibilityListenerCount: () => listenerCount,
  };
}

describe('GameClient', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('syncs the view instead of animating on the first update', async () => {
    const { client, calls } = createHarness();

    client.enqueue(createUpdate(1));
    await flushMicrotasks();

    expect(calls.syncs).toHaveLength(1);
    expect(calls.plays).toHaveLength(0);
    expect(calls.renders).toHaveLength(1);
    expect(calls.plateUpdates).toHaveLength(1);
  });

  it('plays updates in seq order, one at a time, even when they arrive shuffled', async () => {
    const gates = createGates();
    const { client, calls, maxConcurrentPlays } = createHarness(() => gates.wait());

    client.enqueue(createUpdate(1));
    client.enqueue(createUpdate(2, BLIND_EVENT));
    await flushMicrotasks();
    client.enqueue(createUpdate(4, COLLECT_EVENT));
    client.enqueue(createUpdate(3, ACTION_EVENT));
    client.enqueue(createUpdate(3, ACTION_EVENT));
    await flushMicrotasks();
    expect(calls.plays.map((call) => call.event.kind)).toEqual(['blind']);

    gates.openNext();
    await flushMicrotasks();
    expect(calls.plays.map((call) => call.event.kind)).toEqual(['blind', 'action']);

    gates.openNext();
    await flushMicrotasks();
    expect(calls.plays.map((call) => call.event.kind)).toEqual(['blind', 'action', 'collect']);

    gates.openNext();
    await flushMicrotasks();
    expect(maxConcurrentPlays()).toBe(1);
    expect(calls.syncs).toHaveLength(1);

    client.enqueue(createUpdate(2));
    await flushMicrotasks();
    expect(calls.plays).toHaveLength(3);
  });

  it('speeds up to 2.5x only while 3 or more updates wait behind the one being shown', async () => {
    const gates = createGates();
    const { client, calls } = createHarness(() => gates.wait());

    client.enqueue(createUpdate(1));
    client.enqueue(createUpdate(2, BLIND_EVENT));
    await flushMicrotasks();
    for (let seq = 3; seq <= 6; seq += 1) {
      client.enqueue(createUpdate(seq, ACTION_EVENT));
    }
    gates.openNext();
    await flushMicrotasks();
    gates.openNext();
    await flushMicrotasks();

    expect(calls.plays.map((call) => call.speed)).toEqual([1, 2.5, 1]);
  });

  it('skips animations and syncs the latest state when 8 or more updates are queued', async () => {
    const gates = createGates();
    const { client, calls } = createHarness(() => gates.wait());

    client.enqueue(createUpdate(1));
    client.enqueue(createUpdate(2, BLIND_EVENT));
    await flushMicrotasks();
    for (let seq = 3; seq <= 12; seq += 1) {
      client.enqueue(createUpdate(seq, ACTION_EVENT, { state: createState({ handNumber: seq }) }));
    }
    gates.openNext();
    await flushMicrotasks();

    expect(calls.plays).toHaveLength(1);
    expect(calls.syncs).toHaveLength(2);
    expect(calls.syncs.at(-1)?.state.handNumber).toBe(12);
    expect(calls.renders.at(-1)?.handNumber).toBe(12);
  });

  it('resyncs to the latest update after a seq gap and still records hand summaries', async () => {
    const { client, calls } = createHarness();
    const summary = createSummary(4);
    const narration: Narration = { text: 'Fim da mão', tone: 'info', priority: 1 };

    client.enqueue(createUpdate(1));
    await flushMicrotasks();
    client.enqueue(createUpdate(2, ACTION_EVENT));
    await flushMicrotasks();
    client.enqueue(createUpdate(5, { kind: 'handEnd', summary }, { narration }));
    await flushMicrotasks();

    expect(calls.syncs).toHaveLength(2);
    expect(calls.plays).toHaveLength(1);
    expect(calls.summaries).toEqual([summary]);
    expect(calls.announcements).toHaveLength(1);
  });

  it('recovers from a throwing animation and keeps the queue moving', async () => {
    const { client, calls } = createHarness((event) => {
      if (event.kind === 'blind') {
        throw new Error('animation exploded');
      }
    });

    client.enqueue(createUpdate(1));
    client.enqueue(createUpdate(2, BLIND_EVENT));
    client.enqueue(createUpdate(3, ACTION_EVENT));
    await flushMicrotasks();

    expect(calls.plays.map((call) => call.event.kind)).toEqual(['blind', 'action']);
    expect(calls.syncs).toHaveLength(2);
    expect(calls.renders).toHaveLength(3);
  });

  it('gives up on an animation that never resolves after 8 s and continues with the queue', async () => {
    vi.useFakeTimers();
    const { client, calls } = createHarness((event) => (event.kind === 'blind' ? new Promise<void>(() => undefined) : undefined));
    client.setInGame(true);

    client.enqueue(createUpdate(1));
    client.enqueue(createUpdate(2, BLIND_EVENT));
    client.enqueue(createUpdate(3, ACTION_EVENT));
    await vi.advanceTimersByTimeAsync(7900);
    expect(calls.plays).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(200);
    expect(calls.plays.map((call) => call.event.kind)).toEqual(['blind', 'action']);
    expect(calls.syncs).toHaveLength(2);
    expect(calls.cameraResets).toBe(1);
  });

  it('renders turn updates immediately without waiting for their animation', async () => {
    const gates = createGates();
    const { client, calls } = createHarness(() => gates.wait());

    client.enqueue(createUpdate(1));
    await flushMicrotasks();
    client.enqueue(createUpdate(2, { kind: 'turn', seat: 1, deadline: 0, durationMs: 1000 }));
    client.enqueue(createUpdate(3, ACTION_EVENT));
    await flushMicrotasks();

    expect(calls.renders).toHaveLength(2);
    expect(calls.plays.map((call) => call.event.kind)).toEqual(['turn', 'action']);
  });

  it('syncs instead of animating when the viewer seat changes, because slots rotate with it', async () => {
    const { client, calls } = createHarness();
    const notSeated: SelfView = { playerId: null, seat: null, isSpectator: false, legal: null, handName: null };

    client.enqueue(createUpdate(1, { kind: 'snapshot' }, { state: createState({ self: notSeated }) }));
    client.enqueue(createUpdate(2, { kind: 'playerJoined', seat: 3 }, { state: createState({ self: seatedSelf(3) }) }));
    await flushMicrotasks();

    expect(calls.syncs).toHaveLength(2);
    expect(calls.syncs[1].viewerSeat).toBe(3);
    expect(calls.plays).toHaveLength(0);
  });

  it('accepts a lower seq again after the sequence is reset (server restart)', async () => {
    const { client, calls } = createHarness();

    client.enqueue(createUpdate(40));
    client.enqueue(createUpdate(41, ACTION_EVENT));
    await flushMicrotasks();
    client.resetSequence();
    client.enqueue(createUpdate(1));
    await flushMicrotasks();

    expect(calls.syncs).toHaveLength(2);
    expect(calls.renders).toHaveLength(3);
  });

  it('discards the result of an animation that was in flight when the sequence was reset', async () => {
    const gates = createGates();
    const { client, calls } = createHarness(() => gates.wait());

    client.enqueue(createUpdate(1));
    client.enqueue(createUpdate(2, BLIND_EVENT));
    await flushMicrotasks();
    client.resetSequence();
    gates.openNext();
    await flushMicrotasks();

    expect(calls.renders).toHaveLength(1);
    expect(calls.plateUpdates).toHaveLength(1);
  });

  it('speaks narration only while seated and skips hand summaries already in the backlog', async () => {
    const { client, calls } = createHarness();
    const narration: Narration = { text: 'Olá', speech: 'Olá falado', tone: 'info', priority: 1 };

    client.enqueue(createUpdate(1, INFO_EVENT, { narration }));
    await flushMicrotasks();
    expect(calls.announcements).toHaveLength(1);
    expect(calls.spoken).toHaveLength(0);

    client.setInGame(true);
    client.setBacklog({ log: [], hands: [createSummary(7)] });
    client.enqueue(createUpdate(2, INFO_EVENT, { narration }));
    client.enqueue(createUpdate(3, { kind: 'handEnd', summary: createSummary(7) }));
    client.enqueue(createUpdate(4, { kind: 'handEnd', summary: createSummary(8) }));
    await flushMicrotasks();

    expect(calls.spoken).toEqual([{ text: 'Olá falado', priority: 1 }]);
    expect(calls.summaries.map((summary) => summary.handNumber)).toEqual([8]);
  });

  it('gives up on the animation in flight as soon as the tab is hidden, without waiting for the timeout', async () => {
    vi.useFakeTimers();
    const page = stubVisiblePage();
    const { client, calls } = createHarness((event) => (event.kind === 'blind' ? new Promise<void>(() => undefined) : undefined));
    client.setInGame(true);

    client.enqueue(createUpdate(1));
    client.enqueue(createUpdate(2, BLIND_EVENT));
    client.enqueue(createUpdate(3, ACTION_EVENT, { state: createState({ handNumber: 3 }) }));
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.plays.map((call) => call.event.kind)).toEqual(['blind']);
    expect(calls.renders).toHaveLength(1);

    page.setHidden(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.plays).toHaveLength(1);
    expect(calls.renders.map((state) => state.handNumber)).toEqual([1, 1, 3]);
    expect(calls.syncs.at(-1)?.state.handNumber).toBe(3);
    expect(calls.cameraResets).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(page.visibilityListenerCount()).toBe(0);
  });

  it('shows the state of an interrupted animation even when nothing else is queued', async () => {
    vi.useFakeTimers();
    const page = stubVisiblePage();
    const { client, calls } = createHarness((event) => (event.kind === 'blind' ? new Promise<void>(() => undefined) : undefined));

    client.enqueue(createUpdate(1));
    client.enqueue(createUpdate(2, BLIND_EVENT, { state: createState({ handNumber: 2 }) }));
    await vi.advanceTimersByTimeAsync(100);
    page.setHidden(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.syncs.map((entry) => entry.state.handNumber)).toEqual([1, 2]);
    expect(calls.renders.map((state) => state.handNumber)).toEqual([1, 2]);
  });

  it('stops listening for visibility changes once the animation has finished', async () => {
    const page = stubVisiblePage();
    const { client, calls } = createHarness();

    client.enqueue(createUpdate(1));
    client.enqueue(createUpdate(2, BLIND_EVENT));
    await flushMicrotasks();

    expect(calls.plays).toHaveLength(1);
    expect(page.visibilityListenerCount()).toBe(0);
  });

  it('announces each narration with the server time of its update, also while catching up', async () => {
    const gates = createGates();
    const { client, calls } = createHarness(() => gates.wait());
    const narration: Narration = { text: 'Rodada', tone: 'info', priority: 2 };

    client.enqueue(createUpdate(1, INFO_EVENT, { narration, serverTime: 1_000 }));
    client.enqueue(createUpdate(2, BLIND_EVENT, { narration, serverTime: 2_000 }));
    await flushMicrotasks();
    for (let seq = 3; seq <= 12; seq += 1) {
      client.enqueue(createUpdate(seq, ACTION_EVENT, { narration, serverTime: seq * 1_000 }));
    }
    gates.openNext();
    await flushMicrotasks();

    expect(calls.announcementTimes).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((seq) => seq * 1_000));
  });

  it('shows each presented narration in the dealer bubble, only while seated', async () => {
    const { client, calls } = createHarness();
    const first: Narration = { text: 'Rodada', tone: 'info', priority: 2 };
    const second: Narration = { text: 'Flop!', tone: 'street', priority: 1 };

    client.enqueue(createUpdate(1, INFO_EVENT, { narration: first }));
    await flushMicrotasks();
    expect(calls.bubbleLines).toHaveLength(0);

    client.setInGame(true);
    client.enqueue(createUpdate(2, INFO_EVENT, { narration: first }));
    client.enqueue(createUpdate(3, INFO_EVENT, { narration: second }));
    await flushMicrotasks();

    expect(calls.bubbleLines).toEqual([first, second]);
  });

  it('shows only the last narration in the bubble while it skips ahead to catch up', async () => {
    const gates = createGates();
    const { client, calls } = createHarness(() => gates.wait());
    client.setInGame(true);

    client.enqueue(createUpdate(1));
    client.enqueue(createUpdate(2, BLIND_EVENT));
    await flushMicrotasks();
    for (let seq = 3; seq <= 12; seq += 1) {
      const narration: Narration = { text: `Linha ${seq}`, tone: 'info', priority: 2 };
      client.enqueue(createUpdate(seq, ACTION_EVENT, { narration }));
    }
    gates.openNext();
    await flushMicrotasks();

    expect(calls.announcements).toHaveLength(10);
    expect(calls.bubbleLines.map((narration) => narration.text)).toEqual(['Linha 12']);
  });

  it('clears the dealer bubble when the player leaves the table', () => {
    const { client, calls } = createHarness();

    client.setInGame(true);
    expect(calls.bubbleClears).toBe(0);

    client.setInGame(false);
    expect(calls.bubbleClears).toBe(1);
  });

  it('keeps presenting updates when the dealer bubble throws', async () => {
    const { client, calls } = createHarness(undefined, { bubbleThrows: true });
    const narration: Narration = { text: 'Olá', tone: 'info', priority: 1 };
    client.setInGame(true);

    client.enqueue(createUpdate(1, INFO_EVENT, { narration }));
    client.enqueue(createUpdate(2, ACTION_EVENT));
    await flushMicrotasks();

    expect(calls.renders).toHaveLength(2);
    expect(calls.spoken).toHaveLength(1);
    expect(console.error).toHaveBeenCalled();
  });

  it('works without a dealer bubble', async () => {
    const { client, calls } = createHarness(undefined, { withBubble: false });
    const narration: Narration = { text: 'Olá', tone: 'info', priority: 1 };
    client.setInGame(true);

    client.enqueue(createUpdate(1, INFO_EVENT, { narration }));
    client.setInGame(false);
    await flushMicrotasks();

    expect(calls.announcements).toEqual([narration]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('computes the clock offset as the median of the last 10 samples', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { client } = createHarness();
    expect(client.serverOffsetMs).toBe(0);

    [100, 100, 100, 5000, 100].forEach((offset, index) => {
      client.enqueue(createUpdate(index + 1, INFO_EVENT, { serverTime: 1_000_000 + offset }));
    });

    expect(client.serverOffsetMs).toBe(100);
  });
});
