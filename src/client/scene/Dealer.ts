import gsap from 'gsap';
import {
  Group,
  MathUtils,
  Mesh,
  Object3D,
  Quaternion,
  Vector3,
  type LoadingManager,
  type Material,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DealerIdleScheduler, type DealerActivity, type IdleActionId } from './dealerIdle';
import { buildIdleScript, type GazeTarget, type IdleBuildContext, type IdleScript, type PropWindow } from './dealerIdleActions';
import {
  clampHandShape,
  clonePose,
  createRestPose,
  handShape,
  restHandTarget,
  type HandShape,
  type HandSide,
  type PoseGoal,
  type PoseState,
  type Vec3Like,
} from './dealerPose';
import { HELD_DECK_SIZE, createDealerProps, type DealerProps } from './dealerProps';
import { dealerSpringTuning, followTree, snapTree, stepSpring, zeroTreeLike } from './dealerSpring';
import { DEALER_SPEECH_ANCHOR_RISE, DEALER_STAND_POSITION, DEALER_YAW, DECK_POSITION, FELT_Y } from './SeatLayout';

export type { DealerActivity, HandSide, Vec3Like };

const DEALER_MODEL_URL = '/assets/dealer/dealer.glb';
const DEALER_ENV_MAP_INTENSITY = 0.6;

/** Fractions of a deal gesture: the card is pinched in the fingertips at the first, and leaves them at the second. */
export const DEAL_PICKUP_FRACTION = 0.34;
export const DEAL_RELEASE_FRACTION = 0.58;
export const DEAL_GESTURE_SECONDS = 0.42;

/** While dealing, the dealer keeps the deck in his left hand for this long after the last pitch. */
const DECK_HOLD_SECONDS = 1.1;
const DEAL_PICKUP_HAND: Vec3Like = { x: -0.04, y: 1.03, z: 0.33 };
const DEAL_DECK_HAND: Vec3Like = { x: 0.1, y: 1.0, z: 0.29 };
const DEAL_DECK_ROLL = 1;

const TABLE_CENTER = new Vector3(0, FELT_Y, 0);
/** The deck on the felt is bigger than the one in his hands: the prop shrinks as it is lifted. */
const FELT_DECK_SCALE = 1.5;
const DECK_LIFT_SPRING = { omega: 13, zeta: 1 };

const WORLD_DOWN = new Vector3(0, -1, 0);
const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Y = new Vector3(0, 1, 0);
const AXIS_Z = new Vector3(0, 0, 1);

// Dealer space: +Z is forward (the way the dealer faces), +Y up and +X toward the dealer's left hand.
const ELBOW_POLE_OUTWARD = 0.7;
const ELBOW_POLE_BACKWARD = -0.35;
/** How far the elbow trails behind a moving hand (metres of pole per m/s of hand speed), and its limit. */
const ELBOW_TRAIL_GAIN = 0.22;
const ELBOW_TRAIL_LIMIT = 0.5;

const MAX_LOOK_YAW = MathUtils.degToRad(75);
const MAX_LOOK_PITCH_UP = MathUtils.degToRad(24);
const MAX_LOOK_PITCH_DOWN = MathUtils.degToRad(26);
const NECK_LOOK_SHARE = 0.35;
const HEAD_LOOK_SECONDS = 0.14;
const EYE_LOOK_SECONDS = 0.06;
const MAX_EYE_YAW = MathUtils.degToRad(22);
const MAX_EYE_PITCH = MathUtils.degToRad(14);

const LEAN_SHARE_BY_SPINE = [0.4, 0.35, 0.25];
const BREATH_SECONDS = 4.2;
const SWAY_SECONDS = 9.5;
const BLINK_CLOSE_SECONDS = 0.07;
const BLINK_OPEN_SECONDS = 0.1;
const MAX_LID_CLOSE_ANGLE = MathUtils.degToRad(34);

/** Rotation of the three phalanges (radians) at a curl of 1. */
const FINGER_PHALANX_ANGLES = [0.7, 0.95, 0.6];
const THUMB_PHALANX_ANGLES = [0.35, 0.55, 0.6];
const THUMB_OPPOSITION_ANGLE = 0.55;
/** Fan angle at spread = 1, from the index to the pinky (the sign points toward the index side). */
const FINGER_SPREAD_ANGLES = [0.2, 0.03, -0.1, -0.26];
/** Palm-to-fingertip distance: where a card or a chip sits when it is held in the fingers. */
const GRIP_ADVANCE = 0.02;
const GRIPPED_CARD_SCALE = 0.62;

const FINGER_NAMES = ['index', 'middle', 'ring', 'pinky'] as const;
const FINGER_SEGMENTS = ['01', '02', '03'] as const;

const BONE_NAMES = [
  'hip',
  'spine_01',
  'spine_02',
  'spine_03',
  'neck',
  'head',
  'head_end',
  'eye_l',
  'eye_r',
  'eyelid_l',
  'eyelid_r',
  'upperleg_l',
  'upperleg_r',
] as const;

type BoneName = (typeof BONE_NAMES)[number];

interface ArmBones {
  side: HandSide;
  /** +1 for the dealer's left arm (model +X), -1 for the right arm. */
  sign: 1 | -1;
  upperArm: Object3D;
  lowerArm: Object3D;
  lowerArmTwist: Object3D | null;
  hand: Object3D;
  /** Index, middle, ring and pinky, each as its three phalanges. */
  fingerChains: Object3D[][];
  thumbChain: Object3D[];
  thumbTip: Object3D;
  indexTip: Object3D;
  middleBase: Object3D;
  middleTip: Object3D;
  upperLength: number;
  lowerLength: number;
  /** Sign of the hand bone's local Y axis that points out of the palm. */
  palmAxisSign: 1 | -1;
}

interface ActiveGesture {
  timeline: gsap.core.Timeline;
  settle: () => void;
}

export interface LookAngles {
  yaw: number;
  pitch: number;
}

/** What the dealer is told about the table so his idle business makes sense (who to glance at, whether there is a pot). */
export interface DealerAttention {
  seatPoints: readonly Vector3[];
  potPoint: Vector3 | null;
}

/** Elbow position that keeps both bones at their real length while the wrist reaches (or gets as near as it can to) the target. */
export interface ElbowSolution {
  elbow: Vector3;
  wrist: Vector3;
  /** Unit hinge axis of the elbow: dir x pole. */
  hinge: Vector3;
}

