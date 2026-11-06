import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'socket.io';
import { GameController } from '../src/server/game/GameController';
import { BotTableMemory } from '../src/server/game/bots/TableMemory';
import {
  PLAYER_AVATARS,
  PLAYER_COLORS,
  type Backlog,
  type ClientToServerEvents,
  type GameEvent,
  type JoinResponse,
  type ServerToClientEvents,
  type TableUpdate,
} from '../src/shared/protocol';

type GameServer = Server<ClientToServerEvents, ServerToClientEvents>;
type Handler = (...args: unknown[]) => void;
type Middleware = (packet: unknown[], next: () => void) => void;

const STEP_MS = 100;
// 1800 (next-hand delay) + 3 x 550 (blinds and deal gap) + 1600 (dealing animation) before the first turn.
const TIME_UNTIL_FIRST_TURN_MS = 5100;
const TURN_SECONDS = 10;
const MAX_SIMULATED_PLAY_MS = 180_000;

/** Minimal stand-in for a socket.io server socket: enough surface for the controller, no network. */
class FakeSocket {
  readonly emitted: { event: string; payload: unknown }[] = [];
  failOnEmit: string | null = null;
  private readonly handlers = new Map<string, Handler>();
  private readonly middlewares: Middleware[] = [];

  constructor(readonly id: string) {}

  on(event: string, handler: Handler): this {
    this.handlers.set(event, handler);
    return this;
  }

  use(middleware: Middleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  emit(event: string, payload?: unknown): boolean {
    if (event === this.failOnEmit) throw new Error('simulated transport failure');
    this.emitted.push({ event, payload });
    return true;
  }

  /** Delivers a client message through the middleware chain, the way socket.io does. */
  receive(event: string, ...args: unknown[]): void {
    const handler = this.handlers.get(event);
    if (!handler) return;
    let middlewareIndex = 0;
    const next = (): void => {
      const middleware = this.middlewares[middlewareIndex];
      middlewareIndex += 1;
      if (middleware) middleware([event, ...args], next);
      else handler(...args);
    };
    next();
  }

  updates(): TableUpdate[] {
    return this.emitted.filter((entry) => entry.event === 'table:update').map((entry) => entry.payload as TableUpdate);
  }

  updatesOfKind(kind: GameEvent['kind']): TableUpdate[] {
    return this.updates().filter((update) => update.event.kind === kind);
  }

  lastUpdate(): TableUpdate {
    const updates = this.updates();
    return updates[updates.length - 1];
  }

  errors(): string[] {
    return this.emitted.filter((entry) => entry.event === 'table:error').map((entry) => entry.payload as string);
  }

  backlogs(): Backlog[] {
    return this.emitted.filter((entry) => entry.event === 'table:backlog').map((entry) => entry.payload as Backlog);
  }
}

class FakeServer {
  readonly sockets = { sockets: new Map<string, FakeSocket>() };
  private connectionHandler: ((socket: FakeSocket) => void) | null = null;

  on(_event: string, handler: (socket: FakeSocket) => void): this {
    this.connectionHandler = handler;
    return this;
  }

  connect(socketId: string): FakeSocket {
    const socket = new FakeSocket(socketId);
    this.sockets.sockets.set(socketId, socket);
    this.connectionHandler?.(socket);
    return socket;
  }

