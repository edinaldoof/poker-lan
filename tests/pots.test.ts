import { describe, expect, it } from 'vitest';
import { buildPots, splitPot, type ContributionEntry } from '../src/server/game/pots';

function live(seat: number, contribution: number): ContributionEntry {
  return { seat, contribution, folded: false };
}

function folded(seat: number, contribution: number): ContributionEntry {
  return { seat, contribution, folded: true };
}

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

describe('buildPots', () => {
  it('returns no pots when nobody has contributed', () => {
    expect(buildPots([])).toEqual([]);
    expect(buildPots([live(0, 0), live(1, 0)])).toEqual([]);
  });

  it('builds a single pot when every player contributed the same amount', () => {
    expect(buildPots([live(0, 100), live(1, 100), live(2, 100)])).toEqual([
      { amount: 300, eligibleSeats: [0, 1, 2] },
    ]);
  });

  it('builds a main pot and two side pots for three all-ins of different sizes', () => {
    const pots = buildPots([live(0, 100), live(1, 300), live(2, 500)]);

    expect(pots).toEqual([
      { amount: 300, eligibleSeats: [0, 1, 2] },
      { amount: 400, eligibleSeats: [1, 2] },
      { amount: 200, eligibleSeats: [2] },
    ]);
  });

  it('merges players who stopped at the same level into one slice', () => {
    const pots = buildPots([live(0, 100), live(1, 100), live(2, 250), live(3, 250)]);

    expect(pots).toEqual([
      { amount: 400, eligibleSeats: [0, 1, 2, 3] },
      { amount: 300, eligibleSeats: [2, 3] },
    ]);
  });

  it('keeps folded chips in the pot without making the folded player eligible', () => {
    const pots = buildPots([live(0, 100), live(1, 100), folded(2, 50)]);

    expect(pots).toEqual([{ amount: 250, eligibleSeats: [0, 1] }]);
  });

  it('splits a slice that only a folded player and live players above them funded', () => {
    // Seat 2 folded after putting in 200, between the two live levels.
    const pots = buildPots([live(0, 100), live(1, 300), folded(2, 200)]);

    expect(pots).toEqual([
      { amount: 300, eligibleSeats: [0, 1] },
      { amount: 300, eligibleSeats: [1] },
    ]);
  });

  it('adds dead money above the highest live level to the last pot', () => {
    const pots = buildPots([live(0, 50), live(1, 50), folded(2, 120)]);

    expect(pots).toEqual([{ amount: 220, eligibleSeats: [0, 1] }]);
  });

  it('adds dead money above the highest live level to the last of several pots', () => {
    const pots = buildPots([live(0, 40), live(1, 60), folded(2, 100)]);

    expect(pots).toEqual([
      { amount: 120, eligibleSeats: [0, 1] },
      { amount: 80, eligibleSeats: [1] },
    ]);
  });

  it('never makes a live player with no contribution eligible', () => {
    const pots = buildPots([live(0, 0), live(1, 80), live(2, 80)]);

    expect(pots).toEqual([{ amount: 160, eligibleSeats: [1, 2] }]);
  });

  it('lists eligible seats in ascending order whatever the input order', () => {
    const pots = buildPots([live(5, 200), live(1, 200), live(3, 100)]);

    expect(pots).toEqual([
      { amount: 300, eligibleSeats: [1, 3, 5] },
      { amount: 200, eligibleSeats: [1, 5] },
    ]);
  });

  it('keeps the chips of a hand where everybody folded instead of dropping them', () => {
    expect(buildPots([folded(0, 30), folded(1, 20)])).toEqual([{ amount: 50, eligibleSeats: [] }]);
  });

  it('does not mutate its input', () => {
    const entries = [live(2, 100), folded(1, 40), live(0, 70)];
    const snapshot = structuredClone(entries);

    buildPots(entries);

    expect(entries).toEqual(snapshot);
  });

  it('allocates every contributed chip to exactly one pot (random scenarios)', () => {
    const random = seededRandom(1234);
    for (let scenario = 0; scenario < 500; scenario++) {
      const playerCount = 2 + Math.floor(random() * 7);
      const entries: ContributionEntry[] = Array.from({ length: playerCount }, (_, seat) => ({
        seat,
        contribution: Math.floor(random() * 6) * 50,
        folded: random() < 0.3,
      }));
      if (entries.every((entry) => entry.folded)) entries[0].folded = false;

      const pots = buildPots(entries);

      const contributed = entries.reduce((sum, entry) => sum + entry.contribution, 0);
      expect(pots.reduce((sum, pot) => sum + pot.amount, 0)).toBe(contributed);
      for (const pot of pots) {
        expect(pot.amount).toBeGreaterThan(0);
        for (const seat of pot.eligibleSeats) {
          expect(entries[seat].folded).toBe(false);
        }
      }
    }
  });
});

describe('splitPot', () => {
  it('gives the whole pot to a single winner', () => {
    expect([...splitPot(250, [3])]).toEqual([[3, 250]]);
  });

  it('splits evenly when the amount divides exactly', () => {
    expect([...splitPot(300, [1, 4, 6])]).toEqual([
      [1, 100],
      [4, 100],
      [6, 100],
    ]);
  });

  it('gives a single odd chip to the first winner in payout order', () => {
    expect([...splitPot(25, [2, 0])]).toEqual([
      [2, 13],
      [0, 12],
    ]);
  });

  it('hands out several odd chips one by one in payout order', () => {
    expect([...splitPot(11, [5, 1, 3])]).toEqual([
      [5, 4],
      [1, 4],
      [3, 3],
    ]);
  });

  it('follows the given order rather than seat numbers', () => {
    const shares = splitPot(7, [6, 2]);

    expect(shares.get(6)).toBe(4);
    expect(shares.get(2)).toBe(3);
  });

  it('pays out zero chips to everyone when the pot is empty', () => {
    expect([...splitPot(0, [0, 1])]).toEqual([
      [0, 0],
      [1, 0],
    ]);
  });

  it('always pays out exactly the pot amount (random scenarios)', () => {
    const random = seededRandom(99);
    for (let scenario = 0; scenario < 300; scenario++) {
      const amount = Math.floor(random() * 5000);
      const winnerCount = 1 + Math.floor(random() * 8);
      const winners = Array.from({ length: winnerCount }, (_, index) => index);

      const shares = [...splitPot(amount, winners).values()];

      expect(shares.reduce((sum, share) => sum + share, 0)).toBe(amount);
      expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
    }
  });

  it('rejects a pot with no winners', () => {
    expect(() => splitPot(100, [])).toThrow(RangeError);
  });

  it('rejects negative or fractional amounts', () => {
    expect(() => splitPot(-1, [0])).toThrow(RangeError);
    expect(() => splitPot(10.5, [0])).toThrow(RangeError);
  });

  it('rejects the same seat listed twice, which would lose chips', () => {
    expect(() => splitPot(100, [2, 2])).toThrow(RangeError);
  });
});
