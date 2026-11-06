import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  Points,
  PointsMaterial,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  type Object3D,
} from 'three';
import { createCanvas } from '../proceduralTextures';
import { sconcePlacements } from './roomLayout';

/**
 * Candle tips of the Chandelier_03 model (model space, meters): an inner ring of 6 candles and an outer ring of 12,
 * measured on its candle meshes. The flames sit just above them.
 */
const CHANDELIER_CANDLE_TIPS: readonly (readonly [number, number, number])[] = [
  [0.107, -0.584, 0.2035],
  [-0.107, -0.584, 0.204],
  [0.228, -0.584, 0.011],
  [-0.228, -0.584, 0.001],
  [0.113, -0.584, -0.195],
  [-0.1135, -0.584, -0.195],
  [0.071, -0.661, 0.342],
  [-0.072, -0.661, 0.342],
  [0.0825, -0.661, -0.3345],
  [-0.082, -0.661, -0.3345],
  [0.241, -0.661, 0.252],
  [-0.2415, -0.661, 0.251],
  [0.2495, -0.661, -0.238],
  [-0.2495, -0.661, -0.2385],
  [0.329, -0.661, 0.112],
  [-0.3345, -0.661, 0.0965],
  [0.337, -0.661, -0.0805],
  [-0.3325, -0.661, -0.096],
];
const FLAME_ABOVE_CANDLE = 0.028;
/** Middle of the candle rings, where the chandelier's glow halo is centred (model space). */
const CHANDELIER_GLOW_CENTER_Y = -0.66;

/**
 * Flames are HDR-bright so the bloom pass (threshold 1.1) turns them into glowing points. PointsMaterial sizes are
 * multiplied by 1 / tan(fov / 2) on screen, so 0.16 draws a glow about 5.5 cm across.
 */
const FLAME_COLOR: readonly [number, number, number] = [5.2, 2.9, 1.1];
const FLAME_POINT_SIZE = 0.16;
const SCONCE_FLAME_POINT_SIZE = 0.18;

const CHANDELIER_HALO = { size: 2.1, opacity: 0.15 };
const SCONCE_HALO = { size: 0.62, opacity: 0.2 };
const HALO_COLOR = '#ffb46a';


interface Point3 {
  x: number;
  y: number;
  z: number;
}

interface FlickeringFlames {
  colors: BufferAttribute;
  phases: Float32Array;
}

interface FlickeringHalo {
  material: SpriteMaterial;
  baseOpacity: number;
  phase: number;
}

