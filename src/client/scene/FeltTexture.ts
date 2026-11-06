import { CanvasTexture, SRGBColorSpace } from 'three';
import { CARD_HEIGHT, CARD_WIDTH } from './CardFactory';
import {
  COMMUNITY_POSITIONS,
  DECK_POSITION,
  FELT_SHAPE,
  MUCK_POSITION,
  POT_POSITION,
  SEAT_SLOTS,
  VISIBLE_FELT_SHAPE,
  getSeatAnchor,
  stadiumPoint,
} from './SeatLayout';
import { createCanvas, createRandom, hexToRgb, rgba, smoothstep, type Rgb } from './proceduralTextures';

export type FeltTheme = 'emerald' | 'royal' | 'burgundy';

export const FELT_CANVAS_WIDTH = 2048;
export const FELT_CANVAS_HEIGHT = 1024;
/** Radius of the gold line that separates the players' bets from their cards (see paintBettingLine). */
export const BETTING_LINE_RADIUS = 0.34;

/**
 * World rectangle (meters) mapped 1:1 onto the felt canvas: x spans the felt slab, and canvas top is world -Z.
 * Both axes share one scale, so SeatLayout coordinates can be drawn without distortion.
 */
export const FELT_CANVAS_BOUNDS = {
  minX: -1.295,
  maxX: 1.295,
  minZ: FELT_SHAPE.centerZ - 0.6475,
  maxZ: FELT_SHAPE.centerZ + 0.6475,
};

const PIXELS_PER_METER = FELT_CANVAS_WIDTH / (FELT_CANVAS_BOUNDS.maxX - FELT_CANVAS_BOUNDS.minX);

/** UV for a world XZ point, assuming the default CanvasTexture flipY (canvas top row is v = 1). */
export function feltWorldToUv(x: number, z: number): { u: number; v: number } {
  const u = (x - FELT_CANVAS_BOUNDS.minX) / (FELT_CANVAS_BOUNDS.maxX - FELT_CANVAS_BOUNDS.minX);
  const v = 1 - (z - FELT_CANVAS_BOUNDS.minZ) / (FELT_CANVAS_BOUNDS.maxZ - FELT_CANVAS_BOUNDS.minZ);
  return { u, v };
}

function worldToCanvasX(x: number): number {
  return (x - FELT_CANVAS_BOUNDS.minX) * PIXELS_PER_METER;
}

function worldToCanvasY(z: number): number {
  return (z - FELT_CANVAS_BOUNDS.minZ) * PIXELS_PER_METER;
}

function metersToPixels(meters: number): number {
  return meters * PIXELS_PER_METER;
}

interface FeltPalette {
  base: string;
  sheen: string;
}

const FELT_PALETTES: Record<FeltTheme, FeltPalette> = {
  emerald: { base: '#0f5e45', sheen: '#6fd0aa' },
  royal: { base: '#123a6b', sheen: '#6fa1e0' },
  burgundy: { base: '#5a1622', sheen: '#d9788c' },
};

const GOLD: Rgb = hexToRgb('#d9b46a');
const LOGO_FONT_STACK = '"Palatino Linotype", "Book Antiqua", Palatino, Georgia, "Times New Roman", serif';

/** Tint for MeshPhysicalMaterial.sheenColor: a lighter shade of the cloth so grazing light stays on-hue. */
export function getFeltSheenColor(theme: FeltTheme): string {
  return FELT_PALETTES[theme].sheen;
}

function scaleColor(color: Rgb, factor: number): Rgb {
  return {
    r: Math.min(255, color.r * factor),
    g: Math.min(255, color.g * factor),
    b: Math.min(255, color.b * factor),
  };
}

function paintBaseCloth(context: CanvasRenderingContext2D, base: Rgb): void {
  context.fillStyle = rgba(scaleColor(base, 0.72), 1);
  context.fillRect(0, 0, FELT_CANVAS_WIDTH, FELT_CANVAS_HEIGHT);

  const centerX = worldToCanvasX(0);
  const centerY = worldToCanvasY(FELT_SHAPE.centerZ);
  const reach = metersToPixels(1.35);

  context.save();
  context.translate(centerX, centerY);
  context.scale(1, 0.58);
  const falloff = context.createRadialGradient(0, 0, 0, 0, 0, reach);
  falloff.addColorStop(0, rgba(scaleColor(base, 1.3), 1));
  falloff.addColorStop(0.55, rgba(base, 1));
  falloff.addColorStop(1, rgba(scaleColor(base, 0.72), 1));
  context.fillStyle = falloff;
  context.fillRect(-reach, -reach / 0.58, reach * 2, (reach * 2) / 0.58);
  context.restore();
}

