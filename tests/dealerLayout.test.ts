import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CARD_HEIGHT, CARD_WIDTH } from '../src/client/scene/CardFactory';
import { BETTING_LINE_RADIUS, getBettingLineGap } from '../src/client/scene/FeltTexture';
import {
  COMMUNITY_POSITIONS,
  DEALER_RAIL_GAP,
  DEALER_RING_POSITION,
  DEALER_STAND_POSITION,
  DEALER_TRAY_POSITION,
  DEALER_TRAY_SIZE,
  DEALER_TRAY_YAW,
  DEALER_YAW,
  DECK_POSITION,
  FELT_SHAPE,
  FELT_Y,
  HOLE_FAN_ANGLE,
  HOLE_FAN_OFFSET,
  MUCK_POSITION,
  POT_POSITION,
  RAIL_SHAPE,
  RING_POSITIONS,
  SEAT_SLOTS,
  SIDE_POT_POSITIONS,
  VISIBLE_FELT_SHAPE,
  getSeatAnchor,
  ringPositionForSlot,
  seatForSlot,
  slotForSeat,
  stadiumPoint,
  type SeatAnchor,
  type StadiumShape,
} from '../src/client/scene/SeatLayout';
import { parseTableModel } from '../src/client/scene/TableModel';

interface Point {
  x: number;
  z: number;
}

interface Footprint {
  name: string;
  corners: Point[];
}

const BLIND_BUTTON_RADIUS = 0.03;
const PUCK_SPACING = 0.082;
/** A bet stack is a tight hex cluster of chip columns; three columns plus the chip radius. */
const BET_STACK_RADIUS = 0.07;
const MUCK_RADIUS = 0.12;
const MIN_CLEARANCE = 0.012;
const MIN_TABLE_CLEARANCE = 0.01;
const DEALER_MESH_PATH = new URL('../public/assets/dealer/dealer.glb', import.meta.url);
const TABLE_MODEL_PATH = new URL('../public/assets/table/poker_table.3ds', import.meta.url);
const TABLE_SLAB_MIN_Y = 0.55;
const TABLE_SLAB_MAX_Y = 0.8;

function rotated(center: Point, yaw: number, localX: number, localZ: number): Point {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return { x: center.x + localX * cos + localZ * sin, z: center.z - localX * sin + localZ * cos };
}

function rectangle(name: string, center: Point, yaw: number, halfWidth: number, halfDepth: number): Footprint {
  return {
    name,
    corners: [
      rotated(center, yaw, -halfWidth, -halfDepth),
      rotated(center, yaw, halfWidth, -halfDepth),
      rotated(center, yaw, halfWidth, halfDepth),
      rotated(center, yaw, -halfWidth, halfDepth),
    ],
  };
}

function disc(name: string, center: Point, radius: number): Footprint {
  const sides = 32;
  return {
    name,
    corners: Array.from({ length: sides }, (_, index) => {
      const angle = (index / sides) * Math.PI * 2;
      return { x: center.x + Math.cos(angle) * radius, z: center.z + Math.sin(angle) * radius };
    }),
  };
}

function card(name: string, center: Point, yaw: number): Footprint {
  return rectangle(name, center, yaw, CARD_WIDTH / 2, CARD_HEIGHT / 2);
}

function pointToSegmentDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  const along = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared));
  return Math.hypot(point.x - (start.x + dx * along), point.z - (start.z + dz * along));
}

/** Smallest overlap along the separating-axis candidates: positive when the polygons intersect. */
function penetrationDepth(first: Footprint, second: Footprint): number {
  let smallest = Infinity;
  for (const polygon of [first, second]) {
    for (let index = 0; index < polygon.corners.length; index++) {
      const start = polygon.corners[index];
      const end = polygon.corners[(index + 1) % polygon.corners.length];
      const length = Math.hypot(end.x - start.x, end.z - start.z);
      const axis = { x: -(end.z - start.z) / length, z: (end.x - start.x) / length };
      const project = (footprint: Footprint): [number, number] => {
        const values = footprint.corners.map((corner) => corner.x * axis.x + corner.z * axis.z);
        return [Math.min(...values), Math.max(...values)];
      };
      const [minA, maxA] = project(first);
      const [minB, maxB] = project(second);
      const overlap = Math.min(maxA, maxB) - Math.max(minA, minB);
      if (overlap <= 0) return -Infinity;
      smallest = Math.min(smallest, overlap);
    }
  }
  return smallest;
}

