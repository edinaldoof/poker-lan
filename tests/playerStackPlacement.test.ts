import { Euler, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CARD_HEIGHT, CARD_WIDTH } from '../src/client/scene/CardFactory';
import { CHIP_DIAMETER, CHIP_HEIGHT } from '../src/client/scene/ChipFactory';
import { restHandTarget } from '../src/client/scene/dealerPose';
import { BETTING_LINE_RADIUS } from '../src/client/scene/FeltTexture';
import { PLAYER_STACK_MAX_COLUMN_HEIGHT, PLAYER_STACK_RADIUS, playerStackChips } from '../src/client/scene/playerStackLayout';
import {
  COMMUNITY_POSITIONS,
  DEALER_STAND_POSITION,
  DEALER_TRAY_POSITION,
  DEALER_TRAY_SIZE,
  DEALER_TRAY_YAW,
  DEALER_YAW,
  DECK_POSITION,
  FELT_SHAPE,
  FELT_Y,
  MUCK_POSITION,
  POT_POSITION,
  SEAT_SLOTS,
  SIDE_POT_POSITIONS,
  VISIBLE_FELT_SHAPE,
  getSeatAnchor,
  type SeatAnchor,
} from '../src/client/scene/SeatLayout';
import { VERTICAL_FOV_DEGREES, computeGamePose, placeCamera } from '../src/client/scene/Stage';
import { BLIND_BUTTON_HEIGHT, DEALER_BUTTON_HEIGHT, DEALER_BUTTON_RADIUS } from '../src/client/scene/TableButtons';
import { heroCardPose, tableCardPose, type CardPose } from '../src/client/scene/TableView';

const VIEWER_SLOT = 0;
const MIN_CLEARANCE = 0.012;
/**
 * Same envelope as tests/dealerLayout.test.ts (a bet is a tight cluster of up to three chip columns), widened to the
 * player's 2 x 2 block, which an all-in pushes onto the bet spot.
 */
const BET_STACK_RADIUS = Math.max(0.07, PLAYER_STACK_RADIUS);
const BET_STACK_HEIGHT = 12 * CHIP_HEIGHT;
const MUCK_RADIUS = 0.12;
const POT_RADIUS = 0.1;
/** A croupier's hand, fingers spread, seen from above. */
const DEALER_HAND_RADIUS = 0.09;
const STACK_HEIGHT = PLAYER_STACK_MAX_COLUMN_HEIGHT * CHIP_HEIGHT;
/** Heads-up the small blind rests on the dealer button: one footprint, two pucks high. */
const PUCK_PILE_HEIGHT = DEALER_BUTTON_HEIGHT + BLIND_BUTTON_HEIGHT;
const MIN_SCREEN_GAP_PX = 0.5;
/** paintBettingLine strokes the gold line 3.2 mm wide. */
const BETTING_LINE_HALF_WIDTH = 0.0016;
/** Chips past the betting line read as a bet: every chip of a stack keeps at least this much felt before the paint. */
const MIN_BETTING_LINE_CLEARANCE = 0.005;
const MIN_RAIL_CLEARANCE = 0.008;
/** One amount per footprint: one, two, three and four columns, and the full stack. */
const FOOTPRINT_AMOUNTS = [25, 60, 200, 2_000, 50_000];
const Y_AXIS = new Vector3(0, 1, 0);

const LAYOUTS = [
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '390x844', width: 390, height: 844 },
  { name: '844x390', width: 844, height: 390 },
];

interface Point {
  x: number;
  z: number;
}

type Footprint =
  | { name: string; kind: 'disc'; center: Point; radius: number }
  | { name: string; kind: 'rect'; center: Point; yaw: number; halfWidth: number; halfDepth: number };

function disc(name: string, center: Point, radius: number): Footprint {
  return { name, kind: 'disc', center: { x: center.x, z: center.z }, radius };
}

