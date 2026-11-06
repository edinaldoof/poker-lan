import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { BoxGeometry, BufferAttribute, Group, InstancedMesh, Mesh, MeshStandardMaterial, PerspectiveCamera, Texture, Vector2, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { chairOpacityForCamera, settleChairOpacity } from '../src/client/scene/room/chairFade';
import { clockHandAngles, clockwiseAngleOf, handRotationZ } from '../src/client/scene/room/clockHands';
import { capHighlights } from '../src/client/scene/room/roomAssets';
import { RoomChairs } from '../src/client/scene/room/roomChairs';
import { wallLightmapUv } from '../src/client/scene/room/roomGlow';
import {
  CEILING_HEIGHT,
  CHANDELIER_POSITIONS,
  MODEL_FOOTPRINTS,
  PROP_SPECS,
  ROOM_HALF_DEPTH,
  ROOM_HALF_WIDTH,
  RUG_HALF_DEPTH,
  RUG_HALF_WIDTH,
  WALLS,
  canvasCropWindow,
  chairPlacements,
  isCeilingVisibleFrom,
  placeProp,
  sconcePlacements,
  type ChairPlacement,
} from '../src/client/scene/room/roomLayout';
import {
  DEALER_STAND_POSITION,
  FELT_Y,
  RAIL_SHAPE,
  RAIL_Y,
  SEAT_SLOTS,
  getSeatAnchor,
  type StadiumShape,
} from '../src/client/scene/SeatLayout';
import {
  LOBBY_MAX_DISTANCE,
  VERTICAL_FOV_DEGREES,
  VIEWER_HAND_NEAR_EDGE,
  computeGamePose,
  computeLobbyPose,
  fogRangeForCamera,
  placeCamera,
  type CameraPose,
} from '../src/client/scene/Stage';

const SCREEN_ASPECTS = { phonePortrait: 390 / 844, tablet: 768 / 1024, square: 1, laptop: 1366 / 768, wide: 21 / 9, phoneLandscape: 844 / 390 };
const NEAR_SIDE_SLOTS = [7, 0, 1];
const FAR_SIDE_SLOTS = [3, 4, 5];
const CHAIR = MODEL_FOOTPRINTS.chair;

function cameraFor(pose: CameraPose, aspect: number): PerspectiveCamera {
  const camera = new PerspectiveCamera(VERTICAL_FOV_DEGREES, aspect, 0.05, 80);
  placeCamera(camera, pose, new Vector3(pose.targetX, pose.targetY, pose.targetZ), pose.distance);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

/** Signed distance (xz) from a point to a stadium outline: negative inside. */
function distanceOutsideStadium(point: Vector3, shape: StadiumShape): number {
  const alongStraight = Math.max(Math.abs(point.x) - shape.halfLength, 0);
  return Math.hypot(alongStraight, point.z - shape.centerZ) - shape.radius;
}

/** The chair's footprint corners on the floor (its model faces +Z, back at -backDepth). */
function chairFootprint(chair: ChairPlacement): Vector3[] {
  const front = CHAIR.depth - CHAIR.backDepth;
  return [
    [-CHAIR.width / 2, -CHAIR.backDepth],
    [CHAIR.width / 2, -CHAIR.backDepth],
    [CHAIR.width / 2, front],
    [-CHAIR.width / 2, front],
  ].map(([x, z]) => new Vector3(x, 0, z).applyAxisAngle(new Vector3(0, 1, 0), chair.yaw).add(chair.position));
}

function chairBoxCorners(chair: ChairPlacement): Vector3[] {
  return chairFootprint(chair).flatMap((corner) => [corner, corner.clone().setY(CHAIR.height)]);
}

interface ScreenRect {
  min: Vector2;
  max: Vector2;
}

function projectedRect(camera: PerspectiveCamera, points: readonly Vector3[]): ScreenRect {
  const projected = points.map((point) => point.clone().project(camera));
  return {
    min: new Vector2(Math.min(...projected.map((p) => p.x)), Math.min(...projected.map((p) => p.y))),
    max: new Vector2(Math.max(...projected.map((p) => p.x)), Math.max(...projected.map((p) => p.y))),
  };
}

function rectsOverlap(first: ScreenRect, second: ScreenRect): boolean {
  return first.min.x < second.max.x && second.min.x < first.max.x && first.min.y < second.max.y && second.min.y < first.max.y;
}

/** Everything of the viewer's own seat that must stay readable: the raised hand, its bet and its name plate. */
function viewerSeatPoints(): Vector3[] {
  const seat = getSeatAnchor(0);
  const handHalfWidth = 0.086 + (0.13 * 1.35) / 2;
  const hand = [-1, 1].flatMap((side) => [
    new Vector3(seat.cards.x + side * handHalfWidth, RAIL_Y, seat.cards.z - 0.13),
    new Vector3(seat.cards.x + side * handHalfWidth, RAIL_Y, VIEWER_HAND_NEAR_EDGE.z),
  ]);
  return [...hand, seat.bet, seat.plate];
}

describe('chair placement', () => {
  const chairs = chairPlacements();

  it('puts one chair at every seat slot and none at the dealer', () => {
    expect(chairs.map((chair) => chair.slot)).toEqual(Array.from({ length: SEAT_SLOTS }, (_, slot) => slot));
    for (const chair of chairs) {
      expect(chair.position.distanceTo(DEALER_STAND_POSITION)).toBeGreaterThan(0.6);
    }
  });

  it('turns every chair toward the middle of the table while staying nearly square to the rail', () => {
    for (const chair of chairs) {
      const facing = new Vector3(Math.sin(chair.yaw), 0, Math.cos(chair.yaw));
      const towardCenter = chair.position.clone().setY(0).negate().normalize();
      expect(facing.dot(towardCenter)).toBeGreaterThan(0.95);
      expect(facing.dot(chair.outward.clone().negate())).toBeGreaterThan(0.95);
    }
  });

  it('pulls every chair back from the rail, standing on the floor beside its own seat', () => {
    for (const chair of chairs) {
      for (const corner of chairFootprint(chair)) {
        expect(distanceOutsideStadium(corner, RAIL_SHAPE)).toBeGreaterThan(0.1);
      }
      expect(chair.position.y).toBe(0);
      const seatPlate = getSeatAnchor(chair.slot).plate.setY(0);
      expect(chair.position.distanceTo(seatPlate)).toBeLessThan(0.5);
    }
  });

  it('leaves room between neighbouring chairs and keeps them all on the rug', () => {
    for (const [index, chair] of chairs.entries()) {
      const next = chairs[(index + 1) % chairs.length];
      expect(chair.position.distanceTo(next.position)).toBeGreaterThan(CHAIR.width + 0.25);
      for (const corner of chairFootprint(chair)) {
        expect(Math.abs(corner.x)).toBeLessThan(RUG_HALF_WIDTH - 0.5);
        expect(Math.abs(corner.z)).toBeLessThan(RUG_HALF_DEPTH - 0.5);
      }
    }
  });
});

describe('chair fade', () => {
  const chairs = chairPlacements();

  it('hides the chairs on the viewer side and keeps the far ones in every game framing', () => {
    for (const aspect of Object.values(SCREEN_ASPECTS)) {
      const camera = cameraFor(computeGamePose(aspect), aspect);
      for (const chair of chairs) {
        const opacity = chairOpacityForCamera(chair.outward, camera.position);
        if (NEAR_SIDE_SLOTS.includes(chair.slot)) expect(opacity).toBe(0);
        if (FAR_SIDE_SLOTS.includes(chair.slot)) expect(opacity).toBe(1);
      }
    }
  });

  it('never draws a chair over the viewer’s cards, bet or plate in the game view', () => {
    for (const aspect of Object.values(SCREEN_ASPECTS)) {
      const camera = cameraFor(computeGamePose(aspect), aspect);
      const protectedArea = projectedRect(camera, viewerSeatPoints());
      for (const chair of chairs) {
        if (chairOpacityForCamera(chair.outward, camera.position) > 0.01) {
          expect(rectsOverlap(projectedRect(camera, chairBoxCorners(chair)), protectedArea)).toBe(false);
        }
      }
    }
  });

  it('keeps every chair during the lobby orbit, where they give the room its depth', () => {
    for (let azimuth = 0; azimuth < Math.PI * 2; azimuth += Math.PI / 12) {
      const camera = cameraFor(computeLobbyPose(SCREEN_ASPECTS.laptop, azimuth), SCREEN_ASPECTS.laptop);
      for (const chair of chairs) {
        expect(chairOpacityForCamera(chair.outward, camera.position)).toBe(1);
      }
    }
  });

  it('snaps a chair within a hair of solid or hidden to exactly solid or hidden', () => {
    expect(settleChairOpacity(0.998)).toBe(1);
    expect(settleChairOpacity(0.004)).toBe(0);
    expect(settleChairOpacity(0.5)).toBe(0.5);
  });
});

describe('room chairs', () => {
  function createChairs(): RoomChairs {
    const model = new Group().add(new Mesh(new BoxGeometry(0.43, 0.97, 0.58), new MeshStandardMaterial()));
    return new RoomChairs(model, new Texture());
  }

  function fadingMeshes(chairs: RoomChairs): Mesh<BoxGeometry, MeshStandardMaterial>[] {
    return chairs.group.children.filter((child): child is Mesh<BoxGeometry, MeshStandardMaterial> => child.name.startsWith('chairFading-'));
  }

  function shadowAlphas(chairs: RoomChairs): number[] {
    const colors = (chairs.group.getObjectByName('chairShadows') as Mesh).geometry.getAttribute('color') as BufferAttribute;
    return Array.from({ length: colors.count / 4 }, (_, chair) => colors.getW(chair * 4));
  }

  /** Camera positions from the lobby orbit to the game view, as the join flight moves it. */
  function flightPositions(): Vector3[] {
    const aspect = SCREEN_ASPECTS.laptop;
    const from = cameraFor(computeLobbyPose(aspect, 0.3), aspect).position;
    const to = cameraFor(computeGamePose(aspect), aspect).position;
    return Array.from({ length: 41 }, (_, step) => from.clone().lerp(to, step / 40));
  }

  it('draws every chair of the lobby in one instanced draw', () => {
    const chairs = createChairs();
    chairs.update(cameraFor(computeLobbyPose(SCREEN_ASPECTS.laptop, 0.3), SCREEN_ASPECTS.laptop).position);
    expect((chairs.group.getObjectByName('solidChairs') as InstancedMesh).count).toBe(SEAT_SLOTS);
    expect(fadingMeshes(chairs).every((mesh) => !mesh.visible)).toBe(true);
    expect(shadowAlphas(chairs)).toEqual(Array(SEAT_SLOTS).fill(1));
  });

  it('fades the near chairs during the flight without ever asking for a new shader', () => {
    const chairs = createChairs();
    const fading = fadingMeshes(chairs);
    const versionsBefore = fading.map((mesh) => mesh.material.version);
    expect(fading.every((mesh) => mesh.material.transparent)).toBe(true);

    let sawPartialFade = false;
    for (const position of flightPositions()) {
      chairs.update(position);
      sawPartialFade ||= fading.some((mesh) => mesh.visible && mesh.material.opacity > 0 && mesh.material.opacity < 1);
    }

    expect(sawPartialFade).toBe(true);
    expect(fading.map((mesh) => mesh.material.version)).toEqual(versionsBefore);
    expect(fading.every((mesh) => mesh.material.transparent)).toBe(true);
    expect((chairs.group.getObjectByName('solidChairs') as InstancedMesh).count).toBe(SEAT_SLOTS - NEAR_SIDE_SLOTS.length);
    const alphas = shadowAlphas(chairs);
    for (const slot of NEAR_SIDE_SLOTS) expect(alphas[slot]).toBe(0);
    for (const slot of FAR_SIDE_SLOTS) expect(alphas[slot]).toBe(1);
  });

  it('puts the chairs back in the instanced draw when the camera returns to the lobby', () => {
    const chairs = createChairs();
    for (const position of [...flightPositions(), ...flightPositions().reverse()]) {
      chairs.update(position);
    }
    expect((chairs.group.getObjectByName('solidChairs') as InstancedMesh).count).toBe(SEAT_SLOTS);
    expect(fadingMeshes(chairs).every((mesh) => !mesh.visible)).toBe(true);
  });
});

describe('room bounds', () => {
  /** Floor-plan corners of a placed prop, from its measured footprint. */
  function propCorners(spec: (typeof PROP_SPECS)[number]): Vector3[] {
    const footprint = MODEL_FOOTPRINTS[spec.model];
    const placement = placeProp(spec);
    const front = footprint.depth - footprint.backDepth;
    return [
      [-footprint.width / 2, -footprint.backDepth],
      [footprint.width / 2, -footprint.backDepth],
      [footprint.width / 2, front],
      [-footprint.width / 2, front],
    ].map(([x, z]) =>
      new Vector3(x * spec.scale, 0, z * spec.scale).applyAxisAngle(new Vector3(0, 1, 0), placement.yaw).add(placement.position),
    );
  }

  it('stands every piece inside the walls with its back to its own wall', () => {
    for (const spec of PROP_SPECS) {
      const wall = WALLS[spec.wall];
      for (const corner of propCorners(spec)) {
        expect(Math.abs(corner.x)).toBeLessThanOrEqual(ROOM_HALF_WIDTH);
        expect(Math.abs(corner.z)).toBeLessThanOrEqual(ROOM_HALF_DEPTH);
        const distanceFromWall = corner.clone().sub(wall.center).dot(wall.inward);
        expect(distanceFromWall).toBeGreaterThan(0);
      }
      const backGap = placeProp(spec).position.clone().sub(wall.center).dot(wall.inward) - MODEL_FOOTPRINTS[spec.model].backDepth * spec.scale;
      expect(backGap).toBeGreaterThan(0);
      expect(backGap).toBeLessThan(0.08);
    }
  });

  it('hangs each painting above whatever stands under it and below the cornice', () => {
    for (const painting of PROP_SPECS.filter((spec) => spec.model === 'pictureFrame')) {
      const halfHeight = (MODEL_FOOTPRINTS.pictureFrame.height * painting.scale) / 2;
      expect(painting.height + halfHeight).toBeLessThan(CEILING_HEIGHT - 0.4);
      for (const piece of PROP_SPECS.filter((spec) => spec.wall === painting.wall && spec.model !== 'pictureFrame')) {
        const overlapsAlongWall =
          Math.abs(piece.offsetAlong - painting.offsetAlong) <
          (MODEL_FOOTPRINTS[piece.model].width * piece.scale + MODEL_FOOTPRINTS.pictureFrame.width * painting.scale) / 2;
        if (overlapsAlongWall) {
          expect(painting.height - halfHeight).toBeGreaterThan(MODEL_FOOTPRINTS[piece.model].height * piece.scale + 0.25);
        }
      }
    }
  });

  it('keeps the lobby camera inside the room, clear of the furniture, on every screen shape', () => {
    const nearestFurniture = Math.min(
      ...PROP_SPECS.filter((spec) => spec.model !== 'pictureFrame').flatMap((spec) =>
        propCorners(spec).map((corner) => Math.hypot(corner.x, corner.z)),
      ),
    );
    expect(LOBBY_MAX_DISTANCE).toBeLessThan(nearestFurniture - 0.3);
    for (const aspect of Object.values(SCREEN_ASPECTS)) {
      for (let azimuth = 0; azimuth < Math.PI * 2; azimuth += Math.PI / 8) {
        const position = cameraFor(computeLobbyPose(aspect, azimuth), aspect).position;
        expect(Math.hypot(position.x, position.z)).toBeLessThanOrEqual(LOBBY_MAX_DISTANCE + 1e-9);
        expect(position.y).toBeLessThan(CEILING_HEIGHT - 0.5);
        expect(isCeilingVisibleFrom(position.y)).toBe(true);
      }
    }
  });

  it('orbits the lobby at seated eye height, above the chair backs and well under the lamp rim', () => {
    /** Bottom of the lamp's diffuser in the scene (measured on the table model); just under it, its edge aliases. */
    const lampRimY = 1.95;
    for (const aspect of Object.values(SCREEN_ASPECTS)) {
      for (let azimuth = 0; azimuth < Math.PI * 2; azimuth += Math.PI / 8) {
        const position = cameraFor(computeLobbyPose(aspect, azimuth), aspect).position;
        expect(position.y).toBeGreaterThan(CHAIR.height + 0.3);
        expect(position.y).toBeLessThan(lampRimY - 0.4);
      }
    }
  });

  it('keeps the chandeliers out of the game view and the ceiling hidden above the game camera', () => {
    for (const aspect of Object.values(SCREEN_ASPECTS)) {
      const camera = cameraFor(computeGamePose(aspect), aspect);
      expect(isCeilingVisibleFrom(camera.position.y)).toBe(false);
      for (const chandelier of CHANDELIER_POSITIONS) {
        const extent = MODEL_FOOTPRINTS.chandelier;
        const corners = [-1, 1].flatMap((sideX) =>
          [-1, 1].flatMap((sideZ) =>
            [0, -extent.height].map(
              (drop) => new Vector3(chandelier.x + (sideX * extent.width) / 2, chandelier.y + drop, chandelier.z + (sideZ * extent.depth) / 2),
            ),
          ),
        );
        const onScreen = corners.some((corner) => {
          const ndc = corner.clone().project(camera);
          return Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && ndc.z < 1;
        });
        expect(onScreen).toBe(false);
      }
    }
  });

  it('mounts every sconce on its wall, between the panelling and the cornice', () => {
    for (const sconce of sconcePlacements()) {
      expect(sconce.mount.clone().sub(sconce.wall.center).dot(sconce.wall.inward)).toBeCloseTo(0, 6);
      expect(sconce.flame.y).toBeGreaterThan(1.5);
      expect(sconce.flame.y).toBeLessThan(CEILING_HEIGHT - 1);
    }
  });
});

describe('room helpers', () => {
  it('starts the fog past the far side of the table wherever the camera stands', () => {
    for (const distance of [3.5, 4.6, 11]) {
      for (const elevation of [0.1, 0.6, 1.15]) {
        const fog = fogRangeForCamera(distance, elevation);
        expect(fog.near).toBeGreaterThan(distance + 1.5);
        expect(fog.far).toBeGreaterThan(fog.near + 8);
      }
    }
  });

  it('leaves the far wall clear of fog from the lobby orbit and fades the floor past the rail from the game view', () => {
    const tableCenter = new Vector3(0, FELT_Y, 0);
    const lobby = cameraFor(computeLobbyPose(SCREEN_ASPECTS.laptop, 0), SCREEN_ASPECTS.laptop).position;
    const fromTable = lobby.clone().sub(tableCenter);
    const lobbyFog = fogRangeForCamera(fromTable.length(), Math.atan2(fromTable.y, Math.hypot(fromTable.x, fromTable.z)));
    const farWallCenter = new Vector3(0, CEILING_HEIGHT / 2, -ROOM_HALF_DEPTH);
    expect(lobbyFog.near).toBeGreaterThan(lobby.distanceTo(farWallCenter));

    const game = cameraFor(computeGamePose(SCREEN_ASPECTS.laptop), SCREEN_ASPECTS.laptop).position;
    const gameFromTable = game.clone().sub(tableCenter);
    const gameFog = fogRangeForCamera(gameFromTable.length(), Math.atan2(gameFromTable.y, Math.hypot(gameFromTable.x, gameFromTable.z)));
    expect(gameFog.near).toBeLessThan(gameFromTable.length() + 2);
  });

  it('shows the whole painting with an identity window and a smaller part with a crop', () => {
    expect(canvasCropWindow({ left: 0, top: 0, width: 1 })).toEqual({ repeat: 1, offsetU: expect.closeTo(0, 9), offsetV: expect.closeTo(0, 9) });
    const crop = canvasCropWindow({ left: 0.5, top: 0.25, width: 0.5 });
    const paintedLeftEdge = 0.0323;
    expect(paintedLeftEdge * crop.repeat + crop.offsetU).toBeCloseTo(0.0323 + 0.5 * 0.9363, 6);
  });

  it('gives each wall its own band of the light map, floor at the bottom and ceiling at the top', () => {
    const bands = Object.values(WALLS).map((wall) => ({
      floor: wallLightmapUv(wall, 0, 0).v,
      ceiling: wallLightmapUv(wall, 0, CEILING_HEIGHT).v,
    }));
    for (const band of bands) {
      expect(band.ceiling).toBeGreaterThan(band.floor);
    }
    const sorted = [...bands].sort((first, second) => first.floor - second.floor);
    for (let index = 1; index < sorted.length; index++) {
      expect(sorted[index].floor).toBeGreaterThan(sorted[index - 1].ceiling);
    }
  });
});

describe('environment highlights', () => {
  it('caps the bare bulbs of the HDR to the limit, keeping their colour, and leaves the rest of the room alone', () => {
    const texels = Float32Array.from([2754, 1200, 300, 1, 0.2, 0.08, 0.03, 1]);
    capHighlights(texels, 3);

    const bulbLuminance = 0.2126 * texels[0] + 0.7152 * texels[1] + 0.0722 * texels[2];
    expect(bulbLuminance).toBeCloseTo(3, 6);
    expect(texels[0] / texels[1]).toBeCloseTo(2754 / 1200, 6);
    expect(texels[3]).toBe(1);
    expect(Array.from(texels.slice(4))).toEqual(Array.from(Float32Array.from([0.2, 0.08, 0.03, 1])));
  });
});

describe('grandfather clock', () => {
  it('points the hands at the time of day', () => {
    expect(clockHandAngles(new Date(2026, 0, 1, 3, 0, 0))).toEqual({ hour: Math.PI / 2, minute: 0 });
    const halfPastSix = clockHandAngles(new Date(2026, 0, 1, 18, 30, 0));
    expect(halfPastSix.minute).toBeCloseTo(Math.PI, 9);
    expect(halfPastSix.hour).toBeCloseTo((6.5 / 12) * Math.PI * 2, 9);
  });

  it('turns a modelled hand from where it points to where it should point', () => {
    const rest = clockwiseAngleOf(-0.066, 0.061);
    const target = clockHandAngles(new Date(2026, 0, 1, 9, 20, 0)).minute;
    const rotation = handRotationZ(rest, target);
    const tip = new Vector3(-0.066, 0.061, 0).applyAxisAngle(new Vector3(0, 0, 1), rotation);
    expect(clockwiseAngleOf(tip.x, tip.y)).toBeCloseTo(target, 9);
  });
});

describe('room assets', () => {
  const MODELS_DIR = new URL('../public/assets/room/models/', import.meta.url);
  /** Only the chairs (next to the table) and the painting keep 1k colour maps; everything else is 512 px or less. */
  const FULL_SIZE_TEXTURES = new Set(['dining_chair_02_diff_1k.jpg', 'dining_chair_02_nor_gl_1k.jpg', 'fancy_picture_frame_01_canvas_diff_1k.jpg']);

  function jpegSize(bytes: Buffer): { width: number; height: number } {
    let offset = 2;
    while (offset < bytes.length) {
      const marker = bytes.readUInt16BE(offset);
      if (marker === 0xffc0 || marker === 0xffc2) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      offset += 2 + bytes.readUInt16BE(offset + 2);
    }
    throw new Error('no JPEG frame header');
  }

  for (const model of readdirSync(MODELS_DIR)) {
    it(`serves ${model} without transmission and with only the textures its materials use, downscaled`, () => {
      const folder = new URL(`${model}/`, MODELS_DIR);
      const gltf = JSON.parse(readFileSync(new URL(`${model}_1k.gltf`, folder), 'utf8')) as {
        extensionsUsed?: string[];
        materials: Record<string, unknown>[];
        textures: { source: number }[];
        images: { uri: string }[];
      };
      expect(gltf.extensionsUsed ?? []).not.toContain('KHR_materials_transmission');

      const usedTextures = new Set(JSON.stringify(gltf.materials).match(/"index":\d+/g)?.map((match) => Number(match.slice(8))));
      for (const textureIndex of usedTextures) {
        const uri = gltf.images[gltf.textures[textureIndex].source].uri;
        const file = new URL(uri, folder);
        expect(existsSync(file)).toBe(true);
        const { width } = jpegSize(readFileSync(file));
        expect(width).toBeLessThanOrEqual(FULL_SIZE_TEXTURES.has(uri.split('/').pop() ?? '') ? 1024 : 512);
      }
    });
  }
});