/** Gap between two convex footprints in meters; negative when they overlap. */
function gapBetween(first: Footprint, second: Footprint): number {
  const depth = penetrationDepth(first, second);
  if (depth !== -Infinity) return -depth;
  let nearest = Infinity;
  for (const [from, to] of [[first, second], [second, first]] as const) {
    for (const corner of from.corners) {
      for (let index = 0; index < to.corners.length; index++) {
        nearest = Math.min(nearest, pointToSegmentDistance(corner, to.corners[index], to.corners[(index + 1) % to.corners.length]));
      }
    }
  }
  return nearest;
}

/** Distance from a point to the stadium outline: negative inside the shape. */
function signedDistanceToStadium(point: Point, shape: StadiumShape): number {
  const beyondStraight = Math.max(Math.abs(point.x) - shape.halfLength, 0);
  return Math.hypot(beyondStraight, point.z - shape.centerZ) - shape.radius;
}

function toPoint(vector: { x: number; z: number }): Point {
  return { x: vector.x, z: vector.z };
}

function dealerWorkspace(): Footprint[] {
  return [
    rectangle('tray', toPoint(DEALER_TRAY_POSITION), DEALER_TRAY_YAW, DEALER_TRAY_SIZE.width / 2, DEALER_TRAY_SIZE.depth / 2),
    card('deck', toPoint(DECK_POSITION), 0),
    disc('muck', toPoint(MUCK_POSITION), MUCK_RADIUS),
  ];
}

function sharedTableItems(): Footprint[] {
  return [
    ...COMMUNITY_POSITIONS.map((position, index) => card(`community ${index + 1}`, toPoint(position), 0)),
    disc('pot', toPoint(POT_POSITION), 0.1),
    ...SIDE_POT_POSITIONS.map((position, index) => disc(`side pot ${index + 1}`, toPoint(position), BET_STACK_RADIUS)),
  ];
}

function holeCards(anchor: SeatAnchor): Footprint[] {
  return [-1, 1].map((side) => {
    const sideways = rotated({ x: 0, z: 0 }, anchor.yaw, side * HOLE_FAN_OFFSET, 0);
    const center = { x: anchor.cards.x + sideways.x, z: anchor.cards.z + sideways.z };
    return card(`seat ${anchor.slot} card ${side < 0 ? 1 : 2}`, center, anchor.yaw - side * HOLE_FAN_ANGLE);
  });
}

function seatItems(anchor: SeatAnchor): Footprint[] {
  const sideways = { x: anchor.button.x - anchor.cards.x, z: anchor.button.z - anchor.cards.z };
  const sidewaysLength = Math.hypot(sideways.x, sideways.z);
  // Heads-up the dealer button and the blind puck share a seat and spread along this direction.
  const pucks = [0, 1, 2].map((crowded) =>
    disc(`seat ${anchor.slot} puck ${crowded + 1}`, {
      x: anchor.button.x + (sideways.x / sidewaysLength) * crowded * PUCK_SPACING,
      z: anchor.button.z + (sideways.z / sidewaysLength) * crowded * PUCK_SPACING,
    }, BLIND_BUTTON_RADIUS),
  );
  return [...holeCards(anchor), disc(`seat ${anchor.slot} bet`, toPoint(anchor.bet), BET_STACK_RADIUS), ...pucks];
}

function allSeatItems(): Footprint[] {
  return Array.from({ length: SEAT_SLOTS }, (_, slot) => seatItems(getSeatAnchor(slot))).flat();
}

function readDealerVertices(): Float32Array {
  const bytes = readFileSync(DEALER_MESH_PATH);
  const jsonLength = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8')) as {
    accessors: { bufferView: number; byteOffset?: number; count: number }[];
    bufferViews: { byteOffset?: number; byteStride?: number }[];
  };
  const accessor = gltf.accessors[0];
  const view = gltf.bufferViews[accessor.bufferView];
  const binaryStart = 20 + jsonLength + 8;
  const start = binaryStart + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = view.byteStride ?? 12;
  const positions = new Float32Array(accessor.count * 3);
  for (let vertex = 0; vertex < accessor.count; vertex++) {
    for (let axis = 0; axis < 3; axis++) {
      positions[vertex * 3 + axis] = bytes.readFloatLE(start + vertex * stride + axis * 4);
    }
  }
  return positions;
}

