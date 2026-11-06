import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Path,
  Shape,
  ShapeGeometry,
  type Material,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { SurfaceTextureName } from './roomAssets';
import { createCeilingGlowTexture, createWallGlowTexture, setCeilingLightmapUvs, setWallLightmapUvs } from './roomGlow';
import {
  CEILING_HEIGHT,
  CHANDELIER_POSITIONS,
  COFFERS_ALONG_X,
  COFFERS_ALONG_Z,
  CROWN_HEIGHT,
  ROOM_HALF_DEPTH,
  ROOM_HALF_WIDTH,
  RUG_HALF_DEPTH,
  RUG_HALF_WIDTH,
  SCONCE_REACH,
  SKIRTING_HEIGHT,
  WAINSCOT_HEIGHT,
  WALLS,
  sconcePlacements,
  yawFacing,
  type WallSpec,
} from './roomLayout';

/** Real-world size of one texture repeat, in meters. */
const WOOD_TILE = 1.3;
const WALLPAPER_TILE = 1.4;
const FLOOR_TILE = 2.4;
/** The procedural carpet repeats every 3 m (Stage lays 20 repeats over 60 m); the rug border continues its lattice. */
const CARPET_TILE = 3;

const DADO_RAIL = { height: 0.055, depth: 0.04 };
const SKIRTING_DEPTH = 0.024;
const CROWN_DEPTH = 0.1;
const PANEL = { width: 1.05, stile: 0.14, moulding: 0.036, mouldingDepth: 0.016, marginBelowRail: 0.08, marginAboveSkirting: 0.1 };
const BEAM = { width: 0.2, drop: 0.2 };
const MEDALLION = { radius: 0.27, thickness: 0.03 };
const RUG_BORDER = { band: 0.34, inlayInset: 0.25, inlayWidth: 0.026, edgeStrip: 0.03, edgeHeight: 0.01 };

/** Layers above the carpet (y = 0); far enough apart for the depth buffer at the portrait game camera's distance. */
const FLOOR_LIFT = { rugBand: 0.0015, inlay: 0.0025, planks: 0.003 };

/**
 * The colour maps are already dark (walnut, burgundy damask, stained boards), so their tints stay close to white:
 * darker tints took the albedo down to about 1 % and the walls and floor read as black.
 */
const SURFACE_TINTS = { wood: '#a08070', wallpaper: '#f2e2dc', floor: '#ffe6d0', rugBorder: '#d08070' };

/** Strength of the baked candle light: sconce and picture-light pools on the walls, chandelier glow on the ceiling. */
const WALL_GLOW_INTENSITY = 8.5;
const CEILING_GLOW_INTENSITY = 4.5;

export interface RoomShellMaterials {
  wood: MeshStandardMaterial;
  /** The same lacquered wood without the wall light map, for the beams and the cornice. */
  ceilingWood: MeshStandardMaterial;
  wallpaper: MeshStandardMaterial;
  ceiling: MeshStandardMaterial;
  floor: MeshStandardMaterial;
  rugBand: MeshStandardMaterial;
  brass: MeshStandardMaterial;
  /** Satin, darker brass for the rug edging and the ceiling roses: polished, they read as lines and discs of light. */
  satinBrass: MeshStandardMaterial;
  candleWax: MeshStandardMaterial;
}

export interface RoomShell {
  /** Walls, floor and sconces: always drawn. */
  walls: Group;
  /** Ceiling, beams, cornice and medallions: hidden while the camera is above the ceiling. */
  ceiling: Group;
  materials: RoomShellMaterials;
}

/** A texture clone shares the decoded image (one GPU upload) but keeps its own repeat. */
function tiledTexture(source: Texture, tileSize: number): Texture {
  const texture = source.clone();
  texture.repeat.set(1 / tileSize, 1 / tileSize);
  texture.needsUpdate = true;
  return texture;
}