export function solveElbow(
  shoulder: Vector3,
  target: Vector3,
  upperLength: number,
  lowerLength: number,
  pole: Vector3,
): ElbowSolution {
  const toTarget = target.clone().sub(shoulder);
  const rawDistance = Math.max(toTarget.length(), 1e-6);
  const direction = toTarget.clone().divideScalar(rawDistance);
  const minimumReach = Math.abs(upperLength - lowerLength) + 0.01;
  const maximumReach = upperLength + lowerLength - 0.004;
  const distance = MathUtils.clamp(rawDistance, minimumReach, maximumReach);

  const along = (upperLength * upperLength - lowerLength * lowerLength + distance * distance) / (2 * distance);
  const height = Math.sqrt(Math.max(0, upperLength * upperLength - along * along));
  const poleOrthogonal = pole.clone().addScaledVector(direction, -pole.dot(direction));
  if (poleOrthogonal.lengthSq() < 1e-8) {
    poleOrthogonal.copy(WORLD_DOWN).addScaledVector(direction, -WORLD_DOWN.dot(direction));
  }
  poleOrthogonal.normalize();

  return {
    elbow: shoulder.clone().addScaledVector(direction, along).addScaledVector(poleOrthogonal, height),
    wrist: shoulder.clone().addScaledVector(direction, distance),
    hinge: new Vector3().crossVectors(direction, poleOrthogonal).normalize(),
  };
}

/** Yaw (about +Y, positive toward +X) and pitch (positive looking up) from a head position to a target, in dealer space. */
export function computeLookAngles(head: Vector3, target: Vector3): LookAngles {
  const toTarget = target.clone().sub(head);
  return {
    yaw: Math.atan2(toTarget.x, toTarget.z),
    pitch: Math.atan2(toTarget.y, Math.hypot(toTarget.x, toTarget.z)),
  };
}

export function clampLookAngles(angles: LookAngles): LookAngles {
  return {
    yaw: MathUtils.clamp(angles.yaw, -MAX_LOOK_YAW, MAX_LOOK_YAW),
    pitch: MathUtils.clamp(angles.pitch, -MAX_LOOK_PITCH_DOWN, MAX_LOOK_PITCH_UP),
  };
}

function smoothingFactor(deltaSeconds: number, timeConstant: number): number {
  return 1 - Math.exp(-deltaSeconds / timeConstant);
}

function requireObject(scene: Object3D, name: string): Object3D {
  const found = scene.getObjectByName(name);
  if (!found) {
    throw new Error(`Modelo do Juiz inválido: osso "${name}" não encontrado.`);
  }
  return found;
}

function signedAngleAround(from: Vector3, to: Vector3, axis: Vector3): number {
  const fromFlat = from.clone().addScaledVector(axis, -from.dot(axis));
  const toFlat = to.clone().addScaledVector(axis, -to.dot(axis));
  if (fromFlat.lengthSq() < 1e-10 || toFlat.lengthSq() < 1e-10) {
    return 0;
  }
  return Math.atan2(axis.dot(new Vector3().crossVectors(fromFlat, toFlat)), fromFlat.dot(toFlat));
}

function copyPoseInto(target: PoseState, source: PoseState): void {
  Object.assign(target.leftHand, source.leftHand);
  Object.assign(target.rightHand, source.rightHand);
  Object.assign(target.leftShape, source.leftShape);
  Object.assign(target.rightShape, source.rightShape);
  target.lean = source.lean;
  target.hinge = source.hinge;
  target.leftRoll = source.leftRoll;
  target.rightRoll = source.rightRoll;
  target.leftWrist = source.leftWrist;
  target.rightWrist = source.rightWrist;
  target.nod = source.nod;
}

/** The croupier: a skinned character posed procedurally (IK arms, articulated fingers, spring-smoothed motion, idle business, GSAP gestures). */
export class Dealer {
  readonly root = new Group();
  readonly speechAnchor = new Object3D();

  private readonly bones: Record<BoneName, Object3D>;
  private readonly arms: Record<HandSide, ArmBones>;
  private readonly bindRotations = new Map<Object3D, Quaternion>();
  private readonly materials: Material[] = [];
  private readonly props: DealerProps = createDealerProps();

  /** Where gestures and idle actions want the body to be; tweens write here. */
  private readonly pose: PoseState = createRestPose();
  /** What the rig actually shows: it follows `pose` through critically damped springs, so nothing ever snaps. */
  private readonly shown: PoseState = createRestPose();
  private readonly shownVelocity: PoseState = zeroTreeLike(createRestPose());
  /** The pose every gesture returns to: the rest pose, or the dealing stance while the deck is in his left hand. */
  private baseline: PoseState = createRestPose();
  private gesture: ActiveGesture | null = null;
  private nodTween: gsap.core.Timeline | null = null;
  private stanceTween: gsap.core.Animation | null = null;

  private readonly idleScheduler = new DealerIdleScheduler();
  private idleTimeline: gsap.core.Timeline | null = null;
  private idleGaze: GazeTarget | null = null;
  private idleDeck: PropWindow['mode'] | null = null;
  /** How the deck is held; it keeps the last grip while it eases back down to the felt. */
  private deckGrip: PropWindow['mode'] = 'left';
  private idleChips = false;
  private dealingDeckUntil = -1;
  private deckListener: ((held: boolean) => void) | null = null;
  private deckWasVisible = false;
  private readonly deckPresence = { value: 0, velocity: 0 };
  private attention: DealerAttention = { seatPoints: [], potPoint: null };
  private viewpoint: Object3D | null = null;
  private clock = 0;

  private readonly lookTarget = TABLE_CENTER.clone();
  private readonly look: LookAngles = { yaw: 0, pitch: 0 };
  private readonly eyes: LookAngles = { yaw: 0, pitch: 0 };

  private nextBlinkAt = 2;
  private blinkStartedAt = -1;
  private reducedMotion = false;
  private disposed = false;

  private readonly scratchA = new Vector3();
  private readonly scratchB = new Vector3();
  private readonly scratchC = new Vector3();
  private readonly scratchD = new Vector3();
  private readonly scratchE = new Vector3();
  private readonly scratchQuaternionA = new Quaternion();
  private readonly scratchQuaternionB = new Quaternion();
  private readonly scratchQuaternionC = new Quaternion();
  private readonly parentWorldRotation = new Quaternion();
  private readonly parentWorldRotationInverse = new Quaternion();
  private readonly dealerWorldRotation = new Quaternion();
  private readonly dealerWorldRotationInverse = new Quaternion();

  private constructor(scene: Group) {
    this.root.name = 'dealer';
    this.root.add(scene, this.speechAnchor, this.props.deck, this.props.chips);
    this.root.position.copy(DEALER_STAND_POSITION);
    this.root.rotation.y = DEALER_YAW;
    this.root.updateMatrixWorld(true);

    this.bones = Object.fromEntries(BONE_NAMES.map((name) => [name, requireObject(scene, name)])) as Record<BoneName, Object3D>;
    this.arms = { left: this.collectArm(scene, 'left'), right: this.collectArm(scene, 'right') };
    this.rememberBindPose(scene);
    this.prepareMeshes(scene);
    this.applyPose();
  }

  static async load(manager: LoadingManager): Promise<Dealer> {
    const gltf = await new GLTFLoader(manager).loadAsync(DEALER_MODEL_URL);
    return new Dealer(gltf.scene);
  }