describe('seat ring with the dealer position', () => {
  it('spaces the nine ring positions evenly and keeps the dealer out of the seat slots', () => {
    const positions = Array.from({ length: SEAT_SLOTS }, (_, slot) => ringPositionForSlot(slot));

    expect(RING_POSITIONS).toBe(9);
    expect(DEALER_RING_POSITION).toBe(5);
    expect(positions).toEqual([0, 1, 2, 3, 4, 6, 7, 8]);
    expect(positions).not.toContain(DEALER_RING_POSITION);
  });

  it('keeps the slot rotation modulo eight seats', () => {
    for (let viewer = 0; viewer < SEAT_SLOTS; viewer++) {
      for (let seat = 0; seat < SEAT_SLOTS; seat++) {
        const slot = slotForSeat(seat, viewer);
        expect(slot).toBe((seat - viewer + SEAT_SLOTS) % SEAT_SLOTS);
        expect(seatForSlot(slot, viewer)).toBe(seat);
      }
    }
  });

  it('puts the viewer at the bottom centre and the dealer on the far side right of centre', () => {
    expect(getSeatAnchor(0).plate.x).toBeCloseTo(0, 6);
    expect(getSeatAnchor(0).plate.z).toBeGreaterThan(0.7);

    const rail = stadiumPoint(DEALER_RING_POSITION / RING_POSITIONS, RAIL_SHAPE.halfLength, RAIL_SHAPE.radius, RAIL_SHAPE.centerZ);
    expect(rail.point.x).toBeGreaterThan(0.38);
    expect(rail.point.x).toBeLessThan(0.43);
    expect(DEALER_STAND_POSITION.y).toBe(0);
    expect(DEALER_STAND_POSITION.z).toBeCloseTo(rail.point.z - DEALER_RAIL_GAP, 6);
  });

  it('turns the dealer toward the middle of the table', () => {
    const facing = { x: Math.sin(DEALER_YAW), z: Math.cos(DEALER_YAW) };
    const toCentre = { x: -DEALER_STAND_POSITION.x, z: -DEALER_STAND_POSITION.z };
    const length = Math.hypot(toCentre.x, toCentre.z);

    expect(facing.x).toBeCloseTo(toCentre.x / length, 6);
    expect(facing.z).toBeCloseTo(toCentre.z / length, 6);
  });

  it('leaves the dealer ring position empty of plates, cards and bets', () => {
    const dealerPoint = stadiumPoint(DEALER_RING_POSITION / RING_POSITIONS, RAIL_SHAPE.halfLength, RAIL_SHAPE.radius, RAIL_SHAPE.centerZ).point;
    for (let slot = 0; slot < SEAT_SLOTS; slot++) {
      const plate = getSeatAnchor(slot).plate;
      expect(Math.hypot(plate.x - dealerPoint.x, plate.z - dealerPoint.z)).toBeGreaterThan(0.5);
    }
  });
});

describe('dealer workspace on the felt', () => {
  it('keeps the tray, deck and muck on the visible part of the felt', () => {
    for (const item of dealerWorkspace()) {
      for (const corner of item.corners) {
        expect(signedDistanceToStadium(corner, VISIBLE_FELT_SHAPE), `${item.name} corner`).toBeLessThan(0);
      }
    }
  });

  it('keeps the dealer workspace at felt height', () => {
    for (const position of [DEALER_TRAY_POSITION, DECK_POSITION, MUCK_POSITION]) {
      expect(position.y).toBe(FELT_Y);
    }
  });

  it('does not overlap anything else on the table', () => {
    const items = [...dealerWorkspace(), ...sharedTableItems(), ...allSeatItems()];
    const rows: { pair: string; gapMm: number }[] = [];
    const overlaps: string[] = [];

    for (const mine of dealerWorkspace()) {
      for (const other of items) {
        if (other === mine || other.name === mine.name) continue;
        const gap = gapBetween(mine, other);
        rows.push({ pair: `${mine.name} / ${other.name}`, gapMm: Math.round(gap * 1000) });
        if (gap < MIN_CLEARANCE) overlaps.push(`${mine.name} / ${other.name}: ${(gap * 1000).toFixed(1)} mm`);
      }
    }

    const closest = [...rows].sort((a, b) => a.gapMm - b.gapMm).slice(0, 12);
    console.info('Closest dealer workspace gaps (mm)');
    console.table(closest);
    expect(overlaps).toEqual([]);
  });

  it('keeps the tray, deck and muck apart from each other', () => {
    const [tray, deck, muck] = dealerWorkspace();
    for (const [first, second] of [[tray, deck], [tray, muck], [deck, muck]]) {
      expect(gapBetween(first, second), `${first.name} / ${second.name}`).toBeGreaterThanOrEqual(MIN_CLEARANCE);
    }
  });

  it('keeps the community row between the deck and the pot side of the table', () => {
    const deckFootprint = card('deck', toPoint(DECK_POSITION), 0);
    const nearestCommunity = Math.min(...COMMUNITY_POSITIONS.map((position) => gapBetween(deckFootprint, card('community', toPoint(position), 0))));

    expect(DECK_POSITION.z).toBeLessThan(COMMUNITY_POSITIONS[0].z);
    expect(nearestCommunity).toBeGreaterThan(0.05);
  });

  it('puts the tray straight in front of the dealer and the deck on the dealer right-hand side', () => {
    expect(Math.abs(DEALER_TRAY_POSITION.x - DEALER_STAND_POSITION.x)).toBeLessThan(0.08);
    // The dealer faces +Z, so his right hand is toward -X and the muck, on his left, toward +X.
    expect(DECK_POSITION.x).toBeLessThan(DEALER_TRAY_POSITION.x);
    expect(MUCK_POSITION.x).toBeGreaterThan(DEALER_TRAY_POSITION.x);
  });
});

