import { Vector3 } from 'three';

export const FELT_Y = 0.712;
export const RAIL_Y = 0.778;
export const SEAT_SLOTS = 8;
/** The ring has one more position than there are seats: the dealer stands at DEALER_RING_POSITION. */
export const RING_POSITIONS = 9;
export const DEALER_RING_POSITION = 5;

export interface StadiumShape {
  halfLength: number;
  radius: number;
  centerZ: number;
}

/** Felt slab outline. Its outer 0.145 m hides under the padded rail; see VISIBLE_FELT_SHAPE. */
export const FELT_SHAPE: StadiumShape = { halfLength: 0.66, radius: 0.635, centerZ: -0.02 };
/** Outer edge of the padded rail. */
export const RAIL_SHAPE: StadiumShape = { halfLength: 0.75, radius: 0.69, centerZ: 0 };
/** Opening of the rail measured on the 3D model: the part of the felt players can actually see. */
export const VISIBLE_FELT_SHAPE: StadiumShape = { halfLength: 0.72, radius: 0.49, centerZ: -0.02 };

const PLATE_OFFSET_OUTSIDE_RAIL = 0.07;
/**
 * Contract value (measured from FELT_SHAPE, not from the visible opening). With it, the outer end of a hole card
 * reaches ~8 mm past VISIBLE_FELT_SHAPE at slots 0 and 4 (~3 mm at the corner slots), i.e. slightly under the rail.
 */
const CARDS_INSET_FROM_FELT_EDGE = 0.23;
const BET_INSET_FROM_FELT_EDGE = 0.4;
const PLATE_HEIGHT_ABOVE_RAIL = 0.02;

/**
 * A player's chip stack stands on the felt on the player's left of the cards, at this distance from the cards.
 * Every seat keeps its stack on the same side, so between two seats there is only ever one stack; the side away
 * from the dealer's muck is the left one for the seat right of the dealer, which fixes it for everybody.
 * Its inset is midway between the rail opening (0.145 m inside the felt edge along the sides) and the gold betting
 * line (FeltTexture's BETTING_LINE_RADIUS, 0.295 m inside the edge): chips past that line would read as a bet. The
 * 2 x 2 block of columns, 0.12 m deep and turned square to the rail (stackYaw), keeps 15 mm of felt on both sides.
 */
const STACK_INSET_FROM_FELT_EDGE = 0.22;
const STACK_DISTANCE_FROM_CARDS = 0.225;
/** The viewer's cards are lifted and enlarged, so the viewer's stack stands farther out. */
const VIEWER_STACK_DISTANCE_FROM_CARDS = 0.3;
/**
 * The game camera looks down the table from the viewer's side, so the top of a full column shows about 2 cm farther
 * from the camera than its base. Where the ring runs toward the camera (the curved ends) the stack slides half of
 * that toward it, which leaves its silhouette as far from the cards above it on screen as from those below.
 */
const STACK_SILHOUETTE_SHIFT = 0.01;
const TANGENT_STEP = 1e-4;
/**
 * The dealer and blind pucks lie in front of the stack, near the betting line: beside the cards the stack and a
 * neighbour's cards leave no room for them on the curved ends of the table.
 */
const BUTTON_INSET_FROM_FELT_EDGE = 0.39;
const BUTTON_DISTANCE_FROM_CARDS = 0.15;
const VIEWER_BUTTON_DISTANCE_FROM_CARDS = 0.26;
const VIEWER_SLOT = 0;
/** Halving steps of the search along the ring: far below a tenth of a millimetre. */
const RING_SEARCH_STEPS = 40;

export interface SeatAnchor {
  slot: number;
  /** rotation.y so an object's local +Z points from the table center to the seat. */
  yaw: number;
  /** Name plate anchor, outside the rail. */
  plate: Vector3;
  /** Hole cards center on the felt. */
  cards: Vector3;
  /** Bet stack position on the felt. */
  bet: Vector3;
  /** Dealer/blind puck position on the felt, in front of the chip stack on the player's left. */
  button: Vector3;
  /** Centre of the player's own chip stack on the felt, beside the cards on the player's left. */
  stack: Vector3;
  /** rotation.y of the stack: local +Z along the felt's outward normal at the stack, so its columns face the rail. */
  stackYaw: number;
  /** Unit vector (xz) from the seat toward the table center. */
  inward: Vector3;
}

export function slotForSeat(seat: number, viewerSeat: number | null): number {
  const viewer = viewerSeat ?? 0;
  return (((seat - viewer) % SEAT_SLOTS) + SEAT_SLOTS) % SEAT_SLOTS;
}

export function seatForSlot(slot: number, viewerSeat: number | null): number {
  const viewer = viewerSeat ?? 0;
  return (((slot + viewer) % SEAT_SLOTS) + SEAT_SLOTS) % SEAT_SLOTS;
}

/**
 * Point on a stadium outline (two straights joined by two half circles), parameterised by arc length.
 * t = 0 is the +Z center and grows toward -X (clockwise on screen). `normal` points away from the table.
 * Both vectors live in the XZ plane (y = 0).
 */