function createMaterials(
  surfaces: Record<SurfaceTextureName, Texture>,
  environment: Texture,
  carpet: Texture,
  glow: { walls: Texture; ceiling: Texture },
): RoomShellMaterials {
  const environmentLight = { envMap: environment, envMapIntensity: 1 };
  const carpetBorder = tiledTexture(carpet, CARPET_TILE);
  const ceilingWood = new MeshStandardMaterial({
    map: tiledTexture(surfaces.woodColor, WOOD_TILE),
    normalMap: tiledTexture(surfaces.woodNormal, WOOD_TILE),
    roughnessMap: tiledTexture(surfaces.woodArm, WOOD_TILE),
    color: new Color(SURFACE_TINTS.wood),
    roughness: 0.75,
    metalness: 0,
    ...environmentLight,
    lightMap: glow.ceiling,
    lightMapIntensity: CEILING_GLOW_INTENSITY,
  });
  const wood = ceilingWood.clone();
  wood.lightMap = glow.walls;
  wood.lightMapIntensity = WALL_GLOW_INTENSITY;
  return {
    wood,
    ceilingWood,
    // No normal map: the weave's relief does not show at room distance, and the walls cover half the lobby frame.
    wallpaper: new MeshStandardMaterial({
      map: tiledTexture(surfaces.wallpaperColor, WALLPAPER_TILE),
      roughnessMap: tiledTexture(surfaces.wallpaperArm, WALLPAPER_TILE),
      color: new Color(SURFACE_TINTS.wallpaper),
      roughness: 1,
      metalness: 0,
      ...environmentLight,
      lightMap: glow.walls,
      lightMapIntensity: WALL_GLOW_INTENSITY,
    }),
    ceiling: new MeshStandardMaterial({
      color: '#2a1d17',
      roughness: 0.92,
      metalness: 0,
      ...environmentLight,
      lightMap: glow.ceiling,
      lightMapIntensity: CEILING_GLOW_INTENSITY,
    }),
    // Waxed boards: a soft sheen of the warm room is what lets them read against the rug.
    floor: new MeshStandardMaterial({
      map: tiledTexture(surfaces.floorColor, FLOOR_TILE),
      color: new Color(SURFACE_TINTS.floor),
      roughness: 0.55,
      metalness: 0,
      envMap: environment,
      envMapIntensity: 1.4,
    }),
    rugBand: new MeshStandardMaterial({ map: carpetBorder, color: SURFACE_TINTS.rugBorder, roughness: 0.97, metalness: 0, ...environmentLight }),
    brass: new MeshStandardMaterial({ color: '#c9a35c', roughness: 0.32, metalness: 1, envMap: environment, envMapIntensity: 2.8 }),
    satinBrass: new MeshStandardMaterial({ color: '#8a6a3c', roughness: 0.5, metalness: 0.85, envMap: environment, envMapIntensity: 1 }),
    candleWax: new MeshStandardMaterial({ color: '#efe6d2', roughness: 0.55, metalness: 0, ...environmentLight }),
  };
}

/** Scales UVs to meters so the textures (repeat = 1 / tile size) keep their real-world size on every piece. */
function scaleUvs(geometry: BufferGeometry, uScale: number, vScale: number): BufferGeometry {
  const uv = geometry.getAttribute('uv');
  for (let index = 0; index < uv.count; index++) {
    uv.setXY(index, uv.getX(index) * uScale, uv.getY(index) * vScale);
  }
  return geometry;
}

/** A plane facing +Z with its UVs in meters. */
function meterQuad(width: number, height: number): BufferGeometry {
  return scaleUvs(new PlaneGeometry(width, height), width, height);
}

/** A board along X; `upright` stands it on end so the grain follows its length. */
function meterBoard(length: number, thickness: number, depth: number, upright = false): BufferGeometry {
  const board = scaleUvs(new BoxGeometry(length, thickness, depth), length, thickness);
  return upright ? board.applyMatrix4(new Matrix4().makeRotationZ(Math.PI / 2)) : board;
}

/** Local frame of a wall: x along it, y up, z out of the wall into the room. */
function wallMatrix(wall: WallSpec, offsetAlong: number, height: number, offsetOut: number): Matrix4 {
  const position = wall.center.clone().addScaledVector(wall.along, offsetAlong).addScaledVector(wall.inward, offsetOut);
  return new Matrix4().makeRotationY(yawFacing(wall.inward)).setPosition(position.x, height, position.z);
}

/** A piece placed on a wall, carrying the light-map UVs of the baked candle light. */
function onWall(geometry: BufferGeometry, wall: WallSpec, offsetAlong: number, height: number, offsetOut: number): BufferGeometry {
  return setWallLightmapUvs(geometry.applyMatrix4(wallMatrix(wall, offsetAlong, height, offsetOut)), wall);
}

/**
 * Trims on the end walls stop short of the side walls by the trim depth, so the boxes never overlap in the corners
 * (overlapping coplanar faces would z-fight).
 */
function trimLength(wall: WallSpec, depth: number): number {
  return wall.side === 'north' || wall.side === 'south' ? wall.length - 2 * depth : wall.length;
}

const ALL_WALLS = Object.values(WALLS);

