import { CanvasTexture, NoColorSpace, RepeatWrapping, SRGBColorSpace, type ColorSpace } from 'three';

export interface Canvas2D {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function createCanvas(width: number, height: number): Canvas2D {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  // Pixel passes read the canvas back right after drawing; this keeps it CPU-backed.
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('Canvas 2D indisponível neste navegador.');
  }
  return { canvas, context };
}

/** Deterministic PRNG (mulberry32) so every client generates identical textures. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function hexToRgb(hex: string): Rgb {
  const value = parseInt(hex.replace('#', ''), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

export function rgba(color: Rgb, alpha: number): string {
  return `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${alpha})`;
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

interface TextureOptions {
  colorSpace: ColorSpace;
  repeating: boolean;
  maxAnisotropy: number;
}

function toTexture(canvas: HTMLCanvasElement, options: TextureOptions): CanvasTexture {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = options.colorSpace;
  texture.anisotropy = options.maxAnisotropy;
  if (options.repeating) {
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
  }
  texture.needsUpdate = true;
  return texture;
}

/** Fractal value noise that tiles seamlessly, normalised to 0..1 (row-major, size × size). */
function createTileableNoiseField(size: number, baseCells: number, octaves: number, random: () => number): Float32Array {
  const field = new Float32Array(size * size);
  let amplitude = 1;
  let totalAmplitude = 0;
  let cells = baseCells;

  for (let octave = 0; octave < octaves; octave++) {
    const lattice = Float32Array.from({ length: cells * cells }, random);
    const cellSize = size / cells;

    for (let y = 0; y < size; y++) {
      const gridY = y / cellSize;
      const y0 = Math.floor(gridY);
      const fadeY = smoothstep(0, 1, gridY - y0);
      const rowA = (y0 % cells) * cells;
      const rowB = ((y0 + 1) % cells) * cells;

      for (let x = 0; x < size; x++) {
        const gridX = x / cellSize;
        const x0 = Math.floor(gridX);
        const fadeX = smoothstep(0, 1, gridX - x0);
        const x1 = (x0 + 1) % cells;
        const top = lattice[rowA + (x0 % cells)] * (1 - fadeX) + lattice[rowA + x1] * fadeX;
        const bottom = lattice[rowB + (x0 % cells)] * (1 - fadeX) + lattice[rowB + x1] * fadeX;
        field[y * size + x] += amplitude * (top * (1 - fadeY) + bottom * fadeY);
      }
    }

    totalAmplitude += amplitude;
    amplitude *= 0.5;
    cells *= 2;
  }

  for (let index = 0; index < field.length; index++) {
    field[index] /= totalAmplitude;
  }
  return field;
}

