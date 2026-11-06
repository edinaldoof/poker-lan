import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

export const CHIP_DENOMINATIONS = [5000, 1000, 500, 100, 25, 5, 1];
export const CHIP_DIAMETER = 0.058;
export const CHIP_HEIGHT = 0.0046;

const CHIP_MODEL_URL = '/assets/chips/chip.obj';
const CHIP_NORMAL_MAP_URL = '/assets/chips/chip_normal.png';
const chipArtUrl = (denomination: number): string => `/assets/chips/chip_${denomination}.webp`;

const HIGH_DETAIL_OBJECT = 'Mid_Poly_Chip';
const LOW_DETAIL_OBJECT = 'Low_Poly_Chip';
// chip.obj is a unit chip: diameter 2, thickness 0.1, base on y = 0.
const MODEL_DIAMETER = 2;
const MODEL_THICKNESS = 0.1;

const DEFAULT_MAX_VISIBLE_CHIPS = 36;
const MAX_CHIPS_PER_COLUMN = 12;
const COLUMN_SPACING = CHIP_DIAMETER * 1.03;
const POSITION_JITTER = 0.0007;
const YAW_JITTER = 0.12;

/**
 * chip.obj maps its top face with a mirrored planar projection that is rotated by this angle (measured from the
 * vertices: u,v = 0.5 + 0.5 * [[c, s], [s, -c]] * (x, z) with c = cos, s = sin of the angle). Rotating the textures
 * by it makes the art appear upright: texture-right = world +X, texture-up = world -Z.
 */
const CHIP_UV_ROTATION = -1.8530084;

// Measured on the 512 px art: the disc fills the square, its rim stripes touch r = 256 and the centre diamond has
// a half-diagonal of 120. Everything outside the disc is black, so the rim is smeared outward before it is
// sampled, otherwise the edge wall (which samples exactly r = 256) fades to black.
const ART_RIM_START_RATIO = 252 / 512;
const ART_RIM_SAMPLE_RATIO = 250 / 512;
const DIAMOND_HALF_DIAGONAL_RATIO = 120 / 512;

const LABEL_FONT_FAMILY = 'Impact, "Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif';
const LABEL_REFERENCE_FONT_PX = 100;
const LABEL_MAX_FONT_RATIO = 0.24;
const LABEL_DIAMOND_FILL = 0.9;
const LABEL_OUTLINE_RATIO = 0.1;
const LABEL_EMBOLDEN_RATIO = 0.04;

export interface ChipCount {
  denomination: number;
  count: number;
}

function greedyCounts(amount: number): number[] {
  let remaining = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0;
  return CHIP_DENOMINATIONS.map((denomination) => {
    const count = Math.floor(remaining / denomination);
    remaining -= count * denomination;
    return count;
  });
}

function sumOf(counts: number[]): number {
  return counts.reduce((total, count) => total + count, 0);
}

/**
 * Brings a breakdown under the visual cap. Smaller denominations are merged upward first (rounded to the nearest
 * larger chip, so the stack stays approximately right); whatever is still too tall is the largest denomination,
 * whose column is truncated. A merge never rounds down to zero chips, so a positive amount always keeps a chip.
 */
function limitChipCount(counts: number[], maxChips: number): void {
  for (let index = counts.length - 1; index > 0 && sumOf(counts) > maxChips; index--) {
    if (counts[index] === 0) continue;
    const value = counts[index] * CHIP_DENOMINATIONS[index];
    counts[index - 1] += Math.max(1, Math.round(value / CHIP_DENOMINATIONS[index - 1]));
    counts[index] = 0;
  }
  counts[0] = Math.min(counts[0], maxChips);
}

/** Greedy breakdown, largest denomination first, empty denominations omitted. */
export function breakdownChips(amount: number, maxChips: number = DEFAULT_MAX_VISIBLE_CHIPS): ChipCount[] {
  const counts = greedyCounts(amount);
  limitChipCount(counts, Math.max(1, Math.floor(maxChips)));
  return CHIP_DENOMINATIONS.map((denomination, index) => ({ denomination, count: counts[index] })).filter(
    (entry) => entry.count > 0,
  );
}

