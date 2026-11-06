import { describe, expect, it } from 'vitest';
import { CHIP_DENOMINATIONS, CHIP_DIAMETER, CHIP_HEIGHT } from '../src/client/scene/ChipFactory';
import {
  PLAYER_STACK_CHIPS_PER_DOUBLING,
  PLAYER_STACK_MAX_CHIPS,
  PLAYER_STACK_MAX_COLUMNS,
  PLAYER_STACK_MAX_COLUMN_HEIGHT,
  PLAYER_STACK_RADIUS,
  composePlayerStack,
  placeChips,
  placeColumns,
  playerStackChipBudget,
  playerStackChips,
  playerStackOutline,
  stackChipCount,
  stackHeight,
  stackValue,
  type StackColumn,
} from '../src/client/scene/playerStackLayout';

/** Every amount from 1 to 600, then 1 % steps up to well beyond the cap. */
function sweepAmounts(): number[] {
  const amounts: number[] = [];
  for (let amount = 1; amount <= 600; amount++) amounts.push(amount);
  for (let amount = 605; amount <= 260_000; amount = Math.ceil((amount * 1.01) / 5) * 5) amounts.push(amount);
  return amounts;
}

const AMOUNTS = sweepAmounts();
const LARGEST_FULL_STACK = PLAYER_STACK_MAX_CHIPS * CHIP_DENOMINATIONS[0];
/** Where the budget reaches its cap: past it only the colours can still grow. */
const CAPPED_AMOUNT = 22_000;
/** From here a stack has at least eight chips, enough for its value to land within 10 %. */
const MULTI_COLUMN_AMOUNT = 300;

function columnHeights(columns: readonly StackColumn[]): number[] {
  return columns.map((column) => column.length);
}

/** The two chips around the average chip of an amount, as the composition picks them. */
function bracketingDenominations(amount: number): [number, number] {
  const usable = CHIP_DENOMINATIONS.filter((denomination) => denomination > 1 || amount < 25);
  const average = amount / playerStackChipBudget(amount);
  const smallerIndex = usable.findIndex((denomination) => denomination <= average);
  return [usable[Math.max(0, smallerIndex - 1)], usable[smallerIndex]];
}

