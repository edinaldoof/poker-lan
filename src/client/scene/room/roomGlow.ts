import { BufferAttribute, CanvasTexture, SRGBColorSpace, type BufferGeometry } from 'three';
import { createCanvas } from '../proceduralTextures';
import {
  CEILING_HEIGHT,
  CHANDELIER_POSITIONS,
  MODEL_FOOTPRINTS,
  PROP_SPECS,
  ROOM_HALF_DEPTH,
  ROOM_HALF_WIDTH,
  SCONCE_HEIGHT,
  SCONCE_SPOTS,
  WALLS,
  type WallSide,
  type WallSpec,
} from './roomLayout';

/**
 * Baked candle light: light maps (UV channel 1) holding the warm scallop each sconce throws on the paper and
 * panelling, the pool of a picture light over each painting, and the glow of the chandeliers on the ceiling. Real
 * lights would cost every material in the scene a shader loop; this costs the walls and ceiling one texture read.
 */

const WALL_ORDER: readonly WallSide[] = ['north', 'east', 'south', 'west'];
const ATLAS_WIDTH = 1024;
const ROW_HEIGHT = 128;
/** Keeps bilinear filtering from bleeding one wall's row into the next. */
const ROW_PADDING_PX = 3;

const SCONCE_POOL = { halfWidth: 1.05, halfHeight: 1.35, color: [255, 172, 104] as const, strength: 0.75 };
const SCONCE_HOTSPOT = { halfWidth: 0.32, halfHeight: 0.45, rise: 0.12, strength: 0.6 };
const PICTURE_POOL = { widthFactor: 0.62, heightFactor: 0.95, color: [255, 196, 140] as const, strength: 0.5 };

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function rowOf(side: WallSide): number {
  return WALL_ORDER.indexOf(side);
}

/** Atlas coordinates (0..1, v up as three samples a flipped canvas) of a point on a wall. */
export function wallLightmapUv(wall: WallSpec, offsetAlong: number, height: number): { u: number; v: number } {
  const rowCount = WALL_ORDER.length;
  const padding = ROW_PADDING_PX / (ROW_HEIGHT * rowCount);
  const rowBottom = 1 - (rowOf(wall.side) + 1) / rowCount;
  return {
    u: clamp01(offsetAlong / wall.length + 0.5),
    v: rowBottom + padding + clamp01(height / CEILING_HEIGHT) * (1 / rowCount - 2 * padding),
  };
}

/** Adds light-map UVs to a piece already placed on `wall` (world coordinates). */
export function setWallLightmapUvs(geometry: BufferGeometry, wall: WallSpec): BufferGeometry {
  const position = geometry.getAttribute('position');
  const uvs = new Float32Array(position.count * 2);
  for (let index = 0; index < position.count; index++) {
    const offsetAlong =
      (position.getX(index) - wall.center.x) * wall.along.x + (position.getZ(index) - wall.center.z) * wall.along.z;
    const { u, v } = wallLightmapUv(wall, offsetAlong, position.getY(index));
    uvs[index * 2] = u;
    uvs[index * 2 + 1] = v;
  }
  geometry.setAttribute('uv1', new BufferAttribute(uvs, 2));
  return geometry;
}

function paintPool(
  context: CanvasRenderingContext2D,
  wall: WallSpec,
  pool: { offsetAlong: number; height: number; halfWidth: number; halfHeight: number },
  color: readonly [number, number, number],
  strength: number,
): void {
  const center = wallLightmapUv(wall, pool.offsetAlong, pool.height);
  const centerX = center.u * ATLAS_WIDTH;
  const centerY = (1 - center.v) * ROW_HEIGHT * WALL_ORDER.length;
  const radiusX = (pool.halfWidth / wall.length) * ATLAS_WIDTH;
  const radiusY = (pool.halfHeight / CEILING_HEIGHT) * ROW_HEIGHT;
  const [red, green, blue] = color;

  context.save();
  const rowTop = rowOf(wall.side) * ROW_HEIGHT;
  context.beginPath();
  context.rect(0, rowTop, ATLAS_WIDTH, ROW_HEIGHT);
  context.clip();
  context.translate(centerX, centerY);
  context.scale(1, radiusY / radiusX);
  const gradient = context.createRadialGradient(0, 0, 0, 0, 0, radiusX);
  gradient.addColorStop(0, `rgba(${red}, ${green}, ${blue}, ${strength})`);
  gradient.addColorStop(0.4, `rgba(${red}, ${green}, ${blue}, ${strength * 0.45})`);
  gradient.addColorStop(1, `rgba(${red}, ${green}, ${blue}, 0)`);
  context.fillStyle = gradient;
  context.fillRect(-radiusX, -radiusX, radiusX * 2, radiusX * 2);
  context.restore();
}