  disconnect(socket: FakeSocket): void {
    this.sockets.sockets.delete(socket.id);
    socket.receive('disconnect');
  }
}

interface Player {
  socket: FakeSocket;
  response: JoinResponse;
  token: string;
}

interface JoinOptions {
  color?: unknown;
  avatar?: unknown;
  token?: string;
}

let server: FakeServer;
let controller: GameController;
let lanUrls: string[];

function sessionToken(socketId: string): string {
  return `session-${socketId}`;
}

function sendJoin(socket: FakeSocket, name: unknown, token: string, options: JoinOptions = {}): JoinResponse {
  let response: JoinResponse | null = null;
  socket.receive(
    'table:join',
    { name, color: options.color ?? PLAYER_COLORS[0], avatar: options.avatar ?? PLAYER_AVATARS[0], token },
    (received: JoinResponse) => {
      response = received;
    },
  );
  if (response === null) throw new Error('The controller never acknowledged the join request.');
  return response;
}

function joinAs(socketId: string, name: unknown, options: JoinOptions = {}): Player {
  const socket = server.connect(socketId);
  const token = options.token ?? sessionToken(socketId);
  return { socket, response: sendJoin(socket, name, token, options), token };
}

function seatNames(update: TableUpdate): string[] {
  return update.state.seats.flatMap((seat) => (seat ? [seat.name] : []));
}

function startGame(host: Player): void {
  host.socket.receive('table:start', { turnSeconds: TURN_SECONDS });
}

function startHeadsUpGame(): { first: Player; second: Player } {
  const first = joinAs('first', 'Ana');
  const second = joinAs('second', 'Bruno');
  startGame(first);
  vi.advanceTimersByTime(TIME_UNTIL_FIRST_TURN_MS);
  return { first, second };
}

function callOrCheckWhenItIsTheirTurn(socket: FakeSocket): void {
  const legal = socket.lastUpdate()?.state.self.legal;
  if (legal) socket.receive('table:action', { type: legal.canCheck ? 'check' : 'call' });
}

function playPassivelyUntil(players: Player[], isDone: () => boolean): void {
  for (let elapsed = 0; elapsed < MAX_SIMULATED_PLAY_MS && !isDone(); elapsed += STEP_MS) {
    vi.advanceTimersByTime(STEP_MS);
    for (const player of players) callOrCheckWhenItIsTheirTurn(player.socket);
  }
}

function actingPlayer(players: Player[]): Player {
  const turn = players[0].socket.updatesOfKind('turn').at(-1)?.event;
  if (turn?.kind !== 'turn') throw new Error('Nobody was asked to act.');
  const acting = players.find((player) => player.response.seat === turn.seat);
  if (!acting) throw new Error(`No player sits at seat ${turn.seat}.`);
  return acting;
}

function otherPlayer(players: Player[], excluded: Player): Player {
  const other = players.find((player) => player !== excluded);
  if (!other) throw new Error('There is no other player.');
  return other;
}

beforeEach(() => {
  vi.useFakeTimers();
  server = new FakeServer();
  lanUrls = ['http://192.168.0.2:3000'];
  controller = new GameController(server as unknown as GameServer, { lanUrls: () => lanUrls });
  controller.attach();
});

afterEach(() => {
  controller.shutdown();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('invite addresses', () => {
  it('shows the address of the network the computer is on now, not the one it started on', () => {
    const host = joinAs('a', 'Ana');
    expect(host.socket.lastUpdate()?.state.lanUrls).toEqual(['http://192.168.0.2:3000']);

    lanUrls = ['http://192.168.3.7:3000'];
    joinAs('b', 'Bruno');

    expect(host.socket.lastUpdate()?.state.lanUrls).toEqual(['http://192.168.3.7:3000']);
  });
});

describe('joining the table', () => {
  it('trims, strips invisible characters and truncates names to 16 characters', () => {
    const player = joinAs('a', '  \u0007​ Ana‮ Maria Clara Santos  ');

    expect(player.response.ok).toBe(true);
    expect(seatNames(player.socket.lastUpdate())).toEqual(['Ana Maria Clara']);
  });

  it('appends a numeric suffix when the name is already taken, ignoring letter case', () => {
    joinAs('a', 'Ana');
    const second = joinAs('b', 'ana');

    expect(seatNames(second.socket.lastUpdate())).toEqual(['Ana', 'ana 2']);
  });

  it.each([
    ['soft hyphen', '­'],
    ['Hangul filler', 'ㅤ'],
    ['Braille blank', '⠀'],
    ['combining grapheme joiner', '͏'],
    ['Arabic letter mark', '؜'],
    ['variation selector', '️'],
    ['tag character', '\u{E0041}'],
  ])('treats a name padded with a %s as the same name as the plain one', (_label, invisible) => {
    joinAs('a', 'Ana');
    const impostor = joinAs('b', `Ana${invisible}`);

    expect(seatNames(impostor.socket.lastUpdate())).toEqual(['Ana', 'Ana 2']);
  });

  it('treats compatibility look-alikes such as full-width letters as a name already taken', () => {
    joinAs('a', 'Ana');
    const lookAlike = joinAs('b', 'Ａｎａ');

    expect(seatNames(lookAlike.socket.lastUpdate())).toEqual(['Ana', 'Ａｎａ 2']);
  });

  // Written as escapes because the whole point is that these letters are indistinguishable from the Latin ones.
  it.each([
    ['a Cyrillic capital A', 'Ana', '\u0410na'],
    ['a Cyrillic small a', 'Ana', 'An\u0430'],
    ['Cyrillic letters in the middle of a name', 'Pedro', '\u0420\u0435dr\u043E'],
    ['Greek capitals standing in for Latin ones', 'Bob', '\u0392\u039F\u0392'],
    ['a Greek alpha and epsilon', 'Eva', '\u0395v\u03B1'],
    ['a Cyrillic letter followed by a combining accent', 'Zé', 'Z\u0435\u0301'],
  ])('treats %s as a name already taken, keeping what was typed plus a suffix', (_label, original, lookalike) => {
    joinAs('a', original);
    const impostor = joinAs('b', lookalike);

    expect(seatNames(impostor.socket.lastUpdate())).toEqual([original, `${lookalike} 2`]);
  });

  it('keeps a genuinely Cyrillic name apart from a Latin one that merely resembles it', () => {
    joinAs('a', 'Ivan');
    const cyrillic = joinAs('b', '\u0418\u0432\u0430\u043D');

    expect(seatNames(cyrillic.socket.lastUpdate())).toEqual(['Ivan', '\u0418\u0432\u0430\u043D']);
  });

  it.each([
    ['a Hangul filler', 'ㅤ'],
    ['a Braille blank', '⠀⠀'],
    ['a soft hyphen', '­'],
    ['a lone combining mark', '́'],
    ['an invisible mix', ' ​ㅤ️ '],
  ])('rejects a name made only of %s without seating anyone', (_label, name) => {
    const blank = joinAs('a', name);

    expect(blank.response.ok).toBe(false);
    expect(seatNames(blank.socket.lastUpdate())).toEqual([]);
  });

  it('keeps accented letters, digits and emoji in names', () => {
    const player = joinAs('a', 'Zé 2 \u{1F600}');

    expect(seatNames(player.socket.lastUpdate())).toEqual(['Zé 2 \u{1F600}']);
  });

  it('falls back to the first colour and avatar when the requested ones are not offered', () => {
    const player = joinAs('a', 'Ana', { color: 'red', avatar: 'not-an-avatar' });

    const seat = player.socket.lastUpdate().state.seats[player.response.seat ?? -1];
    expect(seat?.color).toBe(PLAYER_COLORS[0]);
    expect(seat?.avatar).toBe(PLAYER_AVATARS[0]);
  });

  it('rejects empty names and malformed session tokens without seating anyone', () => {
    const blankName = joinAs('a', '   ');
    const shortToken = joinAs('b', 'Bruno', { token: 'short' });

    expect(blankName.response.ok).toBe(false);
    expect(shortToken.response.ok).toBe(false);
    expect(seatNames(shortToken.socket.lastUpdate())).toEqual([]);
  });

  it('assigns seats in the order 0, 4, 2, 6, 1, 5, 3, 7 and turns the ninth joiner into a spectator', () => {
    const players = Array.from({ length: 9 }, (_, index) => joinAs(`p${index}`, `Jogador ${index}`));

    expect(players.slice(0, 8).map((player) => player.response.seat)).toEqual([0, 4, 2, 6, 1, 5, 3, 7]);
    expect(players[8].response).toMatchObject({ ok: true, seat: null, spectator: true });
  });

  it('keeps spectators from acting', () => {
    const players = Array.from({ length: 9 }, (_, index) => joinAs(`p${index}`, `Jogador ${index}`));
    const spectator = players[8];

    spectator.socket.receive('table:action', { type: 'fold' });

    expect(spectator.socket.errors()).toEqual(['Você está assistindo e não pode jogar.']);
  });

  it('lets a returning session token reclaim the same seat and player id', () => {
    const original = joinAs('a', 'Ana');
    server.disconnect(original.socket);

    const returning = joinAs('a-again', 'Outro Nome', { token: original.token });

    expect(returning.response).toMatchObject({
      ok: true,
      playerId: original.response.playerId,
      seat: original.response.seat,
      spectator: false,
    });
    expect(seatNames(returning.socket.lastUpdate())).toEqual(['Ana']);
  });

  it('answers a repeated join from an already seated socket without broadcasting to the table', () => {
    const first = joinAs('a', 'Ana');
    const second = joinAs('b', 'Bruno');
    const updatesBefore = second.socket.updates().length;
    const backlogsBefore = first.socket.backlogs().length;

    const response = sendJoin(first.socket, 'Ana', first.token);

    expect(response).toMatchObject({ ok: true, seat: first.response.seat });
    expect(second.socket.updates()).toHaveLength(updatesBefore);
    expect(first.socket.backlogs()).toHaveLength(backlogsBefore + 1);
  });

  it('still tells the table when a player returns on a new connection while the old one lingers', () => {
    const first = joinAs('a', 'Ana');
    const second = joinAs('b', 'Bruno');
    const updatesBefore = second.socket.updates().length;

    const returning = joinAs('a-again', 'Ana', { token: first.token });

    expect(returning.response).toMatchObject({ ok: true, seat: first.response.seat });
    expect(returning.socket.lastUpdate().state.self.seat).toBe(first.response.seat);
    expect(second.socket.updates().length).toBeGreaterThan(updatesBefore);
  });

  it('turns joiners beyond the spectator limit away without disturbing anyone already there', () => {
    const seated = Array.from({ length: 8 }, (_, index) => joinAs(`p${index}`, `Jogador ${index}`));
    const spectators = Array.from({ length: 16 }, (_, index) => joinAs(`s${index}`, `Plateia ${index}`));

    const overflow = joinAs('overflow', 'Atrasado');

    expect(spectators.every((spectator) => spectator.response.ok)).toBe(true);
    expect(overflow.response).toMatchObject({ ok: false });
    expect(seated[0].socket.lastUpdate().state.seats.filter(Boolean)).toHaveLength(8);
  });

  it('lets players and spectators already known to the table back in when the spectator limit is full', () => {
    const seated = Array.from({ length: 8 }, (_, index) => joinAs(`p${index}`, `Jogador ${index}`));
    const spectators = Array.from({ length: 16 }, (_, index) => joinAs(`s${index}`, `Plateia ${index}`));
    server.disconnect(seated[3].socket);
    const watcher = spectators[0];

    const returning = joinAs('p3-again', 'Jogador 3', { token: seated[3].token });
    const watcherResponse = sendJoin(watcher.socket, 'Plateia 0', watcher.token);

    expect(returning.response).toMatchObject({ ok: true, seat: seated[3].response.seat });
    expect(watcherResponse).toMatchObject({ ok: true, spectator: true });
  });

  it('frees the spectator slot when a spectator leaves', () => {
    Array.from({ length: 8 }, (_, index) => joinAs(`p${index}`, `Jogador ${index}`));
    const spectators = Array.from({ length: 16 }, (_, index) => joinAs(`s${index}`, `Plateia ${index}`));
    server.disconnect(spectators[0].socket);

    const replacement = joinAs('replacement', 'Substituto');

    expect(replacement.response).toMatchObject({ ok: true, spectator: true });
  });

  it('sends the narration backlog to the joiner', () => {
    joinAs('a', 'Ana');
    const second = joinAs('b', 'Bruno');

    const [backlog] = second.socket.backlogs();
    expect(backlog.log.map((entry) => entry.text)).toContain('Ana entrou na mesa.');
  });

  it('acknowledges a join only once even when announcing the arrival fails', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const socket = server.connect('a');
    socket.failOnEmit = 'table:backlog';
    const acknowledge = vi.fn();

    socket.receive(
      'table:join',
      { name: 'Ana', color: PLAYER_COLORS[0], avatar: PLAYER_AVATARS[0], token: sessionToken('a') },
      acknowledge,
    );

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledWith(expect.objectContaining({ ok: true, seat: 0 }));
  });
});

describe('host controls', () => {
  it('refuses host controls from connections that have not taken a seat', () => {
    const observer = server.connect('observer');

    observer.receive('table:addBot');

    expect(observer.errors()).toEqual(['Apenas jogadores sentados à mesa podem fazer isso.']);
  });

  it('seats bots with distinct "(Bot)" names, avatars and colours', () => {
    const host = joinAs('host', 'Ana');

    host.socket.receive('table:addBot');
    host.socket.receive('table:addBot');

    const bots = host.socket.lastUpdate().state.seats.filter((seat) => seat?.isBot);
    expect(bots).toHaveLength(2);
    expect(bots.every((bot) => bot?.name.endsWith(' (Bot)'))).toBe(true);
    expect(new Set(bots.map((bot) => bot?.name)).size).toBe(2);
    expect(new Set(bots.map((bot) => bot?.avatar)).size).toBe(2);
    expect(bots.every((bot) => bot?.avatar !== PLAYER_AVATARS[0])).toBe(true);
  });

  it('removes the most recently added bot', () => {
    const host = joinAs('host', 'Ana');
    host.socket.receive('table:addBot');
    const [firstBotName] = seatNames(host.socket.lastUpdate()).filter((name) => name !== 'Ana');
    host.socket.receive('table:addBot');
    const [secondBotName] = seatNames(host.socket.lastUpdate()).filter((name) => name !== 'Ana' && name !== firstBotName);

    host.socket.receive('table:removeBot');

    const remainingNames = seatNames(host.socket.lastUpdate());
    expect(remainingNames).toContain(firstBotName);
    expect(remainingNames).not.toContain(secondBotName);
  });

  it('rejects an invalid configuration and keeps the table in the lobby', () => {
    const host = joinAs('host', 'Ana');

    host.socket.receive('table:start', { smallBlind: 0 });
    host.socket.receive('table:start', { smallBlind: 50, bigBlind: 20 });
    host.socket.receive('table:start', { startingStack: 100 });
    host.socket.receive('table:start', { turnSeconds: 5 });

    expect(host.socket.errors()).toHaveLength(4);
    expect(host.socket.lastUpdate().state.phase).toBe('lobby');
  });

  it('defaults the big blind to twice the requested small blind', () => {
    const host = joinAs('host', 'Ana');

    host.socket.receive('table:start', { smallBlind: 25, startingStack: 5000 });

    expect(host.socket.lastUpdate().state).toMatchObject({
      phase: 'running',
      config: { smallBlind: 25, bigBlind: 50, startingStack: 5000 },
    });
  });

  it('refuses a second start once the game is running', () => {
    const host = joinAs('host', 'Ana');
    startGame(host);

    host.socket.receive('table:start', {});

    expect(host.socket.errors()).toEqual(['A partida já começou.']);
  });
});

describe('message rate limit', () => {
  it('handles at most 30 messages per 2 seconds and accepts more once the window passes', () => {
    const observer = server.connect('observer');

    for (let index = 0; index < 40; index += 1) observer.receive('table:action', { type: 'fold' });
    expect(observer.errors()).toHaveLength(30);

    vi.advanceTimersByTime(2000);
    observer.receive('table:action', { type: 'fold' });
    expect(observer.errors()).toHaveLength(31);
  });
});

describe('a running hand', () => {
  it('keeps the big blind out of currentBet until its blind event', () => {
    const { first } = startHeadsUpGame();

    const [handStart] = first.socket.updatesOfKind('handStart');
    const [smallBlind, bigBlind] = first.socket.updatesOfKind('blind');
    expect(handStart.state.currentBet).toBe(0);
    expect(smallBlind.state.currentBet).toBe(10);
    expect(bigBlind.state.currentBet).toBe(20);
  });

  it('asks only the acting seat to decide and gives it the full turn time', () => {
    const players = Object.values(startHeadsUpGame());
    const acting = actingPlayer(players);
    const waiting = otherPlayer(players, acting);

    const turn = acting.socket.updatesOfKind('turn').at(-1);
    expect(turn?.state.self.legal).not.toBeNull();
    expect(waiting.socket.updatesOfKind('turn').at(-1)?.state.self.legal).toBeNull();
    expect(turn?.event).toMatchObject({ durationMs: TURN_SECONDS * 1000 });
  });

  it('rejects actions from a player who is not the acting seat', () => {
    const players = Object.values(startHeadsUpGame());
    const waiting = otherPlayer(players, actingPlayer(players));
    const actionsBefore = waiting.socket.updatesOfKind('action').length;

    waiting.socket.receive('table:action', { type: 'call' });

    expect(waiting.socket.errors()).toEqual(['Não é a sua vez.']);
    expect(waiting.socket.updatesOfKind('action')).toHaveLength(actionsBefore);
  });

  it('rejects malformed action payloads from the acting seat and keeps the turn open', () => {
    const players = Object.values(startHeadsUpGame());
    const acting = actingPlayer(players);

    acting.socket.receive('table:action', { type: 'raise', amount: 1.5 });
    acting.socket.receive('table:action', { type: 'raise' });
    acting.socket.receive('table:action', { type: 'steal' });
    acting.socket.receive('table:action', null);

    expect(acting.socket.errors()).toEqual(['Jogada inválida.', 'Jogada inválida.', 'Jogada inválida.', 'Jogada inválida.']);
    expect(acting.socket.updatesOfKind('action')).toHaveLength(0);
  });

  it('rejects a raise outside the legal range with an error only for that player', () => {
    const players = Object.values(startHeadsUpGame());
    const acting = actingPlayer(players);
    const waiting = otherPlayer(players, acting);

    acting.socket.receive('table:action', { type: 'raise', amount: 21 });

    expect(acting.socket.errors()).toHaveLength(1);
    expect(waiting.socket.errors()).toHaveLength(0);
    expect(acting.socket.updatesOfKind('action')).toHaveLength(0);
  });

  it('folds automatically and says so when the acting player runs out of time', () => {
    const players = Object.values(startHeadsUpGame());
    const acting = actingPlayer(players);

    vi.advanceTimersByTime(TURN_SECONDS * 1000);

    const [timeout] = acting.socket.updatesOfKind('action');
    expect(timeout.event).toMatchObject({ kind: 'action', action: 'fold', timedOut: true });
    expect(timeout.narration?.text).toContain('Tempo esgotado');
  });

  it('shortens the turn of a player who disconnects while deciding', () => {
    const players = Object.values(startHeadsUpGame());
    const acting = actingPlayer(players);
    const waiting = otherPlayer(players, acting);

    server.disconnect(acting.socket);

    const shortenedTurn = waiting.socket.updatesOfKind('turn').at(-1);
    expect(shortenedTurn?.event).toMatchObject({ kind: 'turn', durationMs: 8000 });
  });

  it('gives the turn back to a player who reconnects before it runs out, never beyond the original deadline', () => {
    const players = Object.values(startHeadsUpGame());
    const acting = actingPlayer(players);
    const waiting = otherPlayer(players, acting);
    const originalTurn = waiting.socket.updatesOfKind('turn').at(-1)?.event;
    if (originalTurn?.kind !== 'turn') throw new Error('The turn was never announced.');

    server.disconnect(acting.socket);
    vi.advanceTimersByTime(1000);
    const returning = joinAs('acting-again', 'Ana', { token: acting.token });

    const restoredTurn = waiting.socket.updatesOfKind('turn').at(-1)?.event;
    expect(restoredTurn).toMatchObject({ kind: 'turn', deadline: originalTurn.deadline, durationMs: TURN_SECONDS * 1000 });
    expect(returning.socket.updatesOfKind('turn').at(-1)?.event).toMatchObject({ deadline: originalTurn.deadline });

    vi.advanceTimersByTime(7900);
    expect(waiting.socket.updatesOfKind('action')).toHaveLength(0);
    vi.advanceTimersByTime(1100);
    expect(waiting.socket.updatesOfKind('action')[0].event).toMatchObject({ action: 'fold', timedOut: true });
  });

  it('keeps the shortened turn of a player who never comes back', () => {
    const players = Object.values(startHeadsUpGame());
    const acting = actingPlayer(players);
    const waiting = otherPlayer(players, acting);

    server.disconnect(acting.socket);
    vi.advanceTimersByTime(8100);

    expect(waiting.socket.updatesOfKind('action')[0].event).toMatchObject({ timedOut: true });
  });

  it('keeps a returning player\'s name when they merely reconnect during the hand', () => {
    const players = Object.values(startHeadsUpGame());
    const [first] = players;

    server.disconnect(first.socket);
    const returning = joinAs('first-again', 'Outro Nome', { token: first.token });

    expect(seatNames(returning.socket.lastUpdate())).toContain('Ana');
    expect(seatNames(returning.socket.lastUpdate())).not.toContain('Outro Nome');
  });

  it('lets someone who left mid-hand and came straight back choose a new identity and keep the seat', () => {
    const players = Object.values(startHeadsUpGame());
    const leaver = actingPlayer(players);
    const stayer = otherPlayer(players, leaver);

    leaver.socket.receive('table:leave');
    const response = sendJoin(leaver.socket, 'Zeca', leaver.token, { color: PLAYER_COLORS[1], avatar: PLAYER_AVATARS[1] });
    vi.advanceTimersByTime(15_000);

    expect(response).toMatchObject({ ok: true, seat: leaver.response.seat });
    const rejoinedSeat = stayer.socket.lastUpdate().state.seats[leaver.response.seat ?? -1];
    expect(rejoinedSeat).toMatchObject({ name: 'Zeca', color: PLAYER_COLORS[1], avatar: PLAYER_AVATARS[1] });
    expect(stayer.socket.lastUpdate().state.seats.filter(Boolean)).toHaveLength(2);
  });

  it('does not let a returning leaver take the name of another player', () => {
    const players = Object.values(startHeadsUpGame());
    const leaver = actingPlayer(players);
    const stayer = otherPlayer(players, leaver);
    const stayerName = stayer.socket.lastUpdate().state.seats[stayer.response.seat ?? -1]?.name ?? '';

    leaver.socket.receive('table:leave');
    sendJoin(leaver.socket, stayerName, leaver.token);

    const names = seatNames(stayer.socket.lastUpdate());
    expect(new Set(names).size).toBe(2);
  });

  it('treats a call with nothing to pay as a check', () => {
    const players = Object.values(startHeadsUpGame());
    callOrCheckWhenItIsTheirTurn(actingPlayer(players).socket);
    vi.advanceTimersByTime(600);
    const bigBlind = actingPlayer(players);

    bigBlind.socket.receive('table:action', { type: 'call' });

    expect(bigBlind.socket.errors()).toEqual([]);
    expect(bigBlind.socket.updatesOfKind('action').at(-1)?.event).toMatchObject({
      kind: 'action',
      seat: bigBlind.response.seat,
      action: 'check',
    });
  });

  it('does not announce a fold for the last live player who leaves while the betting gap is open', () => {
    const players = Object.values(startHeadsUpGame());
    const caller = actingPlayer(players);
    const opponent = otherPlayer(players, caller);
    callOrCheckWhenItIsTheirTurn(caller.socket);

    opponent.socket.receive('table:leave');
    caller.socket.receive('table:leave');
    vi.advanceTimersByTime(15_000);

    const folds = opponent.socket
      .updatesOfKind('action')
      .flatMap((update) => (update.event.kind === 'action' && update.event.action === 'fold' ? [update.event.seat] : []));
    expect(folds).toEqual([opponent.response.seat]);
    expect(opponent.socket.updatesOfKind('award').at(-1)?.event).toMatchObject({
      kind: 'award',
      awards: [{ winners: [{ seat: caller.response.seat }] }],
    });
  });

  it('folds a player who leaves during their turn, ends the hand and frees the seat', () => {
    const players = Object.values(startHeadsUpGame());
    const leaver = actingPlayer(players);
    const stayer = otherPlayer(players, leaver);

    leaver.socket.receive('table:leave');
    vi.advanceTimersByTime(15_000);

    const kinds = stayer.socket.updates().map((update) => update.event.kind);
    expect(kinds).toEqual(expect.arrayContaining(['action', 'award', 'handEnd', 'playerLeft']));
    expect(stayer.socket.updatesOfKind('award').at(-1)?.event).toMatchObject({ showdown: false });
    const seatedAfterwards = stayer.socket.lastUpdate().state.seats.flatMap((seat) => (seat ? [seat.seat] : []));
    expect(seatedAfterwards).toEqual([stayer.response.seat]);
  });

  it('never shows a player\'s hole cards to anyone else before the showdown reveal', () => {
    const players = Object.values(startHeadsUpGame());
    const observer = server.connect('observer');
    const handFinished = (): boolean => players[0].socket.updatesOfKind('handEnd').length > 0;

    playPassivelyUntil(players, handFinished);

    expect(players[0].socket.updatesOfKind('reveal')).toHaveLength(1);
    for (const viewer of [...players.map((player) => player.socket), observer]) {
      let revealed = false;
      for (const update of viewer.updates()) {
        if (update.event.kind === 'handStart') revealed = false;
        if (update.event.kind === 'reveal') revealed = true;
        if (revealed) continue;
        const ownSeat = update.state.self.seat;
        const foreignCards = update.state.seats.flatMap((seat) => (seat && seat.seat !== ownSeat ? [seat.cards] : []));
        expect(foreignCards.every((cards) => cards === null)).toBe(true);
      }
    }
  });

  it('shows each player their own cards and the card count of the others while dealing', () => {
    const players = Object.values(startHeadsUpGame());

    for (const viewer of players) {
      const state = viewer.socket.lastUpdate().state;
      const own = state.seats[viewer.response.seat ?? -1];
      const opponent = state.seats.find((seat) => seat && seat.seat !== viewer.response.seat);
      expect(own?.cards).toHaveLength(2);
      expect(opponent).toMatchObject({ cardCount: 2, cards: null });
    }
  });

  it('shows both hands to everyone at the showdown and pays the pot to the table', () => {
    const players = Object.values(startHeadsUpGame());

    playPassivelyUntil(players, () => players[0].socket.updatesOfKind('handEnd').length > 0);

    const reveal = players[1].socket.updatesOfKind('reveal')[0];
    expect(reveal.state.seats.filter((seat) => seat?.cards?.length === 2)).toHaveLength(2);
    const [handEnd] = players[0].socket.updatesOfKind('handEnd');
    const totalChips = handEnd.state.seats.reduce((sum, seat) => sum + (seat?.chips ?? 0), 0);
    expect(totalChips).toBe(2 * handEnd.state.config.startingStack);
  });

  it('plays a complete hand against a bot without stalling', () => {
    const human = joinAs('human', 'Ana');
    human.socket.receive('table:addBot');
    startGame(human);

    playPassivelyUntil([human], () => human.socket.updatesOfKind('handEnd').length > 0);

    const botSeat = human.socket.lastUpdate().state.seats.find((seat) => seat?.isBot)?.seat;
    const botActions = human.socket
      .updatesOfKind('action')
      .filter((update) => update.event.kind === 'action' && update.event.seat === botSeat);
    expect(human.socket.updatesOfKind('handEnd')).toHaveLength(1);
    expect(botActions.length).toBeGreaterThan(0);
  });

  it('lets bots that read the table play several hands in a row on time and without errors', () => {
    const failures = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const human = joinAs('human', 'Ana');
    human.socket.receive('table:addBot');
    human.socket.receive('table:addBot');
    startGame(human);

    playPassivelyUntil([human], () => human.socket.updatesOfKind('handEnd').length >= 4);

    const botSeats = new Set(
      human.socket.lastUpdate().state.seats.flatMap((seat) => (seat?.isBot ? [seat.seat] : [])),
    );
    const botActions = human.socket
      .updatesOfKind('action')
      .flatMap((update) => (update.event.kind === 'action' && botSeats.has(update.event.seat) ? [update.event] : []));
    expect(human.socket.updatesOfKind('handEnd').length).toBeGreaterThanOrEqual(4);
    expect(botActions.length).toBeGreaterThan(4);
    expect(botActions.every((action) => !action.timedOut)).toBe(true);
    expect(failures).not.toHaveBeenCalled();
  });

  it('waits for players instead of dealing when the only opponent has left', () => {
    const { first, second } = startHeadsUpGame();
    playPassivelyUntil([first, second], () => first.socket.updatesOfKind('handEnd').length > 0);

    second.socket.receive('table:leave');
    vi.advanceTimersByTime(10_000);

    const narrations = first.socket.updates().map((update) => update.narration?.text);
    expect(narrations).toContain('Aguardando jogadores…');
    expect(first.socket.updatesOfKind('handStart')).toHaveLength(1);
  });
});

describe('a seat that changes hands between hands', () => {
  const HAND_END_SLACK_MS = 8000;

  function seatViewOf(socket: FakeSocket, seat: number | null | undefined): TableUpdate['state']['seats'][number] {
    return socket.lastUpdate().state.seats[seat ?? -1];
  }

  it('does not hand an uncontested winner\'s hole cards to the player who takes the freed seat', () => {
    const players = Object.values(startHeadsUpGame());
    const folder = actingPlayer(players);
    const winner = otherPlayer(players, folder);
    folder.socket.receive('table:action', { type: 'fold' });
    winner.socket.receive('table:leave');
    vi.advanceTimersByTime(HAND_END_SLACK_MS);
    expect(folder.socket.updatesOfKind('handEnd')).toHaveLength(1);

    const newcomer = joinAs('newcomer', 'Carla');

    expect(newcomer.response.seat).toBe(winner.response.seat);
    expect(seatViewOf(newcomer.socket, newcomer.response.seat)).toMatchObject({ name: 'Carla', cards: null, cardCount: 0, lastAction: null });
    expect(seatViewOf(folder.socket, newcomer.response.seat)).toMatchObject({ cards: null, cardCount: 0, lastAction: null });
  });

  it('does not show a departed showdown player\'s revealed hand under the newcomer\'s name', () => {
    const players = Object.values(startHeadsUpGame());
    const [stayer, leaver] = players;
    playPassivelyUntil(players, () => stayer.socket.updatesOfKind('award').length > 0);
    leaver.socket.receive('table:leave');
    vi.advanceTimersByTime(HAND_END_SLACK_MS);
    expect(stayer.socket.updatesOfKind('handEnd')).toHaveLength(1);

    const newcomer = joinAs('newcomer', 'Carla');

    expect(newcomer.response.seat).toBe(leaver.response.seat);
    expect(seatViewOf(stayer.socket, newcomer.response.seat)).toMatchObject({ name: 'Carla', cards: null, cardCount: 0 });
    expect(seatViewOf(newcomer.socket, newcomer.response.seat)).toMatchObject({ cards: null, cardCount: 0 });
  });
});

describe('what the bots remember', () => {
  const HAND_END_SLACK_MS = 8000;

  it('never hands the bots the cards of a hand won without a showdown', () => {
    const remembered = vi.spyOn(BotTableMemory.prototype, 'recordShowdown');
    const players = Object.values(startHeadsUpGame());

    actingPlayer(players).socket.receive('table:action', { type: 'fold' });
    vi.advanceTimersByTime(HAND_END_SLACK_MS);

    expect(players[0].socket.updatesOfKind('handEnd')).toHaveLength(1);
    expect(remembered).not.toHaveBeenCalled();
  });

  it('hands the bots exactly the cards the table saw at the showdown reveal', () => {
    const remembered = vi.spyOn(BotTableMemory.prototype, 'recordShowdown');
    const players = Object.values(startHeadsUpGame());

    playPassivelyUntil(players, () => players[0].socket.updatesOfKind('handEnd').length > 0);

    const reveal = players[0].socket.updatesOfKind('reveal')[0]?.event;
    if (reveal?.kind !== 'reveal') throw new Error('The showdown was never revealed.');
    expect(remembered).toHaveBeenCalledTimes(1);
    const shown = remembered.mock.calls[0][0].map(({ seat, cards }) => ({ seat, cards }));
    expect(shown).toEqual(reveal.hands.map(({ seat, cards }) => ({ seat, cards })));
    expect(shown).toHaveLength(2);
  });
});
