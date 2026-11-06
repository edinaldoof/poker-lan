import * as THREE from 'three';
import { type Card, rankValue, suitOf, type SuitChar } from '../../shared/cards';

export const CARD_WIDTH = 0.13;
export const CARD_HEIGHT = 0.182;
export const CARD_THICKNESS = 0.0012;

export type CardHighlight = 'none' | 'winner' | 'dim';

const ATLAS_URL = '/assets/cards/cards_atlas.webp';
const ATLAS_COLUMNS = 13;
const ATLAS_ROWS = 5;
const ACE_VALUE = 14;

const CORNER_RADIUS = 0.008;
const CORNER_SEGMENTS = 6;

const EDGE_COLOR = '#f1ede4';
const DIM_TINT = 0.42;
const WINNER_EMISSIVE_COLOR = '#ffcf7a';
const WINNER_EMISSIVE_INTENSITY = 0.3;
/**
 * The viewer's own cards float tilted toward the camera, where the room reflections and every fill light land
 * almost head-on: at full albedo their faces clip to white and the red pips wash out to pink. Darker paint
 * brings them back to the exposure of the cards on the felt.
 */
const HAND_EXPOSURE = 0.68;

const GLOW_MARGIN = 0.018;
const GLOW_PIXELS_PER_METER = 2400;

interface AtlasCell {
  column: number;
  row: number;
}

interface UvRect {
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

const BACK_CELL: AtlasCell = { column: 0, row: 4 };
const SUIT_ROW: Record<SuitChar, number> = { c: 0, d: 1, h: 2, s: 3 };

function cellOf(card: Card | null): AtlasCell {
  if (card === null) return BACK_CELL;
  const value = rankValue(card);
  return { column: value === ACE_VALUE ? 0 : value - 1, row: SUIT_ROW[suitOf(card)] };
}

function cellKey(cell: AtlasCell): number {
  return cell.row * ATLAS_COLUMNS + cell.column;
}

/** UV rectangle of an atlas cell, inset by half a texel so neighbouring cells never bleed in. */
function cellUvRect(cell: AtlasCell, atlasWidth: number, atlasHeight: number): UvRect {
  const halfTexelU = 0.5 / atlasWidth;
  const halfTexelV = 0.5 / atlasHeight;
  return {
    uMin: cell.column / ATLAS_COLUMNS + halfTexelU,
    uMax: (cell.column + 1) / ATLAS_COLUMNS - halfTexelU,
    vMin: 1 - (cell.row + 1) / ATLAS_ROWS + halfTexelV,
    vMax: 1 - cell.row / ATLAS_ROWS - halfTexelV,
  };
}

function createRoundedRectangleShape(width: number, height: number, radius: number): THREE.Shape {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-halfWidth + radius, -halfHeight);
  shape.lineTo(halfWidth - radius, -halfHeight);
  shape.absarc(halfWidth - radius, -halfHeight + radius, radius, -Math.PI / 2, 0, false);
  shape.lineTo(halfWidth, halfHeight - radius);
  shape.absarc(halfWidth - radius, halfHeight - radius, radius, 0, Math.PI / 2, false);
  shape.lineTo(-halfWidth + radius, halfHeight);
  shape.absarc(-halfWidth + radius, halfHeight - radius, radius, Math.PI / 2, Math.PI, false);
  shape.lineTo(-halfWidth, -halfHeight + radius);
  shape.absarc(-halfWidth + radius, -halfHeight + radius, radius, Math.PI, Math.PI * 1.5, false);
  return shape;
}

/**
 * Card mesh data shared by every card: positions and normals plus, for each lid vertex, where it falls inside
 * its atlas cell (0..1). Vertices are ordered front lid, back lid, then edge, so one geometry per face only has
 * to rewrite the UVs of the two lids.
 */
interface CardTemplate {
  position: THREE.BufferAttribute;
  normal: THREE.BufferAttribute;
  cellUv: Float32Array;
  frontVertexCount: number;
  backVertexCount: number;
  totalVertexCount: number;
}