function buildWallpaper(): BufferGeometry {
  const height = CEILING_HEIGHT - WAINSCOT_HEIGHT;
  return mergeAll(
    ALL_WALLS.map((wall) => onWall(meterQuad(wall.length, height), wall, 0, WAINSCOT_HEIGHT + height / 2, 0)),
  );
}

function panelFrames(wall: WallSpec): BufferGeometry[] {
  const bottom = SKIRTING_HEIGHT + PANEL.marginAboveSkirting;
  const top = WAINSCOT_HEIGHT - DADO_RAIL.height / 2 - PANEL.marginBelowRail;
  const panelCount = Math.max(1, Math.round((wall.length - PANEL.stile) / (PANEL.width + PANEL.stile)));
  const panelWidth = (wall.length - PANEL.stile * (panelCount + 1)) / panelCount;
  const height = top - bottom;
  const out = PANEL.mouldingDepth / 2;
  const pieces: BufferGeometry[] = [];

  for (let panel = 0; panel < panelCount; panel++) {
    const center = -wall.length / 2 + PANEL.stile + panelWidth / 2 + panel * (panelWidth + PANEL.stile);
    for (const edge of [-1, 1]) {
      const rail = meterBoard(panelWidth, PANEL.moulding, PANEL.mouldingDepth);
      pieces.push(onWall(rail, wall, center, bottom + height / 2 + edge * (height / 2 - PANEL.moulding / 2), out));
      const stile = meterBoard(height - 2 * PANEL.moulding, PANEL.moulding, PANEL.mouldingDepth, true);
      pieces.push(onWall(stile, wall, center + edge * (panelWidth / 2 - PANEL.moulding / 2), bottom + height / 2, out));
    }
  }
  return pieces;
}

function buildWallWood(): BufferGeometry {
  const pieces: BufferGeometry[] = [];
  const panellingHeight = WAINSCOT_HEIGHT - SKIRTING_HEIGHT;
  for (const wall of ALL_WALLS) {
    pieces.push(onWall(meterQuad(wall.length, panellingHeight), wall, 0, SKIRTING_HEIGHT + panellingHeight / 2, 0));
    pieces.push(
      onWall(meterBoard(trimLength(wall, SKIRTING_DEPTH), SKIRTING_HEIGHT, SKIRTING_DEPTH), wall, 0, SKIRTING_HEIGHT / 2, SKIRTING_DEPTH / 2),
    );
    pieces.push(
      onWall(meterBoard(trimLength(wall, DADO_RAIL.depth), DADO_RAIL.height, DADO_RAIL.depth), wall, 0, WAINSCOT_HEIGHT, DADO_RAIL.depth / 2),
    );
    pieces.push(...panelFrames(wall));
  }
  return mergeAll(pieces);
}

/** Two stepped boards under the ceiling: a deep cornice with a slimmer band below it. */
function buildCornice(): BufferGeometry {
  const pieces: BufferGeometry[] = [];
  for (const wall of ALL_WALLS) {
    pieces.push(
      meterBoard(trimLength(wall, CROWN_DEPTH), CROWN_HEIGHT * 0.62, CROWN_DEPTH).applyMatrix4(
        wallMatrix(wall, 0, CEILING_HEIGHT - CROWN_HEIGHT * 0.31, CROWN_DEPTH / 2),
      ),
    );
    pieces.push(
      meterBoard(trimLength(wall, CROWN_DEPTH * 0.55), CROWN_HEIGHT * 0.38, CROWN_DEPTH * 0.55).applyMatrix4(
        wallMatrix(wall, 0, CEILING_HEIGHT - CROWN_HEIGHT * 0.81, CROWN_DEPTH * 0.275),
      ),
    );
  }
  return mergeAll(pieces);
}

