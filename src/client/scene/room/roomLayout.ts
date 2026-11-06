import { Vector3 } from 'three';
import { RAIL_SHAPE, RING_POSITIONS, SEAT_SLOTS, ringPositionForSlot, stadiumPoint } from '../SeatLayout';

/**
 * Floor plan of the card room, in table meters (table centre at the origin, the viewer's side at +Z).
 * Pure data and maths only, so the composition can be checked without WebGL.
 */

/** Side walls at x = ±ROOM_HALF_WIDTH, end walls at z = ±ROOM_HALF_DEPTH. */
export const ROOM_HALF_WIDTH = 6.4;
export const ROOM_HALF_DEPTH = 5.8;
export const CEILING_HEIGHT = 3.5;

export const SKIRTING_HEIGHT = 0.16;
/** Top of the wood panelling, where the dado rail runs. */
export const WAINSCOT_HEIGHT = 1.02;
export const CROWN_HEIGHT = 0.16;

export type WallSide = 'north' | 'south' | 'east' | 'west';

export interface WallSpec {
  side: WallSide;
  /** Middle of the wall, on the floor. */
  center: Vector3;
  /** Unit vector from the wall into the room. */
  inward: Vector3;
  /** Unit vector along the wall: to the right of someone standing in the room and facing the wall. */
  along: Vector3;
  length: number;
}

function createWall(side: WallSide, inwardX: number, inwardZ: number): WallSpec {
  const inward = new Vector3(inwardX, 0, inwardZ);
  const center = new Vector3(-inwardX * ROOM_HALF_WIDTH, 0, -inwardZ * ROOM_HALF_DEPTH);
  const length = inwardX === 0 ? 2 * ROOM_HALF_WIDTH : 2 * ROOM_HALF_DEPTH;
  return { side, center, inward, along: new Vector3(inwardZ, 0, -inwardX), length };
}

export const WALLS: Readonly<Record<WallSide, WallSpec>> = Object.freeze({
  north: createWall('north', 0, 1),
  south: createWall('south', 0, -1),
  east: createWall('east', -1, 0),
  west: createWall('west', 1, 0),
});

/** rotation.y that turns an object authored facing +Z so it faces `direction`. */
export function yawFacing(direction: Vector3): number {
  return Math.atan2(direction.x, direction.z);
}

export interface Placement {
  position: Vector3;
  yaw: number;
}

/**
 * A piece standing with its back against a wall. `backDepth` is how far the model's origin sits in front of its
 * own back face; `offsetAlong` slides it along the wall from the middle.
 */
export function placeAgainstWall(wall: WallSpec, offsetAlong: number, backDepth: number, height = 0): Placement {
  const position = wall.center
    .clone()
    .addScaledVector(wall.along, offsetAlong)
    .addScaledVector(wall.inward, backDepth);
  position.y = height;
  return { position, yaw: yawFacing(wall.inward) };
}

export type RoomModelName =
  | 'chair'
  | 'chandelier'
  | 'cabinet'
  | 'sofa'
  | 'clock'
  | 'pictureFrame'
  | 'console';

/** Measured on the Poly Haven models (meters): every one faces +Z and stands on y = 0 with its back at -backDepth. */
export const MODEL_FOOTPRINTS: Readonly<Record<RoomModelName, { width: number; depth: number; height: number; backDepth: number }>> =
  Object.freeze({
    chair: { width: 0.434, depth: 0.576, height: 0.975, backDepth: 0.331 },
    chandelier: { width: 0.78, depth: 0.79, height: 1.041, backDepth: 0 },
    cabinet: { width: 1.72, depth: 1.016, height: 2.361, backDepth: 0.458 },
    sofa: { width: 2.732, depth: 0.926, height: 1.119, backDepth: 0.464 },
    clock: { width: 0.626, depth: 0.427, height: 2.191, backDepth: 0.188 },
    pictureFrame: { width: 0.603, depth: 0.022, height: 0.464, backDepth: 0 },
    console: { width: 1.543, depth: 0.589, height: 0.949, backDepth: 0.338 },
  });

