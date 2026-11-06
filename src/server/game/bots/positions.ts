export type PositionName = 'early' | 'hijack' | 'cutoff' | 'button' | 'smallBlind' | 'bigBlind';

/**
 * Share of all starting hands a solid player opens when everybody before folded, by position (6-max standards).
 * The bots open from it and read other players' opens against it.
 */
export const STANDARD_OPEN_WIDTH: Readonly<Record<PositionName, number>> = {
  early: 0.14,
  hijack: 0.19,
  cutoff: 0.27,
  button: 0.43,
  smallBlind: 0.36,
  bigBlind: 0.25,
};

export interface SeatPosition {
  readonly name: PositionName;
  /** 0 for the first player to act after the flop. */
  readonly postflopOrder: number;
}

/**
 * Positions of the players dealt into a hand, given clockwise from the seat after the button.
 * Heads-up the button posts the small blind and still acts last after the flop.
 */
export function assignPositions(
  seatsFromButtonNext: readonly number[],
  buttonSeat: number,
  bigBlindSeat: number,
): Map<number, SeatPosition> {
  const positions = new Map<number, SeatPosition>();
  const playerCount = seatsFromButtonNext.length;
  seatsFromButtonNext.forEach((seat, postflopOrder) => {
    const seatsBeforeButton = playerCount - 1 - postflopOrder;
    positions.set(seat, { name: positionName(seat, seatsBeforeButton, buttonSeat, bigBlindSeat, playerCount), postflopOrder });
  });
  return positions;
}

function positionName(
  seat: number,
  seatsBeforeButton: number,
  buttonSeat: number,
  bigBlindSeat: number,
  playerCount: number,
): PositionName {
  if (seat === buttonSeat) return 'button';
  if (seat === bigBlindSeat) return 'bigBlind';
  if (seatsBeforeButton === playerCount - 1) return 'smallBlind';
  if (seatsBeforeButton === 1) return 'cutoff';
  if (seatsBeforeButton === 2) return 'hijack';
  return 'early';
}

export function isLatePosition(name: PositionName): boolean {
  return name === 'cutoff' || name === 'button';
}