/** Beams between the coffer bays; their tops sit flush with the ceiling. */
function buildBeams(): BufferGeometry {
  const pieces: BufferGeometry[] = [];
  const y = CEILING_HEIGHT - BEAM.drop / 2;
  for (let line = 1; line < COFFERS_ALONG_X; line++) {
    const x = -ROOM_HALF_WIDTH + (line * 2 * ROOM_HALF_WIDTH) / COFFERS_ALONG_X;
    const beam = meterBoard(2 * ROOM_HALF_DEPTH - 2 * CROWN_DEPTH, BEAM.drop, BEAM.width);
    pieces.push(beam.applyMatrix4(new Matrix4().makeRotationY(Math.PI / 2).setPosition(x, y, 0)));
  }
  for (let line = 1; line < COFFERS_ALONG_Z; line++) {
    const z = -ROOM_HALF_DEPTH + (line * 2 * ROOM_HALF_DEPTH) / COFFERS_ALONG_Z;
    // Cut between the cross beams so no two boxes share a face.
    for (let bay = 0; bay < COFFERS_ALONG_X; bay++) {
      const left = -ROOM_HALF_WIDTH + (bay * 2 * ROOM_HALF_WIDTH) / COFFERS_ALONG_X + (bay === 0 ? CROWN_DEPTH : BEAM.width / 2);
      const right =
        -ROOM_HALF_WIDTH + ((bay + 1) * 2 * ROOM_HALF_WIDTH) / COFFERS_ALONG_X - (bay === COFFERS_ALONG_X - 1 ? CROWN_DEPTH : BEAM.width / 2);
      const beam = meterBoard(right - left, BEAM.drop * 0.999, BEAM.width);
      pieces.push(beam.applyMatrix4(new Matrix4().setPosition((left + right) / 2, y, z)));
    }
  }
  return mergeAll(pieces);
}

function buildCeilingPlane(): BufferGeometry {
  const plane = new PlaneGeometry(2 * ROOM_HALF_WIDTH, 2 * ROOM_HALF_DEPTH);
  return setCeilingLightmapUvs(plane.applyMatrix4(new Matrix4().makeRotationX(Math.PI / 2).setPosition(0, CEILING_HEIGHT, 0)));
}

function rectangle(halfWidth: number, halfDepth: number): Shape {
  const shape = new Shape();
  shape.moveTo(-halfWidth, -halfDepth);
  shape.lineTo(halfWidth, -halfDepth);
  shape.lineTo(halfWidth, halfDepth);
  shape.lineTo(-halfWidth, halfDepth);
  shape.closePath();
  return shape;
}

function rectangleHole(halfWidth: number, halfDepth: number): Path {
  const hole = new Path();
  hole.moveTo(-halfWidth, -halfDepth);
  hole.lineTo(-halfWidth, halfDepth);
  hole.lineTo(halfWidth, halfDepth);
  hole.lineTo(halfWidth, -halfDepth);
  hole.closePath();
  return hole;
}

/** A flat rectangular ring on the floor; ShapeGeometry UVs are the shape's own meters (x, -z). */
function floorFrame(outerHalfWidth: number, outerHalfDepth: number, innerHalfWidth: number, innerHalfDepth: number, lift: number): BufferGeometry {
  const shape = rectangle(outerHalfWidth, outerHalfDepth);
  shape.holes.push(rectangleHole(innerHalfWidth, innerHalfDepth));
  return new ShapeGeometry(shape).applyMatrix4(new Matrix4().makeRotationX(-Math.PI / 2).setPosition(0, lift, 0));
}

function buildRugEdgeStrips(): BufferGeometry {
  const { edgeStrip, edgeHeight } = RUG_BORDER;
  const strips = [
    new BoxGeometry(2 * RUG_HALF_WIDTH + 2 * edgeStrip, edgeHeight, edgeStrip).translate(0, edgeHeight / 2, RUG_HALF_DEPTH + edgeStrip / 2),
    new BoxGeometry(2 * RUG_HALF_WIDTH + 2 * edgeStrip, edgeHeight, edgeStrip).translate(0, edgeHeight / 2, -RUG_HALF_DEPTH - edgeStrip / 2),
    new BoxGeometry(edgeStrip, edgeHeight, 2 * RUG_HALF_DEPTH).translate(RUG_HALF_WIDTH + edgeStrip / 2, edgeHeight / 2, 0),
    new BoxGeometry(edgeStrip, edgeHeight, 2 * RUG_HALF_DEPTH).translate(-RUG_HALF_WIDTH - edgeStrip / 2, edgeHeight / 2, 0),
  ];
  return mergeAll(strips);
}

function buildRugInlay(): BufferGeometry {
  const { inlayInset, inlayWidth } = RUG_BORDER;
  return floorFrame(
    RUG_HALF_WIDTH - inlayInset,
    RUG_HALF_DEPTH - inlayInset,
    RUG_HALF_WIDTH - inlayInset - inlayWidth,
    RUG_HALF_DEPTH - inlayInset - inlayWidth,
    FLOOR_LIFT.inlay,
  );
}

/** Ceiling roses above the chandeliers: flat discs whose top caps would only ever be seen from above the ceiling. */
function buildMedallions(): BufferGeometry {
  return mergeAll(
    CHANDELIER_POSITIONS.map((position) =>
      new CylinderGeometry(MEDALLION.radius, MEDALLION.radius * 0.86, MEDALLION.thickness, 40, 1, false).translate(
        position.x,
        CEILING_HEIGHT - MEDALLION.thickness / 2,
        position.z,
      ),
    ),
  );
}

