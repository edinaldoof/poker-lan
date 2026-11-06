/**
 * How a player's chips are laid out on the felt: which chips, in which columns, where each column stands.
 * Pure functions only, so the look of a stack is decided (and tested) without a renderer.
 *
 * The silhouette (how many columns, how tall each one) depends on the chip budget alone, and the budget never
 * shrinks when the amount grows, so a bigger stack always covers the outline of a smaller one. The amount only
 * decides the colours: chips of the two denominations around the average chip, the larger ones in the back columns.
 */
import { CHIP_DENOMINATIONS, CHIP_DIAMETER, CHIP_HEIGHT, type ChipPlacement } from './ChipFactory';

export const PLAYER_STACK_MAX_COLUMNS = 4;
export const PLAYER_STACK_MAX_COLUMN_HEIGHT = 10;
export const PLAYER_STACK_MAX_CHIPS = PLAYER_STACK_MAX_COLUMNS * PLAYER_STACK_MAX_COLUMN_HEIGHT;

/** About this many chips are added each time the amount doubles (see playerStackChipBudget). */
export const PLAYER_STACK_CHIPS_PER_DOUBLING = 6;
/** Scale of the budget curve: a 2 000 chip starting stack shows 20 chips, and the cap is reached near 22 000. */
const BUDGET_UNIT = 230;
/** Budgets up to these values stand in one, two and three columns; anything bigger uses all four. */
const COLUMN_OPENING_BUDGETS = [1, 3, 7];
/** Chips of 1 are left out of stacks worth this much or more: they would only add stray chips of change. */
const SINGLES_LIMIT = 25;

/** Columns stand almost touching, like chips racked by hand. */
export const STACK_COLUMN_SPACING = CHIP_DIAMETER * 1.01;
const POSITION_JITTER = 0.0007;
const YAW_JITTER = 0.12;

/**
 * Radius of the footprint of the largest stack (the 2 x 2 block of columns) around its anchor, jitter included.
 * Layout checks use it as the stack's bounding circle on the felt.
 */
export const PLAYER_STACK_RADIUS = ((STACK_COLUMN_SPACING + 2 * POSITION_JITTER) * Math.SQRT2) / 2 + CHIP_DIAMETER / 2;

/** One column of a stack: the denomination of each chip, bottom chip first. */
export type StackColumn = readonly number[];

/** A column placed in the seat's frame: +x to the player's right, +z toward the player (away from the table). */
export interface PlacedColumn {
  chips: StackColumn;
  x: number;
  z: number;
}

/** One chip of a stack in the stack's frame, base on y = 0. */
export type PlacedChip = ChipPlacement;

/**
 * How many chips a stack shows. A real stack grows linearly, which would make a 50 000 chip stack 25 times taller
 * than a 2 000 one; here every doubling of the amount adds PLAYER_STACK_CHIPS_PER_DOUBLING chips instead, so
 *   20 → 1 chip, 100 → 3, 500 → 10, 1 000 → 15, 2 000 → 20, 4 000 → 25, 10 000 → 33, 22 000 and more → 40 (the
 *   cap: four columns of ten, 4.6 cm high).
 * The result never decreases when the amount grows.
 */
export function playerStackChipBudget(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const chips = Math.round(PLAYER_STACK_CHIPS_PER_DOUBLING * Math.log2(1 + amount / BUDGET_UNIT));
  return Math.min(PLAYER_STACK_MAX_CHIPS, Math.max(1, chips));
}

function columnCountFor(budget: number): number {
  const opened = COLUMN_OPENING_BUDGETS.filter((limit) => budget > limit).length;
  return Math.min(PLAYER_STACK_MAX_COLUMNS, opened + 1);
}

/** outlines[budget] = column heights, back columns first. Built chip by chip, see playerStackOutline. */
const outlines: number[][] = [[]];
for (let budget = 1; budget <= PLAYER_STACK_MAX_CHIPS; budget++) {
  const previous = outlines[budget - 1];
  if (columnCountFor(budget) > previous.length) {
    outlines.push([...previous, 1]);
    continue;
  }
  const lowest = previous.indexOf(Math.min(...previous));
  outlines.push(previous.map((height, column) => (column === lowest ? height + 1 : height)));
}

/**
 * Heights of the columns of a stack of `budget` chips, back columns first. Each extra chip either opens the next
 * column or tops the lowest one (the backmost among equals), so the outline of a budget always contains the outline
 * of every smaller budget: neither the column count nor any column's height ever drops as the stack grows.
 *   1 → [1], 3 → [2, 1], 7 → [3, 2, 2], 8 → [3, 2, 2, 1], 20 → [5, 5, 5, 5], 40 → [10, 10, 10, 10].
 */
export function playerStackOutline(budget: number): readonly number[] {
  const clamped = Math.max(0, Math.min(PLAYER_STACK_MAX_CHIPS, Math.floor(budget)));
  return outlines[clamped];
}

