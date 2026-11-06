import {
  BufferAttribute,
  DataTexture,
  FrontSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  RGBAFormat,
  Vector3,
  type BufferGeometry,
  type Object3D,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { chairOpacityForCamera, isSolidOpacity, settleChairOpacity } from './chairFade';
import { chairPlacements, type ChairPlacement } from './roomLayout';

/** Chairs never cast into the key light's shadow map; a soft contact shadow under each one grounds it instead. */
const CONTACT_SHADOW = { width: 0.66, depth: 0.78, opacity: 0.62, lift: 0.004, textureSize: 64 };
/** Alpha of the contact shadow from its centre (0) to its rim (1). */
const CONTACT_SHADOW_FALLOFF: readonly (readonly [number, number])[] = [
  [0, 0.85],
  [0.45, 0.55],
  [1, 0],
];
const CHAIR_ENV_INTENSITY = 1.75;
const VERTICES_PER_SHADOW = 4;

interface ChairInstance {
  placement: ChairPlacement;
  matrix: Matrix4;
  /** Drawn only while the chair is part-way faded; transparent from the start, so fading never compiles a shader. */
  fadeMesh: Mesh<BufferGeometry, MeshStandardMaterial>;
  opacity: number;
}

function falloffAlpha(radius: number): number {
  for (let index = 1; index < CONTACT_SHADOW_FALLOFF.length; index++) {
    const [outerRadius, outerAlpha] = CONTACT_SHADOW_FALLOFF[index];
    if (radius <= outerRadius) {
      const [innerRadius, innerAlpha] = CONTACT_SHADOW_FALLOFF[index - 1];
      return innerAlpha + ((radius - innerRadius) / (outerRadius - innerRadius)) * (outerAlpha - innerAlpha);
    }
  }
  return 0;
}

/** A radial alpha blob; the material colours it black. */
function createContactShadowTexture(): DataTexture {
  const size = CONTACT_SHADOW.textureSize;
  const texels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const radius = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      texels[(y * size + x) * 4 + 3] = Math.round(255 * falloffAlpha(radius));
    }
  }
  const texture = new DataTexture(texels, size, size, RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

function findFirstMesh(model: Object3D): Mesh {
  const meshes: Mesh[] = [];
  model.traverse((object) => {
    if (object instanceof Mesh) {
      meshes.push(object);
    }
  });
  if (meshes.length === 0) {
    throw new Error('Sala: o modelo da cadeira não tem malha.');
  }
  return meshes[0];
}

function placementMatrix(placement: ChairPlacement): Matrix4 {
  const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), placement.yaw);
  return new Matrix4().compose(placement.position, rotation, new Vector3(1, 1, 1));
}

/** One floor quad per chair in a single mesh; each quad's vertex alpha follows its chair's opacity. */
function createContactShadows(placements: readonly ChairPlacement[], texture: Texture): Mesh<BufferGeometry, MeshBasicMaterial> {
  const quads = placements.map((placement) =>
    new PlaneGeometry(CONTACT_SHADOW.width, CONTACT_SHADOW.depth)
      .rotateX(-Math.PI / 2)
      .rotateY(placement.yaw)
      .translate(placement.position.x, CONTACT_SHADOW.lift, placement.position.z),
  );
  const geometry = mergeGeometries(quads, false);
  quads.forEach((quad) => quad.dispose());
  if (!geometry) {
    throw new Error('Sala: as sombras das cadeiras não puderam ser combinadas.');
  }
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 4).fill(1), 4));

  const material = new MeshBasicMaterial({
    map: texture,
    color: '#000000',
    vertexColors: true,
    transparent: true,
    opacity: CONTACT_SHADOW.opacity,
    depthWrite: false,
  });
  const shadows = new Mesh(geometry, material);
  shadows.name = 'chairShadows';
  return shadows;
}

/**
 * One leather dining chair per seat slot, pulled back from the rail and facing the table. Every fully drawn chair
 * is one instance of a single draw; a chair fading out in front of the game camera is drawn by its own transparent
 * mesh instead. Those meshes are part of the scene from the start (hidden), so the scene's shader pre-compilation
 * covers them and the lobby-to-game flight never stalls on a compile.
 */
