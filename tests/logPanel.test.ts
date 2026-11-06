import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLedger, matchesFilter, parseHandStart, toLogEntry } from '../src/client/ui/LogPanel';
import { warmCardAtlas } from '../src/client/ui/miniCard';
import type { LogEntry, Narration } from '../src/shared/protocol';

const narration: Narration = { text: 'Bruno aumenta para 300.', tone: 'action', priority: 2 };

describe('live log lines', () => {
  it('are stamped with the server time, so they share a clock with the backlog', () => {
    const serverTime = Date.UTC(2026, 10, 5, 20, 15);
    const deviceClockFiveMinutesAhead = serverTime + 5 * 60_000;

    expect(toLogEntry(narration, serverTime, deviceClockFiveMinutesAhead).time).toBe(serverTime);
  });

  it('keep the time of each update when a burst is announced at once', () => {
    const announcedAt = Date.UTC(2026, 10, 5, 20, 30);
    const times = [20_000, 21_500, 24_000].map((offset) => toLogEntry(narration, announcedAt - offset, announcedAt).time);

    expect(times).toEqual([announcedAt - 20_000, announcedAt - 21_500, announcedAt - 24_000]);
  });

  it('fall back to the device clock when no server time is given', () => {
    const deviceTime = Date.UTC(2026, 10, 5, 20, 0);

    expect(toLogEntry(narration, undefined, deviceTime).time).toBe(deviceTime);
    expect(toLogEntry(narration, Number.NaN, deviceTime).time).toBe(deviceTime);
  });

  it('carry the narration text and tone', () => {
    expect(toLogEntry(narration, 1, 2)).toMatchObject({ text: 'Bruno aumenta para 300.', tone: 'action' });
  });
});

describe('hand separators', () => {
  it('read the number and the details from the hand-start line', () => {
    expect(parseHandStart('Mão #12 — Dealer: Ana · Blinds 10/20')).toEqual({ handNumber: 12, details: 'Dealer Ana, Blinds 10/20' });
    expect(parseHandStart('Mão #3 - Dealer: Bia')).toEqual({ handNumber: 3, details: 'Dealer Bia' });
    expect(parseHandStart('Mão #7')).toEqual({ handNumber: 7, details: '' });
  });

  it('leave every other line alone', () => {
    expect(parseHandStart('Ana vence o pote de 300 sem showdown.')).toBeNull();
    expect(parseHandStart('A Mão #4 foi boa')).toBeNull();
  });
});

describe('filter chips', () => {
  it('Jogadas keeps player actions, all-ins and timeouts', () => {
    expect(matchesFilter('action', 'plays')).toBe(true);
    expect(matchesFilter('alert', 'plays')).toBe(true);
    expect(matchesFilter('warn', 'plays')).toBe(true);
    expect(matchesFilter('street', 'plays')).toBe(false);
    expect(matchesFilter('win', 'plays')).toBe(false);
  });

  it('Resultados keeps only the pots that were won', () => {
    expect(matchesFilter('win', 'results')).toBe(true);
    expect(matchesFilter('action', 'results')).toBe(false);
    expect(matchesFilter('info', 'results')).toBe(false);
  });

  it('Tudo keeps everything', () => {
    for (const tone of ['info', 'action', 'street', 'win', 'warn', 'alert'] as const) expect(matchesFilter(tone, 'all')).toBe(true);
  });
});

describe('ledger grouping', () => {
  const log: LogEntry[] = [
    { time: 1, text: 'Ana entrou na mesa.', tone: 'info' },
    { time: 2, text: 'Mão #1 — Dealer: Ana · Blinds 10/20', tone: 'info' },
    { time: 3, text: 'Ana paga 20.', tone: 'action' },
    { time: 4, text: 'Bia dá check.', tone: 'action' },
    { time: 5, text: 'Cartas na mesa: Flop! A♠ K♦ 7♣', tone: 'street' },
    { time: 6, text: 'Ana vence o pote de 40 sem showdown.', tone: 'win' },
    { time: 7, text: 'Mão #2 — Dealer: Bia · Blinds 10/20', tone: 'info' },
    { time: 8, text: 'ALL-IN! Bia empurra 500 fichas!', tone: 'alert' },
  ];

  it('puts the newest hand first and the newest line first inside each hand', () => {
    const groups = buildLedger(log, 'all');

    expect(groups.map((group) => group.handNumber)).toEqual([2, 1, null]);
    expect(groups[0].entries.map((entry) => entry.time)).toEqual([8]);
    expect(groups[1].entries.map((entry) => entry.time)).toEqual([6, 5, 4, 3]);
    expect(groups[2].entries.map((entry) => entry.time)).toEqual([1]);
    expect(groups[0].details).toBe('Dealer Bia, Blinds 10/20');
    expect(groups[0].startedAt).toBe(7);
  });

  it('never lists the hand-start line as a row, since it is the separator itself', () => {
    const rows = buildLedger(log, 'all').flatMap((group) => group.entries.map((entry) => entry.text));

    expect(rows.some((text) => text.startsWith('Mão #'))).toBe(false);
  });

  it('drops the hands that a filter leaves empty', () => {
    expect(buildLedger(log, 'plays').map((group) => [group.handNumber, group.entries.length])).toEqual([
      [2, 1],
      [1, 2],
    ]);
    expect(buildLedger(log, 'results').map((group) => group.handNumber)).toEqual([1]);
  });

  it('returns nothing for an empty log', () => {
    expect(buildLedger([], 'all')).toEqual([]);
  });
});

describe('card atlas warm-up', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('decodes the atlas image only once, however many panels ask for it', async () => {
    const decodedSources: string[] = [];
    class FakeImage {
      src = '';
      decode(): Promise<void> {
        decodedSources.push(this.src);
        return Promise.resolve();
      }
    }
    vi.stubGlobal('Image', FakeImage);

    await Promise.all([warmCardAtlas(), warmCardAtlas()]);
    await warmCardAtlas();

    expect(decodedSources).toEqual(['/assets/cards/cards_atlas.webp']);
  });
});
