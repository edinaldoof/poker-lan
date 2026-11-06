import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'socket.io';
import { GameController } from '../src/server/game/GameController';
import {
  BLIND_OPTIONS,
  STACK_OPTIONS,
  TURN_SECONDS_OPTIONS,
  adjustStackForBlinds,
  describeStackRule,
  describeTableSettings,
  formatCompactChips,
  missingPlayersMessage,
  rosterDisplayName,
  rosterOrder,
  rosterTag,
  selectableStacks,
  stackInBigBlinds,
} from '../src/client/ui/HostPanel';
import {
  PLAYER_AVATARS,
  PLAYER_COLORS,
  type ClientToServerEvents,
  type JoinResponse,
  type ServerToClientEvents,
  type TableUpdate,
} from '../src/shared/protocol';

type GameServer = Server<ClientToServerEvents, ServerToClientEvents>;
type Handler = (...args: unknown[]) => void;

/** Minimal stand-in for a socket.io server socket: enough surface for the controller, no network. */
class FakeSocket {
  readonly emitted: { event: string; payload: unknown }[] = [];
  private readonly handlers = new Map<string, Handler>();

  constructor(readonly id: string) {}

  on(event: string, handler: Handler): this {
    this.handlers.set(event, handler);
    return this;
  }

  use(): this {
    return this;
  }

  emit(event: string, payload?: unknown): boolean {
    this.emitted.push({ event, payload });
    return true;
  }

  receive(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.(...args);
  }

  errors(): string[] {
    return this.emitted.filter((entry) => entry.event === 'table:error').map((entry) => entry.payload as string);
  }

  lastUpdate(): TableUpdate {
    const updates = this.emitted.filter((entry) => entry.event === 'table:update');
    return updates[updates.length - 1].payload as TableUpdate;
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
}

let controller: GameController | null = null;

function seatHost(): FakeSocket {
  const server = new FakeServer();
  controller = new GameController(server as unknown as GameServer, { lanUrls: () => [] });
  controller.attach();

  const socket = server.connect('host');
  let response: JoinResponse | null = null;
  socket.receive(
    'table:join',
    { name: 'Ana', color: PLAYER_COLORS[0], avatar: PLAYER_AVATARS[0], token: 'session-host-token' },
    (received: JoinResponse) => {
      response = received;
    },
  );
  if (response === null || !(response as JoinResponse).ok) throw new Error('The host could not take a seat.');
  return socket;
}

function startWith(smallBlind: number, bigBlind: number, startingStack: number, turnSeconds: number): FakeSocket {
  const host = seatHost();
  host.receive('table:start', { smallBlind, bigBlind, startingStack, turnSeconds });
  return host;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  controller?.shutdown();
  controller = null;
  vi.useRealTimers();
});

describe('host panel options', () => {
  it('offers only the stacks the server accepts for the chosen blinds', () => {
    expect(selectableStacks(10)).toEqual([1000, 2000, 5000, 10000]);
    expect(selectableStacks(50)).toEqual([1000, 2000, 5000, 10000]);
    expect(selectableStacks(100)).toEqual([2000, 5000, 10000]);
  });

  it('never leaves a blind level without a selectable stack', () => {
    for (const { bigBlind } of BLIND_OPTIONS) expect(selectableStacks(bigBlind).length).toBeGreaterThan(0);
  });

  it('only offers combinations that the server starts without an error', () => {
    for (const { smallBlind, bigBlind } of BLIND_OPTIONS) {
      for (const stack of selectableStacks(bigBlind)) {
        for (const turnSeconds of TURN_SECONDS_OPTIONS) {
          const host = startWith(smallBlind, bigBlind, stack, turnSeconds);

          expect(host.errors(), `${smallBlind}/${bigBlind} with ${stack} chips and ${turnSeconds} s`).toEqual([]);
          expect(host.lastUpdate().state.config).toEqual({ smallBlind, bigBlind, startingStack: stack, turnSeconds });
          controller?.shutdown();
        }
      }
    }
  });

  it('keeps hiding the stacks the server refuses, so the filter is not dead code', () => {
    const refused = BLIND_OPTIONS.flatMap(({ smallBlind, bigBlind }) =>
      STACK_OPTIONS.filter((stack) => !selectableStacks(bigBlind).includes(stack)).map((stack) => ({ smallBlind, bigBlind, stack })),
    );

    expect(refused).toEqual([{ smallBlind: 50, bigBlind: 100, stack: 1000 }]);
    for (const { smallBlind, bigBlind, stack } of refused) {
      const host = startWith(smallBlind, bigBlind, stack, TURN_SECONDS_OPTIONS[0]);

      expect(host.errors()).toHaveLength(1);
      expect(host.lastUpdate().state.phase).toBe('lobby');
      controller?.shutdown();
    }
  });
});