/** Furniture stands clear of the dado rail and the panel mouldings; paintings hang almost flat on the wallpaper. */
const FURNITURE_WALL_GAP = 0.05;
const PAINTING_WALL_GAP = 0.012;

export interface PropSpec {
  model: Exclude<RoomModelName, 'chair' | 'chandelier'>;
  wall: WallSide;
  offsetAlong: number;
  /** Height of the model origin (paintings hang, everything else stands on the floor). */
  height: number;
  scale: number;
  /** Paintings only: which part of the canvas image is shown, so the three frames read as different works. */
  canvasCrop?: CanvasCrop;
}

/** Window into the painting, as fractions of the painted area (0..1 from its left and top edges). */
export interface CanvasCrop {
  left: number;
  top: number;
  width: number;
}

/**
 * Composition: the console under the largest painting on the wall behind the dealer (the lobby's opening view),
 * the sofa under a painting on the west wall, the gothic cabinet facing it on the east wall, and the clock with
 * the third painting on the wall behind the viewer.
 */
export const PROP_SPECS: readonly PropSpec[] = Object.freeze([
  { model: 'console', wall: 'north', offsetAlong: 0, height: 0, scale: 1 },
  {
    model: 'pictureFrame',
    wall: 'north',
    offsetAlong: 0,
    height: 1.98,
    scale: 2.3,
    canvasCrop: { left: 0, top: 0, width: 1 },
  },
  { model: 'sofa', wall: 'west', offsetAlong: 0, height: 0, scale: 1 },
  {
    model: 'pictureFrame',
    wall: 'west',
    offsetAlong: 0,
    height: 2.05,
    scale: 1.9,
    canvasCrop: { left: 0.02, top: 0.12, width: 0.55 },
  },
  { model: 'cabinet', wall: 'east', offsetAlong: 0, height: 0, scale: 1 },
  { model: 'clock', wall: 'south', offsetAlong: -1.6, height: 0, scale: 1 },
  {
    model: 'pictureFrame',
    wall: 'south',
    offsetAlong: 1.2,
    height: 1.85,
    scale: 1.7,
    canvasCrop: { left: 0.45, top: 0.05, width: 0.55 },
  },
]);

/** The canvas of the frame model only uses this part of its texture (glTF UVs, v from the top). */
const CANVAS_UV_AREA = Object.freeze({ u: 0.0323, v: 0.1253, width: 0.9363, height: 0.6949 });

export interface TextureWindow {
  repeat: number;
  offsetU: number;
  offsetV: number;
}

/** Texture repeat/offset that shows `crop` of the painting across the whole canvas (the crop keeps its aspect). */
export function canvasCropWindow(crop: CanvasCrop): TextureWindow {
  const area = CANVAS_UV_AREA;
  return {
    repeat: crop.width,
    offsetU: area.u + crop.left * area.width - area.u * crop.width,
    offsetV: area.v + crop.top * area.height - area.v * crop.width,
  };
}

export function placeProp(spec: PropSpec): Placement {
  const footprint = MODEL_FOOTPRINTS[spec.model];
  const gap = spec.model === 'pictureFrame' ? PAINTING_WALL_GAP : FURNITURE_WALL_GAP;
  return placeAgainstWall(WALLS[spec.wall], spec.offsetAlong, footprint.backDepth * spec.scale + gap, spec.height);
}

/** The coffered ceiling: beams split it into this many bays each way; the table lamp hangs in the middle bay. */
export const COFFERS_ALONG_X = 5;
export const COFFERS_ALONG_Z = 5;

/** Centre of a coffer bay, counted from the middle bay (0) outward. */
function cofferCenterX(bayFromMiddle: number): number {
  return (bayFromMiddle * 2 * ROOM_HALF_WIDTH) / COFFERS_ALONG_X;
}