function createFlameTexture(): CanvasTexture {
  const size = 64;
  const { canvas, context } = createCanvas(size, size);
  const glow = context.createRadialGradient(size / 2, size * 0.56, 0, size / 2, size * 0.56, size / 2);
  glow.addColorStop(0, 'rgba(255, 236, 200, 0.55)');
  glow.addColorStop(0.35, 'rgba(255, 170, 80, 0.16)');
  glow.addColorStop(1, 'rgba(255, 140, 50, 0)');
  context.fillStyle = glow;
  context.fillRect(0, 0, size, size);

  // The teardrop of the flame itself, narrow and taller than wide.
  context.save();
  context.translate(size / 2, size * 0.6);
  context.scale(0.42, 1);
  const core = context.createRadialGradient(0, 0, 0, 0, 0, size * 0.3);
  core.addColorStop(0, 'rgba(255, 255, 245, 1)');
  core.addColorStop(0.45, 'rgba(255, 214, 140, 0.9)');
  core.addColorStop(1, 'rgba(255, 150, 60, 0)');
  context.fillStyle = core;
  context.beginPath();
  context.arc(0, 0, size * 0.3, 0, Math.PI * 2);
  context.fill();
  context.restore();

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function createHaloTexture(): CanvasTexture {
  const size = 128;
  const { canvas, context } = createCanvas(size, size);
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255, 210, 150, 1)');
  gradient.addColorStop(0.18, 'rgba(255, 180, 110, 0.55)');
  gradient.addColorStop(0.5, 'rgba(255, 150, 80, 0.14)');
  gradient.addColorStop(1, 'rgba(255, 140, 60, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Brightness of one flame over time: two incommensurate wobbles, so neighbouring candles never pulse together. */
function flicker(elapsedSeconds: number, phase: number): number {
  return 1 + 0.1 * Math.sin(elapsedSeconds * 8.3 + phase) + 0.06 * Math.sin(elapsedSeconds * 13.1 + phase * 2.7);
}

/**
 * Candle flames and their soft halos. The halos replace the old floating bokeh: every glow in the room now comes
 * from a candle. There are no real lights here: a point light would add a shader loop to every lit material in the
 * scene (felt and carpet included), so the candles' light on the walls and ceiling is baked (see roomGlow.ts).
 */
export class CandleLights {
  /** Wall-sconce flames and halos; the chandelier ones live inside each chandelier (see attachToChandelier). */
  readonly sconceGlow = new Group();

  private readonly flameTexture = createFlameTexture();
  private readonly haloTexture = createHaloTexture();
  private readonly flameMaterials: PointsMaterial[] = [];
  private readonly flameSets: FlickeringFlames[] = [];
  private readonly halos: FlickeringHalo[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private reducedMotion = false;

  constructor() {
    this.sconceGlow.name = 'sconceGlow';
    const sconces = sconcePlacements();
    this.sconceGlow.add(this.createFlames(sconces.map((sconce) => [sconce.flame.x, sconce.flame.y, sconce.flame.z]), SCONCE_FLAME_POINT_SIZE));
    for (const sconce of sconces) {
      this.sconceGlow.add(this.createHalo(sconce.flame, SCONCE_HALO.size, SCONCE_HALO.opacity));
    }
  }

  /** Adds the 18 candle flames and the halo to one chandelier (in its own model space). */
  attachToChandelier(chandelier: Object3D): void {
    chandelier.add(
      this.createFlames(
        CHANDELIER_CANDLE_TIPS.map(([x, y, z]) => [x, y + FLAME_ABOVE_CANDLE, z]),
        FLAME_POINT_SIZE,
      ),
    );
    chandelier.add(this.createHalo({ x: 0, y: CHANDELIER_GLOW_CENTER_Y, z: 0 }, CHANDELIER_HALO.size, CHANDELIER_HALO.opacity));
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    if (reduced) {
      this.update(0);
    }
  }

  update(elapsedSeconds: number): void {
    const time = this.reducedMotion ? 0 : elapsedSeconds;
    for (const flames of this.flameSets) {
      for (let index = 0; index < flames.phases.length; index++) {
        const brightness = this.reducedMotion ? 1 : flicker(time, flames.phases[index]);
        flames.colors.setXYZ(index, brightness, brightness, brightness);
      }
      flames.colors.needsUpdate = true;
    }
    for (const halo of this.halos) {
      halo.material.opacity = halo.baseOpacity * (this.reducedMotion ? 1 : 0.92 + 0.08 * flicker(time * 0.6, halo.phase));
    }
  }

  dispose(): void {
    this.geometries.forEach((geometry) => geometry.dispose());
    this.flameMaterials.forEach((material) => material.dispose());
    this.halos.forEach((halo) => halo.material.dispose());
    this.flameTexture.dispose();
    this.haloTexture.dispose();
  }

  private createFlames(tips: readonly (readonly [number, number, number])[], size: number): Points {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(Float32Array.from(tips.flat()), 3));
    const colors = new BufferAttribute(new Float32Array(tips.length * 3).fill(1), 3);
    geometry.setAttribute('color', colors);
    this.geometries.push(geometry);

    const material = new PointsMaterial({
      map: this.flameTexture,
      size,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    material.color.setRGB(...FLAME_COLOR);
    this.flameMaterials.push(material);

    const phases = Float32Array.from(tips, (_, index) => (index * 2.399) % (Math.PI * 2));
    this.flameSets.push({ colors, phases });

    const points = new Points(geometry, material);
    points.name = 'candleFlames';
    // Flames are tiny; a stale bounding sphere must never cull a whole chandelier's worth of them.
    points.frustumCulled = false;
    return points;
  }

  private createHalo(center: Point3, size: number, opacity: number): Sprite {
    const material = new SpriteMaterial({
      map: this.haloTexture,
      color: HALO_COLOR,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      fog: false,
      opacity,
    });
    this.halos.push({ material, baseOpacity: opacity, phase: this.halos.length * 1.7 });
    const sprite = new Sprite(material);
    sprite.position.set(center.x, center.y, center.z);
    sprite.scale.setScalar(size);
    sprite.name = 'candleHalo';
    return sprite;
  }
}