/** A denomination taller than one column is split into evenly filled columns. */
function splitIntoColumns(entries: ChipCount[]): ChipCount[] {
  return entries.flatMap(({ denomination, count }) => {
    const columnCount = Math.ceil(count / MAX_CHIPS_PER_COLUMN);
    const baseHeight = Math.floor(count / columnCount);
    const tallerColumns = count % columnCount;
    return Array.from({ length: columnCount }, (_, column) => ({
      denomination,
      count: baseHeight + (column < tallerColumns ? 1 : 0),
    }));
  });
}

interface PlanarOffset {
  x: number;
  z: number;
}

/** Hexagonal lattice points ordered from the centre outward, ring by ring. */
function hexLatticePoints(count: number): PlanarOffset[] {
  let ringCount = 0;
  while (1 + 3 * ringCount * (ringCount + 1) < count) ringCount++;

  const points: (PlanarOffset & { distance: number; angle: number })[] = [];
  for (let q = -ringCount; q <= ringCount; q++) {
    for (let r = -ringCount; r <= ringCount; r++) {
      if (Math.abs(q + r) > ringCount) continue;
      const x = COLUMN_SPACING * (q + r / 2);
      const z = COLUMN_SPACING * r * (Math.sqrt(3) / 2);
      points.push({ x, z, distance: Math.round(Math.hypot(x, z) * 1e6), angle: Math.atan2(z, x) });
    }
  }
  points.sort((a, b) => a.distance - b.distance || a.angle - b.angle);
  return points.slice(0, count);
}

/** Column centres packed as tightly as the chips allow and centred on the stack origin. */
function clusterOffsets(columnCount: number): PlanarOffset[] {
  const points = hexLatticePoints(columnCount);
  const centerX = points.reduce((sum, point) => sum + point.x, 0) / columnCount;
  const centerZ = points.reduce((sum, point) => sum + point.z, 0) / columnCount;
  return points.map((point) => ({ x: point.x - centerX, z: point.z - centerZ }));
}

/** Deterministic 0..1 noise so a rebuilt stack looks the same instead of shuffling its chips. */
function seededUnit(seed: number): number {
  let state = (seed + 0x6d2b79f5) | 0;
  state = Math.imul(state ^ (state >>> 15), state | 1);
  state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
  return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
}

function jitter(columnIndex: number, chipIndex: number, channel: number, amplitude: number): number {
  const seed = columnIndex * 7919 + chipIndex * 131 + channel * 17;
  return (seededUnit(seed) * 2 - 1) * amplitude;
}

/** What a stack needs from its factory. */
export interface ChipSource {
  createChip(denomination: number): THREE.Mesh;
}

/** What the players' stacks need from the factory: one instanced mesh per denomination. */
export interface InstancedChipSource {
  createInstancedChips(denomination: number, capacity: number): THREE.InstancedMesh;
}

/** One chip placed in a stack's own frame, its base at `y`. */
export interface ChipPlacement {
  denomination: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * Columns of chips in a tight cluster, one denomination per column; showChips lays out any given chips instead.
 * Origin = cluster centre, on the base.
 */
export class ChipStack extends THREE.Group {
  amount = 0;
  private readonly source: ChipSource;
  private tallestColumnHeight = 0;

  constructor(source: ChipSource, amount: number) {
    super();
    this.source = source;
    this.setAmount(amount);
  }

  /** Height of the tallest column, in local units. */
  get topY(): number {
    return this.tallestColumnHeight;
  }

  setAmount(amount: number): void {
    this.amount = amount;
    this.clear();

    const columns = splitIntoColumns(breakdownChips(amount));
    const offsets = clusterOffsets(Math.max(1, columns.length));
    columns.forEach((column, columnIndex) => this.addColumn(column, offsets[columnIndex], columnIndex));
    this.tallestColumnHeight = columns.reduce((tallest, column) => Math.max(tallest, column.count), 0) * CHIP_HEIGHT;
  }