export class RoomChairs {
  readonly group = new Group();

  private readonly chairs: ChairInstance[];
  private readonly geometry: BufferGeometry;
  private readonly solidMaterial: MeshStandardMaterial;
  private readonly solidChairs: InstancedMesh;
  private readonly shadowTexture = createContactShadowTexture();
  private readonly shadows: Mesh<BufferGeometry, MeshBasicMaterial>;

  constructor(model: Object3D, environment: Texture) {
    const source = findFirstMesh(model);
    if (!(source.material instanceof MeshStandardMaterial)) {
      throw new Error('Sala: material inesperado na cadeira.');
    }
    this.geometry = source.geometry;
    this.solidMaterial = source.material;
    this.solidMaterial.envMap = environment;
    this.solidMaterial.envMapIntensity = CHAIR_ENV_INTENSITY;
    // The model is closed: its back faces never show, and culling them saves a third of the chairs' raster work.
    this.solidMaterial.side = FrontSide;
    this.group.name = 'roomChairs';

    const placements = chairPlacements();
    this.chairs = placements.map((placement) => this.createChair(placement));

    this.solidChairs = new InstancedMesh(this.geometry, this.solidMaterial, this.chairs.length);
    this.solidChairs.name = 'solidChairs';
    // The table's shadow falls across the legs and seat fronts nearest the rail.
    this.solidChairs.receiveShadow = true;
    this.packSolidChairs();

    this.shadows = createContactShadows(placements, this.shadowTexture);
    this.group.add(this.solidChairs, this.shadows, ...this.chairs.map((chair) => chair.fadeMesh));
  }

  /** Fades the chairs that would stand between the camera and the viewer's side of the table. */
  update(cameraPosition: Vector3): void {
    let solidSetChanged = false;
    this.chairs.forEach((chair, index) => {
      const opacity = settleChairOpacity(chairOpacityForCamera(chair.placement.outward, cameraPosition));
      if (opacity === chair.opacity) {
        return;
      }
      solidSetChanged ||= isSolidOpacity(opacity) !== isSolidOpacity(chair.opacity);
      chair.opacity = opacity;
      chair.fadeMesh.material.opacity = opacity;
      chair.fadeMesh.visible = opacity > 0 && !isSolidOpacity(opacity);
      this.setShadowOpacity(index, opacity);
    });
    if (solidSetChanged) {
      this.packSolidChairs();
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.solidMaterial.dispose();
    this.solidChairs.dispose();
    for (const chair of this.chairs) {
      chair.fadeMesh.material.dispose();
    }
    this.shadows.geometry.dispose();
    this.shadows.material.dispose();
    this.shadowTexture.dispose();
  }

  private createChair(placement: ChairPlacement): ChairInstance {
    const fadeMaterial = this.solidMaterial.clone();
    fadeMaterial.transparent = true;
    const fadeMesh = new Mesh(this.geometry, fadeMaterial);
    fadeMesh.name = `chairFading-${placement.slot}`;
    fadeMesh.position.copy(placement.position);
    fadeMesh.rotation.y = placement.yaw;
    fadeMesh.receiveShadow = true;
    fadeMesh.visible = false;
    return { placement, matrix: placementMatrix(placement), fadeMesh, opacity: 1 };
  }

  /** The instanced draw holds exactly the chairs at full opacity. */
  private packSolidChairs(): void {
    let count = 0;
    for (const chair of this.chairs) {
      if (isSolidOpacity(chair.opacity)) {
        this.solidChairs.setMatrixAt(count++, chair.matrix);
      }
    }
    this.solidChairs.count = count;
    this.solidChairs.visible = count > 0;
    this.solidChairs.instanceMatrix.needsUpdate = true;
    this.solidChairs.computeBoundingSphere();
  }

  private setShadowOpacity(chairIndex: number, opacity: number): void {
    const colors = this.shadows.geometry.getAttribute('color') as BufferAttribute;
    const first = chairIndex * VERTICES_PER_SHADOW;
    for (let vertex = first; vertex < first + VERTICES_PER_SHADOW; vertex++) {
      colors.setW(vertex, opacity);
    }
    colors.needsUpdate = true;
  }
}