export function createWallGlowTexture(): CanvasTexture {
  const { canvas, context } = createCanvas(ATLAS_WIDTH, ROW_HEIGHT * WALL_ORDER.length);
  context.fillStyle = '#000000';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = 'lighter';

  for (const spot of SCONCE_SPOTS) {
    const wall = WALLS[spot.wall];
    paintPool(context, wall, { offsetAlong: spot.offsetAlong, height: SCONCE_HEIGHT, ...SCONCE_POOL }, SCONCE_POOL.color, SCONCE_POOL.strength);
    paintPool(
      context,
      wall,
      { offsetAlong: spot.offsetAlong, height: SCONCE_HEIGHT + SCONCE_HOTSPOT.rise, ...SCONCE_HOTSPOT },
      SCONCE_POOL.color,
      SCONCE_HOTSPOT.strength,
    );
  }

  for (const spec of PROP_SPECS) {
    if (spec.model !== 'pictureFrame') {
      continue;
    }
    const frame = MODEL_FOOTPRINTS.pictureFrame;
    paintPool(
      context,
      WALLS[spec.wall],
      {
        offsetAlong: spec.offsetAlong,
        height: spec.height + frame.height * spec.scale * 0.25,
        halfWidth: frame.width * spec.scale * PICTURE_POOL.widthFactor,
        halfHeight: frame.height * spec.scale * PICTURE_POOL.heightFactor,
      },
      PICTURE_POOL.color,
      PICTURE_POOL.strength,
    );
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.channel = 1;
  return texture;
}

const CEILING_ATLAS_SIZE = 256;
const CHANDELIER_CEILING_GLOW = { radius: 2.4, color: [255, 178, 112] as const, strength: 0.9 };

/** Light-map UVs (channel 1) for the ceiling and its beams: the room's floor plan, x and z mapped to 0..1. */
export function setCeilingLightmapUvs(geometry: BufferGeometry): BufferGeometry {
  const position = geometry.getAttribute('position');
  const uvs = new Float32Array(position.count * 2);
  for (let index = 0; index < position.count; index++) {
    uvs[index * 2] = clamp01((position.getX(index) + ROOM_HALF_WIDTH) / (2 * ROOM_HALF_WIDTH));
    uvs[index * 2 + 1] = clamp01((position.getZ(index) + ROOM_HALF_DEPTH) / (2 * ROOM_HALF_DEPTH));
  }
  geometry.setAttribute('uv1', new BufferAttribute(uvs, 2));
  return geometry;
}

export function createCeilingGlowTexture(): CanvasTexture {
  const { canvas, context } = createCanvas(CEILING_ATLAS_SIZE, CEILING_ATLAS_SIZE);
  context.fillStyle = '#000000';
  context.fillRect(0, 0, CEILING_ATLAS_SIZE, CEILING_ATLAS_SIZE);
  const [red, green, blue] = CHANDELIER_CEILING_GLOW.color;
  for (const chandelier of CHANDELIER_POSITIONS) {
    const centerX = ((chandelier.x + ROOM_HALF_WIDTH) / (2 * ROOM_HALF_WIDTH)) * CEILING_ATLAS_SIZE;
    // The canvas is sampled flipped: its top row is v = 1, the +Z end of the room.
    const centerY = (1 - (chandelier.z + ROOM_HALF_DEPTH) / (2 * ROOM_HALF_DEPTH)) * CEILING_ATLAS_SIZE;
    const radiusX = (CHANDELIER_CEILING_GLOW.radius / (2 * ROOM_HALF_WIDTH)) * CEILING_ATLAS_SIZE;
    const radiusY = (CHANDELIER_CEILING_GLOW.radius / (2 * ROOM_HALF_DEPTH)) * CEILING_ATLAS_SIZE;
    context.save();
    context.translate(centerX, centerY);
    context.scale(1, radiusY / radiusX);
    const gradient = context.createRadialGradient(0, 0, 0, 0, 0, radiusX);
    gradient.addColorStop(0, `rgba(${red}, ${green}, ${blue}, ${CHANDELIER_CEILING_GLOW.strength})`);
    gradient.addColorStop(0.3, `rgba(${red}, ${green}, ${blue}, ${CHANDELIER_CEILING_GLOW.strength * 0.4})`);
    gradient.addColorStop(1, `rgba(${red}, ${green}, ${blue}, 0)`);
    context.fillStyle = gradient;
    context.fillRect(-radiusX, -radiusX, radiusX * 2, radiusX * 2);
    context.restore();
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.channel = 1;
  return texture;
}