export function stadiumPoint(
  t: number,
  halfLength: number,
  radius: number,
  centerZ = 0,
): { point: Vector3; normal: Vector3 } {
  const straight = 2 * halfLength;
  const arc = Math.PI * radius;
  const perimeter = 2 * straight + 2 * arc;
  const s = (t - Math.floor(t)) * perimeter;

  const bottomRightEnd = halfLength + arc + straight + arc;
  const leftArcEnd = halfLength + arc;
  const topEnd = leftArcEnd + straight;

  if (s <= halfLength) {
    return makeStadiumSample(-s, centerZ + radius, 0, 1);
  }
  if (s <= leftArcEnd) {
    const angle = (s - halfLength) / radius;
    const nx = -Math.sin(angle);
    const nz = Math.cos(angle);
    return makeStadiumSample(-halfLength + radius * nx, centerZ + radius * nz, nx, nz);
  }
  if (s <= topEnd) {
    return makeStadiumSample(-halfLength + (s - leftArcEnd), centerZ - radius, 0, -1);
  }
  if (s <= bottomRightEnd) {
    const angle = (s - topEnd) / radius;
    const nx = Math.sin(angle);
    const nz = -Math.cos(angle);
    return makeStadiumSample(halfLength + radius * nx, centerZ + radius * nz, nx, nz);
  }
  return makeStadiumSample(halfLength - (s - bottomRightEnd), centerZ + radius, 0, 1);
}

function makeStadiumSample(x: number, z: number, normalX: number, normalZ: number): { point: Vector3; normal: Vector3 } {
  return { point: new Vector3(x, 0, z), normal: new Vector3(normalX, 0, normalZ) };
}

/** Slots 0-4 keep their ring position; slots 5-7 skip the dealer's spot. */
export function ringPositionForSlot(slot: number): number {
  const wrapped = ((slot % SEAT_SLOTS) + SEAT_SLOTS) % SEAT_SLOTS;
  return wrapped < DEALER_RING_POSITION ? wrapped : wrapped + 1;
}

/** Point on the felt `inset` metres inside the felt edge at ring parameter t, with the felt's outward normal there. */
function insetRingSample(t: number, inset: number): { point: Vector3; normal: Vector3 } {
  const edge = stadiumPoint(t, FELT_SHAPE.halfLength, FELT_SHAPE.radius, FELT_SHAPE.centerZ);
  const point = edge.point.addScaledVector(edge.normal, -inset);
  point.y = FELT_Y;
  return { point, normal: edge.normal };
}

function insetRingPoint(t: number, inset: number): Vector3 {
  return insetRingSample(t, inset).point;
}

/**
 * Ring parameter of the point `inset` metres inside the felt edge on the player's left (growing t), `distance`
 * metres in a straight line from the seat's own point at that inset. It follows the ring rather than the tangent, so
 * on the curved ends the spot stays as far inside the rail as the seat itself.
 */
function besideSeatParameter(t: number, inset: number, distance: number): number {
  const origin = insetRingPoint(t, inset);
  let near = 0;
  let far = 1 / RING_POSITIONS;
  for (let step = 0; step < RING_SEARCH_STEPS; step++) {
    const middle = (near + far) / 2;
    if (insetRingPoint(t + middle, inset).distanceTo(origin) < distance) near = middle;
    else far = middle;
  }
  return t + near;
}

function besideSeat(t: number, inset: number, distance: number): Vector3 {
  return insetRingPoint(besideSeatParameter(t, inset, distance), inset);
}

/** Where the stack stands: beside the cards, nudged along the ring toward the camera where the ring faces it. */
function stackSample(t: number, distance: number): { point: Vector3; normal: Vector3 } {
  const point = besideSeat(t, STACK_INSET_FROM_FELT_EDGE, distance);
  const tangent = besideSeat(t, STACK_INSET_FROM_FELT_EDGE, distance + TANGENT_STEP).sub(point).normalize();
  const shifted = besideSeatParameter(t, STACK_INSET_FROM_FELT_EDGE, distance + STACK_SILHOUETTE_SHIFT * tangent.z);
  return insetRingSample(shifted, STACK_INSET_FROM_FELT_EDGE);
}

function buildSeatAnchor(slot: number): SeatAnchor {
  const t = ringPositionForSlot(slot) / RING_POSITIONS;
  const isViewer = slot === VIEWER_SLOT;
  const feltEdge = stadiumPoint(t, FELT_SHAPE.halfLength, FELT_SHAPE.radius, FELT_SHAPE.centerZ);
  const railEdge = stadiumPoint(t, RAIL_SHAPE.halfLength, RAIL_SHAPE.radius, RAIL_SHAPE.centerZ);

  const outward = feltEdge.normal;
  const inward = outward.clone().negate();

  const onFelt = (inset: number): Vector3 => {
    const point = feltEdge.point.clone().addScaledVector(inward, inset);
    point.y = FELT_Y;
    return point;
  };

  const cards = onFelt(CARDS_INSET_FROM_FELT_EDGE);
  const stack = stackSample(t, isViewer ? VIEWER_STACK_DISTANCE_FROM_CARDS : STACK_DISTANCE_FROM_CARDS);
  const plate = railEdge.point.clone().addScaledVector(railEdge.normal, PLATE_OFFSET_OUTSIDE_RAIL);
  plate.y = RAIL_Y + PLATE_HEIGHT_ABOVE_RAIL;

  return {
    slot,
    yaw: Math.atan2(outward.x, outward.z),
    plate,
    cards,
    bet: onFelt(BET_INSET_FROM_FELT_EDGE),
    button: besideSeat(t, BUTTON_INSET_FROM_FELT_EDGE, isViewer ? VIEWER_BUTTON_DISTANCE_FROM_CARDS : BUTTON_DISTANCE_FROM_CARDS),
    stack: stack.point,
    stackYaw: Math.atan2(stack.normal.x, stack.normal.z),
    inward,
  };
}