function rect(name: string, center: Point, yaw: number, halfWidth: number, halfDepth: number): Footprint {
  return { name, kind: 'rect', center: { x: center.x, z: center.z }, yaw, halfWidth, halfDepth };
}

/** Gap between a circle and a footprint on the felt, in metres; negative when they overlap. */
function gapToCircle(center: Point, radius: number, other: Footprint): number {
  const dx = center.x - other.center.x;
  const dz = center.z - other.center.z;
  if (other.kind === 'disc') return Math.hypot(dx, dz) - radius - other.radius;
  // Into the rectangle's own frame (rotation.y = yaw turns local +X toward world (cos, -sin)).
  const localX = dx * Math.cos(other.yaw) - dz * Math.sin(other.yaw);
  const localZ = dx * Math.sin(other.yaw) + dz * Math.cos(other.yaw);
  const outsideX = Math.abs(localX) - other.halfWidth;
  const outsideZ = Math.abs(localZ) - other.halfDepth;
  const outside = Math.hypot(Math.max(outsideX, 0), Math.max(outsideZ, 0));
  return (outside > 0 ? outside : Math.max(outsideX, outsideZ)) - radius;
}

function signedDistanceToStadium(point: Point, shape: { halfLength: number; radius: number; centerZ: number }): number {
  const beyondStraight = Math.max(Math.abs(point.x) - shape.halfLength, 0);
  return Math.hypot(beyondStraight, point.z - shape.centerZ) - shape.radius;
}

function cardFootprint(name: string, pose: CardPose): Footprint {
  // A tilted card covers less depth of felt.
  const halfDepth = ((CARD_HEIGHT * pose.scale) / 2) * Math.cos(pose.rotation.x);
  return rect(name, pose.position, pose.rotation.y, (CARD_WIDTH * pose.scale) / 2, halfDepth);
}

function holeCardPoses(anchor: SeatAnchor): CardPose[] {
  return [0, 1].map((index) => (anchor.slot === VIEWER_SLOT ? heroCardPose(anchor, index) : tableCardPose(anchor, index, false)));
}

/** World point of a dealer's resting hand (the pose is in the dealer's own frame, facing +Z). */
function dealerRestHand(side: 'left' | 'right'): Vector3 {
  const local = restHandTarget(side);
  return new Vector3(local.x, local.y, local.z).applyAxisAngle(new Vector3(0, 1, 0), DEALER_YAW).add(DEALER_STAND_POSITION);
}

function seatFootprints(anchor: SeatAnchor): Footprint[] {
  const cards = holeCardPoses(anchor).map((pose, index) => cardFootprint(`seat ${anchor.slot} card ${index + 1}`, pose));
  // The viewer's cards also lie on the felt for a moment, while they are dealt and before they are lifted.
  const dealt = anchor.slot === VIEWER_SLOT ? [0, 1].map((index) => cardFootprint(`seat 0 dealt card ${index + 1}`, tableCardPose(anchor, index, false))) : [];
  return [
    ...cards,
    ...dealt,
    disc(`seat ${anchor.slot} bet`, anchor.bet, BET_STACK_RADIUS),
    disc(`seat ${anchor.slot} pucks`, anchor.button, DEALER_BUTTON_RADIUS),
    disc(`seat ${anchor.slot} plate`, anchor.plate, 0.05),
  ];
}

function tableFootprints(): Footprint[] {
  return [
    rect('dealer tray', DEALER_TRAY_POSITION, DEALER_TRAY_YAW, DEALER_TRAY_SIZE.width / 2, DEALER_TRAY_SIZE.depth / 2),
    rect('deck', DECK_POSITION, 0, CARD_WIDTH / 2, CARD_HEIGHT / 2),
    disc('muck', MUCK_POSITION, MUCK_RADIUS),
    disc('dealer left hand', dealerRestHand('left'), DEALER_HAND_RADIUS),
    disc('dealer right hand', dealerRestHand('right'), DEALER_HAND_RADIUS),
    disc('pot', POT_POSITION, POT_RADIUS),
    ...SIDE_POT_POSITIONS.map((position, index) => disc(`side pot ${index + 1}`, position, BET_STACK_RADIUS)),
    ...COMMUNITY_POSITIONS.map((position, index) => rect(`community ${index + 1}`, position, 0, CARD_WIDTH / 2, CARD_HEIGHT / 2)),
  ];
}