/** The two neighbouring denominations around the average chip `averageChip`, larger first (the same one twice at the ends). */
function denominationPair(amount: number, averageChip: number): [number, number] {
  const usable = CHIP_DENOMINATIONS.filter((denomination) => denomination > 1 || amount < SINGLES_LIMIT);
  const lowerIndex = usable.findIndex((denomination) => denomination <= averageChip);
  if (lowerIndex === -1) return [usable[usable.length - 1], usable[usable.length - 1]];
  return [usable[Math.max(0, lowerIndex - 1)], usable[lowerIndex]];
}

/**
 * The chips of a player's stack, column by column (back columns first, each listed bottom chip first): the outline
 * of playerStackChipBudget(amount), filled with the two denominations that bracket the average chip, as many of the
 * larger one as bring the total closest to the amount. The larger chips fill the back columns, so at most one column
 * holds both, and there they sit on top: the game camera looks down on the stacks and sees their top chips, so even a
 * single large chip shows. Within half the step between the two chips of the amount; an amount beyond what the cap
 * can show in the largest chip shows that full stack. Empty for no chips.
 *
 * As the amount changes, the chips change colour one at a time: when the average chip crosses a denomination every
 * chip is that denomination on both sides of the change, so a bet or a win never repaints the whole stack.
 */
export function composePlayerStack(amount: number): StackColumn[] {
  const budget = playerStackChipBudget(amount);
  if (budget === 0) return [];
  const [larger, smaller] = denominationPair(amount, amount / budget);
  const largerCount = larger === smaller ? budget : Math.round((amount - budget * smaller) / (larger - smaller));
  const clampedLargerCount = Math.max(0, Math.min(budget, largerCount));

  let largerLeft = clampedLargerCount;
  return playerStackOutline(budget).map((height) => {
    const largerInColumn = Math.min(height, largerLeft);
    largerLeft -= largerInColumn;
    return [...Array<number>(height - largerInColumn).fill(smaller), ...Array<number>(largerInColumn).fill(larger)];
  });
}

/** Total value the chips of a composition are worth. */
export function stackValue(columns: readonly StackColumn[]): number {
  return columns.reduce((total, column) => total + column.reduce((sum, denomination) => sum + denomination, 0), 0);
}

export function stackChipCount(columns: readonly StackColumn[]): number {
  return columns.reduce((total, column) => total + column.length, 0);
}

/** Height of the tallest column of a composition. */
export function stackHeight(columns: readonly StackColumn[]): number {
  return columns.reduce((tallest, column) => Math.max(tallest, column.length), 0) * CHIP_HEIGHT;
}

/**
 * Column positions in units of STACK_COLUMN_SPACING, centred on the anchor (the footprint's bounding box, so the
 * stack reaches equally far toward the player and toward the table). The back columns stand nearest the player,
 * as players keep their big chips behind the rest.
 */
const TRIANGLE_HALF_DEPTH = Math.sqrt(3) / 4;
const COLUMN_SLOTS: Record<number, readonly { x: number; z: number }[]> = {
  1: [{ x: 0, z: 0 }],
  2: [
    { x: -0.5, z: 0 },
    { x: 0.5, z: 0 },
  ],
  3: [
    { x: -0.5, z: TRIANGLE_HALF_DEPTH },
    { x: 0.5, z: TRIANGLE_HALF_DEPTH },
    { x: 0, z: -TRIANGLE_HALF_DEPTH },
  ],
  4: [
    { x: -0.5, z: 0.5 },
    { x: 0.5, z: 0.5 },
    { x: -0.5, z: -0.5 },
    { x: 0.5, z: -0.5 },
  ],
};

export function placeColumns(columns: readonly StackColumn[]): PlacedColumn[] {
  const slots = COLUMN_SLOTS[columns.length] ?? [];
  return columns.slice(0, slots.length).map((chips, index) => ({
    chips,
    x: slots[index].x * STACK_COLUMN_SPACING,
    z: slots[index].z * STACK_COLUMN_SPACING,
  }));
}

/** Deterministic 0..1 noise, so a rebuilt stack looks exactly like the one it replaces. */
function seededUnit(seed: number): number {
  let state = (seed + 0x6d2b79f5) | 0;
  state = Math.imul(state ^ (state >>> 15), state | 1);
  state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
  return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
}

function jitter(seed: number, amplitude: number): number {
  return (seededUnit(seed) * 2 - 1) * amplitude;
}

/** Every chip of a stack, bottom to top per column, slightly out of true like chips stacked by hand. */
export function placeChips(columns: readonly PlacedColumn[], seed: number): PlacedChip[] {
  return columns.flatMap((column, columnIndex) =>
    column.chips.map((denomination, level) => {
      const chipSeed = seed * 104729 + columnIndex * 7919 + level * 131;
      return {
        denomination,
        x: column.x + jitter(chipSeed + 1, POSITION_JITTER),
        y: level * CHIP_HEIGHT,
        z: column.z + jitter(chipSeed + 2, POSITION_JITTER),
        yaw: jitter(chipSeed + 3, YAW_JITTER),
      };
    }),
  );
}

/** The chips of a seat's stack worth `amount`, in the stack's frame (see placeChips). */
export function playerStackChips(amount: number, seat: number): PlacedChip[] {
  return placeChips(placeColumns(composePlayerStack(amount)), seat);
}