const seatAnchors: SeatAnchor[] = Array.from({ length: SEAT_SLOTS }, (_, slot) => buildSeatAnchor(slot));

/** Returns a fresh copy, so callers may mutate the vectors freely. */
export function getSeatAnchor(slot: number): SeatAnchor {
  if (!Number.isInteger(slot)) {
    throw new RangeError(`Invalid seat slot: ${slot}`);
  }
  const anchor = seatAnchors[((slot % SEAT_SLOTS) + SEAT_SLOTS) % SEAT_SLOTS];
  return {
    slot: anchor.slot,
    yaw: anchor.yaw,
    plate: anchor.plate.clone(),
    cards: anchor.cards.clone(),
    bet: anchor.bet.clone(),
    button: anchor.button.clone(),
    stack: anchor.stack.clone(),
    stackYaw: anchor.stackYaw,
    inward: anchor.inward.clone(),
  };
}

/**
 * These vectors are shared by every module, so they are frozen: a stray .add()/.copy() on one throws instead of
 * silently moving the spot for everybody. Callers that need to move a point must clone() it first.
 */
function sharedPosition(x: number, y: number, z: number): Vector3 {
  return Object.freeze(new Vector3(x, y, z));
}

export const COMMUNITY_POSITIONS: readonly Vector3[] = Object.freeze(
  Array.from({ length: 5 }, (_, index) => sharedPosition((index - 2) * 0.145, FELT_Y, -0.08)),
);

export const POT_POSITION = sharedPosition(0, FELT_Y, 0.075);

export const SIDE_POT_POSITIONS: readonly Vector3[] = Object.freeze(
  [-0.2, 0.2, -0.4, 0.4].map((offsetX) => sharedPosition(offsetX, FELT_Y, POT_POSITION.z)),
);

/**
 * How far the dealer's hip joint stands outside the padded rail. Measured on the dealer mesh: the front of the
 * thighs and the turned hip stay clear of the table slab (see tests/dealerLayout.test.ts).
 */
export const DEALER_RAIL_GAP = 0.16;

const dealerRailPoint = stadiumPoint(
  DEALER_RING_POSITION / RING_POSITIONS,
  RAIL_SHAPE.halfLength,
  RAIL_SHAPE.radius,
  RAIL_SHAPE.centerZ,
);

/** Floor point under the dealer's hips, behind the far rail at the dealer's ring position. */
export const DEALER_STAND_POSITION = sharedPosition(
  dealerRailPoint.point.x + dealerRailPoint.normal.x * DEALER_RAIL_GAP,
  0,
  dealerRailPoint.point.z + dealerRailPoint.normal.z * DEALER_RAIL_GAP,
);

/** rotation.y that turns the dealer model (it faces +Z) toward the middle of the table. */
export const DEALER_YAW = Math.atan2(-DEALER_STAND_POSITION.x, -DEALER_STAND_POSITION.z);

/** Where the speech bubble's anchor floats above the top of the dealer's head; Stage frames the bubble from it. */
export const DEALER_SPEECH_ANCHOR_RISE = 0.28;

/** Footprint of the chip tray after TableModel scales the model's tray (0.534 x 0.334 m) down to fit the felt. */
export const DEALER_TRAY_SIZE = Object.freeze({ width: 0.3, depth: 0.19 });
/** Center of the tray on the felt, straight in front of the dealer. */
export const DEALER_TRAY_POSITION = sharedPosition(0.35, FELT_Y, -0.39);
export const DEALER_TRAY_YAW = 0;

/** On the dealer's right hand side of the tray, between the tray and the community row. */
export const DECK_POSITION = sharedPosition(0.085, FELT_Y, -0.395);
/** On the dealer's left hand side of the tray. */
export const MUCK_POSITION = sharedPosition(0.64, FELT_Y, -0.375);

/** The two hole cards of a seat lie side by side, each turned slightly outward from the other. */
export const HOLE_FAN_OFFSET = 0.045;
export const HOLE_FAN_ANGLE = 0.09;

export const HERO_CARD_OFFSETS: number[] = [-0.086, 0.086];
export const HERO_CARD_LIFT = 0.035;
/** Radians the viewer's cards tilt toward the camera. */
export const HERO_CARD_TILT = 0.55;
