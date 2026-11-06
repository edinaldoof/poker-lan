import * as THREE from 'three';

export const DEALER_BUTTON_RADIUS = 0.04;
export const DEALER_BUTTON_HEIGHT = 0.011;
export const BLIND_BUTTON_RADIUS = 0.03;
export const BLIND_BUTTON_HEIGHT = 0.009;

const FACE_TEXTURE_SIZE = 512;
const CYLINDER_SEGMENTS = 48;
const FACE_ANISOTROPY = 8;
// CylinderGeometry maps its caps with u = z and v = x; a quarter turn makes the canvas upright for a viewer at +Z.
const CAP_UV_ROTATION = Math.PI / 2;

const SERIF_FAMILY = 'Georgia, "Times New Roman", serif';
const SANS_FAMILY = '"Helvetica Neue", Arial, "Segoe UI", sans-serif';

const PUCK_IVORY = '#f4f0e6';
const GOLD = '#e4b363';
const GOLD_DEEP = '#b98a36';
const ROYAL_BLUE = '#2147c9';
const INK = '#15171c';

type ButtonKey = 'dealer' | 'SB' | 'BB';

interface ButtonAssets {
  geometry: THREE.BufferGeometry;
  materials: THREE.Material[];
}

function createFaceCanvas(): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = FACE_TEXTURE_SIZE;
  canvas.height = FACE_TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Canvas 2D context is not available');
  return { canvas, context };
}

function createFaceTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = FACE_ANISOTROPY;
  texture.center.set(0.5, 0.5);
  texture.rotation = CAP_UV_ROTATION;
  return texture;
}

function fillDisc(context: CanvasRenderingContext2D, radius: number, fill: string | CanvasGradient): void {
  const center = FACE_TEXTURE_SIZE / 2;
  context.beginPath();
  context.arc(center, center, radius, 0, Math.PI * 2);
  context.fillStyle = fill;
  context.fill();
}

function strokeRing(context: CanvasRenderingContext2D, radius: number, width: number, color: string): void {
  const center = FACE_TEXTURE_SIZE / 2;
  context.beginPath();
  context.arc(center, center, radius, 0, Math.PI * 2);
  context.lineWidth = width;
  context.strokeStyle = color;
  context.stroke();
}

function createSoftDisc(context: CanvasRenderingContext2D, inner: string, outer: string): CanvasGradient {
  const center = FACE_TEXTURE_SIZE / 2;
  const gradient = context.createRadialGradient(center, center, 0, center, center, center);
  gradient.addColorStop(0, inner);
  gradient.addColorStop(1, outer);
  return gradient;
}

function fillDiamond(
  context: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  halfSize: number,
  color: string,
): void {
  context.beginPath();
  context.moveTo(centerX, centerY - halfSize);
  context.lineTo(centerX + halfSize, centerY);
  context.lineTo(centerX, centerY + halfSize);
  context.lineTo(centerX - halfSize, centerY);
  context.closePath();
  context.fillStyle = color;
  context.fill();
}

/** Draws letter-spaced text centred on `centerX`, shrinking the font so the whole word fits `maxWidth`. */
function drawSpacedText(
  context: CanvasRenderingContext2D,
  text: string,
  fontFamily: string,
  weight: string,
  centerX: number,
  centerY: number,
  maxWidth: number,
  spacingRatio: number,
  maxFontPx: number,
): void {
  const referencePx = 100;
  const letters = [...text];
  context.font = `${weight} ${referencePx}px ${fontFamily}`;
  const referenceWidth =
    letters.reduce((sum, letter) => sum + context.measureText(letter).width, 0) +
    referencePx * spacingRatio * (letters.length - 1);
  const fontPx = Math.min(maxFontPx, (maxWidth / referenceWidth) * referencePx);
  const scale = fontPx / referencePx;
  const ascent = context.measureText(text).actualBoundingBoxAscent * scale;

  context.font = `${weight} ${fontPx}px ${fontFamily}`;
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  const spacing = fontPx * spacingRatio;
  const widths = letters.map((letter) => context.measureText(letter).width);
  let cursor = centerX - (widths.reduce((sum, width) => sum + width, 0) + spacing * (letters.length - 1)) / 2;
  letters.forEach((letter, index) => {
    context.fillText(letter, cursor, centerY + ascent / 2);
    cursor += widths[index] + spacing;
  });
}