function createCardTemplate(): CardTemplate {
  const extruded = new THREE.ExtrudeGeometry(createRoundedRectangleShape(CARD_WIDTH, CARD_HEIGHT, CORNER_RADIUS), {
    depth: CARD_THICKNESS,
    bevelEnabled: false,
    curveSegments: CORNER_SEGMENTS,
  });
  // Extrusion runs along +Z in shape space. Centre it on the card's mid-plane, then stand the shape on its
  // side so the front lid faces +Y and the shape's top edge points to -Z.
  extruded.translate(0, 0, -CARD_THICKNESS / 2);
  extruded.rotateX(-Math.PI / 2);

  const sourcePosition = extruded.getAttribute('position');
  const sourceNormal = extruded.getAttribute('normal');

  const frontTriangles: number[] = [];
  const backTriangles: number[] = [];
  const sideTriangles: number[] = [];
  for (let firstVertex = 0; firstVertex < sourcePosition.count; firstVertex += 3) {
    const facing = sourceNormal.getY(firstVertex);
    if (facing > 0.5) frontTriangles.push(firstVertex);
    else if (facing < -0.5) backTriangles.push(firstVertex);
    else sideTriangles.push(firstVertex);
  }

  const orderedTriangles = [...frontTriangles, ...backTriangles, ...sideTriangles];
  const totalVertexCount = orderedTriangles.length * 3;
  const positions = new Float32Array(totalVertexCount * 3);
  const normals = new Float32Array(totalVertexCount * 3);
  const cellUv = new Float32Array(totalVertexCount * 2);

  orderedTriangles.forEach((firstSourceVertex, triangleIndex) => {
    const isFront = triangleIndex < frontTriangles.length;
    const isBack = !isFront && triangleIndex < frontTriangles.length + backTriangles.length;
    for (let corner = 0; corner < 3; corner++) {
      const source = firstSourceVertex + corner;
      const target = triangleIndex * 3 + corner;
      const x = sourcePosition.getX(source);
      const z = sourcePosition.getZ(source);
      positions.set([x, sourcePosition.getY(source), z], target * 3);
      normals.set([sourceNormal.getX(source), sourceNormal.getY(source), sourceNormal.getZ(source)], target * 3);

      const faceV = (CARD_HEIGHT / 2 - z) / CARD_HEIGHT;
      if (isFront) cellUv.set([(x + CARD_WIDTH / 2) / CARD_WIDTH, faceV], target * 2);
      // Seen from outside the flipped card the x axis is mirrored.
      else if (isBack) cellUv.set([(CARD_WIDTH / 2 - x) / CARD_WIDTH, faceV], target * 2);
    }
  });
  extruded.dispose();

  return {
    position: new THREE.BufferAttribute(positions, 3),
    normal: new THREE.BufferAttribute(normals, 3),
    cellUv,
    frontVertexCount: frontTriangles.length * 3,
    backVertexCount: backTriangles.length * 3,
    totalVertexCount,
  };
}

function writeCellUv(
  target: Float32Array,
  cellUv: Float32Array,
  fromVertex: number,
  toVertex: number,
  rect: UvRect,
): void {
  for (let vertex = fromVertex; vertex < toVertex; vertex++) {
    target[vertex * 2] = rect.uMin + cellUv[vertex * 2] * (rect.uMax - rect.uMin);
    target[vertex * 2 + 1] = rect.vMin + cellUv[vertex * 2 + 1] * (rect.vMax - rect.vMin);
  }
}

function createCardGeometry(
  template: CardTemplate,
  frontCell: AtlasCell,
  atlasWidth: number,
  atlasHeight: number,
): THREE.BufferGeometry {
  const { frontVertexCount, backVertexCount, totalVertexCount } = template;
  const lidVertexCount = frontVertexCount + backVertexCount;

  const uv = new Float32Array(totalVertexCount * 2);
  writeCellUv(uv, template.cellUv, 0, frontVertexCount, cellUvRect(frontCell, atlasWidth, atlasHeight));
  writeCellUv(uv, template.cellUv, frontVertexCount, lidVertexCount, cellUvRect(BACK_CELL, atlasWidth, atlasHeight));

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', template.position);
  geometry.setAttribute('normal', template.normal);
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.addGroup(0, lidVertexCount, 0);
  geometry.addGroup(lidVertexCount, totalVertexCount - lidVertexCount, 1);
  return geometry;
}

/**
 * One material array per highlight mode: [faces (front and back lids), edge]. Only the tint and the emissive
 * intensity differ between modes, so all of them compile to the same two shader programs.
 */