  /** Shows exactly these chips (a player's own stack pushed forward) as a stack worth `amount`. */
  showChips(amount: number, chips: readonly ChipPlacement[]): void {
    this.amount = amount;
    this.clear();
    for (const placement of chips) {
      const chip = this.source.createChip(placement.denomination);
      chip.position.set(placement.x, placement.y, placement.z);
      chip.rotation.y = placement.yaw;
      this.add(chip);
    }
    this.tallestColumnHeight = chips.reduce((top, chip) => Math.max(top, chip.y + CHIP_HEIGHT), 0);
  }

  /** Meshes share the factory's geometry and materials, so releasing a stack only detaches it. */
  dispose(): void {
    this.removeFromParent();
    this.clear();
  }

  private addColumn(column: ChipCount, offset: PlanarOffset, columnIndex: number): void {
    for (let chipIndex = 0; chipIndex < column.count; chipIndex++) {
      const chip = this.source.createChip(column.denomination);
      chip.position.set(
        offset.x + jitter(columnIndex, chipIndex, 1, POSITION_JITTER),
        chipIndex * CHIP_HEIGHT,
        offset.z + jitter(columnIndex, chipIndex, 2, POSITION_JITTER),
      );
      chip.rotation.y = jitter(columnIndex, chipIndex, 3, YAW_JITTER);
      this.add(chip);
    }
  }
}

function chipLabel(denomination: number): string {
  if (denomination >= 1000) return `${denomination / 1000}K`;
  return String(denomination);
}

function createCanvas(size: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Canvas 2D context is not available');
  return { canvas, context };
}

function extendRimBeyondDisc(context: CanvasRenderingContext2D, size: number): void {
  const imageData = context.getImageData(0, 0, size, size);
  const pixels = imageData.data;
  const center = size / 2;
  const rimStart = size * ART_RIM_START_RATIO;
  const sampleRadius = size * ART_RIM_SAMPLE_RATIO;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - center;
      const dy = y + 0.5 - center;
      const distance = Math.hypot(dx, dy);
      if (distance <= rimStart) continue;

      const scale = sampleRadius / distance;
      const sourceX = Math.min(size - 1, Math.floor(center + dx * scale));
      const sourceY = Math.min(size - 1, Math.floor(center + dy * scale));
      const source = (sourceY * size + sourceX) * 4;
      const target = (y * size + x) * 4;
      pixels[target] = pixels[source];
      pixels[target + 1] = pixels[source + 1];
      pixels[target + 2] = pixels[source + 2];
      pixels[target + 3] = pixels[source + 3];
    }
  }
  context.putImageData(imageData, 0, 0);
}