function paintDealerFace(context: CanvasRenderingContext2D): void {
  const center = FACE_TEXTURE_SIZE / 2;
  fillDisc(context, center, createSoftDisc(context, '#ffffff', PUCK_IVORY));

  strokeRing(context, center * 0.88, center * 0.07, GOLD_DEEP);
  strokeRing(context, center * 0.88, center * 0.035, GOLD);
  strokeRing(context, center * 0.76, center * 0.014, GOLD_DEEP);

  context.fillStyle = INK;
  drawSpacedText(context, 'DEALER', SERIF_FAMILY, '700', center, center, FACE_TEXTURE_SIZE * 0.6, 0.1, 96);

  const ornamentOffset = center * 0.4;
  const ornamentHalfSize = center * 0.06;
  const ruleHalfWidth = center * 0.22;
  for (const side of [-1, 1]) {
    const y = center + side * ornamentOffset;
    fillDiamond(context, center, y, ornamentHalfSize, GOLD_DEEP);
    context.fillStyle = GOLD_DEEP;
    context.fillRect(center - ruleHalfWidth - ornamentHalfSize * 1.8, y - 1.5, ruleHalfWidth, 3);
    context.fillRect(center + ornamentHalfSize * 1.8, y - 1.5, ruleHalfWidth, 3);
  }
}

function paintBlindFace(context: CanvasRenderingContext2D, kind: 'SB' | 'BB'): void {
  const center = FACE_TEXTURE_SIZE / 2;
  const isSmallBlind = kind === 'SB';
  const base = isSmallBlind ? ROYAL_BLUE : GOLD;
  const lighter = isSmallBlind ? '#4b73ee' : '#f5d493';
  const ring = isSmallBlind ? 'rgba(255, 255, 255, 0.85)' : 'rgba(58, 39, 8, 0.7)';

  fillDisc(context, center, createSoftDisc(context, lighter, base));
  strokeRing(context, center * 0.86, center * 0.05, ring);
  strokeRing(context, center * 0.72, center * 0.016, ring);

  context.fillStyle = isSmallBlind ? '#ffffff' : '#3a2708';
  drawSpacedText(context, kind, SANS_FAMILY, '800', center, center, FACE_TEXTURE_SIZE * 0.5, 0.06, 210);
}

function createPuckMaterial(color: string, map?: THREE.Texture): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color),
    map: map ?? null,
    // Satin finish: a glossy white puck right under the key light blooms into a glowing ball.
    roughness: 0.6,
    metalness: 0,
    clearcoat: 0.15,
    clearcoatRoughness: 0.5,
  });
}

/** Cylinder standing on y = 0; its material groups are [side, top cap, bottom cap]. */
function createPuckGeometry(radius: number, height: number): THREE.CylinderGeometry {
  const geometry = new THREE.CylinderGeometry(radius, radius, height, CYLINDER_SEGMENTS);
  geometry.translate(0, height / 2, 0);
  return geometry;
}

function buildDealerAssets(): ButtonAssets {
  const { canvas, context } = createFaceCanvas();
  paintDealerFace(context);
  return {
    geometry: createPuckGeometry(DEALER_BUTTON_RADIUS, DEALER_BUTTON_HEIGHT),
    materials: [
      createPuckMaterial(PUCK_IVORY),
      createPuckMaterial('#e6e0d2', createFaceTexture(canvas)),
      createPuckMaterial('#d9d4c6'),
    ],
  };
}

function buildBlindAssets(kind: 'SB' | 'BB'): ButtonAssets {
  const { canvas, context } = createFaceCanvas();
  paintBlindFace(context, kind);
  const isSmallBlind = kind === 'SB';
  return {
    geometry: createPuckGeometry(BLIND_BUTTON_RADIUS, BLIND_BUTTON_HEIGHT),
    materials: [
      createPuckMaterial(isSmallBlind ? '#1b3aa6' : '#c99a3e'),
      createPuckMaterial('#e6e0d2', createFaceTexture(canvas)),
      createPuckMaterial(isSmallBlind ? '#14297a' : '#a67b2a'),
    ],
  };
}

const ASSET_BUILDERS: Record<ButtonKey, () => ButtonAssets> = {
  dealer: buildDealerAssets,
  SB: () => buildBlindAssets('SB'),
  BB: () => buildBlindAssets('BB'),
};

const sharedAssets: Partial<Record<ButtonKey, ButtonAssets>> = {};

/** Geometry and materials are built on first use and shared by every puck of the same kind. */
function createButton(key: ButtonKey): THREE.Mesh {
  const assets = (sharedAssets[key] ??= ASSET_BUILDERS[key]());
  const button = new THREE.Mesh(assets.geometry, assets.materials);
  button.castShadow = true;
  button.receiveShadow = true;
  return button;
}

/** White dealer puck, origin at the centre of its base. */
export function createDealerButton(): THREE.Mesh {
  return createButton('dealer');
}

/** Small blind puck (royal blue) or big blind puck (gold), origin at the centre of its base. */
export function createBlindButton(kind: 'SB' | 'BB'): THREE.Mesh {
  return createButton(kind);
}