describe('player stack chip budget', () => {
  it('shows nothing for an empty, negative or invalid amount', () => {
    for (const amount of [0, -50, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(playerStackChipBudget(amount)).toBe(0);
      expect(composePlayerStack(amount)).toEqual([]);
    }
  });

  it('never shrinks as the amount grows and stops at the cap', () => {
    let previous = 0;
    for (const amount of AMOUNTS) {
      const budget = playerStackChipBudget(amount);
      expect(budget, `budget of ${amount}`).toBeGreaterThanOrEqual(previous);
      previous = budget;
    }
    expect(playerStackChipBudget(1)).toBe(1);
    expect(playerStackChipBudget(2_000)).toBe(20);
    expect(playerStackChipBudget(CAPPED_AMOUNT)).toBe(PLAYER_STACK_MAX_CHIPS);
  });

  it('adds a chip every time a short stack doubles and five or six from half a starting stack, so a 15 % loss shows', () => {
    for (let amount = 25; amount * 2 <= CAPPED_AMOUNT; amount = Math.ceil(amount * 1.1)) {
      const gained = playerStackChipBudget(amount * 2) - playerStackChipBudget(amount);
      const expected = amount >= 1_000 ? PLAYER_STACK_CHIPS_PER_DOUBLING - 1 : 1;
      expect(gained, `${amount} → ${amount * 2}`).toBeGreaterThanOrEqual(expected);
    }
    expect(playerStackChipBudget(1_700)).toBeLessThan(playerStackChipBudget(2_000));
  });

  it('compresses big stacks: 50 000 chips stand at most twice as high as a 2 000 starting stack', () => {
    const starting = composePlayerStack(2_000);
    const huge = composePlayerStack(50_000);

    expect(stackChipCount(huge) / stackChipCount(starting)).toBeLessThanOrEqual(2);
    expect(stackHeight(huge)).toBeLessThanOrEqual(PLAYER_STACK_MAX_COLUMN_HEIGHT * CHIP_HEIGHT);
  });
});

describe('player stack silhouette', () => {
  it('grows chip by chip: every outline holds the outline of every smaller budget', () => {
    for (let budget = 1; budget <= PLAYER_STACK_MAX_CHIPS; budget++) {
      const outline = playerStackOutline(budget);
      const smaller = playerStackOutline(budget - 1);
      expect(outline.reduce((total, height) => total + height, 0)).toBe(budget);
      expect(outline.length).toBeGreaterThanOrEqual(smaller.length);
      expect(outline.length).toBeLessThanOrEqual(PLAYER_STACK_MAX_COLUMNS);
      smaller.forEach((height, column) => expect(outline[column], `budget ${budget}, column ${column}`).toBeGreaterThanOrEqual(height));
      expect(Math.max(...outline)).toBeLessThanOrEqual(PLAYER_STACK_MAX_COLUMN_HEIGHT);
    }
    expect(playerStackOutline(20)).toEqual([5, 5, 5, 5]);
    expect(playerStackOutline(PLAYER_STACK_MAX_CHIPS)).toEqual([10, 10, 10, 10]);
  });

  it('never shows fewer chips, fewer columns or a lower column for a bigger amount', () => {
    let previous = composePlayerStack(AMOUNTS[0]);
    for (const amount of AMOUNTS.slice(1)) {
      const columns = composePlayerStack(amount);
      expect(stackChipCount(columns), `chips of ${amount}`).toBeGreaterThanOrEqual(stackChipCount(previous));
      expect(columns.length, `columns of ${amount}`).toBeGreaterThanOrEqual(previous.length);
      columnHeights(previous).forEach((height, column) => expect(columns[column].length, `column ${column} of ${amount}`).toBeGreaterThanOrEqual(height));
      previous = columns;
    }
  });

  it('shows 1 000, 1 500, 2 000 and 4 000 as visibly different stacks', () => {
    const heights = [1_000, 1_500, 2_000, 4_000].map((amount) => stackHeight(composePlayerStack(amount)));
    const chips = [1_000, 1_500, 2_000, 4_000].map((amount) => stackChipCount(composePlayerStack(amount)));

    expect(heights).toEqual([...heights].sort((a, b) => a - b));
    expect(new Set(chips).size).toBe(4);
  });
});

describe('player stack chips', () => {
  it('is worth the amount within half the step between the two chips it uses, and within 10 % from 300 up', () => {
    for (const amount of AMOUNTS.filter((value) => value < LARGEST_FULL_STACK)) {
      const [larger, smaller] = bracketingDenominations(amount);
      const error = Math.abs(stackValue(composePlayerStack(amount)) - amount);
      expect(error, `value of ${amount}`).toBeLessThanOrEqual((larger - smaller) / 2 + 1e-9);
      if (amount >= MULTI_COLUMN_AMOUNT) expect(error / amount, `value of ${amount}`).toBeLessThanOrEqual(0.105);
    }
  });

  it('shows a full stack of the largest chip for amounts beyond what the cap can be worth', () => {
    const columns = composePlayerStack(5_000_000);

    expect(stackChipCount(columns)).toBe(PLAYER_STACK_MAX_CHIPS);
    expect(columns.flat().every((denomination) => denomination === CHIP_DENOMINATIONS[0])).toBe(true);
  });

  it('uses two neighbouring chips at most, the larger ones filling the back columns and topping the one they share', () => {
    for (const amount of AMOUNTS) {
      const columns = composePlayerStack(amount);
      const denominations = [...new Set(columns.flat())];
      expect(denominations.length, `chips of ${amount}`).toBeLessThanOrEqual(2);
      for (const denomination of denominations) expect(CHIP_DENOMINATIONS).toContain(denomination);

      const largerShares = columns.map((column) => column.filter((denomination) => denomination === Math.max(...denominations)).length / column.length);
      expect(largerShares, `columns of ${amount}`).toEqual([...largerShares].sort((a, b) => b - a));
      expect(largerShares.filter((share) => share > 0 && share < 1).length, `mixed columns of ${amount}`).toBeLessThanOrEqual(1);
      for (const column of columns) expect(column, `column of ${amount}`).toEqual([...column].sort((a, b) => a - b));
    }
  });

  it('shows a single large chip on top of its column, where the game camera sees it', () => {
    const columns = composePlayerStack(2_400);

    expect(columns[0][columns[0].length - 1]).toBe(500);
    expect(columns.flat().filter((denomination) => denomination === 500)).toHaveLength(1);
  });

  it('starts a 2 000 stack as four even columns of 100s and keeps their colour through a three blind bet', () => {
    const starting = composePlayerStack(2_000);
    const afterBet = composePlayerStack(1_940);

    expect(starting).toEqual([0, 1, 2, 3].map(() => [100, 100, 100, 100, 100]));
    expect(afterBet.flat().every((denomination) => denomination === 100)).toBe(true);
  });

  it('repaints at most two chips when the amount moves by 1 %, so a bet or a win never recolours the stack', () => {
    for (let index = 1; index < AMOUNTS.length; index++) {
      const before = composePlayerStack(AMOUNTS[index - 1]);
      const after = composePlayerStack(AMOUNTS[index]);
      const repainted = before.flatMap((column, columnIndex) =>
        column.filter((denomination, level) => after[columnIndex]?.[level] !== undefined && after[columnIndex][level] !== denomination),
      );
      expect(repainted.length, `${AMOUNTS[index - 1]} → ${AMOUNTS[index]}`).toBeLessThanOrEqual(2);
    }
  });

  it('gives the same stack for the same amount, so a rebuild never reshuffles the chips', () => {
    expect(composePlayerStack(1_995)).toEqual(composePlayerStack(1_995));
    expect(playerStackChips(1_995, 3)).toEqual(playerStackChips(1_995, 3));
  });
});

describe('player stack chips on the felt', () => {
  it('stands every column on the felt, each chip exactly one chip height above the one below', () => {
    const chips = playerStackChips(12_345, 5);
    const byColumn = new Map<string, number[]>();
    for (const chip of chips) {
      const key = `${Math.round(chip.x * 100)}:${Math.round(chip.z * 100)}`;
      byColumn.set(key, [...(byColumn.get(key) ?? []), chip.y]);
    }
    expect(byColumn.size).toBe(PLAYER_STACK_MAX_COLUMNS);
    for (const heights of byColumn.values()) {
      expect(heights[0]).toBe(0);
      heights.forEach((height, level) => expect(height).toBeCloseTo(level * CHIP_HEIGHT, 9));
    }
  });

  it('keeps every chip inside the stack radius used by the layout checks', () => {
    for (const amount of [20, 60, 150, 640, 2_000, 9_870, 50_000, 300_000]) {
      for (const chip of playerStackChips(amount, 7)) {
        expect(Math.hypot(chip.x, chip.z) + CHIP_DIAMETER / 2).toBeLessThanOrEqual(PLAYER_STACK_RADIUS + 1e-9);
      }
    }
  });

  it('centres every footprint, so a stack reaches as far toward the table as toward the player', () => {
    for (const amount of [20, 60, 150, 2_000]) {
      const zs = placeColumns(composePlayerStack(amount)).map((column) => column.z);
      expect(Math.max(...zs) + Math.min(...zs), `footprint of ${amount}`).toBeCloseTo(0, 9);
    }
  });

  it('places the columns apart so no two chips of different columns overlap', () => {
    for (const amount of [60, 150, 10_000]) {
      const columns = placeColumns(composePlayerStack(amount));
      for (let first = 0; first < columns.length; first++) {
        for (let second = first + 1; second < columns.length; second++) {
          const distance = Math.hypot(columns[first].x - columns[second].x, columns[first].z - columns[second].z);
          expect(distance).toBeGreaterThanOrEqual(CHIP_DIAMETER);
        }
      }
    }
  });

  it('places exactly the composed chips, column by column', () => {
    const columns = composePlayerStack(4_321);
    const chips = placeChips(placeColumns(columns), 2);

    expect(chips.map((chip) => chip.denomination)).toEqual(columns.flat());
  });
});
