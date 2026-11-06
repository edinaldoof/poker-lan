import { MathUtils } from 'three';

export type HandSide = 'left' | 'right';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Articulation of one hand. Curls are 0 = straight and 1 = a loose fist; the rig clamps them to HAND_SHAPE_LIMITS. */
export interface HandShape {
  thumb: number;
  /** Swings the thumb across the palm: 0 = beside the index finger, 1 = under the other fingers. */
  thumbOpposition: number;
  index: number;
  middle: number;
  ring: number;
  pinky: number;
  /** Fans the fingers apart: 0 = together, 1 = wide open. */
  spread: number;
}

export interface PoseState {
  /** Forward lean of the spine, radians. */
  lean: number;
  /** Forward bend of the pelvis with the legs kept upright, radians: lets the arms reach the table top. */
  hinge: number;
  leftHand: Vec3Like;
  rightHand: Vec3Like;
  /** 0 = palm down, positive = turning the palm up. */
  leftRoll: number;
  rightRoll: number;
  /** Wrist extension: positive bends the fingers back toward the back of the hand, negative flexes them toward the palm. */
  leftWrist: number;
  rightWrist: number;
  leftShape: HandShape;
  rightShape: HandShape;
  /** Extra head pitch down from a nod, radians. */
  nod: number;
}

export type PoseGoal = Partial<Omit<PoseState, 'leftHand' | 'rightHand' | 'leftShape' | 'rightShape'>> & {
  leftHand?: Vec3Like;
  rightHand?: Vec3Like;
  leftShape?: HandShape;
  rightShape?: HandShape;
};

export const REST_LEAN = 0.2;
export const REST_HINGE = 0;
export const REST_HAND_HEIGHT = 1.06;
export const REST_HAND_FORWARD = 0.27;
export const REST_HAND_SPREAD = 0.16;

export const HAND_SHAPE_LIMITS: Record<keyof HandShape, { min: number; max: number }> = {
  thumb: { min: 0, max: 1.1 },
  thumbOpposition: { min: 0, max: 1 },
  index: { min: 0, max: 1.2 },
  middle: { min: 0, max: 1.2 },
  ring: { min: 0, max: 1.2 },
  pinky: { min: 0, max: 1.2 },
  spread: { min: -0.2, max: 1 },
};

export const HAND_SHAPES = {
  relaxed: { thumb: 0.22, thumbOpposition: 0.18, index: 0.3, middle: 0.4, ring: 0.5, pinky: 0.6, spread: 0.04 },
  flat: { thumb: 0.05, thumbOpposition: 0, index: 0.04, middle: 0.04, ring: 0.05, pinky: 0.06, spread: 0.1 },
  /** Fingers fanned and straight, ready to rake chips. */
  spread: { thumb: 0.02, thumbOpposition: 0, index: 0.06, middle: 0.04, ring: 0.06, pinky: 0.08, spread: 1 },
  /** Fingers curled in to drag chips back. */
  rake: { thumb: 0.3, thumbOpposition: 0.1, index: 0.55, middle: 0.6, ring: 0.65, pinky: 0.7, spread: 0.2 },
  /** Thumb and index (with the middle finger behind) closed on the edge of a card. */
  pinch: { thumb: 0.22, thumbOpposition: 0.7, index: 0.9, middle: 0.7, ring: 0.6, pinky: 0.65, spread: 0.02 },
  /** Fingers snapped open after a card leaves them. */
  release: { thumb: 0.1, thumbOpposition: 0.25, index: 0.08, middle: 0.14, ring: 0.3, pinky: 0.4, spread: 0.3 },
  /** Loosely wrapped around a deck with the thumb resting on top. */
  hold: { thumb: 0.28, thumbOpposition: 0.6, index: 0.5, middle: 0.62, ring: 0.7, pinky: 0.78, spread: 0.05 },
  /** The cup of a hand riffling chips. */
  cupped: { thumb: 0.4, thumbOpposition: 0.55, index: 0.62, middle: 0.7, ring: 0.76, pinky: 0.82, spread: 0.1 },
  point: { thumb: 0.3, thumbOpposition: 0.4, index: 0.04, middle: 0.95, ring: 1, pinky: 1, spread: 0 },
  /** Open hand with a slightly cupped palm, for presenting or welcoming. */
  open: { thumb: 0.12, thumbOpposition: 0.05, index: 0.12, middle: 0.16, ring: 0.2, pinky: 0.26, spread: 0.35 },
} as const satisfies Record<string, HandShape>;

export type HandShapeName = keyof typeof HAND_SHAPES;

export function handShape(name: HandShapeName): HandShape {
  return { ...HAND_SHAPES[name] };
}

export function clampHandShape(shape: HandShape): HandShape {
  const clamped = { ...shape };
  for (const key of Object.keys(HAND_SHAPE_LIMITS) as (keyof HandShape)[]) {
    clamped[key] = MathUtils.clamp(shape[key], HAND_SHAPE_LIMITS[key].min, HAND_SHAPE_LIMITS[key].max);
  }
  return clamped;
}

export function restHandTarget(side: HandSide): Vec3Like {
  const sign = side === 'left' ? 1 : -1;
  return { x: sign * REST_HAND_SPREAD, y: REST_HAND_HEIGHT, z: REST_HAND_FORWARD };
}

export function createRestPose(): PoseState {
  return {
    lean: REST_LEAN,
    hinge: REST_HINGE,
    leftHand: restHandTarget('left'),
    rightHand: restHandTarget('right'),
    leftRoll: 0,
    rightRoll: 0,
    leftWrist: 0,
    rightWrist: 0,
    leftShape: handShape('relaxed'),
    rightShape: handShape('relaxed'),
    nod: 0,
  };
}

export function clonePose(pose: PoseState): PoseState {
  return {
    ...pose,
    leftHand: { ...pose.leftHand },
    rightHand: { ...pose.rightHand },
    leftShape: { ...pose.leftShape },
    rightShape: { ...pose.rightShape },
  };
}

/** Applies a goal on top of a pose, the way a finished tween would leave it. */
export function applyGoal(pose: PoseState, goal: PoseGoal): PoseState {
  const next = clonePose(pose);
  const { leftHand, rightHand, leftShape, rightShape, ...scalars } = goal;
  Object.assign(next, scalars);
  if (leftHand) next.leftHand = { ...leftHand };
  if (rightHand) next.rightHand = { ...rightHand };
  if (leftShape) next.leftShape = { ...leftShape };
  if (rightShape) next.rightShape = { ...rightShape };
  return next;
}