describe('waiting room rules', () => {
  it('keeps a valid stack when the blinds change and otherwise falls back to the smallest allowed one', () => {
    expect(adjustStackForBlinds(2000, 100)).toBe(2000);
    expect(adjustStackForBlinds(1000, 100)).toBe(2000);
    expect(adjustStackForBlinds(1000, 20)).toBe(1000);
  });

  it('shows how many big blinds a stack is worth', () => {
    expect(stackInBigBlinds(2000, 20)).toBe(100);
    expect(stackInBigBlinds(10000, 100)).toBe(100);
    expect(stackInBigBlinds(1000, 0)).toBe(0);
  });

  it('explains the stack floor only for the blinds that need it', () => {
    expect(describeStackRule(10, 20)).toBeNull();
    expect(describeStackRule(50, 100)).toContain('2.000');
    expect(describeStackRule(50, 100)).toContain('20 big blinds');
  });

  it('tells the host what is missing to start', () => {
    expect(missingPlayersMessage(1)).toBe('Falta 1 jogador. Adicione um bot ou chame alguém.');
    expect(missingPlayersMessage(0)).toBe('Falta 2 jogadores. Adicione um bot ou chame alguém.');
    expect(missingPlayersMessage(2)).toBe('Qualquer jogador sentado pode iniciar a partida.');
  });

  it('lists the viewer first and keeps the others in seat order', () => {
    const seated = [{ seat: 0 }, { seat: 2 }, { seat: 5 }, { seat: 7 }];

    expect(rosterOrder(seated, 5).map((entry) => entry.seat)).toEqual([5, 0, 2, 7]);
    expect(rosterOrder(seated, null).map((entry) => entry.seat)).toEqual([0, 2, 5, 7]);
    expect(seated.map((entry) => entry.seat)).toEqual([0, 2, 5, 7]);
  });

  it('tags the viewer as "Você" and every bot as "Bot"', () => {
    expect(rosterTag(false, true)).toBe('Você');
    expect(rosterTag(true, false)).toBe('Bot');
    expect(rosterTag(false, false)).toBeNull();
  });

  it('drops the "(Bot)" suffix the server adds, so the marker is not repeated in the name', () => {
    expect(rosterDisplayName('Bia (Bot)', true)).toBe('Bia');
    expect(rosterDisplayName('Nina (Bot) 2', true)).toBe('Nina 2');
    expect(rosterDisplayName('Robô', true)).toBe('Robô');
  });

  it('keeps the exact name of a person, even one that imitates the bot suffix', () => {
    expect(rosterDisplayName('Ana (Bot)', false)).toBe('Ana (Bot)');
  });

  it('never shows an empty name for a bot', () => {
    expect(rosterDisplayName('(Bot)', true)).toBe('(Bot)');
  });
});

describe('compact settings line', () => {
  it('abbreviates thousands the way the chips do', () => {
    expect(formatCompactChips(1000)).toBe('1K');
    expect(formatCompactChips(10000)).toBe('10K');
    expect(formatCompactChips(2500)).toBe('2500');
    expect(formatCompactChips(50)).toBe('50');
  });

  it('summarises blinds, starting stack and turn time in one short line', () => {
    expect(describeTableSettings(10, 20, 2000, 30)).toBe('10/20, 2K, 30 s');
    expect(describeTableSettings(50, 100, 10000, 60)).toBe('50/100, 10K, 60 s');
  });
});

describe('waiting room stylesheet', () => {
  const css = readFileSync(new URL('../src/client/ui/hostPanel.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('docks a card no wider than 320 px at the bottom-left of wide screens', () => {
    const docked = css.slice(css.indexOf('@media (min-width: 1000px)'));
    expect(docked).toMatch(/position: absolute;[\s\S]*?width: 308px;/);
  });

  it('gives touch screens 44 px buttons', () => {
    expect(css).toMatch(/@media \(pointer: coarse\) \{\s*\.host-card \.mk-btn,\s*\.host-card \.mk-btn--cta \{\s*min-height: 44px;/);
  });
});