function paintCloudiness(context: CanvasRenderingContext2D, random: () => number): void {
  const layers = [
    { width: 48, height: 24, alpha: 0.11 },
    { width: 170, height: 85, alpha: 0.07 },
  ];

  for (const layer of layers) {
    const { canvas, context: layerContext } = createCanvas(layer.width, layer.height);
    const image = layerContext.createImageData(layer.width, layer.height);
    for (let offset = 0; offset < image.data.length; offset += 4) {
      const shade = 70 + random() * 120;
      image.data[offset] = shade;
      image.data[offset + 1] = shade;
      image.data[offset + 2] = shade;
      image.data[offset + 3] = 255;
    }
    layerContext.putImageData(image, 0, 0);

    context.save();
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.globalCompositeOperation = 'overlay';
    context.globalAlpha = layer.alpha;
    context.drawImage(canvas, 0, 0, FELT_CANVAS_WIDTH, FELT_CANVAS_HEIGHT);
    context.restore();
  }
}

function paintFibres(context: CanvasRenderingContext2D, random: () => number): void {
  const batches = [
    { style: 'rgba(255, 255, 255, 0.05)', count: 16000 },
    { style: 'rgba(0, 0, 0, 0.08)', count: 16000 },
  ];

  context.lineWidth = 1;
  for (const batch of batches) {
    context.strokeStyle = batch.style;
    context.beginPath();
    for (let fibre = 0; fibre < batch.count; fibre++) {
      const x = random() * FELT_CANVAS_WIDTH;
      const y = random() * FELT_CANVAS_HEIGHT;
      const angle = random() * Math.PI;
      const length = 2 + random() * 6;
      context.moveTo(x, y);
      context.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
    }
    context.stroke();
  }
}

/** Per-pixel grain plus a darkening toward the rail, measured from the visible felt opening. */
function applyGrainAndRailVignette(context: CanvasRenderingContext2D, random: () => number): void {
  const image = context.getImageData(0, 0, FELT_CANVAS_WIDTH, FELT_CANVAS_HEIGHT);
  const { data } = image;
  const { halfLength, radius, centerZ } = VISIBLE_FELT_SHAPE;

  const outsideSegmentX = new Float32Array(FELT_CANVAS_WIDTH);
  for (let pixelX = 0; pixelX < FELT_CANVAS_WIDTH; pixelX++) {
    const x = FELT_CANVAS_BOUNDS.minX + (pixelX + 0.5) / PIXELS_PER_METER;
    outsideSegmentX[pixelX] = Math.max(Math.abs(x) - halfLength, 0);
  }

  for (let pixelY = 0; pixelY < FELT_CANVAS_HEIGHT; pixelY++) {
    const z = FELT_CANVAS_BOUNDS.minZ + (pixelY + 0.5) / PIXELS_PER_METER;
    const deltaZ = z - centerZ;

    for (let pixelX = 0; pixelX < FELT_CANVAS_WIDTH; pixelX++) {
      const deltaX = outsideSegmentX[pixelX];
      const depthInside = radius - Math.sqrt(deltaX * deltaX + deltaZ * deltaZ);
      const vignette = 1 - 0.36 * (1 - smoothstep(0, 0.2, depthInside));
      const grain = (1 + (random() - 0.5) * 0.15) * vignette;

      const offset = (pixelY * FELT_CANVAS_WIDTH + pixelX) * 4;
      data[offset] *= grain;
      data[offset + 1] *= grain;
      data[offset + 2] *= grain;
    }
  }
  context.putImageData(image, 0, 0);
}

/**
 * Sits between each seat's bet ring and its hole cards. The rail hides the outer 0.145 m of the felt slab,
 * so an inset measured from the slab edge would run under the rail and never be seen.
 */
const MUCK_SPOT_RADIUS = 0.105;
/** The dealer's tray, deck and muck stand on the line, so the line stops short of them on both sides. */
const DEALER_ZONE_LEFT_X = DECK_POSITION.x - CARD_WIDTH / 2 - 0.045;
const DEALER_ZONE_RIGHT_X = MUCK_POSITION.x + MUCK_SPOT_RADIUS + 0.06;

