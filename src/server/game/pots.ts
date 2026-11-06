export interface ContributionEntry {
  seat: number;
  contribution: number;
  folded: boolean;
}

export interface Pot {
  amount: number;
  /** Sorted ascending. */
  eligibleSeats: number[];
}

/**
 * Builds the main pot and side pots from each player's total contribution to the hand.
 *
 * Pot levels are the distinct contributions of players who have not folded. Chips from folded players
 * above the highest live level are dead money and join the last pot. Consecutive levels never share the
 * same eligible set (every live level has a player who stops exactly there), so no merge step is needed.
 */
export function buildPots(entries: ContributionEntry[]): Pot[] {
  const contributors = entries.filter((entry) => entry.contribution > 0);
  const levels = collectLevels(contributors);

  const pots: Pot[] = [];
  let carriedDeadMoney = 0;
  let previousLevel = 0;

  for (const level of levels) {
    const sliceAmount = contributors.reduce(
      (sum, entry) => sum + Math.max(0, Math.min(entry.contribution, level) - previousLevel),
      0,
    );
    const eligibleSeats = contributors
      .filter((entry) => !entry.folded && entry.contribution >= level)
      .map((entry) => entry.seat)
      .sort((a, b) => a - b);
    previousLevel = level;

    if (eligibleSeats.length > 0) {
      pots.push({ amount: sliceAmount + carriedDeadMoney, eligibleSeats });
      carriedDeadMoney = 0;
    } else if (pots.length > 0) {
      pots[pots.length - 1].amount += sliceAmount;
    } else {
      carriedDeadMoney += sliceAmount;
    }
  }

  // Only reachable when nobody is left alive: keep the chips visible instead of dropping them silently.
  if (carriedDeadMoney > 0) {
    pots.push({ amount: carriedDeadMoney, eligibleSeats: [] });
  }
  return pots;
}

function collectLevels(contributors: ContributionEntry[]): number[] {
  const liveLevels = [...new Set(contributors.filter((entry) => !entry.folded).map((entry) => entry.contribution))].sort(
    (a, b) => a - b,
  );
  const highestContribution = contributors.reduce((highest, entry) => Math.max(highest, entry.contribution), 0);
  const highestLiveLevel = liveLevels[liveLevels.length - 1] ?? 0;
  return highestContribution > highestLiveLevel ? [...liveLevels, highestContribution] : liveLevels;
}

/** Splits `amount` evenly; leftover chips go one by one to the winners in the given order. */
export function splitPot(amount: number, winnersInPayoutOrder: number[]): Map<number, number> {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new RangeError(`splitPot expects a non-negative integer amount, received ${amount}`);
  }
  if (winnersInPayoutOrder.length === 0) {
    throw new RangeError('splitPot needs at least one winner');
  }
  if (new Set(winnersInPayoutOrder).size !== winnersInPayoutOrder.length) {
    throw new RangeError('splitPot received the same seat twice');
  }

  const baseShare = Math.floor(amount / winnersInPayoutOrder.length);
  const oddChips = amount - baseShare * winnersInPayoutOrder.length;
  const shares = new Map<number, number>();
  winnersInPayoutOrder.forEach((seat, index) => {
    shares.set(seat, baseShare + (index < oddChips ? 1 : 0));
  });
  return shares;
}
