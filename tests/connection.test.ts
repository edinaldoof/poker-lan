import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Connection } from '../src/client/net/Connection';
import type { LobbyProfile } from '../src/client/ui/Lobby';
import { DEFAULT_CONFIG, type GameEvent, type JoinResponse, type TableUpdate } from '../src/shared/protocol';

type Listener = (...args: unknown[]) => void;
type JoinAcknowledge = (error: Error | null, response?: JoinResponse) => void;

const MICROTASK_TURNS = 20;
const SEATED_AT = 4;

/** Stand-in for the socket.io client socket: the tests play the server's side by hand. */
class FakeClientSocket {
  connected = false;
  readonly emitted: { event: string; payload: unknown }[] = [];
  private readonly listeners = new Map<string, Listener[]>();
  private readonly pendingJoinAcknowledgements: JoinAcknowledge[] = [];

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
    );
    return this;
  }

  emit(event: string, payload?: unknown): boolean {
    this.emitted.push({ event, payload });
    return true;
  }

  timeout(): { emit: (event: string, payload: unknown, acknowledge: JoinAcknowledge) => void } {
    return {
      emit: (event, payload, acknowledge) => {
        this.emitted.push({ event, payload });
        this.pendingJoinAcknowledgements.push(acknowledge);
      },
    };
  }

  connect(): this {
    return this;
  }

  receive(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  serverAccepts(): void {
    this.connected = true;
    this.receive('connect');
  }

  serverDrops(reason = 'transport close'): void {
    this.connected = false;
    this.receive('disconnect', reason);
  }

  answerJoin(response: JoinResponse | null): void {
    const acknowledge = this.pendingJoinAcknowledgements.shift();
    if (response === null) acknowledge?.(new Error('timeout'));
    else acknowledge?.(null, response);
  }

  joinRequests(): number {
    return this.emitted.filter((entry) => entry.event === 'table:join').length;
  }
}

const holder = vi.hoisted(() => ({ socket: null as unknown }));

vi.mock('socket.io-client', () => ({ io: () => holder.socket }));

const PROFILE: LobbyProfile = { name: 'Ana', color: '#ff0000', avatar: 'fox' };
const JOINED: JoinResponse = { ok: true, playerId: 'player-1', seat: SEATED_AT, spectator: false };

function createUpdate(seq: number, event: GameEvent, seat: number | null): TableUpdate {
  return {
    seq,
    serverTime: 1_000 + seq,
    event,
    narration: null,
    state: {
      phase: 'running',
      handNumber: 3,
      street: 'flop',
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
      self: { playerId: seat === null ? null : 'player-1', seat, isSpectator: seat === null, legal: null, handName: null },
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < MICROTASK_TURNS; turn += 1) {
    await Promise.resolve();
  }
}

interface Setup {
  socket: FakeClientSocket;
  connection: Connection;
  updates: TableUpdate[];
  errors: string[];
}

function createConnection(): Setup {
  const socket = new FakeClientSocket();
  holder.socket = socket;
  const connection = new Connection();
  const updates: TableUpdate[] = [];
  const errors: string[] = [];
  connection.onUpdate((update) => updates.push(update));
  connection.onError((message) => errors.push(message));
  return { socket, connection, updates, errors };
}

async function seatPlayer({ socket, connection }: Setup): Promise<void> {
  socket.serverAccepts();
  const joined = connection.join(PROFILE);
  await flushMicrotasks();
  socket.answerJoin(JOINED);
  await joined;
}

describe('Connection', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delivers the snapshot of a fresh connection while nobody is reclaiming a seat', () => {
    const { socket, updates } = createConnection();
    socket.serverAccepts();

    socket.receive('table:update', createUpdate(10, { kind: 'snapshot' }, null));

    expect(updates.map((update) => update.event.kind)).toEqual(['snapshot']);
  });

  it('never shows the anonymous snapshot to a seated player who reconnects, only the reclaimed state', async () => {
    const setup = createConnection();
    const { socket, updates } = setup;
    await seatPlayer(setup);
    socket.serverDrops();

    socket.serverAccepts();
    socket.receive('table:update', createUpdate(10, { kind: 'snapshot' }, null));
    expect(socket.joinRequests()).toBe(2);
    socket.answerJoin(JOINED);
    await flushMicrotasks();
    socket.receive('table:update', createUpdate(11, { kind: 'info' }, SEATED_AT));

    expect(updates.map((update) => update.event.kind)).toEqual(['info']);
    expect(updates[0].state.self.seat).toBe(SEATED_AT);
  });

  it('lets updates that are not snapshots through while the seat is being reclaimed', async () => {
    const setup = createConnection();
    const { socket, updates } = setup;
    await seatPlayer(setup);
    socket.serverDrops();
    socket.serverAccepts();

    socket.receive('table:update', createUpdate(12, { kind: 'info' }, SEATED_AT));

    expect(updates).toHaveLength(1);
  });

  it('falls back to the held snapshot and reports the error when the seat cannot be reclaimed', async () => {
    const setup = createConnection();
    const { socket, updates, errors } = setup;
    await seatPlayer(setup);
    socket.serverDrops();
    socket.serverAccepts();
    socket.receive('table:update', createUpdate(10, { kind: 'snapshot' }, null));

    socket.answerJoin({ ok: false, error: 'A mesa foi reiniciada.' });
    await flushMicrotasks();

    expect(updates.map((update) => update.event.kind)).toEqual(['snapshot']);
    expect(errors).toEqual(['A mesa foi reiniciada.']);
  });

  it('ignores the answer of a rejoin attempt that a newer connection already replaced', async () => {
    const setup = createConnection();
    const { socket, updates, errors } = setup;
    await seatPlayer(setup);
    socket.serverDrops();
    socket.serverAccepts();
    socket.serverDrops();
    socket.serverAccepts();
    socket.receive('table:update', createUpdate(10, { kind: 'snapshot' }, null));

    socket.answerJoin(null);
    await flushMicrotasks();
    expect(updates).toHaveLength(0);
    expect(errors).toEqual([]);

    socket.answerJoin(JOINED);
    await flushMicrotasks();
    expect(updates).toHaveLength(0);
  });

  it('shows the held snapshot when the player leaves before the rejoin is answered', async () => {
    const setup = createConnection();
    const { socket, connection, updates } = setup;
    await seatPlayer(setup);
    socket.serverDrops();
    socket.serverAccepts();
    socket.receive('table:update', createUpdate(10, { kind: 'snapshot' }, null));

    connection.leave();
    socket.answerJoin(JOINED);
    await flushMicrotasks();

    expect(updates.map((update) => update.event.kind)).toEqual(['snapshot']);
  });

  it('does not wait for a rejoin after the player left the table', async () => {
    const setup = createConnection();
    const { socket, connection, updates } = setup;
    await seatPlayer(setup);
    connection.leave();
    socket.serverDrops();

    socket.serverAccepts();
    socket.receive('table:update', createUpdate(10, { kind: 'snapshot' }, null));

    expect(socket.joinRequests()).toBe(1);
    expect(updates.map((update) => update.event.kind)).toEqual(['snapshot']);
  });
});