  /** Wraps an already loaded character (the glTF scene, or a bare skeleton when no GPU is available). */
  static fromScene(scene: Group): Dealer {
    return new Dealer(scene);
  }

  /** Call every frame (Stage.onFrame): idle business, spring smoothing, look-at smoothing, then the rig is posed. */
  update(deltaSeconds: number, elapsedSeconds: number): void {
    if (this.disposed) {
      return;
    }
    const delta = Math.min(deltaSeconds, 0.1);
    this.clock += delta;
    this.releaseDeckAfterDealing();
    this.advanceIdle(delta);
    this.advanceDeckLift(delta);
    this.advanceSprings(delta);
    this.advanceLook(delta);
    this.advanceBlink(elapsedSeconds);
    this.applyPose(elapsedSeconds);
  }

  /** The head turns toward the point (clamped); null goes back to the middle of the table. Interrupts idle business. */
  lookAt(target: Vector3 | null): void {
    this.interruptIdle();
    this.lookTarget.copy(target ?? TABLE_CENTER);
  }

  /** Busier in the lobby and the waiting room, discreet during a hand. */
  setActivity(activity: DealerActivity): void {
    this.idleScheduler.setContext({ activity });
  }

  /** Occupied seats to glance at, and the pot (when there is one) to check. */
  setAttention(attention: DealerAttention): void {
    this.attention = attention;
    this.idleScheduler.setContext({ potVisible: attention.potPoint !== null });
  }

  /** The camera the dealer occasionally looks up at. */
  setViewpoint(viewpoint: Object3D | null): void {
    this.viewpoint = viewpoint;
  }

  /** Called when the deck appears in (or leaves) his hands, so the table can hide its own copy meanwhile. */
  onDeckHeldChange(listener: ((held: boolean) => void) | null): void {
    this.deckListener = listener;
  }

  /** A small welcoming gesture toward a seat where a player just sat down. */
  welcomeSeat(point: Vector3): void {
    if (this.disposed || this.gesture) {
      return;
    }
    this.interruptIdle();
    if (this.idleScheduler.request('welcome')) {
      this.startIdleAction('welcome', point);
    }
  }

  /** Jumps straight to a pose with no tween: for previews and for checking that a pose clears the table. */
  holdPose(pose: PoseState): void {
    copyPoseInto(this.pose, pose);
    snapTree(this.shown, this.shownVelocity, this.pose);
    this.applyPose(this.clock);
  }

  handWorldPosition(side: HandSide, out: Vector3): Vector3 {
    const { middleBase, middleTip } = this.arms[side];
    middleBase.getWorldPosition(this.scratchA);
    middleTip.getWorldPosition(this.scratchB);
    return out.copy(this.scratchA).add(this.scratchB).multiplyScalar(0.5);
  }

  /** Where a card held between the thumb and the fingertips sits: just beyond the pinch, so it leaves from the fingers. */
  gripWorldPosition(side: HandSide, out: Vector3): Vector3 {
    const { thumbTip, indexTip, hand } = this.arms[side];
    thumbTip.getWorldPosition(this.scratchA);
    indexTip.getWorldPosition(this.scratchB);
    hand.getWorldPosition(this.scratchC);
    out.copy(this.scratchA).add(this.scratchB).multiplyScalar(0.5);
    const outward = this.scratchD.copy(out).sub(this.scratchC).normalize();
    return out.addScaledVector(outward, GRIP_ADVANCE);
  }

  /** Scale a card should have while it sits in the fingers (the deck in his hands is smaller than the table's cards). */
  get grippedCardScale(): number {
    return GRIPPED_CARD_SCALE;
  }

  /** The right hand picks a card off the deck in his left hand, pinches it, flicks and releases it toward the target. */
  gestureDeal(target: Vector3, seconds = DEAL_GESTURE_SECONDS): Promise<void> {
    const direction = this.directionToward(target);
    const flick: Vec3Like = {
      x: DEAL_PICKUP_HAND.x + direction.x * 0.15,
      y: DEAL_PICKUP_HAND.y - 0.02,
      z: DEAL_PICKUP_HAND.z + 0.1 + Math.max(direction.z, 0) * 0.05,
    };
    const base = this.baseline;
    const windUp = seconds * 0.4;
    const release = seconds * DEAL_RELEASE_FRACTION;
    this.holdDeckForDealing();

    return this.runGesture((timeline) => {
      this.addKey(timeline, 0, windUp * 0.55, { lean: base.lean + 0.08, rightHand: DEAL_PICKUP_HAND, rightRoll: -0.1, rightWrist: 0.3, rightShape: handShape('open') }, 'power2.out');
      this.addKey(timeline, windUp * 0.45, windUp * 0.5, { rightShape: handShape('pinch') }, 'power2.inOut');
      this.addKey(timeline, windUp, release - windUp, { lean: base.lean + 0.13, rightHand: flick, rightRoll: 0.55, rightWrist: -0.3 }, 'power3.out');
      this.addKey(timeline, release, seconds * 0.1, { rightShape: handShape('release') }, 'power2.out');
      this.addKey(timeline, release + seconds * 0.06, seconds - release - seconds * 0.06, this.baselineGoal(['lean', 'rightHand', 'rightRoll', 'rightWrist', 'rightShape']), 'sine.inOut');
    });
  }

  /** Both hands open and reach toward the pot, then the fingers curl in and drag it back. */
  gestureCollect(seconds = 0.95): Promise<void> {
    const base = this.baseline;
    const anticipate = seconds * 0.12;
    const reach = seconds * 0.28;
    const sweep = seconds * 0.38;
    const reachAt = anticipate;
    const sweepAt = anticipate + reach;
    return this.runGesture((timeline) => {
      this.addKey(timeline, 0, anticipate, {
        lean: base.lean - 0.03,
        leftHand: { x: 0.19, y: 1.1, z: 0.3 },
        rightHand: { x: -0.19, y: 1.1, z: 0.3 },
        leftShape: handShape('open'),
        rightShape: handShape('open'),
      }, 'power1.out');
      this.addKey(timeline, reachAt, reach, {
        lean: base.lean + 0.2,
        hinge: 0.1,
        leftHand: { x: 0.22, y: 0.97, z: 0.5 },
        rightHand: { x: -0.22, y: 0.97, z: 0.5 },
        leftShape: handShape('spread'),
        rightShape: handShape('spread'),
      }, 'power2.out');
      this.addKey(timeline, sweepAt, sweep, {
        lean: base.lean + 0.1,
        hinge: 0.05,
        leftHand: { x: 0.07, y: 1, z: 0.3 },
        rightHand: { x: -0.07, y: 1, z: 0.3 },
        leftShape: handShape('rake'),
        rightShape: handShape('rake'),
      }, 'power2.inOut');
      this.addKey(timeline, sweepAt + sweep, seconds - sweepAt - sweep, this.baselineGoal(), 'sine.inOut');
    });
  }