function createMaterialSet(atlas: THREE.Texture, highlight: CardHighlight, exposure: number): THREE.Material[] {
  const tint = (highlight === 'dim' ? DIM_TINT : 1) * exposure;
  const emissiveIntensity = highlight === 'winner' ? WINNER_EMISSIVE_INTENSITY : 0;

  const faces = new THREE.MeshStandardMaterial({
    map: atlas,
    emissiveMap: atlas,
    emissive: new THREE.Color(WINNER_EMISSIVE_COLOR),
    emissiveIntensity,
    // Matte enough that the key light's specular hot spot never washes out the card indices.
    roughness: 0.64,
    metalness: 0,
  });
  faces.color.setScalar(tint);

  const edge = new THREE.MeshStandardMaterial({
    color: new THREE.Color(EDGE_COLOR).multiplyScalar(tint),
    emissive: new THREE.Color(WINNER_EMISSIVE_COLOR),
    emissiveIntensity,
    roughness: 0.85,
    metalness: 0,
  });
  return [faces, edge];
}

function traceRoundedRectangle(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

/** Soft gold halo around the card outline; the part under the card itself is hidden by the lids. */
function createGlowTexture(): THREE.CanvasTexture {
  const width = Math.round((CARD_WIDTH + GLOW_MARGIN * 2) * GLOW_PIXELS_PER_METER);
  const height = Math.round((CARD_HEIGHT + GLOW_MARGIN * 2) * GLOW_PIXELS_PER_METER);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Canvas 2D context is not available');

  const margin = GLOW_MARGIN * GLOW_PIXELS_PER_METER;
  const cardWidth = CARD_WIDTH * GLOW_PIXELS_PER_METER;
  const cardHeight = CARD_HEIGHT * GLOW_PIXELS_PER_METER;
  const radius = CORNER_RADIUS * GLOW_PIXELS_PER_METER;

  context.shadowColor = 'rgba(255, 196, 92, 1)';
  context.shadowBlur = margin * 0.75;
  context.strokeStyle = 'rgba(255, 210, 120, 0.95)';
  context.lineWidth = 0.0032 * GLOW_PIXELS_PER_METER;
  traceRoundedRectangle(context, margin, margin, cardWidth, cardHeight, radius);
  // Stroked twice on purpose: the shadow colour is already fully opaque, so a second pass is the only way to
  // accumulate more halo intensity.
  context.stroke();
  context.stroke();

  context.shadowBlur = 0;
  context.strokeStyle = '#fff0c2';
  context.lineWidth = 0.0014 * GLOW_PIXELS_PER_METER;
  traceRoundedRectangle(context, margin, margin, cardWidth, cardHeight, radius);
  context.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** What a card needs from its factory; lets every card share geometry and materials. */
export interface CardAssets {
  geometryFor(card: Card | null): THREE.BufferGeometry;
  materialsFor(highlight: CardHighlight, inHand: boolean): THREE.Material[];
  createGlow(): THREE.Mesh;
}

/**
 * A playing card. Origin = centre of the card's thickness. Front face normal is local +Y with the top edge of the
 * face toward local -Z; face-down is `rotation.z = Math.PI`.
 */
export class CardObject extends THREE.Group {
  card: Card | null;
  private readonly assets: CardAssets;
  private readonly body: THREE.Mesh;
  private glow: THREE.Mesh | null = null;
  private highlight: CardHighlight = 'none';
  private inHand = false;

  constructor(assets: CardAssets, card: Card | null) {
    super();
    this.assets = assets;
    this.card = card;
    this.body = new THREE.Mesh(assets.geometryFor(card), assets.materialsFor('none', false));
    this.body.castShadow = true;
    this.body.receiveShadow = true;
    this.add(this.body);
  }

  /** `null` = unknown card: the front shows the back image as well. */
  setFace(card: Card | null): void {
    this.card = card;
    this.body.geometry = this.assets.geometryFor(card);
  }

  /** Marks the card as held up in the viewer's hand, which needs its own exposure (see HAND_EXPOSURE). */
  setInHand(inHand: boolean): void {
    if (inHand === this.inHand) return;
    this.inHand = inHand;
    this.body.material = this.assets.materialsFor(this.highlight, inHand);
  }

  setHighlight(mode: CardHighlight): void {
    if (mode === this.highlight) return;
    this.highlight = mode;
    this.body.material = this.assets.materialsFor(mode, this.inHand);

    if (mode === 'winner') {
      this.glow ??= this.createGlowMesh();
      this.glow.visible = true;
    } else if (this.glow !== null) {
      this.glow.visible = false;
    }
  }

  /** Geometry, materials and textures belong to the factory, so releasing a card only detaches it. */
  dispose(): void {
    this.removeFromParent();
    this.clear();
    this.glow = null;
  }

  private createGlowMesh(): THREE.Mesh {
    const glow = this.assets.createGlow();
    this.add(glow);
    return glow;
  }
}

export class CardFactory implements CardAssets {
  private readonly atlas: THREE.Texture;
  private readonly atlasWidth: number;
  private readonly atlasHeight: number;
  private readonly template: CardTemplate;
  private readonly geometries = new Map<number, THREE.BufferGeometry>();
  private readonly materialSets: Record<CardHighlight, THREE.Material[]>;
  private readonly handMaterialSets: Record<CardHighlight, THREE.Material[]>;
  private readonly glowTexture: THREE.CanvasTexture;
  private readonly glowGeometry: THREE.PlaneGeometry;
  private readonly glowMaterial: THREE.MeshBasicMaterial;

  static async create(manager: THREE.LoadingManager, renderer: THREE.WebGLRenderer): Promise<CardFactory> {
    const atlas = await new THREE.TextureLoader(manager).loadAsync(ATLAS_URL);
    atlas.colorSpace = THREE.SRGBColorSpace;
    atlas.anisotropy = renderer.capabilities.getMaxAnisotropy();
    atlas.generateMipmaps = true;
    atlas.minFilter = THREE.LinearMipmapLinearFilter;
    atlas.magFilter = THREE.LinearFilter;
    return new CardFactory(atlas);
  }

  private constructor(atlas: THREE.Texture) {
    const image = atlas.image as { width: number; height: number };
    this.atlas = atlas;
    this.atlasWidth = image.width;
    this.atlasHeight = image.height;
    this.template = createCardTemplate();
    this.materialSets = {
      none: createMaterialSet(atlas, 'none', 1),
      winner: createMaterialSet(atlas, 'winner', 1),
      dim: createMaterialSet(atlas, 'dim', 1),
    };
    this.handMaterialSets = {
      none: createMaterialSet(atlas, 'none', HAND_EXPOSURE),
      winner: createMaterialSet(atlas, 'winner', HAND_EXPOSURE),
      dim: createMaterialSet(atlas, 'dim', HAND_EXPOSURE),
    };

    this.glowTexture = createGlowTexture();
    this.glowGeometry = new THREE.PlaneGeometry(CARD_WIDTH + GLOW_MARGIN * 2, CARD_HEIGHT + GLOW_MARGIN * 2);
    this.glowGeometry.rotateX(-Math.PI / 2);
    this.glowMaterial = new THREE.MeshBasicMaterial({
      map: this.glowTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
  }

  createCard(card: Card | null): CardObject {
    return new CardObject(this, card);
  }

  geometryFor(card: Card | null): THREE.BufferGeometry {
    const cell = cellOf(card);
    const key = cellKey(cell);
    let geometry = this.geometries.get(key);
    if (geometry === undefined) {
      geometry = createCardGeometry(this.template, cell, this.atlasWidth, this.atlasHeight);
      this.geometries.set(key, geometry);
    }
    return geometry;
  }

  materialsFor(highlight: CardHighlight, inHand: boolean): THREE.Material[] {
    return inHand ? this.handMaterialSets[highlight] : this.materialSets[highlight];
  }

  createGlow(): THREE.Mesh {
    const glow = new THREE.Mesh(this.glowGeometry, this.glowMaterial);
    glow.renderOrder = 2;
    return glow;
  }

  /** Releases every GPU resource; cards created by this factory must not be rendered afterwards. */
  dispose(): void {
    for (const geometry of this.geometries.values()) geometry.dispose();
    this.geometries.clear();
    for (const materials of [...Object.values(this.materialSets), ...Object.values(this.handMaterialSets)]) {
      for (const material of materials) material.dispose();
    }
    this.glowGeometry.dispose();
    this.glowMaterial.dispose();
    this.glowTexture.dispose();
    this.atlas.dispose();
  }
}