/**
 * Two chandeliers flank the table along its long axis, each in the middle of a coffer bay. They hang clear of the
 * table lamp and outside the game camera's view on every screen shape.
 */
export const CHANDELIER_POSITIONS: readonly Vector3[] = Object.freeze([
  new Vector3(cofferCenterX(-1), CEILING_HEIGHT, 0),
  new Vector3(cofferCenterX(1), CEILING_HEIGHT, 0),
]);

/**
 * Everything hung from the ceiling is only drawn while the camera is below it: the game camera looks down from
 * above the ceiling, where the beams and chandeliers would cross the table.
 */
export function isCeilingVisibleFrom(cameraHeight: number): boolean {
  return cameraHeight < CEILING_HEIGHT - 0.05;
}

/** Wall sconces: height of the candle flame and their spots on each wall. */
export const SCONCE_HEIGHT = 1.88;
export const SCONCE_SPOTS: readonly { wall: WallSide; offsetAlong: number }[] = Object.freeze([
  { wall: 'north', offsetAlong: -1.55 },
  { wall: 'north', offsetAlong: 1.55 },
  { wall: 'west', offsetAlong: -2.05 },
  { wall: 'west', offsetAlong: 2.05 },
  { wall: 'east', offsetAlong: -1.55 },
  { wall: 'east', offsetAlong: 1.55 },
  { wall: 'south', offsetAlong: -0.4 },
  { wall: 'south', offsetAlong: 2.8 },
]);

export interface SconcePlacement {
  wall: WallSpec;
  /** Point on the wall surface behind the candle. */
  mount: Vector3;
  /** Centre of the candle flame. */
  flame: Vector3;
}

/** How far the candle of a sconce stands out from the wall. */
export const SCONCE_REACH = 0.16;
const SCONCE_FLAME_ABOVE_CUP = 0.2;

export function sconcePlacements(): SconcePlacement[] {
  return SCONCE_SPOTS.map(({ wall: side, offsetAlong }) => {
    const wall = WALLS[side];
    const mount = wall.center.clone().addScaledVector(wall.along, offsetAlong);
    mount.y = SCONCE_HEIGHT - SCONCE_FLAME_ABOVE_CUP;
    const flame = mount.clone().addScaledVector(wall.inward, SCONCE_REACH);
    flame.y = SCONCE_HEIGHT;
    return { wall, mount, flame };
  });
}

/** The patterned carpet is a rug in the middle of a plank floor; this is its half size. */
export const RUG_HALF_WIDTH = 4.3;
export const RUG_HALF_DEPTH = 3.7;

/** Chairs are pulled back from the padded rail by this much (measured from the rail's outer edge to the chair origin). */
export const CHAIR_SETBACK = 0.43;

export interface ChairPlacement extends Placement {
  slot: number;
  /** Unit vector (xz) from the table toward the chair. */
  outward: Vector3;
}

/**
 * How far a chair turns from square-on to the rail toward the table centre. On the long sides of the table a player
 * sits square to the rail; half a turn toward the middle makes the ring of chairs read as gathered around the game.
 */
const CHAIR_TURN_TOWARD_CENTER = 0.5;

/** One chair per seat slot, behind the rail and facing the table centre. The dealer's ring position has none. */
export function chairPlacements(): ChairPlacement[] {
  return Array.from({ length: SEAT_SLOTS }, (_, slot) => {
    const rail = stadiumPoint(ringPositionForSlot(slot) / RING_POSITIONS, RAIL_SHAPE.halfLength, RAIL_SHAPE.radius, RAIL_SHAPE.centerZ);
    const position = rail.point.clone().addScaledVector(rail.normal, CHAIR_SETBACK);
    const squareToRail = rail.normal.clone().negate();
    const towardCenter = position.clone().negate().normalize();
    const facing = squareToRail.lerp(towardCenter, CHAIR_TURN_TOWARD_CENTER).normalize();
    return { slot, position, yaw: yawFacing(facing), outward: rail.normal.clone() };
  });
}