const anchors = Array.from({ length: SEAT_SLOTS }, (_, slot) => getSeatAnchor(slot));

/** Centres of the chips of every footprint at the seat's stack, as TableView turns them (stackYaw). */
function stackChipCentres(anchor: SeatAnchor): Point[] {
  return FOOTPRINT_AMOUNTS.flatMap((amount) =>
    playerStackChips(amount, anchor.slot).map((chip) => {
      const world = new Vector3(chip.x, 0, chip.z).applyAxisAngle(Y_AXIS, anchor.stackYaw).add(anchor.stack);
      return { x: world.x, z: world.z };
    }),
  );
}
const stackFootprints = anchors.map((anchor) => disc(`seat ${anchor.slot} stack`, anchor.stack, PLAYER_STACK_RADIUS));
const everythingElse = [...tableFootprints(), ...anchors.flatMap(seatFootprints)];

describe('player stack anchors on the felt', () => {
  it('lies on the felt at every seat', () => {
    for (const anchor of anchors) expect(anchor.stack.y).toBe(FELT_Y);
  });

  it('turns every stack square to the rail', () => {
    for (const anchor of anchors) {
      const outward = new Vector3(Math.sin(anchor.stackYaw), 0, Math.cos(anchor.stackYaw));
      const ahead = anchor.stack.clone().addScaledVector(outward, 0.01);
      expect(signedDistanceToStadium(ahead, FELT_SHAPE) - signedDistanceToStadium(anchor.stack, FELT_SHAPE)).toBeCloseTo(0.01, 6);
    }
  });

  it('keeps every chip of every footprint on the visible felt, clear of the padded rail', () => {
    for (const anchor of anchors) {
      const margin = Math.min(...stackChipCentres(anchor).map((chip) => -signedDistanceToStadium(chip, VISIBLE_FELT_SHAPE) - CHIP_DIAMETER / 2));
      expect(margin, `seat ${anchor.slot}`).toBeGreaterThanOrEqual(MIN_RAIL_CLEARANCE);
    }
  });

  it('keeps every chip of every footprint on the player side of the betting line', () => {
    const bettingLine = { halfLength: FELT_SHAPE.halfLength, radius: BETTING_LINE_RADIUS, centerZ: FELT_SHAPE.centerZ };
    for (const anchor of anchors) {
      const clearance = Math.min(
        ...stackChipCentres(anchor).map((chip) => signedDistanceToStadium(chip, bettingLine) - CHIP_DIAMETER / 2 - BETTING_LINE_HALF_WIDTH),
      );
      expect(clearance, `seat ${anchor.slot}`).toBeGreaterThanOrEqual(MIN_BETTING_LINE_CLEARANCE);
    }
  });

  it('clears every card, bet, puck, plate, the dealer workspace and the other stacks of all eight seats', () => {
    const gaps = stackFootprints.flatMap((stack) =>
      [...everythingElse, ...stackFootprints.filter((other) => other !== stack)].map((other) => ({
        pair: `${stack.name} / ${other.name}`,
        gapMm: Math.round(gapToCircle(stack.center, PLAYER_STACK_RADIUS, other) * 1000),
      })),
    );
    gaps.sort((first, second) => first.gapMm - second.gapMm);
    console.info('Closest player stack gaps on the felt (mm)');
    console.table(gaps.slice(0, 12));

    expect(gaps.filter((entry) => entry.gapMm < MIN_CLEARANCE * 1000)).toEqual([]);
  });

  it('keeps the dealer and blind pucks clear of the cards, bets and the dealer workspace', () => {
    for (const anchor of anchors) {
      const puck = disc('puck', anchor.button, DEALER_BUTTON_RADIUS);
      const others = [...tableFootprints(), ...anchors.flatMap(seatFootprints).filter((item) => item.name !== `seat ${anchor.slot} pucks`)];
      for (const other of others) {
        expect(gapToCircle(puck.center, DEALER_BUTTON_RADIUS, other), `seat ${anchor.slot} pucks / ${other.name}`).toBeGreaterThanOrEqual(MIN_CLEARANCE);
      }
    }
  });

  it('puts the stack on the player left of the cards at every seat, so two stacks never share a gap', () => {
    for (const anchor of anchors) {
      const playerLeft = new Vector3(anchor.inward.z, 0, -anchor.inward.x);
      expect(anchor.stack.clone().sub(anchor.cards).dot(playerLeft), `seat ${anchor.slot}`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The same check through the game camera: tall columns, the lifted hand and the pucks as they appear on screen.
// ---------------------------------------------------------------------------------------------------------------

interface ScreenShape {
  name: string;
  hull: { x: number; y: number }[];
}

function cylinderPoints(center: Point, radius: number, bottom: number, height: number): Vector3[] {
  return [bottom, bottom + height].flatMap((y) =>
    Array.from({ length: 24 }, (_, index) => {
      const angle = (index / 24) * Math.PI * 2;
      return new Vector3(center.x + Math.cos(angle) * radius, y, center.z + Math.sin(angle) * radius);
    }),
  );
}

function cardCorners(pose: CardPose): Vector3[] {
  const rotation = new Euler(pose.rotation.x, pose.rotation.y, pose.rotation.z, 'YXZ');
  return [-1, 1].flatMap((sideX) =>
    [-1, 1].map((sideZ) =>
      new Vector3((sideX * CARD_WIDTH) / 2, 0, (sideZ * CARD_HEIGHT) / 2).multiplyScalar(pose.scale).applyEuler(rotation).add(pose.position),
    ),
  );
}

function boxPoints(center: Point, halfWidth: number, halfDepth: number, height: number): Vector3[] {
  return [-1, 1].flatMap((sideX) =>
    [-1, 1].flatMap((sideZ) =>
      [FELT_Y, FELT_Y + height].map((y) => new Vector3(center.x + sideX * halfWidth, y, center.z + sideZ * halfDepth)),
    ),
  );
}

function spherePoints(center: Vector3, radius: number): Vector3[] {
  const points: Vector3[] = [];
  for (let ring = 0; ring <= 6; ring++) {
    const polar = (ring / 6) * Math.PI;
    for (let index = 0; index < 12; index++) {
      const azimuth = (index / 12) * Math.PI * 2;
      points.push(
        new Vector3(
          center.x + radius * Math.sin(polar) * Math.cos(azimuth),
          center.y + radius * Math.cos(polar),
          center.z + radius * Math.sin(polar) * Math.sin(azimuth),
        ),
      );
    }
  }
  return points;
}

function convexHull(points: { x: number; y: number }[]): { x: number; y: number }[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: { x: number; y: number }[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: { x: number; y: number }[] = [];
  for (const point of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Separating-axis gap between two convex hulls in pixels; negative when they overlap on screen. */
function screenGap(first: ScreenShape, second: ScreenShape): number {
  let largestSeparation = -Infinity;
  for (const hull of [first.hull, second.hull]) {
    for (let index = 0; index < hull.length; index++) {
      const start = hull[index];
      const end = hull[(index + 1) % hull.length];
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      if (length === 0) continue;
      const axis = { x: -(end.y - start.y) / length, y: (end.x - start.x) / length };
      const project = (points: { x: number; y: number }[]): [number, number] => {
        const values = points.map((point) => point.x * axis.x + point.y * axis.y);
        return [Math.min(...values), Math.max(...values)];
      };
      const [minA, maxA] = project(first.hull);
      const [minB, maxB] = project(second.hull);
      largestSeparation = Math.max(largestSeparation, minB - maxA, minA - maxB);
    }
  }
  return largestSeparation;
}

function gameCamera(width: number, height: number): PerspectiveCamera {
  const aspect = width / height;
  const pose = computeGamePose(aspect, {
    viewportWidthPx: width,
    viewportHeightPx: height,
    sidePlateHalfWidthPx: 0,
    plateHalfHeightPx: 0,
    topReservePx: 0,
    bottomReservePx: 0,
    dealerBubbleRisePx: 0,
    wideLandscape: false,
  });
  const camera = new PerspectiveCamera(VERTICAL_FOV_DEGREES, aspect, 0.05, 80);
  placeCamera(camera, pose, new Vector3(pose.targetX, pose.targetY, pose.targetZ), pose.distance);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

function toScreen(name: string, points: Vector3[], camera: PerspectiveCamera, width: number, height: number): ScreenShape {
  const projected = points.map((point) => {
    const ndc = point.clone().project(camera);
    return { x: ((ndc.x + 1) / 2) * width, y: ((1 - ndc.y) / 2) * height };
  });
  return { name, hull: convexHull(projected) };
}

function screenObjects(camera: PerspectiveCamera, width: number, height: number): { stacks: ScreenShape[]; others: ScreenShape[] } {
  const shape = (name: string, points: Vector3[]): ScreenShape => toScreen(name, points, camera, width, height);
  const stacks = anchors.map((anchor) => shape(`seat ${anchor.slot} stack`, cylinderPoints(anchor.stack, PLAYER_STACK_RADIUS, FELT_Y, STACK_HEIGHT)));
  const others = [
    ...anchors.flatMap((anchor) => [
      ...holeCardPoses(anchor).map((pose, index) => shape(`seat ${anchor.slot} card ${index + 1}`, cardCorners(pose))),
      shape(`seat ${anchor.slot} bet`, cylinderPoints(anchor.bet, BET_STACK_RADIUS, FELT_Y, BET_STACK_HEIGHT)),
      shape(`seat ${anchor.slot} pucks`, cylinderPoints(anchor.button, DEALER_BUTTON_RADIUS, FELT_Y, PUCK_PILE_HEIGHT)),
    ]),
    shape('dealer tray', boxPoints(DEALER_TRAY_POSITION, DEALER_TRAY_SIZE.width / 2, DEALER_TRAY_SIZE.depth / 2, 0.03)),
    shape('deck', boxPoints(DECK_POSITION, CARD_WIDTH / 2, CARD_HEIGHT / 2, 0.02)),
    shape('dealer left hand', spherePoints(dealerRestHand('left'), DEALER_HAND_RADIUS)),
    shape('dealer right hand', spherePoints(dealerRestHand('right'), DEALER_HAND_RADIUS)),
    ...COMMUNITY_POSITIONS.map((position, index) => shape(`community ${index + 1}`, boxPoints(position, CARD_WIDTH / 2, CARD_HEIGHT / 2, 0.002))),
  ];
  return { stacks, others };
}

describe('player stacks through the game camera', () => {
  it.each(LAYOUTS)('never overlaps the lifted hand, cards, bets, pucks, the dealer or another stack on screen at $name', ({ width, height }) => {
    const camera = gameCamera(width, height);
    const { stacks, others } = screenObjects(camera, width, height);
    const overlaps: string[] = [];
    let closest = { gap: Infinity, pair: '' };
    for (const stack of stacks) {
      for (const other of [...others, ...stacks.filter((candidate) => candidate !== stack)]) {
        const gap = screenGap(stack, other);
        if (gap < closest.gap) closest = { gap, pair: `${stack.name} / ${other.name}` };
        if (gap < MIN_SCREEN_GAP_PX) overlaps.push(`${stack.name} / ${other.name}: ${gap.toFixed(1)} px`);
      }
    }
    console.info(`Closest stack gap on screen at ${width}x${height}: ${closest.gap.toFixed(1)} px (${closest.pair})`);

    expect(overlaps).toEqual([]);
  });
});