  /** Both flat hands reach out and push the pot sideways toward the winner, then relax open. */
  gesturePush(target: Vector3, seconds = 0.95): Promise<void> {
    const direction = this.directionToward(target);
    const base = this.baseline;
    const shift = MathUtils.clamp(direction.x * 0.22, -0.2, 0.2);
    const anticipate = seconds * 0.12;
    const reach = seconds * 0.26;
    const push = seconds * 0.38;
    return this.runGesture((timeline) => {
      this.addKey(timeline, 0, anticipate, {
        lean: base.lean - 0.03,
        leftHand: { x: 0.16, y: 1.1, z: 0.3 },
        rightHand: { x: -0.16, y: 1.1, z: 0.3 },
        leftShape: handShape('flat'),
        rightShape: handShape('flat'),
      }, 'power1.out');
      this.addKey(timeline, anticipate, reach, {
        lean: base.lean + 0.2,
        hinge: 0.1,
        leftHand: { x: 0.16, y: 0.97, z: 0.48 },
        rightHand: { x: -0.16, y: 0.97, z: 0.48 },
      }, 'power2.out');
      this.addKey(timeline, anticipate + reach, push, {
        lean: base.lean + 0.24,
        hinge: 0.12,
        leftHand: { x: 0.16 + shift, y: 0.97, z: 0.52 },
        rightHand: { x: -0.16 + shift, y: 0.97, z: 0.52 },
      }, 'power2.inOut');
      this.addKey(timeline, anticipate + reach + push, seconds * 0.08, { leftShape: handShape('open'), rightShape: handShape('open') }, 'power1.out');
      this.addKey(timeline, anticipate + reach + push + seconds * 0.08, seconds - anticipate - reach - push - seconds * 0.08, this.baselineGoal(), 'sine.inOut');
    });
  }

  /** A brief open-palm point of the right hand toward the acting seat, index finger extended. */
  gesturePoint(target: Vector3): void {
    const direction = this.directionToward(target);
    const rest = restHandTarget('right');
    const pointing: Vec3Like = {
      x: rest.x + direction.x * 0.2,
      y: 1.08,
      z: rest.z + 0.14 + Math.max(direction.z, 0) * 0.06,
    };
    const base = this.baseline;
    void this.runGesture((timeline) => {
      this.addKey(timeline, 0, 0.1, { lean: base.lean - 0.02, rightHand: { ...rest, y: rest.y + 0.03 }, rightShape: handShape('open') }, 'power1.out');
      this.addKey(timeline, 0.1, 0.26, { lean: base.lean + 0.05, rightHand: pointing, rightRoll: 0.8, rightShape: handShape('point') }, 'power2.out');
      this.addKey(timeline, 0.36, 0.42, {}, 'none');
      this.addKey(timeline, 0.78, 0.38, this.baselineGoal(['lean', 'rightHand', 'rightRoll', 'rightShape']), 'sine.inOut');
    });
  }