function drawDenominationLabel(context: CanvasRenderingContext2D, size: number, label: string): void {
  const center = size / 2;
  // Measurement and drawing must share this alignment: anchorX below is the left edge of the advance box, so a
  // centred draw would shift the ink left by half the text width.
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  context.font = `${LABEL_REFERENCE_FONT_PX}px ${LABEL_FONT_FAMILY}`;
  const metrics = context.measureText(label);
  const inkWidth = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight;
  const inkHeight = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;

  // The ink box grows by the outline on every side and must still sit inside the diamond |x| + |y| <= halfDiagonal.
  const halfDiagonal = size * DIAMOND_HALF_DIAGONAL_RATIO * LABEL_DIAMOND_FILL;
  const inkPerPixel = (inkWidth + inkHeight) / LABEL_REFERENCE_FONT_PX;
  const fittedFontPx = (2 * halfDiagonal) / (inkPerPixel + 4 * LABEL_OUTLINE_RATIO);
  const fontPx = Math.min(size * LABEL_MAX_FONT_RATIO, fittedFontPx);
  const scale = fontPx / LABEL_REFERENCE_FONT_PX;

  const anchorX = center - ((metrics.actualBoundingBoxRight - metrics.actualBoundingBoxLeft) / 2) * scale;
  const baselineY = center + ((metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2) * scale;

  context.save();
  context.font = `${fontPx}px ${LABEL_FONT_FAMILY}`;
  context.lineJoin = 'round';
  context.miterLimit = 2;
  context.lineWidth = fontPx * LABEL_OUTLINE_RATIO * 2;
  context.strokeStyle = 'rgba(8, 10, 14, 0.92)';
  context.shadowColor = 'rgba(0, 0, 0, 0.45)';
  context.shadowBlur = fontPx * 0.06;
  context.shadowOffsetY = fontPx * 0.03;
  context.strokeText(label, anchorX, baselineY);
  context.shadowColor = 'transparent';
  // A thin white stroke thickens fallback fonts that have no heavy weight.
  context.strokeStyle = '#ffffff';
  context.lineWidth = fontPx * LABEL_EMBOLDEN_RATIO;
  context.strokeText(label, anchorX, baselineY);
  context.fillStyle = '#ffffff';
  context.fillText(label, anchorX, baselineY);
  context.restore();
}

function orientTexture(texture: THREE.Texture, anisotropy: number): void {
  texture.center.set(0.5, 0.5);
  texture.rotation = CHIP_UV_ROTATION;
  texture.anisotropy = anisotropy;
}

function createChipArtTexture(image: HTMLImageElement, denomination: number, anisotropy: number): THREE.CanvasTexture {
  const size = image.width;
  const { canvas, context } = createCanvas(size);
  context.drawImage(image, 0, 0, size, size);
  extendRimBeyondDisc(context, size);
  drawDenominationLabel(context, size, chipLabel(denomination));

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  orientTexture(texture, anisotropy);
  return texture;
}

function extractChipGeometry(model: THREE.Object3D, objectName: string): THREE.BufferGeometry {
  const mesh = model.getObjectByName(objectName);
  if (!(mesh instanceof THREE.Mesh)) throw new Error(`chip.obj has no "${objectName}" object`);
  const geometry = (mesh.geometry as THREE.BufferGeometry).clone();
  geometry.scale(CHIP_DIAMETER / MODEL_DIAMETER, CHIP_HEIGHT / MODEL_THICKNESS, CHIP_DIAMETER / MODEL_DIAMETER);
  return geometry;
}

export class ChipFactory implements ChipSource, InstancedChipSource {
  private readonly highDetailGeometry: THREE.BufferGeometry;
  private readonly lowDetailGeometry: THREE.BufferGeometry;
  /** The one geometry every chip renders; setDetail swaps its attributes instead of touching each mesh. */
  private readonly chipGeometry = new THREE.BufferGeometry();
  private readonly materials: Map<number, THREE.MeshPhysicalMaterial>;
  private readonly normalMap: THREE.Texture;
  /** The players' stacks; low detail stops them casting shadows (see setDetail). */
  private readonly instancedChips = new Set<THREE.InstancedMesh>();
  private detail: 'high' | 'low' = 'high';

  static async create(manager: THREE.LoadingManager, renderer: THREE.WebGLRenderer): Promise<ChipFactory> {
    const imageLoader = new THREE.ImageLoader(manager);
    const [model, normalMap, artImages] = await Promise.all([
      new OBJLoader(manager).loadAsync(CHIP_MODEL_URL),
      new THREE.TextureLoader(manager).loadAsync(CHIP_NORMAL_MAP_URL),
      Promise.all(CHIP_DENOMINATIONS.map((denomination) => imageLoader.loadAsync(chipArtUrl(denomination)))),
    ]);

    const anisotropy = renderer.capabilities.getMaxAnisotropy();
    orientTexture(normalMap, anisotropy);

    const materials = new Map<number, THREE.MeshPhysicalMaterial>();
    CHIP_DENOMINATIONS.forEach((denomination, index) => {
      materials.set(
        denomination,
        new THREE.MeshPhysicalMaterial({
          map: createChipArtTexture(artImages[index], denomination, anisotropy),
          normalMap,
          roughness: 0.42,
          metalness: 0,
          clearcoat: 0.6,
          clearcoatRoughness: 0.3,
        }),
      );
    });

    return new ChipFactory(
      extractChipGeometry(model, HIGH_DETAIL_OBJECT),
      extractChipGeometry(model, LOW_DETAIL_OBJECT),
      materials,
      normalMap,
    );
  }

  private constructor(
    highDetailGeometry: THREE.BufferGeometry,
    lowDetailGeometry: THREE.BufferGeometry,
    materials: Map<number, THREE.MeshPhysicalMaterial>,
    normalMap: THREE.Texture,
  ) {
    this.highDetailGeometry = highDetailGeometry;
    this.lowDetailGeometry = lowDetailGeometry;
    this.materials = materials;
    this.normalMap = normalMap;
    this.setDetail('high');
  }

  createStack(amount: number): ChipStack {
    return new ChipStack(this, amount);
  }

  /** A single chip with its base on y = 0. Unknown values use the largest denomination not above them. */
  createChip(denomination: number): THREE.Mesh {
    const chip = new THREE.Mesh(this.chipGeometry, this.materialFor(denomination));
    chip.castShadow = true;
    chip.receiveShadow = true;
    return chip;
  }

  /**
   * Room for `capacity` chips of one denomination drawn in a single call, with the material of createChip. Always the
   * low-poly chip (508 triangles instead of 2 556): the players' stacks hold a few hundred small chips, mostly hidden
   * under one another, and the high one would multiply the triangles of the whole scene by five. Starts empty:
   * callers set the instance matrices and `count`.
   */
  createInstancedChips(denomination: number, capacity: number): THREE.InstancedMesh {
    const chips = new THREE.InstancedMesh(this.lowDetailGeometry, this.materialFor(denomination), capacity);
    chips.count = 0;
    chips.castShadow = this.detail === 'high';
    chips.receiveShadow = true;
    this.instancedChips.add(chips);
    chips.addEventListener('dispose', () => this.instancedChips.delete(chips));
    return chips;
  }

  /**
   * Low detail swaps every bet and pot chip to the low-poly model and stops the players' stacks casting shadows:
   * their chips would otherwise be drawn a second time into the shadow map, hundreds of chips for a contact shadow
   * that the felt's own shading already suggests.
   */
  setDetail(level: 'high' | 'low'): void {
    this.detail = level;
    for (const chips of this.instancedChips) chips.castShadow = level === 'high';
    const source = level === 'high' ? this.highDetailGeometry : this.lowDetailGeometry;
    // Dispose first so the renderer drops the buffers and vertex-array state of the previous level.
    this.chipGeometry.dispose();
    this.chipGeometry.setAttribute('position', source.getAttribute('position'));
    this.chipGeometry.setAttribute('normal', source.getAttribute('normal'));
    this.chipGeometry.setAttribute('uv', source.getAttribute('uv'));
    this.chipGeometry.setIndex(source.getIndex());
    this.chipGeometry.computeBoundingSphere();
    this.chipGeometry.computeBoundingBox();
  }

  /** Releases every GPU resource; chips created by this factory must not be rendered afterwards. */
  dispose(): void {
    for (const material of this.materials.values()) {
      material.map?.dispose();
      material.dispose();
    }
    this.normalMap.dispose();
    this.chipGeometry.dispose();
    this.highDetailGeometry.dispose();
    this.lowDetailGeometry.dispose();
  }

  private materialFor(denomination: number): THREE.MeshPhysicalMaterial {
    const exact = this.materials.get(denomination);
    if (exact !== undefined) return exact;
    const fallback = CHIP_DENOMINATIONS.find((candidate) => candidate <= denomination) ?? 1;
    return this.materials.get(fallback) as THREE.MeshPhysicalMaterial;
  }
}