describe('dealer standing behind the far rail', () => {
  it('keeps every vertex of the legs and hips outside the table slab', () => {
    const positions = readDealerVertices();
    const cos = Math.cos(DEALER_YAW);
    const sin = Math.sin(DEALER_YAW);
    let closest = Infinity;

    for (let vertex = 0; vertex < positions.length / 3; vertex++) {
      const y = positions[vertex * 3 + 1];
      if (y < TABLE_SLAB_MIN_Y || y > TABLE_SLAB_MAX_Y) continue;
      const localX = positions[vertex * 3];
      const localZ = positions[vertex * 3 + 2];
      const world = {
        x: DEALER_STAND_POSITION.x + localX * cos + localZ * sin,
        z: DEALER_STAND_POSITION.z - localX * sin + localZ * cos,
      };
      closest = Math.min(closest, signedDistanceToStadium(world, RAIL_SHAPE));
    }

    console.info(`Dealer closest approach to the table slab: ${(closest * 1000).toFixed(1)} mm`);
    expect(closest).toBeGreaterThanOrEqual(MIN_TABLE_CLEARANCE);
  });

  it('stands close enough for the arms to reach the felt in front of the rail', () => {
    // Shoulder height 1.5 m and a combined arm of ~0.54 m: the felt edge must be within a leaning arm's reach.
    expect(DEALER_RAIL_GAP).toBeLessThanOrEqual(0.2);
  });
});

describe('dealer chip tray on the felt', () => {
  function loadTray(): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } {
    const bytes = readFileSync(TABLE_MODEL_PATH);
    const parts = parseTableModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    parts.tray.geometry.computeBoundingBox();
    const bounds = parts.tray.geometry.boundingBox;
    if (!bounds) throw new Error('tray has no bounds');
    // The mesh sits at DEALER_TRAY_POSITION, so world bounds are the local bounds plus that offset.
    const offset = parts.tray.position;
    return {
      min: { x: bounds.min.x + offset.x, y: bounds.min.y + offset.y, z: bounds.min.z + offset.z },
      max: { x: bounds.max.x + offset.x, y: bounds.max.y + offset.y, z: bounds.max.z + offset.z },
    };
  }

  it('stands on the felt inside its footprint', () => {
    const { min, max } = loadTray();

    expect(min.y).toBeCloseTo(FELT_Y, 4);
    expect(max.y - min.y).toBeLessThan(0.05);
    expect(max.x - min.x).toBeLessThanOrEqual(DEALER_TRAY_SIZE.width + 1e-6);
    expect(max.z - min.z).toBeLessThanOrEqual(DEALER_TRAY_SIZE.depth + 1e-6);
    expect((min.x + max.x) / 2).toBeCloseTo(DEALER_TRAY_POSITION.x, 3);
    expect((min.z + max.z) / 2).toBeCloseTo(DEALER_TRAY_POSITION.z, 3);
  });

  it('keeps every corner of the tray on the visible felt', () => {
    const { min, max } = loadTray();
    for (const x of [min.x, max.x]) {
      for (const z of [min.z, max.z]) {
        expect(signedDistanceToStadium({ x, z }, VISIBLE_FELT_SHAPE)).toBeLessThan(0);
      }
    }
  });
});

describe('betting line around the dealer workspace', () => {
  it('stops before the deck and resumes after the muck without touching either', () => {
    const gap = getBettingLineGap();
    const painted: Point[] = [];
    const samples = 600;
    for (let sample = 0; sample <= samples; sample++) {
      const t = gap.end + (sample / samples) * (1 - (gap.end - gap.start));
      painted.push(toPoint(stadiumPoint(t, FELT_SHAPE.halfLength, BETTING_LINE_RADIUS, FELT_SHAPE.centerZ).point));
    }

    for (const item of dealerWorkspace()) {
      const nearest = Math.min(...painted.map((point) => gapBetween(item, disc('line point', point, 0.001))));
      expect(nearest, `${item.name} distance to the line`).toBeGreaterThan(0.02);
    }
    expect(gap.end).toBeGreaterThan(gap.start);
    expect(gap.end - gap.start).toBeLessThan(0.3);
  });
});
