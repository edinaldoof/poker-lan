import {
  FloatType,
  PMREMGenerator,
  RepeatWrapping,
  SRGBColorSpace,
  TextureLoader,
  type Group,
  type LoadingManager,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import type { RoomModelName } from './roomLayout';

/** Poly Haven CC0 assets, prepared for the web (see docs/ASSETS.md). */
const ROOM_ASSET_ROOT = '/assets/room';

const MODEL_URLS: Readonly<Record<RoomModelName, string>> = {
  chair: `${ROOM_ASSET_ROOT}/models/dining_chair_02/dining_chair_02_1k.gltf`,
  chandelier: `${ROOM_ASSET_ROOT}/models/Chandelier_03/Chandelier_03_1k.gltf`,
  cabinet: `${ROOM_ASSET_ROOT}/models/GothicCabinet_01/GothicCabinet_01_1k.gltf`,
  sofa: `${ROOM_ASSET_ROOT}/models/sofa_03/sofa_03_1k.gltf`,
  clock: `${ROOM_ASSET_ROOT}/models/vintage_grandfather_clock_01/vintage_grandfather_clock_01_1k.gltf`,
  pictureFrame: `${ROOM_ASSET_ROOT}/models/fancy_picture_frame_01/fancy_picture_frame_01_1k.gltf`,
  console: `${ROOM_ASSET_ROOT}/models/ClassicConsole_01/ClassicConsole_01_1k.gltf`,
};

const ENVIRONMENT_URL = `${ROOM_ASSET_ROOT}/hdri/warm_bar_1k.hdr`;

/**
 * Three quarters of the warm bar's light comes from a few bare bulbs (up to ~2750 against a median of 0.05). Mirrored
 * in the chrome and brass they bloomed into glowing rings, so texels are capped at this luminance (keeping their hue)
 * before prefiltering; the intensities in Stage and in the room materials are tuned for the capped map.
 */
export const ENVIRONMENT_LUMINANCE_CAP = 3;

/** Scales every RGBA texel brighter than `cap` down to it, keeping its colour. */
export function capHighlights(data: Float32Array, cap: number): void {
  for (let offset = 0; offset < data.length; offset += 4) {
    const luminance = 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
    if (luminance > cap) {
      const scale = cap / luminance;
      data[offset] *= scale;
      data[offset + 1] *= scale;
      data[offset + 2] *= scale;
    }
  }
}

const SURFACE_TEXTURE_URLS = {
  woodColor: `${ROOM_ASSET_ROOT}/textures/dark_wood/dark_wood_diff_1k.jpg`,
  woodNormal: `${ROOM_ASSET_ROOT}/textures/dark_wood/dark_wood_nor_gl_512.jpg`,
  woodArm: `${ROOM_ASSET_ROOT}/textures/dark_wood/dark_wood_arm_512.jpg`,
  floorColor: `${ROOM_ASSET_ROOT}/textures/dark_wood/dark_wood_planks_diff_1k.jpg`,
  wallpaperColor: `${ROOM_ASSET_ROOT}/textures/quatrefoil_jacquard_fabric/quatrefoil_jacquard_fabric_damask_diff_512.jpg`,
  wallpaperArm: `${ROOM_ASSET_ROOT}/textures/quatrefoil_jacquard_fabric/quatrefoil_jacquard_fabric_arm_512.jpg`,
} as const;

export type SurfaceTextureName = keyof typeof SURFACE_TEXTURE_URLS;

const COLOR_SURFACES: ReadonlySet<SurfaceTextureName> = new Set(['woodColor', 'floorColor', 'wallpaperColor']);

export interface RoomAssets {
  models: Record<RoomModelName, Group>;
  surfaces: Record<SurfaceTextureName, Texture>;
  /** The warm bar HDR, prefiltered once for image-based lighting. */
  environment: WebGLRenderTarget;
}

async function loadModels(manager: LoadingManager): Promise<Record<RoomModelName, Group>> {
  const loader = new GLTFLoader(manager);
  const entries = await Promise.all(
    (Object.entries(MODEL_URLS) as [RoomModelName, string][]).map(
      async ([name, url]) => [name, (await loader.loadAsync(url)).scene] as const,
    ),
  );
  return Object.fromEntries(entries) as Record<RoomModelName, Group>;
}

async function loadSurfaces(manager: LoadingManager, maxAnisotropy: number): Promise<Record<SurfaceTextureName, Texture>> {
  const loader = new TextureLoader(manager);
  const entries = await Promise.all(
    (Object.entries(SURFACE_TEXTURE_URLS) as [SurfaceTextureName, string][]).map(async ([name, url]) => {
      const texture = await loader.loadAsync(url);
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      texture.anisotropy = maxAnisotropy;
      if (COLOR_SURFACES.has(name)) {
        texture.colorSpace = SRGBColorSpace;
      }
      return [name, texture] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<SurfaceTextureName, Texture>;
}

async function loadEnvironment(manager: LoadingManager, renderer: WebGLRenderer): Promise<WebGLRenderTarget> {
  const equirect = await new RGBELoader(manager).setDataType(FloatType).loadAsync(ENVIRONMENT_URL);
  const texels = equirect.image.data;
  if (texels instanceof Float32Array) {
    capHighlights(texels, ENVIRONMENT_LUMINANCE_CAP);
    equirect.needsUpdate = true;
  }
  const generator = new PMREMGenerator(renderer);
  try {
    return generator.fromEquirectangular(equirect);
  } finally {
    // Only the prefiltered cube is sampled; the source panorama and the generator's shaders can go.
    equirect.dispose();
    generator.dispose();
  }
}

export async function loadRoomAssets(manager: LoadingManager, renderer: WebGLRenderer): Promise<RoomAssets> {
  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
  const [models, surfaces, environment] = await Promise.all([
    loadModels(manager),
    loadSurfaces(manager, maxAnisotropy),
    loadEnvironment(manager, renderer),
  ]);
  return { models, surfaces, environment };
}