  nod(): void {
    if (this.reducedMotion || this.disposed) {
      return;
    }
    this.interruptIdle();
    this.nodTween?.kill();
    this.idleScheduler.gestureStarted();
    this.nodTween = gsap
      .timeline({
        onComplete: () => {
          this.pose.nod = 0;
          this.nodTween = null;
          this.idleScheduler.gestureEnded();
        },
      })
      .to(this.pose, { nod: 0.2, duration: 0.14, ease: 'power2.out' })
      .to(this.pose, { nod: 0, duration: 0.26, ease: 'power2.inOut' });
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    this.idleScheduler.setContext({ reducedMotion: reduced });
    if (reduced) {
      this.stopGesture();
      this.stopIdleTimeline();
      this.nodTween?.kill();
      this.nodTween = null;
      this.stanceTween?.kill();
      this.dealingDeckUntil = -1;
      this.baseline = createRestPose();
      this.resetToRestPose();
      this.refreshProps();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopGesture();
    this.stopIdleTimeline();
    this.nodTween?.kill();
    this.stanceTween?.kill();
    this.root.removeFromParent();
    this.root.traverse((object) => {
      if (object instanceof Mesh) {
        object.geometry.dispose();
      }
    });
    this.props.dispose();
    for (const material of this.materials) {
      for (const value of Object.values(material)) {
        if (value && typeof (value as { dispose?: unknown }).dispose === 'function') {
          (value as { dispose: () => void }).dispose();
        }
      }
      material.dispose();
    }
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  private collectArm(scene: Object3D, side: HandSide): ArmBones {
    const suffix = side === 'left' ? 'l' : 'r';
    const sign: 1 | -1 = side === 'left' ? 1 : -1;
    const named = (name: string): Object3D => requireObject(scene, `${name}_${suffix}`);
    const upperArm = named('upperarm');
    const lowerArm = named('lowerarm');
    const hand = named('hand');

    return {
      side,
      sign,
      upperArm,
      lowerArm,
      lowerArmTwist: scene.getObjectByName(`lowerarm_twist_${suffix}`) ?? null,
      hand,
      fingerChains: FINGER_NAMES.map((finger) => FINGER_SEGMENTS.map((segment) => named(`${finger}_${segment}`))),
      thumbChain: FINGER_SEGMENTS.map((segment) => named(`thumb_${segment}`)),
      thumbTip: named('thumb_end'),
      indexTip: named('index_end'),
      middleBase: named('middle_01'),
      middleTip: named('middle_end'),
      upperLength: lowerArm.position.length() * this.worldScaleOf(upperArm),
      lowerLength: hand.position.length() * this.worldScaleOf(lowerArm),
      palmAxisSign: side === 'left' ? 1 : -1,
    };
  }

  private worldScaleOf(object: Object3D): number {
    object.updateWorldMatrix(true, false);
    return object.getWorldScale(this.scratchA).x;
  }

  private rememberBindPose(scene: Object3D): void {
    scene.traverse((object) => {
      if ((object as { isBone?: boolean }).isBone === true) {
        this.bindRotations.set(object, object.quaternion.clone());
      }
    });
  }

  private prepareMeshes(scene: Object3D): void {
    scene.traverse((object) => {
      if (!(object instanceof Mesh)) {
        return;
      }
      object.castShadow = true;
      object.receiveShadow = true;
      // The bind pose is an A-pose: the culling sphere computed from it would clip the arms once they move.
      object.frustumCulled = false;
      const materials: Material[] = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        (material as { envMapIntensity?: number }).envMapIntensity = DEALER_ENV_MAP_INTENSITY;
        this.materials.push(material);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Gestures
  // ---------------------------------------------------------------------------

  /** Unit direction (x lateral, z forward) from the dealer toward a world point, in dealer space. */
  private directionToward(target: Vector3): Vec3Like {
    const local = this.root.worldToLocal(this.scratchA.copy(target));
    const length = Math.hypot(local.x, local.z) || 1;
    return { x: local.x / length, y: 0, z: local.z / length };
  }

  private baselineGoal(keys?: (keyof PoseState)[]): PoseGoal {
    const goal: PoseGoal = {};
    const source = clonePose(this.baseline);
    for (const key of keys ?? (Object.keys(source) as (keyof PoseState)[])) {
      (goal as Record<string, unknown>)[key] = source[key];
    }
    return goal;
  }

  private addKey(timeline: gsap.core.Timeline, at: number, duration: number, goal: PoseGoal, ease: string): void {
    const { leftHand, rightHand, leftShape, rightShape, ...scalars } = goal;
    const length = Math.max(duration, 0.01);
    if (Object.keys(scalars).length > 0) {
      timeline.to(this.pose, { ...scalars, duration: length, ease }, at);
    }
    const bundles: [object, object | undefined][] = [
      [this.pose.leftHand, leftHand],
      [this.pose.rightHand, rightHand],
      [this.pose.leftShape, leftShape],
      [this.pose.rightShape, rightShape],
    ];
    for (const [channel, values] of bundles) {
      if (values) {
        timeline.to(channel, { ...values, duration: length, ease }, at);
      }
    }
    if (Object.keys(goal).length === 0) {
      timeline.to({}, { duration: length }, at);
    }
  }

  /**
   * One gesture at a time: a new one replaces the running one from the pose it left off in, and every gesture
   * ends by tweening back to the baseline pose, so the rig is never stranded in the middle of a move. The spring
   * between `pose` and the rig turns the hand-over into a blend instead of a snap.
   */
  private runGesture(build: (timeline: gsap.core.Timeline) => void): Promise<void> {
    this.stopGesture();
    if (this.reducedMotion || this.disposed) {
      return Promise.resolve();
    }
    this.interruptIdle();
    this.idleScheduler.gestureStarted();
    return new Promise<void>((resolve) => {
      const timeline = gsap.timeline({
        onComplete: () => {
          this.gesture = null;
          this.idleScheduler.gestureEnded();
          resolve();
        },
      });
      this.gesture = { timeline, settle: resolve };
      build(timeline);
    });
  }

  private stopGesture(): void {
    const running = this.gesture;
    if (!running) {
      return;
    }
    this.gesture = null;
    running.timeline.kill();
    this.idleScheduler.gestureEnded();
    running.settle();
  }

  private resetToRestPose(): void {
    copyPoseInto(this.pose, this.baseline);
    snapTree(this.shown, this.shownVelocity, this.pose);
  }

  // ---------------------------------------------------------------------------
  // Deck in the left hand while dealing
  // ---------------------------------------------------------------------------

  private holdDeckForDealing(): void {
    if (this.reducedMotion) {
      return;
    }
    const wasHolding = this.dealingDeckUntil >= 0;
    this.deckGrip = 'left';
    this.dealingDeckUntil = this.clock + DECK_HOLD_SECONDS;
    if (!wasHolding) {
      this.moveBaselineTo(this.dealingStance());
    }
    this.refreshProps();
  }

  private dealingStance(): PoseState {
    const stance = createRestPose();
    stance.leftHand = { ...DEAL_DECK_HAND };
    stance.leftRoll = DEAL_DECK_ROLL;
    stance.leftShape = handShape('hold');
    return stance;
  }

  private releaseDeckAfterDealing(): void {
    if (this.dealingDeckUntil < 0 || this.clock < this.dealingDeckUntil || this.gesture) {
      return;
    }
    this.dealingDeckUntil = -1;
    this.moveBaselineTo(createRestPose());
    this.refreshProps();
  }

  /** Changes what "rest" means; the idle left hand glides there unless a gesture is driving it. */
  private moveBaselineTo(next: PoseState): void {
    this.baseline = next;
    this.stanceTween?.kill();
    const left = this.baselineGoal(['leftHand', 'leftRoll', 'leftShape']);
    if (this.gesture || this.idleTimeline) {
      return;
    }
    const timeline = gsap.timeline();
    this.addKey(timeline, 0, 0.35, left, 'sine.inOut');
    this.stanceTween = timeline;
  }

  // ---------------------------------------------------------------------------
  // Idle business
  // ---------------------------------------------------------------------------

  private advanceIdle(deltaSeconds: number): void {
    if (this.dealingDeckUntil >= 0) {
      return;
    }
    const due = this.idleScheduler.tick(deltaSeconds);
    if (due !== null) {
      this.startIdleAction(due, null);
    }
  }

  private idleBuildContext(focusPoint: Vector3 | null): IdleBuildContext {
    const focus = focusPoint ? { point: focusPoint.clone(), direction: this.directionToward(focusPoint) } : null;
    return {
      activity: this.idleScheduler.activity,
      reducedMotion: this.reducedMotion,
      random: Math.random,
      seatPoints: this.attention.seatPoints,
      potPoint: this.attention.potPoint,
      focus,
    };
  }

  private startIdleAction(id: IdleActionId, focusPoint: Vector3 | null): void {
    const script = buildIdleScript(id, this.idleBuildContext(focusPoint));
    const timeline = gsap.timeline({ onComplete: () => this.finishIdleAction() });
    this.idleTimeline = timeline;
    this.stanceTween?.kill();

    // Reduced motion keeps only the gaze: no arms, no props, no body movement.
    for (const key of this.reducedMotion ? [] : script.keys) {
      this.addKey(timeline, key.at, key.duration, key.goal, key.ease ?? 'sine.inOut');
    }
    for (const gaze of script.gazes) {
      timeline.call(() => { this.idleGaze = gaze.target; }, undefined, gaze.at);
    }
    if (!this.reducedMotion) {
      this.scheduleProps(timeline, script);
    }
    timeline.to({}, { duration: script.seconds }, 0);
  }

  private scheduleProps(timeline: gsap.core.Timeline, script: IdleScript): void {
    if (script.deck) {
      const { from, to, mode } = script.deck;
      timeline.call(() => this.setIdleDeck(mode), undefined, from);
      timeline.call(() => this.setIdleDeck(null), undefined, to);
    }
    if (script.chips) {
      timeline.call(() => this.setIdleChips(true), undefined, script.chips.from);
      timeline.call(() => this.setIdleChips(false), undefined, script.chips.to);
    }
  }

  private finishIdleAction(): void {
    this.idleTimeline = null;
    this.clearIdleState();
    this.idleScheduler.actionFinished();
  }

  /** Kills the running idle action; the springs blend the body back to the baseline without a pop. */
  private interruptIdle(): void {
    if (!this.idleTimeline) {
      return;
    }
    this.stopIdleTimeline();
    copyPoseInto(this.pose, this.baseline);
    this.idleScheduler.actionInterrupted();
  }

  private stopIdleTimeline(): void {
    this.idleTimeline?.kill();
    this.idleTimeline = null;
    this.clearIdleState();
  }

  private clearIdleState(): void {
    this.idleGaze = null;
    this.idleDeck = null;
    this.idleChips = false;
    this.refreshProps();
  }

  private setIdleDeck(mode: PropWindow['mode'] | null): void {
    this.idleDeck = mode;
    if (mode) {
      this.deckGrip = mode;
    }
    this.refreshProps();
  }

  private setIdleChips(held: boolean): void {
    this.idleChips = held;
    this.refreshProps();
  }

  private get deckIsWanted(): boolean {
    return this.idleDeck !== null || this.dealingDeckUntil >= 0;
  }

  private advanceDeckLift(deltaSeconds: number): void {
    stepSpring(this.deckPresence, this.deckIsWanted ? 1 : 0, DECK_LIFT_SPRING, deltaSeconds);
    this.refreshProps();
  }

  private refreshProps(): void {
    const deckVisible = this.deckIsWanted || this.deckPresence.value > 0.01;
    this.props.deck.visible = deckVisible;
    this.props.chips.visible = this.idleChips;
    if (deckVisible !== this.deckWasVisible) {
      this.deckWasVisible = deckVisible;
      this.deckListener?.(deckVisible);
    }
  }

  // ---------------------------------------------------------------------------
  // Per-frame life
  // ---------------------------------------------------------------------------

  private advanceSprings(deltaSeconds: number): void {
    if (this.reducedMotion) {
      snapTree(this.shown, this.shownVelocity, this.pose);
      return;
    }
    followTree(this.shown, this.shownVelocity, this.pose, dealerSpringTuning, deltaSeconds);
  }

  private resolveGaze(gaze: GazeTarget, out: Vector3): Vector3 | null {
    switch (gaze.kind) {
      case 'point':
        return out.set(gaze.point.x, gaze.point.y, gaze.point.z);
      case 'camera':
        return this.viewpoint ? this.viewpoint.getWorldPosition(out) : null;
      case 'hand':
        return this.handWorldPosition(gaze.side, out);
    }
  }

  private advanceLook(deltaSeconds: number): void {
    const head = this.root.worldToLocal(this.bones.head.getWorldPosition(this.scratchA));
    const gazePoint = this.idleGaze ? this.resolveGaze(this.idleGaze, this.scratchD) : null;
    const target = this.root.worldToLocal(this.scratchB.copy(gazePoint ?? this.lookTarget));
    const unclamped = computeLookAngles(head, target);
    const wanted = clampLookAngles(unclamped);

    if (this.reducedMotion) {
      this.look.yaw = wanted.yaw;
      this.look.pitch = wanted.pitch;
    } else {
      const headFactor = smoothingFactor(deltaSeconds, HEAD_LOOK_SECONDS);
      this.look.yaw += (wanted.yaw - this.look.yaw) * headFactor;
      this.look.pitch += (wanted.pitch - this.look.pitch) * headFactor;
    }

    // The eyes get ahead of the head, then settle as the head catches up.
    const eyeFactor = this.reducedMotion ? 1 : smoothingFactor(deltaSeconds, EYE_LOOK_SECONDS);
    const eyeYaw = MathUtils.clamp(unclamped.yaw - this.look.yaw, -MAX_EYE_YAW, MAX_EYE_YAW);
    const eyePitch = MathUtils.clamp(unclamped.pitch - this.look.pitch, -MAX_EYE_PITCH, MAX_EYE_PITCH);
    this.eyes.yaw += (eyeYaw - this.eyes.yaw) * eyeFactor;
    this.eyes.pitch += (eyePitch - this.eyes.pitch) * eyeFactor;
  }

  private advanceBlink(elapsedSeconds: number): void {
    if (this.reducedMotion) {
      this.blinkStartedAt = -1;
      return;
    }
    if (this.blinkStartedAt < 0 && elapsedSeconds >= this.nextBlinkAt) {
      this.blinkStartedAt = elapsedSeconds;
      this.nextBlinkAt = elapsedSeconds + 2.2 + Math.random() * 3.6;
    }
  }

  private blinkAmount(elapsedSeconds: number): number {
    if (this.blinkStartedAt < 0) {
      return 0;
    }
    const age = elapsedSeconds - this.blinkStartedAt;
    if (age < BLINK_CLOSE_SECONDS) {
      return age / BLINK_CLOSE_SECONDS;
    }
    if (age < BLINK_CLOSE_SECONDS + BLINK_OPEN_SECONDS) {
      return 1 - (age - BLINK_CLOSE_SECONDS) / BLINK_OPEN_SECONDS;
    }
    this.blinkStartedAt = -1;
    return 0;
  }

  // ---------------------------------------------------------------------------
  // Posing
  // ---------------------------------------------------------------------------

  private applyPose(elapsedSeconds = 0): void {
    this.resetBones();
    this.root.getWorldQuaternion(this.dealerWorldRotation);
    this.dealerWorldRotationInverse.copy(this.dealerWorldRotation).invert();
    const alive = this.reducedMotion ? 0 : 1;
    const breath = Math.sin((elapsedSeconds / BREATH_SECONDS) * Math.PI * 2) * alive;
    const sway = Math.sin((elapsedSeconds / SWAY_SECONDS) * Math.PI * 2) * alive;
    const shown = this.shown;
    const reachTwist = ((shown.leftHand.x + shown.rightHand.x) / 2) * 0.3;

    this.poseTorso(breath, sway, reachTwist);
    this.poseArm(this.arms.left, shown.leftHand, this.shownVelocity.leftHand, shown.leftRoll, shown.leftWrist, shown.leftShape, elapsedSeconds, alive);
    this.poseArm(this.arms.right, shown.rightHand, this.shownVelocity.rightHand, shown.rightRoll, shown.rightWrist, shown.rightShape, elapsedSeconds, alive);
    this.poseHead(this.blinkAmount(elapsedSeconds), reachTwist, elapsedSeconds, alive);
    this.root.updateMatrixWorld(true);
    this.placeHeldProps();
    this.updateSpeechAnchor();
  }

  private resetBones(): void {
    for (const [bone, rotation] of this.bindRotations) {
      bone.quaternion.copy(rotation);
    }
  }

  /** Rotates a bone by a rotation expressed in dealer space (axes of the dealer, origin at the bone). */
  private rotateInDealerSpace(bone: Object3D, axis: Vector3, angle: number): void {
    if (Math.abs(angle) < 1e-7) {
      return;
    }
    const rotation = this.scratchQuaternionB.setFromAxisAngle(axis, angle);
    const worldRotation = this.scratchQuaternionC
      .copy(this.dealerWorldRotation)
      .multiply(rotation)
      .multiply(this.dealerWorldRotationInverse);
    this.applyWorldRotation(bone, worldRotation);
  }

  private applyWorldRotation(bone: Object3D, worldRotation: Quaternion): void {
    const parent = bone.parent;
    if (!parent) {
      return;
    }
    parent.getWorldQuaternion(this.parentWorldRotation);
    this.parentWorldRotationInverse.copy(this.parentWorldRotation).invert();
    bone.quaternion
      .premultiply(this.parentWorldRotation)
      .premultiply(worldRotation)
      .premultiply(this.parentWorldRotationInverse);
  }

  private rotateAroundWorldAxis(bone: Object3D, worldAxis: Vector3, angle: number): void {
    if (Math.abs(angle) < 1e-7) {
      return;
    }
    this.applyWorldRotation(bone, this.scratchQuaternionB.setFromAxisAngle(worldAxis, angle));
  }

  /** Points a bone's axis (the direction to its child) along a world direction by the shortest turn. */
  private aimBone(bone: Object3D, child: Object3D, worldDirection: Vector3): void {
    const localAxis = this.scratchC.copy(child.position).normalize();
    const currentAxis = localAxis.applyQuaternion(bone.getWorldQuaternion(this.scratchQuaternionA));
    const turn = this.scratchQuaternionB.setFromUnitVectors(currentAxis, worldDirection);
    this.applyWorldRotation(bone, turn);
  }

  private poseTorso(breath: number, sway: number, reachTwist: number): void {
    const { hip, spine_01: lower, spine_02: middle, spine_03: upper, upperleg_l: legLeft, upperleg_r: legRight } = this.bones;
    const spine = [lower, middle, upper];
    const { lean, hinge } = this.shown;

    // The weight goes onto the leg on the side the hands reach toward.
    this.rotateInDealerSpace(hip, AXIS_Z, sway * 0.016 - reachTwist * 0.12);
    this.rotateInDealerSpace(hip, AXIS_Y, sway * 0.02);
    // Bending at the pelvis tips the legs too: counter-rotating them keeps the legs upright and out of the table.
    this.rotateInDealerSpace(hip, AXIS_X, hinge);
    this.rotateInDealerSpace(legLeft, AXIS_X, -hinge);
    this.rotateInDealerSpace(legRight, AXIS_X, -hinge);
    spine.forEach((bone, index) => {
      this.rotateInDealerSpace(bone, AXIS_X, lean * LEAN_SHARE_BY_SPINE[index]);
      this.rotateInDealerSpace(bone, AXIS_Z, -sway * 0.007);
      this.rotateInDealerSpace(bone, AXIS_Y, reachTwist * LEAN_SHARE_BY_SPINE[index]);
    });
    this.rotateInDealerSpace(middle, AXIS_X, -breath * 0.007);
    this.rotateInDealerSpace(upper, AXIS_X, -breath * 0.012);
  }

  private poseArm(
    arm: ArmBones,
    handTarget: Vec3Like,
    handVelocity: Vec3Like,
    roll: number,
    wrist: number,
    shape: HandShape,
    elapsedSeconds: number,
    alive: number,
  ): void {
    const shoulder = arm.upperArm.getWorldPosition(this.scratchA).clone();
    const target = this.root.localToWorld(new Vector3(handTarget.x, handTarget.y, handTarget.z));
    const trail = (speed: number): number => MathUtils.clamp(-speed * ELBOW_TRAIL_GAIN, -ELBOW_TRAIL_LIMIT, ELBOW_TRAIL_LIMIT);
    // The elbow lags behind the hand it follows, which is what makes the arm look like it has weight.
    const pole = this.dealerDirectionToWorld(
      new Vector3(
        arm.sign * ELBOW_POLE_OUTWARD + trail(handVelocity.x),
        -1 + trail(handVelocity.y),
        ELBOW_POLE_BACKWARD + trail(handVelocity.z),
      ),
    );
    const solution = solveElbow(shoulder, target, arm.upperLength, arm.lowerLength, pole);

    const upperDirection = solution.elbow.clone().sub(shoulder).normalize();
    this.aimBone(arm.upperArm, arm.lowerArm, upperDirection);
    this.alignElbowHinge(arm, upperDirection, solution.hinge);

    const lowerDirection = solution.wrist.clone().sub(solution.elbow).normalize();
    this.aimBone(arm.lowerArm, arm.hand, lowerDirection);
    this.rollHand(arm, lowerDirection, roll);
    // The finger bones bend about local Z toward the palm, so extending the wrist is the opposite turn.
    arm.hand.quaternion.multiply(this.scratchQuaternionB.setFromAxisAngle(AXIS_Z, -wrist));
    this.articulateHand(arm, shape, elapsedSeconds, alive);
  }

  /** Twists the upper arm so the elbow bends about its natural hinge instead of rolling the forearm. */
  private alignElbowHinge(arm: ArmBones, upperDirection: Vector3, hinge: Vector3): void {
    const currentHinge = AXIS_Z.clone().applyQuaternion(arm.upperArm.getWorldQuaternion(this.scratchQuaternionA));
    const twist = signedAngleAround(currentHinge, hinge, upperDirection);
    this.rotateAroundWorldAxis(arm.upperArm, upperDirection, twist);
  }

  private rollHand(arm: ArmBones, forearmDirection: Vector3, roll: number): void {
    const palmDown = WORLD_DOWN.clone().addScaledVector(forearmDirection, -WORLD_DOWN.dot(forearmDirection)).normalize();
    // Supination turns the palm toward the body's midline, which is the opposite direction on each arm.
    const wanted = palmDown.applyAxisAngle(forearmDirection, -arm.sign * roll);
    const currentPalm = new Vector3(0, arm.palmAxisSign, 0).applyQuaternion(arm.hand.getWorldQuaternion(this.scratchQuaternionA));
    const correction = signedAngleAround(currentPalm, wanted, forearmDirection);

    this.rotateAroundWorldAxis(arm.hand, forearmDirection, correction);
    if (arm.lowerArmTwist) {
      this.rotateAroundWorldAxis(arm.lowerArmTwist, forearmDirection, correction * 0.5);
    }
  }

  /**
   * Finger bones run along their local X with the knuckles bending about Z (toward the palm) and the fingers fanning
   * about Y; the thumb root is turned across the palm about Y. The same signs work for both hands because the
   * right hand's skeleton is a mirror image.
   */
  private articulateHand(arm: ArmBones, requested: HandShape, elapsedSeconds: number, alive: number): void {
    const shape = clampHandShape(this.withFingerLife(requested, arm, elapsedSeconds, alive));
    const curls = [shape.index, shape.middle, shape.ring, shape.pinky];

    arm.fingerChains.forEach((chain, finger) => {
      chain.forEach((bone, segment) => {
        if (segment === 0) {
          bone.quaternion.multiply(this.scratchQuaternionB.setFromAxisAngle(AXIS_Y, shape.spread * FINGER_SPREAD_ANGLES[finger]));
        }
        bone.quaternion.multiply(this.scratchQuaternionB.setFromAxisAngle(AXIS_Z, curls[finger] * FINGER_PHALANX_ANGLES[segment]));
      });
    });

    arm.thumbChain.forEach((bone, segment) => {
      if (segment === 0) {
        bone.quaternion.multiply(this.scratchQuaternionB.setFromAxisAngle(AXIS_Y, shape.thumbOpposition * THUMB_OPPOSITION_ANGLE));
      }
      bone.quaternion.multiply(this.scratchQuaternionB.setFromAxisAngle(AXIS_Z, shape.thumb * THUMB_PHALANX_ANGLES[segment]));
    });
  }

  /** Fingers are never perfectly still: each one drifts a little around its curl. */
  private withFingerLife(shape: HandShape, arm: ArmBones, elapsedSeconds: number, alive: number): HandShape {
    if (alive === 0) {
      return shape;
    }
    const phase = elapsedSeconds * 0.7 + (arm.side === 'left' ? 0 : 1.7);
    const drift = (offset: number): number => Math.sin(phase + offset) * 0.035;
    return {
      ...shape,
      thumb: shape.thumb + drift(0.4),
      index: shape.index + drift(1.1),
      middle: shape.middle + drift(2.3),
      ring: shape.ring + drift(3.1),
      pinky: shape.pinky + drift(4.2),
    };
  }

  private poseHead(blink: number, reachTwist: number, elapsedSeconds: number, alive: number): void {
    const { neck, head, eye_l: eyeLeft, eye_r: eyeRight, eyelid_l: lidLeft, eyelid_r: lidRight } = this.bones;
    const { lean, hinge } = this.shown;
    // Small, unsynchronised head movements so the gaze is never frozen.
    const driftYaw = (Math.sin(elapsedSeconds * 0.37 + 1.3) * 0.02 + Math.sin(elapsedSeconds * 0.91) * 0.008) * alive;
    const driftPitch = (Math.sin(elapsedSeconds * 0.53) * 0.012 + Math.sin(elapsedSeconds * 1.3 + 0.6) * 0.005) * alive;
    const driftTilt = Math.sin(elapsedSeconds * 0.29 + 2.1) * 0.02 * alive;
    // The head keeps its gaze while the body bends and twists under it.
    const yaw = this.look.yaw - reachTwist * 0.6 + driftYaw;
    const pitchDown = -this.look.pitch + this.shown.nod - (lean - this.baseline.lean) * 0.5 - hinge * 0.7 + driftPitch;

    this.rotateInDealerSpace(neck, AXIS_Y, yaw * NECK_LOOK_SHARE);
    this.rotateInDealerSpace(neck, AXIS_X, pitchDown * NECK_LOOK_SHARE);
    this.rotateInDealerSpace(neck, AXIS_Z, driftTilt * 0.5);
    this.rotateInDealerSpace(head, AXIS_Y, yaw * (1 - NECK_LOOK_SHARE));
    this.rotateInDealerSpace(head, AXIS_X, pitchDown * (1 - NECK_LOOK_SHARE));
    this.rotateInDealerSpace(head, AXIS_Z, driftTilt * 0.5);

    for (const eye of [eyeLeft, eyeRight]) {
      this.rotateInDealerSpace(eye, AXIS_Y, this.eyes.yaw);
      this.rotateInDealerSpace(eye, AXIS_X, -this.eyes.pitch);
    }
    for (const lid of [lidLeft, lidRight]) {
      this.rotateInDealerSpace(lid, AXIS_X, blink * MAX_LID_CLOSE_ANGLE);
    }
  }

  /** The deck rests on his left palm (or between both hands while shuffling) and the chip stack rides his right fingertips. */
  private placeHeldProps(): void {
    if (this.props.deck.visible) {
      if (this.deckGrip === 'between') {
        this.placeDeckBetweenHands();
      } else {
        this.placeDeckOnLeftPalm();
      }
    }
    if (this.props.chips.visible) {
      this.placeChipsInRightHand();
    }
  }

  private placeDeckOnLeftPalm(): void {
    const { hand } = this.arms.left;
    const handRotation = hand.getWorldQuaternion(this.scratchQuaternionA);
    const palmPoint = this.scratchA.set(0.058, 0.026, -0.004).applyQuaternion(handRotation).add(hand.getWorldPosition(this.scratchB));
    // The deck's long edge runs along the fingers.
    const deckRotation = this.scratchQuaternionB.setFromAxisAngle(AXIS_Y, Math.PI / 2);
    this.setDeckPose(palmPoint, handRotation.clone().multiply(deckRotation));
  }

  private placeDeckBetweenHands(): void {
    const midpoint = this.scratchA.set(0, 0, 0);
    for (const side of ['left', 'right'] as const) {
      const { hand } = this.arms[side];
      const offset = this.scratchC.set(0.07 * this.arms[side].sign, 0, 0).applyQuaternion(hand.getWorldQuaternion(this.scratchQuaternionA));
      midpoint.add(hand.getWorldPosition(this.scratchB).add(offset));
    }
    midpoint.multiplyScalar(0.5);
    this.setDeckPose(midpoint, this.dealerWorldRotation);
  }

  private placeChipsInRightHand(): void {
    this.gripWorldPosition('right', this.scratchE);
    this.setPropPose(this.props.chips, this.scratchE, this.dealerWorldRotation);
  }

  /** The deck eases between its place on the felt and his hands, so lifting and putting it down never pops. */
  private setDeckPose(heldPosition: Vector3, heldRotation: Quaternion): void {
    const lift = MathUtils.clamp(this.deckPresence.value, 0, 1);
    const deckThickness = HELD_DECK_SIZE.thickness * FELT_DECK_SCALE;
    const position = this.scratchE.set(DECK_POSITION.x, FELT_Y + deckThickness / 2, DECK_POSITION.z).lerp(heldPosition, lift);
    const rotation = this.scratchQuaternionC.identity().slerp(heldRotation, lift);
    this.setPropPose(this.props.deck, position, rotation);
    this.props.deck.scale.setScalar(MathUtils.lerp(FELT_DECK_SCALE, 1, lift));
  }

  private setPropPose(prop: Object3D, worldPosition: Vector3, worldRotation: Quaternion): void {
    prop.position.copy(this.root.worldToLocal(this.scratchD.copy(worldPosition)));
    prop.quaternion.copy(this.dealerWorldRotationInverse).multiply(worldRotation);
  }

  private updateSpeechAnchor(): void {
    const headTop = this.bones.head_end.getWorldPosition(this.scratchA);
    this.root.worldToLocal(headTop);
    this.speechAnchor.position.set(headTop.x, headTop.y + DEALER_SPEECH_ANCHOR_RISE, headTop.z);
  }

  private dealerDirectionToWorld(direction: Vector3): Vector3 {
    return direction.applyQuaternion(this.dealerWorldRotation).normalize();
  }
}
