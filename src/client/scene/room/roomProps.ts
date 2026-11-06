import { Group, Mesh, MeshStandardMaterial, type Material, type Object3D, type Texture } from 'three';
import type { CandleLights } from './candleLights';
import { GrandfatherClock } from './grandfatherClock';
import { CHANDELIER_POSITIONS, PROP_SPECS, canvasCropWindow, placeProp, type PropSpec, type RoomModelName } from './roomLayout';

/** Furniture reflects the warm room a little more than the walls do: lacquer, brass and leather catch the candles. */
const PROP_ENV_INTENSITY = 1.75;
const GLASS = { opacity: 0.18, roughness: 0.05 };
const CHANDELIER_GLASS = { opacity: 0.4, roughness: 0.08 };
const CANVAS_MESH_SUFFIX = '_canvas';
/** The cabinet's doors are modelled ajar; closed, the cabinet reads as a clean silhouette against the panelling. */
const CABINET_DOOR_PATTERN = /_door\d$/;

function materialsOf(mesh: Mesh): Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

/** Room lighting for a loaded model: the room's environment, glass that does not hide what is behind it, no shadows. */
function prepareModelMaterials(model: Object3D, environment: Texture): void {
  model.traverse((object) => {
    if (!(object instanceof Mesh)) {
      return;
    }
    object.castShadow = false;
    object.receiveShadow = false;
    for (const material of materialsOf(object)) {
      if (!(material instanceof MeshStandardMaterial)) {
        continue;
      }
      material.envMap = environment;
      material.envMapIntensity = PROP_ENV_INTENSITY;
      if (material.name.endsWith('_glass')) {
        tuneGlass(material, material.name.startsWith('Chandelier') ? CHANDELIER_GLASS : GLASS);
      } else if (material.name.endsWith('_fringe')) {
        // The fringe texture has no alpha channel, so blending only cost a sort and the depth write.
        material.transparent = false;
        material.depthWrite = true;
      }
      material.needsUpdate = true;
    }
  });
}

function tuneGlass(material: MeshStandardMaterial, settings: { opacity: number; roughness: number }): void {
  // The clock glass is mapped onto its body texture; without the map it reads as clear glass over the dial.
  material.map = null;
  material.metalnessMap = null;
  material.roughnessMap = null;
  material.color.set('#fffaf0');
  material.metalness = 0;
  material.roughness = settings.roughness;
  material.transparent = true;
  material.opacity = settings.opacity;
  material.depthWrite = false;
}

function freezeTransforms(object: Object3D): void {
  object.updateMatrixWorld(true);
  object.traverse((child) => {
    child.matrixAutoUpdate = false;
  });
}

/** Each painting shows its own crop of the canvas image; the clone keeps the decoded image shared. */
function paintCanvas(frame: Object3D, spec: PropSpec): void {
  if (!spec.canvasCrop) {
    return;
  }
  const cropWindow = canvasCropWindow(spec.canvasCrop);
  frame.traverse((object) => {
    if (!(object instanceof Mesh) || !object.name.endsWith(CANVAS_MESH_SUFFIX)) {
      return;
    }
    const source = object.material as MeshStandardMaterial;
    const material = source.clone();
    if (source.map) {
      material.map = source.map.clone();
      material.map.repeat.set(cropWindow.repeat, cropWindow.repeat);
      material.map.offset.set(cropWindow.offsetU, cropWindow.offsetV);
      material.map.needsUpdate = true;
    }
    object.material = material;
  });
}

function closeDoors(cabinet: Object3D): void {
  cabinet.traverse((object) => {
    if (CABINET_DOOR_PATTERN.test(object.name)) {
      object.quaternion.identity();
    }
  });
}

export interface RoomProps {
  /** Furniture and paintings against the walls. */
  furniture: Group;
  /** The chandeliers, to hang in the ceiling group. */
  chandeliers: Object3D[];
  clock: GrandfatherClock | null;
}

/** Places the Poly Haven furniture along the walls (see PROP_SPECS) and the chandeliers under the ceiling roses. */
export function buildRoomProps(models: Record<RoomModelName, Object3D>, environment: Texture, candles: CandleLights): RoomProps {
  Object.values(models).forEach((model) => prepareModelMaterials(model, environment));

  const furniture = new Group();
  furniture.name = 'roomFurniture';
  let clock: GrandfatherClock | null = null;
  for (const spec of PROP_SPECS) {
    const piece = models[spec.model].clone();
    const placement = placeProp(spec);
    piece.position.copy(placement.position);
    piece.rotation.y = placement.yaw;
    piece.scale.setScalar(spec.scale);
    piece.name = `prop-${spec.model}-${spec.wall}`;
    paintCanvas(piece, spec);
    if (spec.model === 'cabinet') {
      closeDoors(piece);
    }
    freezeTransforms(piece);
    if (spec.model === 'clock') {
      clock = GrandfatherClock.fromModel(piece);
    }
    furniture.add(piece);
  }

  const chandeliers = CHANDELIER_POSITIONS.map((position, index) => {
    const chandelier = models.chandelier.clone();
    chandelier.position.copy(position);
    // Turned a little apart so the two do not read as copies from the lobby orbit.
    chandelier.rotation.y = index * 0.5;
    chandelier.name = `chandelier-${index}`;
    candles.attachToChandelier(chandelier);
    freezeTransforms(chandelier);
    return chandelier;
  });

  return { furniture, chandeliers, clock };
}
