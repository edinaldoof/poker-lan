import { Mesh, Points, Sprite, type BufferGeometry, type Material, type Object3D, type Texture } from 'three';

const TEXTURE_SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
  'alphaMap',
  'bumpMap',
  'lightMap',
] as const;

function texturesOf(material: Material): Texture[] {
  const slots = material as unknown as Partial<Record<(typeof TEXTURE_SLOTS)[number], Texture | null>>;
  return TEXTURE_SLOTS.map((slot) => slots[slot]).filter((texture): texture is Texture => Boolean(texture));
}

export interface TreeResources {
  geometries: Set<BufferGeometry>;
  materials: Set<Material>;
  textures: Set<Texture>;
}

/** Every geometry, material and texture under `root`, each once although clones share them. */
export function collectResources(root: Object3D): TreeResources {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  root.traverse((object) => {
    if (object instanceof Mesh || object instanceof Points || object instanceof Sprite) {
      geometries.add(object.geometry);
      const objectMaterials: Material[] = Array.isArray(object.material) ? object.material : [object.material];
      objectMaterials.forEach((material) => materials.add(material));
    }
  });
  const textures = new Set<Texture>();
  materials.forEach((material) => texturesOf(material).forEach((texture) => textures.add(texture)));
  return { geometries, materials, textures };
}

/**
 * Releases every geometry, material and texture under `root`. The shared environment map is not a material slot
 * here and is kept.
 */
export function disposeTree(root: Object3D): void {
  const { geometries, materials, textures } = collectResources(root);
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
}