/** Low-contrast grayscale noise for bump maps. Tileable. */
export function createNoiseTexture(maxAnisotropy = 1): CanvasTexture {
  const size = 256;
  const { canvas, context } = createCanvas(size, size);
  const field = createTileableNoiseField(size, 8, 4, createRandom(7301));
  const image = context.createImageData(size, size);

  for (let index = 0; index < field.length; index++) {
    const shade = 96 + field[index] * 64;
    image.data[index * 4] = shade;
    image.data[index * 4 + 1] = shade;
    image.data[index * 4 + 2] = shade;
    image.data[index * 4 + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return toTexture(canvas, { colorSpace: NoColorSpace, repeating: true, maxAnisotropy });
}

/** Dark walnut grain running along U. Tileable horizontally. */
export function createWoodTexture(maxAnisotropy = 1): CanvasTexture {
  const width = 1024;
  const height = 512;
  const { canvas, context } = createCanvas(width, height);
  const random = createRandom(5113);

  const verticalTone = context.createLinearGradient(0, 0, 0, height);
  verticalTone.addColorStop(0, '#3a2213');
  verticalTone.addColorStop(0.5, '#2e1a0e');
  verticalTone.addColorStop(1, '#3a2213');
  context.fillStyle = verticalTone;
  context.fillRect(0, 0, width, height);

  const darkGrain = { r: 18, g: 9, b: 4 };
  const lightGrain = { r: 96, g: 62, b: 36 };
  const segmentLength = 8;

  for (let baseY = -4; baseY < height + 4; baseY += 1.6 + random() * 3.2) {
    const wave = 1.5 + random() * 7;
    const waveCycles = 1 + Math.floor(random() * 3);
    const phase = random() * Math.PI * 2;
    const drift = (random() - 0.5) * 5;
    const tone = random() < 0.62 ? darkGrain : lightGrain;

    context.strokeStyle = rgba(tone, 0.05 + random() * 0.17);
    context.lineWidth = 0.6 + random() * 2.2;
    context.beginPath();
    for (let x = 0; x <= width; x += segmentLength) {
      const angle = (x / width) * Math.PI * 2 * waveCycles + phase;
      const y = baseY + Math.sin(angle) * wave + Math.sin(angle * 3 + phase) * wave * 0.25 + drift;
      if (x === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    }
    context.stroke();
  }

  context.strokeStyle = rgba(darkGrain, 0.35);
  context.lineWidth = 1;
  context.beginPath();
  for (let pore = 0; pore < 2600; pore++) {
    const x = random() * width;
    const y = random() * height;
    context.moveTo(x, y);
    context.lineTo(x + 2 + random() * 9, y + (random() - 0.5) * 0.8);
  }
  context.stroke();

  return toTexture(canvas, { colorSpace: SRGBColorSpace, repeating: true, maxAnisotropy });
}

function createPebbleHeightField(size: number, cellsPerSide: number, random: () => number): Float32Array {
  const cellSize = size / cellsPerSide;
  const jitterX = Float32Array.from({ length: cellsPerSide * cellsPerSide }, () => 0.15 + random() * 0.7);
  const jitterY = Float32Array.from({ length: cellsPerSide * cellsPerSide }, () => 0.15 + random() * 0.7);
  const heights = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const cellY = Math.floor(y / cellSize);
    for (let x = 0; x < size; x++) {
      const cellX = Math.floor(x / cellSize);
      let nearest = Infinity;
      let secondNearest = Infinity;

      for (let offsetY = -1; offsetY <= 1; offsetY++) {
        for (let offsetX = -1; offsetX <= 1; offsetX++) {
          const neighborX = cellX + offsetX;
          const neighborY = cellY + offsetY;
          const wrapped = ((neighborY + cellsPerSide) % cellsPerSide) * cellsPerSide + ((neighborX + cellsPerSide) % cellsPerSide);
          const dx = x - (neighborX + jitterX[wrapped]) * cellSize;
          const dy = y - (neighborY + jitterY[wrapped]) * cellSize;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < nearest) {
            secondNearest = nearest;
            nearest = distance;
          } else if (distance < secondNearest) {
            secondNearest = distance;
          }
        }
      }

      const groove = smoothstep(0, 0.2, (secondNearest - nearest) / cellSize);
      const dome = 1 - 0.35 * clamp01(nearest / (cellSize * 0.7)) ** 2;
      heights[y * size + x] = groove * dome;
    }
  }
  return heights;
}

/** Pebbled-leather tangent-space normal map (OpenGL convention). Tileable. */
export function createLeatherNormalMap(maxAnisotropy = 1): CanvasTexture {
  const size = 512;
  const strength = 1.6;
  const { canvas, context } = createCanvas(size, size);
  const heights = createPebbleHeightField(size, 40, createRandom(9127));
  const image = context.createImageData(size, size);
  const wrap = (value: number): number => (value + size) % size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const slopeX = (heights[y * size + wrap(x + 1)] - heights[y * size + wrap(x - 1)]) * 0.5;
      // Canvas rows grow downward while tangent-space +Y points up, hence the sign flip on Y only.
      const slopeY = (heights[wrap(y + 1) * size + x] - heights[wrap(y - 1) * size + x]) * 0.5;
      const normalX = -slopeX * strength;
      const normalY = slopeY * strength;
      const inverseLength = 1 / Math.sqrt(normalX * normalX + normalY * normalY + 1);
      const offset = (y * size + x) * 4;
      image.data[offset] = (normalX * inverseLength * 0.5 + 0.5) * 255;
      image.data[offset + 1] = (normalY * inverseLength * 0.5 + 0.5) * 255;
      image.data[offset + 2] = (inverseLength * 0.5 + 0.5) * 255;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return toTexture(canvas, { colorSpace: NoColorSpace, repeating: true, maxAnisotropy });
}

/** Dark wine-colored club carpet with a faint diamond lattice. Tileable. */
export function createCarpetTexture(maxAnisotropy = 1): CanvasTexture {
  const size = 512;
  const { canvas, context } = createCanvas(size, size);
  const random = createRandom(2203);

  context.fillStyle = '#2b1219';
  context.fillRect(0, 0, size, size);

  const step = size / 4;
  const latticeTone = { r: 150, g: 84, b: 98 };

  context.strokeStyle = rgba(latticeTone, 0.17);
  context.lineWidth = 2;
  context.beginPath();
  for (let index = -4; index <= 8; index++) {
    context.moveTo(index * step - size, 0);
    context.lineTo(index * step + size, size * 2);
    context.moveTo(index * step + size, 0);
    context.lineTo(index * step - size, size * 2);
  }
  context.stroke();

  context.fillStyle = rgba(latticeTone, 0.2);
  const medallion = step * 0.1;
  for (let row = 0; row <= 4; row++) {
    for (let column = 0; column <= 4; column++) {
      const centerX = column * step;
      const centerY = row * step;
      context.beginPath();
      context.moveTo(centerX, centerY - medallion);
      context.lineTo(centerX + medallion, centerY);
      context.lineTo(centerX, centerY + medallion);
      context.lineTo(centerX - medallion, centerY);
      context.closePath();
      context.fill();
    }
  }

  const image = context.getImageData(0, 0, size, size);
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const grain = (random() - 0.5) * 22;
    image.data[offset] += grain;
    image.data[offset + 1] += grain * 0.7;
    image.data[offset + 2] += grain * 0.8;
  }
  context.putImageData(image, 0, 0);

  return toTexture(canvas, { colorSpace: SRGBColorSpace, repeating: true, maxAnisotropy });
}

/** Soft out-of-focus light disc with a slightly brighter rim, for additive sprites. */
export function createBokehTexture(hexColor: string): CanvasTexture {
  const size = 128;
  const { canvas, context } = createCanvas(size, size);
  const color = hexToRgb(hexColor);
  const radius = size / 2;

  const gradient = context.createRadialGradient(radius, radius, 0, radius, radius, radius);
  gradient.addColorStop(0, rgba(color, 0.5));
  gradient.addColorStop(0.72, rgba(color, 0.42));
  gradient.addColorStop(0.9, rgba(color, 0.8));
  gradient.addColorStop(1, rgba(color, 0));
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);

  return toTexture(canvas, { colorSpace: SRGBColorSpace, repeating: false, maxAnisotropy: 1 });
}