/** Stadium parameter of the point of the far side (top of the table) whose x is `x`, going around the right end. */
function farSideParameter(x: number, halfLength: number, radius: number): number {
  const straight = 2 * halfLength;
  const arc = Math.PI * radius;
  const perimeter = 2 * straight + 2 * arc;
  const topStart = halfLength + arc;
  if (Math.abs(x) <= halfLength) {
    return (topStart + (x + halfLength)) / perimeter;
  }
  const angle = Math.asin(Math.min(1, (x - halfLength) / radius));
  return (topStart + straight + radius * angle) / perimeter;
}

/** The stretch of the betting line (stadium parameter, start < end) that stays unpainted around the dealer's workspace. */
export function getBettingLineGap(): { start: number; end: number } {
  const { halfLength } = FELT_SHAPE;
  return {
    start: farSideParameter(DEALER_ZONE_LEFT_X, halfLength, BETTING_LINE_RADIUS),
    end: farSideParameter(DEALER_ZONE_RIGHT_X, halfLength, BETTING_LINE_RADIUS),
  };
}

function paintBettingLine(context: CanvasRenderingContext2D): void {
  context.strokeStyle = rgba(GOLD, 0.55);
  context.lineWidth = metersToPixels(0.0032);
  context.lineJoin = 'round';
  context.lineCap = 'round';

  const { halfLength, centerZ } = FELT_SHAPE;
  const { start: gapStart, end: gapEnd } = getBettingLineGap();
  const samples = 720;
  context.beginPath();
  for (let sample = 0; sample <= samples; sample++) {
    // Open path: from the end of the dealer zone once around to its start.
    const t = gapEnd + (sample / samples) * (1 - (gapEnd - gapStart));
    const { point } = stadiumPoint(t, halfLength, BETTING_LINE_RADIUS, centerZ);
    const x = worldToCanvasX(point.x);
    const y = worldToCanvasY(point.z);
    if (sample === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }
  context.stroke();
}

function traceRoundedRect(
  context: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  width: number,
  height: number,
  cornerRadius: number,
): void {
  const left = centerX - width / 2;
  const top = centerY - height / 2;
  context.beginPath();
  context.moveTo(left + cornerRadius, top);
  context.arcTo(left + width, top, left + width, top + height, cornerRadius);
  context.arcTo(left + width, top + height, left, top + height, cornerRadius);
  context.arcTo(left, top + height, left, top, cornerRadius);
  context.arcTo(left, top, left + width, top, cornerRadius);
  context.closePath();
}

function paintCommunitySlots(context: CanvasRenderingContext2D): void {
  context.strokeStyle = rgba(GOLD, 0.3);
  context.lineWidth = metersToPixels(0.0025);

  for (const position of COMMUNITY_POSITIONS) {
    traceRoundedRect(
      context,
      worldToCanvasX(position.x),
      worldToCanvasY(position.z),
      metersToPixels(CARD_WIDTH + 0.008),
      metersToPixels(CARD_HEIGHT + 0.008),
      metersToPixels(0.008),
    );
    context.stroke();
  }
}

/** Faint spots for the dealer's deck and for the muck, so they sit on marked places like the community cards. */
function paintDealerSpots(context: CanvasRenderingContext2D): void {
  context.strokeStyle = rgba(GOLD, 0.3);
  context.lineWidth = metersToPixels(0.0025);
  traceRoundedRect(
    context,
    worldToCanvasX(DECK_POSITION.x),
    worldToCanvasY(DECK_POSITION.z),
    metersToPixels(CARD_WIDTH + 0.008),
    metersToPixels(CARD_HEIGHT + 0.008),
    metersToPixels(0.008),
  );
  context.stroke();

  context.strokeStyle = rgba(GOLD, 0.22);
  context.beginPath();
  context.arc(worldToCanvasX(MUCK_POSITION.x), worldToCanvasY(MUCK_POSITION.z), metersToPixels(MUCK_SPOT_RADIUS), 0, Math.PI * 2);
  context.stroke();
}

function paintBetRings(context: CanvasRenderingContext2D): void {
  context.strokeStyle = rgba(GOLD, 0.5);
  context.lineWidth = metersToPixels(0.0028);

  for (let slot = 0; slot < SEAT_SLOTS; slot++) {
    const { bet } = getSeatAnchor(slot);
    context.beginPath();
    context.arc(worldToCanvasX(bet.x), worldToCanvasY(bet.z), metersToPixels(0.044), 0, Math.PI * 2);
    context.stroke();
  }
}

function paintPotCircle(context: CanvasRenderingContext2D): void {
  context.strokeStyle = rgba(GOLD, 0.24);
  context.lineWidth = metersToPixels(0.0025);
  context.beginPath();
  context.arc(worldToCanvasX(POT_POSITION.x), worldToCanvasY(POT_POSITION.z), metersToPixels(0.1), 0, Math.PI * 2);
  context.stroke();
}

function drawSpacedText(
  context: CanvasRenderingContext2D,
  text: string,
  centerX: number,
  centerY: number,
  spacing: number,
): number {
  const glyphs = [...text];
  const widths = glyphs.map((glyph) => context.measureText(glyph).width);
  const totalWidth = widths.reduce((sum, width) => sum + width, 0) + spacing * (glyphs.length - 1);

  let cursorX = centerX - totalWidth / 2;
  glyphs.forEach((glyph, index) => {
    context.fillText(glyph, cursorX, centerY);
    cursorX += widths[index] + spacing;
  });
  return totalWidth;
}

function traceSpade(context: CanvasRenderingContext2D, centerX: number, centerY: number, halfHeight: number): void {
  const x = (unit: number): number => centerX + unit * halfHeight;
  const y = (unit: number): number => centerY + unit * halfHeight;

  context.beginPath();
  context.moveTo(x(0), y(-1));
  context.bezierCurveTo(x(0.12), y(-0.62), x(1), y(-0.22), x(1), y(0.28));
  context.bezierCurveTo(x(1), y(0.78), x(0.3), y(0.92), x(0.08), y(0.5));
  context.lineTo(x(0.22), y(1));
  context.lineTo(x(-0.22), y(1));
  context.lineTo(x(-0.08), y(0.5));
  context.bezierCurveTo(x(-0.3), y(0.92), x(-1), y(0.78), x(-1), y(0.28));
  context.bezierCurveTo(x(-1), y(-0.22), x(-0.12), y(-0.62), x(0), y(-1));
  context.closePath();
}

/** Stacked around the community cards so the name stays readable once the board is dealt. */
function paintWatermark(context: CanvasRenderingContext2D): void {
  const centerX = worldToCanvasX(0);
  context.textBaseline = 'middle';
  context.textAlign = 'left';
  context.fillStyle = rgba(GOLD, 0.2);

  context.font = `700 ${metersToPixels(0.075)}px ${LOGO_FONT_STACK}`;
  drawSpacedText(context, 'MESA REAL', centerX, worldToCanvasY(-0.1965), metersToPixels(0.024));

  const subtitleY = worldToCanvasY(-0.145);
  context.font = `600 ${metersToPixels(0.0225)}px ${LOGO_FONT_STACK}`;
  const subtitleWidth = drawSpacedText(context, "TEXAS HOLD'EM · NO LIMIT", centerX, subtitleY, metersToPixels(0.0085));

  context.strokeStyle = rgba(GOLD, 0.16);
  context.lineWidth = metersToPixels(0.002);
  const ruleGap = metersToPixels(0.03);
  const ruleLength = metersToPixels(0.17);
  context.beginPath();
  context.moveTo(centerX - subtitleWidth / 2 - ruleGap, subtitleY);
  context.lineTo(centerX - subtitleWidth / 2 - ruleGap - ruleLength, subtitleY);
  context.moveTo(centerX + subtitleWidth / 2 + ruleGap, subtitleY);
  context.lineTo(centerX + subtitleWidth / 2 + ruleGap + ruleLength, subtitleY);
  context.stroke();

  context.fillStyle = rgba(GOLD, 0.2);
  traceSpade(context, centerX, worldToCanvasY(0.026), metersToPixels(0.0135));
  context.fill();
}

/** Felt canvas for the table top; see FELT_CANVAS_BOUNDS for how it maps onto the table. */
export function createFeltTexture(theme: FeltTheme, maxAnisotropy: number): CanvasTexture {
  const { canvas, context } = createCanvas(FELT_CANVAS_WIDTH, FELT_CANVAS_HEIGHT);
  const random = createRandom(4242);
  const base = hexToRgb(FELT_PALETTES[theme].base);

  paintBaseCloth(context, base);
  paintCloudiness(context, random);
  paintFibres(context, random);
  applyGrainAndRailVignette(context, random);

  paintBettingLine(context);
  paintCommunitySlots(context);
  paintDealerSpots(context);
  paintBetRings(context);
  paintPotCircle(context);
  paintWatermark(context);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = maxAnisotropy;
  texture.needsUpdate = true;
  return texture;
}
