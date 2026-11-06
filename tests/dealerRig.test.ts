import { readFileSync } from 'node:fs';
import { Bone, Group, MathUtils, Object3D, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  DEAL_RELEASE_FRACTION,
  Dealer,
  clampLookAngles,
  computeLookAngles,
  solveElbow,
} from '../src/client/scene/Dealer';
import type { IdleActionId } from '../src/client/scene/dealerIdle';
import { buildIdleScript, type IdleBuildContext } from '../src/client/scene/dealerIdleActions';
import {
  HAND_SHAPE_LIMITS,
  applyGoal,
  createRestPose,
  handShape,
  type HandShape,
  type PoseState,
} from '../src/client/scene/dealerPose';
import { DEALER_STAND_POSITION, DEALER_YAW, FELT_Y, RAIL_SHAPE, RAIL_Y } from '../src/client/scene/SeatLayout';

interface GlbNode {
  name: string;
  mesh?: number;
  children?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

const DEALER_MODEL_PATH = new URL('../public/assets/dealer/dealer.glb', import.meta.url);
const HAND_REACH_TOLERANCE = 0.015;

/** The skeleton of the real model without its mesh or textures: enough to pose and measure the rig from Node. */
function buildSkeletonScene(): Group {
  const bytes = readFileSync(DEALER_MODEL_PATH);
  const jsonLength = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8')) as { nodes: GlbNode[]; scenes: { nodes: number[] }[] };

  const objects = gltf.nodes.map((node) => {
    const object: Object3D = node.mesh === undefined && node.name !== 'dealer_rig' ? new Bone() : new Object3D();
    object.name = node.name;
    if (node.translation) object.position.fromArray(node.translation);
    if (node.rotation) object.quaternion.fromArray(node.rotation);
    if (node.scale) object.scale.fromArray(node.scale);
    return object;
  });
  gltf.nodes.forEach((node, index) => node.children?.forEach((child) => objects[index].add(objects[child])));

  const scene = new Group();
  scene.add(objects[gltf.scenes[0].nodes[0]]);
  return scene;
}

function createDealer(): Dealer {
  const dealer = Dealer.fromScene(buildSkeletonScene());
  dealer.update(0.016, 0);
  return dealer;
}

function worldPositionOf(dealer: Dealer, name: string): Vector3 {
  const bone = dealer.root.getObjectByName(name);
  if (!bone) throw new Error(`missing bone ${name}`);
  return bone.getWorldPosition(new Vector3());
}

function localToDealer(dealer: Dealer, world: Vector3): Vector3 {
  return dealer.root.worldToLocal(world.clone());
}

/** Where the face points, as yaw (toward the dealer's left is positive) and pitch (up is positive) in dealer space. */
function faceDirection(dealer: Dealer): { yaw: number; pitch: number } {
  const head = dealer.root.getObjectByName('head');
  if (!head) throw new Error('missing head bone');
  // In the model's bind pose the face looks along the head bone's -Y axis.
  const forward = new Vector3(0, -1, 0).applyQuaternion(head.getWorldQuaternion(new Quaternion()));
  const inDealerSpace = forward.applyQuaternion(dealer.root.getWorldQuaternion(new Quaternion()).invert());
  return { yaw: Math.atan2(inDealerSpace.x, inDealerSpace.z), pitch: Math.asin(MathUtils.clamp(inDealerSpace.y, -1, 1)) };
}

function settle(dealer: Dealer, seconds = 4): void {
  for (let frame = 0; frame < seconds * 20; frame++) dealer.update(0.05, frame * 0.05);
}

function handPosition(dealer: Dealer, side: 'left' | 'right'): Vector3 {
  return dealer.handWorldPosition(side, new Vector3());
}

describe('two-bone arm solver', () => {
  const shoulder = new Vector3(0.17, 1.5, 0);
  const pole = new Vector3(0.7, -1, -0.35);

  it('keeps both bones at their real length when the target is reachable', () => {
    const target = new Vector3(0.15, 1.12, 0.3);
    const { elbow, wrist } = solveElbow(shoulder, target, 0.317, 0.219, pole);

    expect(elbow.distanceTo(shoulder)).toBeCloseTo(0.317, 5);
    expect(wrist.distanceTo(elbow)).toBeCloseTo(0.219, 5);
    expect(wrist.distanceTo(target)).toBeLessThan(1e-6);
  });

  it('stops at full extension instead of stretching toward a target out of reach', () => {
    const target = new Vector3(0.17, 0.2, 1.5);
    const { elbow, wrist } = solveElbow(shoulder, target, 0.317, 0.219, pole);

    expect(wrist.distanceTo(shoulder)).toBeLessThanOrEqual(0.317 + 0.219);
    expect(elbow.distanceTo(shoulder)).toBeCloseTo(0.317, 5);
    expect(wrist.distanceTo(target)).toBeGreaterThan(0.5);
  });

  it('bends the elbow toward the pole side', () => {
    const { elbow } = solveElbow(shoulder, new Vector3(0.15, 1.12, 0.3), 0.317, 0.219, pole);
    const straightMidpoint = shoulder.clone().lerp(new Vector3(0.15, 1.12, 0.3), 0.5);

    expect(elbow.y).toBeLessThan(straightMidpoint.y + 0.001);
    expect(elbow.x).toBeGreaterThan(straightMidpoint.x);
  });

  it('survives a pole that points along the arm', () => {
    const target = new Vector3(0.17, 1.0, 0.3);
    const { elbow } = solveElbow(shoulder, target, 0.317, 0.219, target.clone().sub(shoulder));

    expect(Number.isFinite(elbow.x + elbow.y + elbow.z)).toBe(true);
  });
});

describe('look-at angles', () => {
  it('measures yaw toward +X and pitch upward', () => {
    const head = new Vector3(0, 1.7, 0);

    expect(computeLookAngles(head, new Vector3(1, 1.7, 1)).yaw).toBeCloseTo(Math.PI / 4, 6);
    expect(computeLookAngles(head, new Vector3(0, 2.7, 1)).pitch).toBeCloseTo(Math.PI / 4, 6);
  });

  it('limits how far the head can turn', () => {
    const clamped = clampLookAngles({ yaw: Math.PI, pitch: -Math.PI / 2 });

    expect(Math.abs(clamped.yaw)).toBeLessThan(MathUtils.degToRad(80));
    expect(clamped.pitch).toBeGreaterThan(-MathUtils.degToRad(40));
  });
});

describe('dealer rest pose', () => {
  it('stands on the floor at the dealer spot facing the table', () => {
    const dealer = createDealer();

    expect(dealer.root.position.toArray()).toEqual(DEALER_STAND_POSITION.toArray());
    expect(dealer.root.rotation.y).toBeCloseTo(DEALER_YAW, 9);
    expect(worldPositionOf(dealer, 'foot_l').y).toBeLessThan(0.2);
  });

  it('holds both hands in front of the body, above the rail and within reach', () => {
    const dealer = createDealer();

    for (const side of ['left', 'right'] as const) {
      const hand = handPosition(dealer, side);
      const local = localToDealer(dealer, hand);

      expect(hand.y, `${side} hand height`).toBeGreaterThan(RAIL_Y + 0.05);
      expect(hand.y, `${side} hand height`).toBeLessThan(RAIL_Y + 0.5);
      expect(local.z, `${side} hand forward`).toBeGreaterThan(0.2);
      expect(Math.abs(local.x), `${side} hand spread`).toBeGreaterThan(0.08);
    }
  });

  it('bends the elbows below the shoulders without stretching either bone', () => {
    const dealer = createDealer();

    for (const suffix of ['l', 'r']) {
      const shoulder = worldPositionOf(dealer, `upperarm_${suffix}`);
      const elbow = worldPositionOf(dealer, `lowerarm_${suffix}`);
      const wrist = worldPositionOf(dealer, `hand_${suffix}`);
      const upperLength = (dealer.root.getObjectByName(`lowerarm_${suffix}`) as Object3D).position.length() * 0.01;
      const lowerLength = (dealer.root.getObjectByName(`hand_${suffix}`) as Object3D).position.length() * 0.01;

      expect(elbow.y, `${suffix} elbow`).toBeLessThan(shoulder.y - 0.1);
      expect(shoulder.distanceTo(elbow)).toBeCloseTo(upperLength, 4);
      expect(elbow.distanceTo(wrist)).toBeCloseTo(lowerLength, 4);
      // The wrist is in front of the elbow's line down from the shoulder: a bent arm, not a hanging one.
      expect(localToDealer(dealer, wrist).z, `${suffix} wrist forward`).toBeGreaterThan(localToDealer(dealer, shoulder).z + 0.08);
    }
  });

  it('looks at the middle of the table: straight ahead and a little down', () => {
    const dealer = createDealer();
    settle(dealer);
    const face = faceDirection(dealer);

    expect(Math.abs(face.yaw)).toBeLessThan(MathUtils.degToRad(8));
    expect(face.pitch).toBeLessThan(0);
    expect(face.pitch).toBeGreaterThan(-MathUtils.degToRad(40));
  });
});

/** GSAP runs on wall-clock time, so the test samples the rig until the nod reaches each phase instead of sleeping. */
async function updateUntil(dealer: Dealer, reached: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  let elapsedSeconds = 5;
  while (performance.now() < deadline) {
    dealer.update(0.016, elapsedSeconds);
    if (reached()) {
      return true;
    }
    elapsedSeconds += 0.016;
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  return false;
}

describe('dealer gestures', () => {
  const seat = new Vector3(-0.9, FELT_Y, -0.3);

  it('puts the right hand over the felt while a card is flicked toward a seat', async () => {
    const dealer = createDealer();
    const restHand = handPosition(dealer, 'right');
    const gesture = dealer.gestureDeal(seat, 0.2);

    await new Promise((resolve) => setTimeout(resolve, 0.2 * DEAL_RELEASE_FRACTION * 1000));
    dealer.update(0.1, 0.1);
    const flickHand = handPosition(dealer, 'right');
    await gesture;

    expect(flickHand.distanceTo(restHand)).toBeGreaterThan(0.03);
  });

  it.each([
    ['deal', (dealer: Dealer) => dealer.gestureDeal(new Vector3(0.9, FELT_Y, 0.2), 0.05)],
    ['collect', (dealer: Dealer) => dealer.gestureCollect(0.05)],
    ['push', (dealer: Dealer) => dealer.gesturePush(new Vector3(-0.8, FELT_Y, 0.3), 0.05)],
  ])('returns the hands to the rest pose after a %s gesture', async (_name, perform) => {
    const dealer = createDealer();
    const restLeft = handPosition(dealer, 'left');
    const restRight = handPosition(dealer, 'right');

    await perform(dealer);
    settle(dealer);

    expect(handPosition(dealer, 'left').distanceTo(restLeft)).toBeLessThan(HAND_REACH_TOLERANCE);
    expect(handPosition(dealer, 'right').distanceTo(restRight)).toBeLessThan(HAND_REACH_TOLERANCE);
  });

  it('ends at rest when a second gesture interrupts the first', async () => {
    const dealer = createDealer();
    const restRight = handPosition(dealer, 'right');

    const first = dealer.gestureDeal(seat, 0.1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = dealer.gestureCollect(0.05);
    await Promise.all([first, second]);
    settle(dealer);

    expect(handPosition(dealer, 'right').distanceTo(restRight)).toBeLessThan(HAND_REACH_TOLERANCE);
  });

  it('skips gestures under reduced motion and stays at rest', async () => {
    const dealer = createDealer();
    const restRight = handPosition(dealer, 'right');
    dealer.setReducedMotion(true);

    await dealer.gestureDeal(seat, 0.2);
    settle(dealer);

    expect(handPosition(dealer, 'right').distanceTo(restRight)).toBeLessThan(HAND_REACH_TOLERANCE);
  });

  it('turns the head toward a seat', () => {
    const dealer = createDealer();
    const head = worldPositionOf(dealer, 'head');
    // 50 degrees to the dealer's left, at head height.
    const leftward = new Vector3(Math.sin(MathUtils.degToRad(50)), 0, Math.cos(MathUtils.degToRad(50))).multiplyScalar(2);
    dealer.lookAt(dealer.root.localToWorld(dealer.root.worldToLocal(head.clone()).add(leftward)));
    settle(dealer);

    const face = faceDirection(dealer);
    expect(face.yaw).toBeGreaterThan(MathUtils.degToRad(35));
    expect(face.yaw).toBeLessThan(MathUtils.degToRad(60));
  });

  it('never turns the head farther than a person could, even for a target behind the dealer', () => {
    const dealer = createDealer();
    const head = worldPositionOf(dealer, 'head');
    const behind = dealer.root.localToWorld(dealer.root.worldToLocal(head.clone()).add(new Vector3(0.3, 0, -2)));
    dealer.lookAt(behind);
    settle(dealer);

    expect(Math.abs(faceDirection(dealer).yaw)).toBeLessThan(MathUtils.degToRad(80));
    dealer.lookAt(null);
    settle(dealer);
    expect(Math.abs(faceDirection(dealer).yaw)).toBeLessThan(MathUtils.degToRad(8));
  });

  it('dips the head for a nod and comes back up', async () => {
    const dealer = createDealer();
    settle(dealer);
    const before = faceDirection(dealer).pitch;

    dealer.nod();
    const dipped = await updateUntil(dealer, () => faceDirection(dealer).pitch < before - 0.03);
    const returned = await updateUntil(dealer, () => Math.abs(faceDirection(dealer).pitch - before) < 0.05);

    expect(dipped).toBe(true);
    expect(returned).toBe(true);
  });
});

function fingertipGap(dealer: Dealer, side: 'l' | 'r'): number {
  return worldPositionOf(dealer, `thumb_end_${side}`).distanceTo(worldPositionOf(dealer, `index_end_${side}`));
}

function poseWithRightShape(shape: HandShape): PoseState {
  const pose = createRestPose();
  pose.rightShape = shape;
  return pose;
}

describe('articulated fingers', () => {
  it('closes the thumb onto the index finger for a pinch and keeps them apart in a flat hand', () => {
    const dealer = createDealer();

    dealer.holdPose(poseWithRightShape(handShape('pinch')));
    const pinched = fingertipGap(dealer, 'r');
    dealer.holdPose(poseWithRightShape(handShape('flat')));
    const flat = fingertipGap(dealer, 'r');

    expect(pinched).toBeLessThan(0.025);
    expect(flat).toBeGreaterThan(pinched + 0.03);
  });

  it('fans the fingertips apart when the hand is spread', () => {
    const dealer = createDealer();
    const span = (): number => worldPositionOf(dealer, 'index_end_r').distanceTo(worldPositionOf(dealer, 'pinky_end_r'));

    dealer.holdPose(poseWithRightShape(handShape('flat')));
    const together = span();
    dealer.holdPose(poseWithRightShape(handShape('spread')));

    expect(span()).toBeGreaterThan(together + 0.02);
  });

  it('curls a relaxed hand more than a flat one and never bends a finger past its joint limit', () => {
    const dealer = createDealer();
    const reach = (): number => worldPositionOf(dealer, 'middle_end_l').distanceTo(worldPositionOf(dealer, 'hand_l'));

    dealer.holdPose({ ...createRestPose(), leftShape: handShape('flat') });
    const flat = reach();
    dealer.holdPose({ ...createRestPose(), leftShape: { ...handShape('relaxed'), middle: 50 } });
    const overbent = reach();
    dealer.holdPose({ ...createRestPose(), leftShape: { ...handShape('relaxed'), middle: HAND_SHAPE_LIMITS.middle.max } });

    expect(overbent).toBeLessThan(flat);
    expect(overbent).toBeCloseTo(reach(), 9);
  });

  it('puts the grip point of a pinch beside the fingertips, not at the wrist', () => {
    const dealer = createDealer();
    dealer.holdPose(poseWithRightShape(handShape('pinch')));
    const grip = dealer.gripWorldPosition('right', new Vector3());
    const tip = worldPositionOf(dealer, 'index_end_r');
    const wrist = worldPositionOf(dealer, 'hand_r');

    expect(grip.distanceTo(tip)).toBeLessThan(0.06);
    expect(grip.distanceTo(wrist)).toBeGreaterThan(0.12);
  });
});

describe('spring-smoothed motion', () => {
  it('eases toward a new pose instead of snapping to it', async () => {
    const dealer = createDealer();
    const rest = handPosition(dealer, 'left');
    const gesture = dealer.gestureCollect(0.3);

    await new Promise((resolve) => setTimeout(resolve, 60));
    dealer.update(0.016, 0.1);
    const early = handPosition(dealer, 'left').distanceTo(rest);
    await gesture;
    settle(dealer);

    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(0.2);
    expect(handPosition(dealer, 'left').distanceTo(rest)).toBeLessThan(HAND_REACH_TOLERANCE);
  });
});

describe('dealer idle business', () => {
  const welcomePoint = new Vector3(-0.9, FELT_Y + 0.07, 0.3);

  async function pumpFor(dealer: Dealer, milliseconds: number): Promise<void> {
    const deadline = performance.now() + milliseconds;
    let elapsed = 5;
    while (performance.now() < deadline) {
      dealer.update(0.016, elapsed);
      elapsed += 0.016;
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  }

  it('moves his hands when he welcomes a player who sat down', async () => {
    const dealer = createDealer();
    dealer.setActivity('waiting');
    const rest = handPosition(dealer, 'right');

    dealer.welcomeSeat(welcomePoint);
    await pumpFor(dealer, 700);

    expect(handPosition(dealer, 'right').distanceTo(rest)).toBeGreaterThan(0.04);
  });

  it('goes back to the rest pose when a look order interrupts the action', async () => {
    const dealer = createDealer();
    const restRight = handPosition(dealer, 'right');
    dealer.welcomeSeat(welcomePoint);
    await pumpFor(dealer, 500);

    dealer.lookAt(null);
    settle(dealer);

    expect(handPosition(dealer, 'right').distanceTo(restRight)).toBeLessThan(HAND_REACH_TOLERANCE);
  });

  it('lets a gameplay gesture take over from an idle action and still end at rest', async () => {
    const dealer = createDealer();
    const restLeft = handPosition(dealer, 'left');
    const restRight = handPosition(dealer, 'right');
    dealer.welcomeSeat(welcomePoint);
    await pumpFor(dealer, 400);

    await dealer.gestureCollect(0.1);
    settle(dealer);

    expect(handPosition(dealer, 'left').distanceTo(restLeft)).toBeLessThan(HAND_REACH_TOLERANCE);
    expect(handPosition(dealer, 'right').distanceTo(restRight)).toBeLessThan(HAND_REACH_TOLERANCE);
  });

  it('only holds the deck while dealing and tells the table when it lifts and puts it down', async () => {
    const dealer = createDealer();
    const changes: boolean[] = [];
    dealer.onDeckHeldChange((held) => changes.push(held));

    await dealer.gestureDeal(new Vector3(-0.9, FELT_Y, -0.3), 0.05);
    dealer.update(0.016, 1);
    settle(dealer, 6);

    expect(changes[0]).toBe(true);
    expect(changes.at(-1)).toBe(false);
  });

  it('stays still apart from breathing when reduced motion is on', async () => {
    const dealer = createDealer();
    dealer.setReducedMotion(true);
    const rest = handPosition(dealer, 'right');

    dealer.welcomeSeat(welcomePoint);
    await pumpFor(dealer, 300);

    expect(handPosition(dealer, 'right').distanceTo(rest)).toBeLessThan(HAND_REACH_TOLERANCE);
  });
});

const IDLE_ACTIONS: IdleActionId[] = [
  'shuffleDeck',
  'squareDeck',
  'riffleChips',
  'glanceAround',
  'lookAtCamera',
  'rubHands',
  'adjustCuffs',
  'adjustTie',
  'leanOnRail',
  'drumFingers',
  'checkPot',
  'welcome',
];

const SEAT_RING = [0, 1, 2, 3, 4, 5].map((index) => ({ x: Math.cos(index) * 0.9, y: 0.78, z: Math.sin(index) * 0.9 }));
const SCRIPT_CONTEXT: IdleBuildContext = {
  activity: 'lobby',
  reducedMotion: false,
  random: () => 0.5,
  seatPoints: SEAT_RING,
  potPoint: { x: 0, y: FELT_Y, z: 0.075 },
  focus: { point: { x: 0.9, y: 0.78, z: 0.3 }, direction: { x: 0.5, y: 0, z: 0.8 } },
};
const REACH_TOLERANCE = 0.03;
const HAND_BONES = ['hand', 'thumb_end', 'index_end', 'middle_end', 'pinky_end', 'lowerarm'];

/** Metres a point stands above the felt (or the padded rail near the table edge); infinite outside the table. */
function heightAboveTable(point: Vector3): number {
  const beyondStraight = Math.max(Math.abs(point.x) - RAIL_SHAPE.halfLength, 0);
  const outline = Math.hypot(beyondStraight, point.z - RAIL_SHAPE.centerZ) - RAIL_SHAPE.radius;
  if (outline >= 0) return Infinity;
  return point.y - (outline > -0.06 ? RAIL_Y : FELT_Y);
}

/** The pose at the end of every key of a script and halfway to it, so the check also covers the travel between keys. */
function posesAlongScript(id: IdleActionId): PoseState[] {
  const script = buildIdleScript(id, SCRIPT_CONTEXT);
  const poses: PoseState[] = [];
  let pose = createRestPose();
  for (const key of script.keys) {
    const before = pose;
    pose = applyGoal(pose, key.goal);
    const halfway = applyGoal(pose, {});
    for (const side of ['leftHand', 'rightHand'] as const) {
      halfway[side] = {
        x: (before[side].x + pose[side].x) / 2,
        y: (before[side].y + pose[side].y) / 2,
        z: (before[side].z + pose[side].z) / 2,
      };
    }
    halfway.lean = (before.lean + pose.lean) / 2;
    halfway.hinge = (before.hinge + pose.hinge) / 2;
    poses.push(halfway, pose);
  }
  return poses;
}

describe.each(IDLE_ACTIONS)('idle action %s', (id) => {
  it('keeps every hand and finger above the felt and the rail along the whole motion', () => {
    const dealer = createDealer();
    let lowest = Infinity;

    for (const pose of posesAlongScript(id)) {
      dealer.holdPose(pose);
      for (const side of ['l', 'r']) {
        for (const bone of HAND_BONES) {
          lowest = Math.min(lowest, heightAboveTable(worldPositionOf(dealer, `${bone}_${side}`)));
        }
      }
    }

    expect(lowest).toBeGreaterThanOrEqual(0);
  });

  it('only asks for wrist positions the arms can reach', () => {
    const dealer = createDealer();

    for (const pose of posesAlongScript(id)) {
      dealer.holdPose(pose);
      for (const side of ['left', 'right'] as const) {
        const wanted = pose[`${side}Hand`];
        const wrist = localToDealer(dealer, worldPositionOf(dealer, side === 'left' ? 'hand_l' : 'hand_r'));
        expect(wrist.distanceTo(new Vector3(wanted.x, wanted.y, wanted.z)), `${side} wrist`).toBeLessThan(REACH_TOLERANCE);
      }
    }
  });

  it('keeps every finger inside the joint limits of a hand', () => {
    for (const pose of posesAlongScript(id)) {
      for (const shape of [pose.leftShape, pose.rightShape]) {
        for (const channel of Object.keys(HAND_SHAPE_LIMITS) as (keyof HandShape)[]) {
          expect(shape[channel]).toBeGreaterThanOrEqual(HAND_SHAPE_LIMITS[channel].min - 1e-9);
          expect(shape[channel]).toBeLessThanOrEqual(HAND_SHAPE_LIMITS[channel].max + 1e-9);
        }
      }
    }
  });

  it('ends exactly when its last move has finished, back at the rest pose', () => {
    const script = buildIdleScript(id, SCRIPT_CONTEXT);
    const last = script.keys.at(-1);

    expect(last?.goal.leftHand).toEqual(createRestPose().leftHand);
    expect(last?.goal.rightHand).toEqual(createRestPose().rightHand);
    expect(last ? last.at + last.duration : -1).toBeCloseTo(script.seconds, 6);
  });
});