/** Brass back plate, arm and cup of every sconce, in each wall's frame (z out of the wall). */
function buildSconceBrass(): BufferGeometry {
  const pieces: BufferGeometry[] = [];
  for (const sconce of sconcePlacements()) {
    const toWall = (geometry: BufferGeometry, y: number, out: number): BufferGeometry =>
      geometry.applyMatrix4(
        new Matrix4()
          .makeRotationY(yawFacing(sconce.wall.inward))
          .setPosition(sconce.mount.x + sconce.wall.inward.x * out, y, sconce.mount.z + sconce.wall.inward.z * out),
      );
    const plate = new CylinderGeometry(0.055, 0.07, 0.022, 24).applyMatrix4(new Matrix4().makeRotationX(Math.PI / 2));
    pieces.push(toWall(plate, sconce.mount.y + 0.04, 0.011));
    const arm = new CylinderGeometry(0.011, 0.011, SCONCE_REACH, 10).applyMatrix4(new Matrix4().makeRotationX(Math.PI / 2));
    pieces.push(toWall(arm, sconce.mount.y, SCONCE_REACH / 2));
    pieces.push(toWall(new CylinderGeometry(0.045, 0.022, 0.035, 20), sconce.flame.y - 0.21, SCONCE_REACH));
  }
  return mergeAll(pieces);
}

function buildSconceCandles(): BufferGeometry {
  return mergeAll(
    sconcePlacements().map((sconce) => new CylinderGeometry(0.018, 0.019, 0.17, 14).translate(sconce.flame.x, sconce.flame.y - 0.105, sconce.flame.z)),
  );
}

function mergeAll(pieces: BufferGeometry[]): BufferGeometry {
  // Box, plane, cylinder and shape geometries all come indexed with position, normal and uv.
  const merged = mergeGeometries(pieces, false);
  pieces.forEach((piece) => piece.dispose());
  if (!merged) {
    throw new Error('Sala: as peças da sala não puderam ser combinadas.');
  }
  return merged;
}

function staticMesh(geometry: BufferGeometry, material: Material, name: string): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.name = name;
  return mesh;
}

/**
 * The architecture of the card room: panelled walls with a damask paper, a coffered ceiling, a plank floor around
 * the carpet (which Stage lays wall to wall at y = 0) and brass candle sconces. One merged mesh per material.
 */
export function buildRoomShell(surfaces: Record<SurfaceTextureName, Texture>, environment: Texture, carpet: Texture): RoomShell {
  const materials = createMaterials(surfaces, environment, carpet, { walls: createWallGlowTexture(), ceiling: createCeilingGlowTexture() });

  const walls = new Group();
  walls.name = 'roomWalls';
  walls.add(
    staticMesh(buildWallpaper(), materials.wallpaper, 'wallpaper'),
    staticMesh(buildWallWood(), materials.wood, 'wainscot'),
    staticMesh(
      floorFrame(ROOM_HALF_WIDTH, ROOM_HALF_DEPTH, RUG_HALF_WIDTH + RUG_BORDER.edgeStrip, RUG_HALF_DEPTH + RUG_BORDER.edgeStrip, FLOOR_LIFT.planks),
      materials.floor,
      'plankFloor',
    ),
    staticMesh(
      floorFrame(RUG_HALF_WIDTH, RUG_HALF_DEPTH, RUG_HALF_WIDTH - RUG_BORDER.band, RUG_HALF_DEPTH - RUG_BORDER.band, FLOOR_LIFT.rugBand),
      materials.rugBand,
      'rugBorder',
    ),
    staticMesh(mergeAll([buildRugEdgeStrips(), buildRugInlay()]), materials.satinBrass, 'rugEdging'),
    staticMesh(buildSconceBrass(), materials.brass, 'sconces'),
    staticMesh(buildSconceCandles(), materials.candleWax, 'sconceCandles'),
  );

  const ceiling = new Group();
  ceiling.name = 'roomCeiling';
  ceiling.add(
    staticMesh(buildCeilingPlane(), materials.ceiling, 'ceiling'),
    staticMesh(setCeilingLightmapUvs(mergeAll([buildBeams(), buildCornice()])), materials.ceilingWood, 'ceilingWood'),
    staticMesh(buildMedallions(), materials.satinBrass, 'ceilingRoses'),
  );

  return { walls, ceiling, materials };
}
