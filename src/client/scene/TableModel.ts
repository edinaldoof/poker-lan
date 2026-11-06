import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  FileLoader,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Triangle,
  Vector3,
  type LoadingManager,
  type Material,
  type Object3D,
  type WebGLRenderer,
} from 'three';
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js';
import { createFeltTexture, feltWorldToUv, getFeltSheenColor, type FeltTheme } from './FeltTexture';
import { DEALER_TRAY_POSITION, DEALER_TRAY_SIZE, DEALER_TRAY_YAW } from './SeatLayout';
import {
  createLeatherNormalMap,
  createNoiseTexture,
  createWoodTexture,
} from './proceduralTextures';

export type { FeltTheme } from './FeltTexture';

export interface TableModelResult {
  root: Group;
  felt: Mesh;
  lamp: Object3D | null;
  /** The dealer's chip tray, standing on the felt in front of the dealer (already in table meters). */
  tray: Mesh;
  setFeltTheme(theme: FeltTheme): void;
}

export type PartRole =
  | 'felt'
  | 'feltPatch'
  | 'feltEdge'
  | 'wood'
  | 'chrome'
  | 'leather'
  | 'lampShade'
  | 'lampDiffuser';

export interface TableParts {
  /** The 3DS group, already rotated to Y-up, scaled to meters and centered on the origin. */
  root: Group;
  meshes: Record<PartRole, Mesh>;
  lamp: Group;
  /** The model's chip tray moved to the dealer's spot; unlike the other parts it is already in table meters. */
  tray: Mesh;
}

const TABLE_MODEL_URL = '/assets/table/poker_table.3ds';

/** The 3DS is authored in centimeters. */
const MODEL_UNITS_TO_METERS = 0.01;

/** 3DS object names are truncated to 10 characters; the two table meshes differ only by case. */
const SOURCE_NAMES = {
  feltSlab: 'poker_tabl',
  body: 'Poker_Tabl',
  lamp: 'Poker_Lamp',
  tray: 'chips_box',
} as const;

/**
 * Measured on the model: the dealer chip tray used to sit in a through-hole of the felt slab, where the dealer
 * now stands beside it; the tray is shown again on the felt (see createTrayPart), so the hole is patched.
 * The patch overlaps the surrounding felt by about a centimeter.
 */
const TRAY_CUTOUT = { minX: -0.257, maxX: 0.255, minZ: -0.625, maxZ: -0.325 };

/** Keeps the patch just below the felt top so it never z-fights with it. */
const FELT_PATCH_DEPTH = 0.0006;

/**
 * The lobby camera orbits at eye level; at the model's own height the shade hung across the croupier's head and
 * shoulders. Raised along the model's up axis (Z, in centimetres), its rim clears the top of his head.
 */
const LAMP_LIFT_CM = 45;

/** The lamp's bottom rim and inner light planes sit below this height (cm, model space). */
const LAMP_DIFFUSER_MAX_HEIGHT_CM = 153;

const LEATHER_TILE_SIZE_CM = 25;

const SHADOW_FLAGS: Record<PartRole, { cast: boolean; receive: boolean }> = {
  felt: { cast: false, receive: true },
  feltPatch: { cast: false, receive: true },
  feltEdge: { cast: false, receive: false },
  wood: { cast: true, receive: true },
  chrome: { cast: true, receive: true },
  leather: { cast: true, receive: true },
  // The key light sits inside the lamp: casting would shadow the whole table.
  lampShade: { cast: false, receive: false },
  lampDiffuser: { cast: false, receive: false },
};

type FaceMaterialNames = (string | null)[];

const CHUNK_MAIN = 0x4d4d;
const CHUNK_EDITOR = 0x3d3d;
const CHUNK_NAMED_OBJECT = 0x4000;
const CHUNK_TRIANGLE_MESH = 0x4100;
const CHUNK_FACE_ARRAY = 0x4120;
const CHUNK_MATERIAL_GROUP = 0x4130;
const CHUNK_HEADER_BYTES = 6;
const FACE_RECORD_BYTES = 8;

function forEachChunk(
  view: DataView,
  start: number,
  end: number,
  visit: (id: number, bodyStart: number, bodyEnd: number) => void,
): void {
  let cursor = start;
  while (cursor + CHUNK_HEADER_BYTES <= end) {
    const length = view.getUint32(cursor + 2, true);
    if (length < CHUNK_HEADER_BYTES) {
      return;
    }
    visit(view.getUint16(cursor, true), cursor + CHUNK_HEADER_BYTES, Math.min(cursor + length, end));
    cursor += length;
  }
}

function readCString(view: DataView, offset: number): { text: string; next: number } {
  let cursor = offset;
  let text = '';
  while (cursor < view.byteLength && view.getUint8(cursor) !== 0) {
    text += String.fromCharCode(view.getUint8(cursor));
    cursor++;
  }
  return { text, next: cursor + 1 };
}

/**
 * Material name of every face, per object, straight from the file. TDSLoader builds its geometry groups assuming
 * each material owns a contiguous run of faces, which is false for this model (the felt and the rail would end up
 * with the wrong materials), so the groups it produces cannot be trusted.
 */
export function readFaceMaterialNames(buffer: ArrayBuffer): Map<string, FaceMaterialNames> {
  const view = new DataView(buffer);
  const result = new Map<string, FaceMaterialNames>();
  let objectName = '';

  const visitChunk = (id: number, bodyStart: number, bodyEnd: number): void => {
    switch (id) {
      case CHUNK_MAIN:
      case CHUNK_EDITOR:
      case CHUNK_TRIANGLE_MESH:
        forEachChunk(view, bodyStart, bodyEnd, visitChunk);
        break;
      case CHUNK_NAMED_OBJECT: {
        const name = readCString(view, bodyStart);
        objectName = name.text;
        forEachChunk(view, name.next, bodyEnd, visitChunk);
        break;
      }
      case CHUNK_FACE_ARRAY: {
        const faceCount = view.getUint16(bodyStart, true);
        const names: FaceMaterialNames = new Array<string | null>(faceCount).fill(null);
        forEachChunk(view, bodyStart + 2 + faceCount * FACE_RECORD_BYTES, bodyEnd, (subId, subStart) => {
          if (subId !== CHUNK_MATERIAL_GROUP) {
            return;
          }
          const material = readCString(view, subStart);
          const groupFaceCount = view.getUint16(material.next, true);
          for (let entry = 0; entry < groupFaceCount; entry++) {
            names[view.getUint16(material.next + 2 + entry * 2, true)] = material.text;
          }
        });
        result.set(objectName, names);
        break;
      }
      default:
        break;
    }
  };

  forEachChunk(view, 0, buffer.byteLength, visitChunk);
  return result;
}

function findSourceMesh(loaded: Group, name: string): Mesh {
  const mesh = loaded.children.find((child): child is Mesh => child instanceof Mesh && child.name === name);
  if (!mesh) {
    throw new Error(`Modelo da mesa inválido: malha "${name}" não encontrada.`);
  }
  return mesh;
}

/** Z-up centimeters -> Y-up meters, with the table centered on the origin in X/Z. */
function placeModelRoot(loaded: Group, body: Mesh): void {
  loaded.rotation.x = -Math.PI / 2;
  loaded.scale.setScalar(MODEL_UNITS_TO_METERS);
  loaded.updateMatrixWorld(true);

  const center = new Box3().setFromObject(body).getCenter(new Vector3());
  loaded.position.x -= center.x;
  loaded.position.z -= center.z;
  loaded.updateMatrix();
  loaded.updateMatrixWorld(true);
}

/** Moves the mesh's own placement into its vertices so every part shares the root's coordinate frame. */
function bakeMeshTransform(mesh: Mesh): void {
  mesh.updateMatrix();
  mesh.geometry.applyMatrix4(mesh.matrix);
  mesh.position.set(0, 0, 0);
  mesh.quaternion.identity();
  mesh.scale.set(1, 1, 1);
  mesh.updateMatrix();
}

interface FaceGeometry {
  normal: Vector3;
  center: Vector3;
}

function describeFace(geometry: BufferGeometry, face: number, triangle: Triangle): FaceGeometry {
  const index = geometry.getIndex();
  const position = geometry.getAttribute('position');
  if (!index) {
    throw new Error('Modelo da mesa inválido: geometria sem índices.');
  }
  triangle.a.fromBufferAttribute(position, index.getX(face * 3));
  triangle.b.fromBufferAttribute(position, index.getX(face * 3 + 1));
  triangle.c.fromBufferAttribute(position, index.getX(face * 3 + 2));
  return {
    normal: triangle.getNormal(new Vector3()),
    center: triangle.getMidpoint(new Vector3()),
  };
}

function groupFacesByRole(
  source: Mesh,
  roleOfFace: (face: number, description: () => FaceGeometry) => PartRole,
): Map<PartRole, number[]> {
  const index = source.geometry.getIndex();
  if (!index) {
    throw new Error(`Modelo da mesa inválido: "${source.name}" sem índices.`);
  }
  const triangle = new Triangle();
  const faceCount = index.count / 3;
  const facesByRole = new Map<PartRole, number[]>();

  for (let face = 0; face < faceCount; face++) {
    const role = roleOfFace(face, () => describeFace(source.geometry, face, triangle));
    const faces = facesByRole.get(role);
    if (faces) {
      faces.push(face);
    } else {
      facesByRole.set(role, [face]);
    }
  }
  return facesByRole;
}

function requireFaces(facesByRole: Map<PartRole, number[]>, role: PartRole, sourceName: string): number[] {
  const faces = facesByRole.get(role);
  if (!faces || faces.length === 0) {
    throw new Error(`Modelo da mesa inválido: "${sourceName}" não tem faces para "${role}".`);
  }
  return faces;
}

function requireFaceMaterials(faceMaterials: Map<string, FaceMaterialNames>, source: Mesh): FaceMaterialNames {
  const names = faceMaterials.get(source.name);
  const faceCount = (source.geometry.getIndex()?.count ?? 0) / 3;
  if (!names || names.length !== faceCount) {
    throw new Error(`Modelo da mesa inválido: materiais por face de "${source.name}" não conferem.`);
  }
  return names;
}

/** A part that reuses the source vertex buffers and only owns its own index list. */
function createIndexedPart(source: Mesh, faces: number[], name: string): Mesh {
  const sourceIndex = source.geometry.getIndex();
  if (!sourceIndex) {
    throw new Error(`Modelo da mesa inválido: "${source.name}" sem índices.`);
  }
  const indices = new Uint32Array(faces.length * 3);
  faces.forEach((face, slot) => {
    for (let corner = 0; corner < 3; corner++) {
      indices[slot * 3 + corner] = sourceIndex.getX(face * 3 + corner);
    }
  });

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', source.geometry.getAttribute('position'));
  geometry.setAttribute('normal', source.geometry.getAttribute('normal'));
  geometry.setAttribute('uv', source.geometry.getAttribute('uv'));
  geometry.setIndex(new BufferAttribute(indices, 1));

  const mesh = new Mesh(geometry);
  mesh.name = name;
  return mesh;
}

/**
 * The rail's own UVs are collapsed to a point, so its pebbled-leather normal map needs fresh ones:
 * each face is projected along its dominant axis, which keeps the grain evenly sized without seams that show.
 */
function createBoxMappedPart(source: Mesh, faces: number[], tileSizeCm: number, name: string): Mesh {
  const sourceIndex = source.geometry.getIndex();
  const sourcePosition = source.geometry.getAttribute('position');
  const sourceNormal = source.geometry.getAttribute('normal');
  if (!sourceIndex) {
    throw new Error(`Modelo da mesa inválido: "${source.name}" sem índices.`);
  }

  const positions = new Float32Array(faces.length * 9);
  const normals = new Float32Array(faces.length * 9);
  const uvs = new Float32Array(faces.length * 6);
  const triangle = new Triangle();
  const faceNormal = new Vector3();
  const vertex = new Vector3();

  faces.forEach((face, slot) => {
    const corners = [0, 1, 2].map((corner) => sourceIndex.getX(face * 3 + corner));
    triangle.a.fromBufferAttribute(sourcePosition, corners[0]);
    triangle.b.fromBufferAttribute(sourcePosition, corners[1]);
    triangle.c.fromBufferAttribute(sourcePosition, corners[2]);
    triangle.getNormal(faceNormal);

    const absX = Math.abs(faceNormal.x);
    const absY = Math.abs(faceNormal.y);
    const absZ = Math.abs(faceNormal.z);

    corners.forEach((sourceVertex, corner) => {
      vertex.fromBufferAttribute(sourcePosition, sourceVertex);
      const target = slot * 3 + corner;
      positions.set([vertex.x, vertex.y, vertex.z], target * 3);
      normals.set(
        [sourceNormal.getX(sourceVertex), sourceNormal.getY(sourceVertex), sourceNormal.getZ(sourceVertex)],
        target * 3,
      );

      let u = vertex.x;
      let v = vertex.y;
      if (absX >= absY && absX >= absZ) {
        u = vertex.y;
        v = vertex.z;
      } else if (absY >= absZ) {
        u = vertex.x;
        v = vertex.z;
      }
      uvs.set([u / tileSizeCm, v / tileSizeCm], target * 2);
    });
  });

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));

  const mesh = new Mesh(geometry);
  mesh.name = name;
  return mesh;
}

/** The felt top is flat: straight-up normals and UVs that match the felt canvas (see FELT_CANVAS_BOUNDS). */
function createFeltTopPart(source: Mesh, faces: number[], root: Group): { mesh: Mesh; topY: number } {
  const part = createIndexedPart(source, faces, 'felt');
  const position = part.geometry.getAttribute('position');
  const normals = new Float32Array(position.count * 3);
  const uvs = new Float32Array(position.count * 2);
  const world = new Vector3();
  let topY = -Infinity;

  for (let vertex = 0; vertex < position.count; vertex++) {
    world.fromBufferAttribute(position, vertex).applyMatrix4(root.matrix);
    const { u, v } = feltWorldToUv(world.x, world.z);
    normals[vertex * 3 + 2] = 1;
    uvs[vertex * 2] = u;
    uvs[vertex * 2 + 1] = v;
    topY = Math.max(topY, world.y);
  }

  part.geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  part.geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  return { mesh: part, topY };
}

/** Flat felt quad over the chip-tray hole, expressed in the root's local (centimeter, Z-up) frame. */
function createFeltPatchPart(root: Group, topY: number): Mesh {
  const inverseRoot = root.matrix.clone().invert();
  const { minX, maxX, minZ, maxZ } = TRAY_CUTOUT;
  const worldCorners = [
    new Vector3(minX, topY - FELT_PATCH_DEPTH, maxZ),
    new Vector3(maxX, topY - FELT_PATCH_DEPTH, maxZ),
    new Vector3(maxX, topY - FELT_PATCH_DEPTH, minZ),
    new Vector3(minX, topY - FELT_PATCH_DEPTH, minZ),
  ];

  const positions = new Float32Array(12);
  const normals = new Float32Array(12);
  const uvs = new Float32Array(8);
  worldCorners.forEach((corner, index) => {
    const { u, v } = feltWorldToUv(corner.x, corner.z);
    corner.applyMatrix4(inverseRoot);
    positions.set([corner.x, corner.y, corner.z], index * 3);
    normals.set([0, 0, 1], index * 3);
    uvs.set([u, v], index * 2);
  });

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);

  const mesh = new Mesh(geometry);
  mesh.name = 'feltPatch';
  return mesh;
}

/**
 * The chip tray, resized to DEALER_TRAY_SIZE and standing on the felt at the dealer's spot. The source geometry is
 * in the root's centimeter Z-up frame, so it is moved into table meters first and then centred on its footprint
 * with its base at y = 0.
 */
function createTrayPart(source: Mesh, root: Group): Mesh {
  const geometry = source.geometry.clone();
  geometry.applyMatrix4(root.matrix);
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds) {
    throw new Error('Modelo da mesa inválido: a bandeja de fichas não tem geometria.');
  }
  const center = bounds.getCenter(new Vector3());
  const size = bounds.getSize(new Vector3());
  geometry.translate(-center.x, -bounds.min.y, -center.z);
  const scale = Math.min(DEALER_TRAY_SIZE.width / size.x, DEALER_TRAY_SIZE.depth / size.z);
  geometry.scale(scale, scale, scale);

  const mesh = new Mesh(geometry);
  mesh.name = 'dealerTray';
  mesh.position.copy(DEALER_TRAY_POSITION);
  mesh.rotation.y = DEALER_TRAY_YAW;
  return mesh;
}

/**
 * Splits the parsed 3DS into one mesh per material role, applies the root transform and repairs the model:
 * correct per-face materials, UVs for the felt and the rail, a felt patch over the chip-tray hole, and a lit
 * diffuser carved from the lamp. Needs no DOM, so it can be checked from Node.
 */
export function prepareTableParts(loaded: Group, faceMaterials: Map<string, FaceMaterialNames>): TableParts {
  const feltSlab = findSourceMesh(loaded, SOURCE_NAMES.feltSlab);
  const body = findSourceMesh(loaded, SOURCE_NAMES.body);
  const lampSource = findSourceMesh(loaded, SOURCE_NAMES.lamp);
  const traySource = findSourceMesh(loaded, SOURCE_NAMES.tray);
  const feltNames = requireFaceMaterials(faceMaterials, feltSlab);
  const bodyNames = requireFaceMaterials(faceMaterials, body);
  requireFaceMaterials(faceMaterials, lampSource);

  placeModelRoot(loaded, body);
  [feltSlab, body, lampSource, traySource].forEach(bakeMeshTransform);

  const feltFaces = groupFacesByRole(feltSlab, (face) => (feltNames[face] === 'table' ? 'felt' : 'feltEdge'));
  const bodyFaces = groupFacesByRole(body, (face) => {
    switch (bodyNames[face]) {
      case 'PT_Wood':
        return 'wood';
      case 'leather_black':
        return 'leather';
      default:
        return 'chrome';
    }
  });
  const lampFaces = groupFacesByRole(lampSource, (_face, describe) => {
    const { normal, center } = describe();
    return normal.z < -0.7 && center.z < LAMP_DIFFUSER_MAX_HEIGHT_CM ? 'lampDiffuser' : 'lampShade';
  });

  const feltTop = createFeltTopPart(feltSlab, requireFaces(feltFaces, 'felt', feltSlab.name), loaded);
  const lamp = new Group();
  lamp.name = lampSource.name;

  const meshes: Record<PartRole, Mesh> = {
    felt: feltTop.mesh,
    feltPatch: createFeltPatchPart(loaded, feltTop.topY),
    feltEdge: createIndexedPart(feltSlab, requireFaces(feltFaces, 'feltEdge', feltSlab.name), 'feltEdge'),
    wood: createIndexedPart(body, requireFaces(bodyFaces, 'wood', body.name), 'wood'),
    chrome: createIndexedPart(body, requireFaces(bodyFaces, 'chrome', body.name), 'chrome'),
    leather: createBoxMappedPart(body, requireFaces(bodyFaces, 'leather', body.name), LEATHER_TILE_SIZE_CM, 'leather'),
    lampShade: createIndexedPart(lampSource, requireFaces(lampFaces, 'lampShade', lampSource.name), 'lampShade'),
    lampDiffuser: createIndexedPart(lampSource, requireFaces(lampFaces, 'lampDiffuser', lampSource.name), 'lampDiffuser'),
  };

  const tray = createTrayPart(traySource, loaded);

  // The tray is rebuilt as its own part in table meters, so the cm-scaled source meshes are dropped.
  loaded.clear();
  lamp.add(meshes.lampShade, meshes.lampDiffuser);
  lamp.position.z = LAMP_LIFT_CM;
  loaded.add(
    meshes.felt,
    meshes.feltPatch,
    meshes.feltEdge,
    meshes.wood,
    meshes.chrome,
    meshes.leather,
    lamp,
  );
  loaded.updateMatrixWorld(true);

  return { root: loaded, meshes, lamp, tray };
}

/** Parses the 3DS bytes and repairs the model; DOM-free (see prepareTableParts). */
export function parseTableModel(buffer: ArrayBuffer, manager?: LoadingManager): TableParts {
  const loaded = new TDSLoader(manager).parse(buffer, '');
  return prepareTableParts(loaded, readFaceMaterialNames(buffer));
}

interface TableMaterials {
  tray: MeshStandardMaterial;
  felt: MeshPhysicalMaterial;
  feltEdge: MeshStandardMaterial;
  wood: MeshPhysicalMaterial;
  chrome: MeshStandardMaterial;
  leather: MeshPhysicalMaterial;
  lampShade: MeshStandardMaterial;
  lampDiffuser: MeshStandardMaterial;
}

function createTableMaterials(maxAnisotropy: number): TableMaterials {
  const feltNoise = createNoiseTexture(maxAnisotropy);
  feltNoise.repeat.set(36, 18);

  return {
    tray: new MeshStandardMaterial({ color: '#23262b', roughness: 0.46, metalness: 0.2 }),
    felt: new MeshPhysicalMaterial({
      roughness: 0.92,
      metalness: 0,
      sheen: 1,
      sheenRoughness: 0.75,
      bumpMap: feltNoise,
      bumpScale: 0.5,
    }),
    feltEdge: new MeshStandardMaterial({ color: '#25272b', roughness: 0.55, metalness: 0.1 }),
    wood: new MeshPhysicalMaterial({
      map: createWoodTexture(maxAnisotropy),
      roughness: 0.4,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.12,
    }),
    chrome: new MeshStandardMaterial({ color: '#e6e8ee', metalness: 1, roughness: 0.15 }),
    leather: new MeshPhysicalMaterial({
      color: '#16110e',
      roughness: 0.55,
      metalness: 0,
      normalMap: createLeatherNormalMap(maxAnisotropy),
      clearcoat: 0.3,
      clearcoatRoughness: 0.45,
    }),
    // Transparent from the start (opacity 1) so Stage can fade the lamp without a shader recompile.
    lampShade: new MeshStandardMaterial({
      color: '#202226',
      roughness: 0.38,
      metalness: 0.55,
      side: DoubleSide,
      transparent: true,
    }),
    lampDiffuser: new MeshStandardMaterial({
      color: '#1c1208',
      emissive: '#ffcf8a',
      emissiveIntensity: 1.6,
      roughness: 0.5,
      side: DoubleSide,
      transparent: true,
    }),
  };
}

function applyMaterials(parts: TableParts, materials: TableMaterials): void {
  const materialByRole: Record<PartRole, Material> = {
    felt: materials.felt,
    feltPatch: materials.felt,
    feltEdge: materials.feltEdge,
    wood: materials.wood,
    chrome: materials.chrome,
    leather: materials.leather,
    lampShade: materials.lampShade,
    lampDiffuser: materials.lampDiffuser,
  };

  for (const [role, mesh] of Object.entries(parts.meshes) as [PartRole, Mesh][]) {
    mesh.material = materialByRole[role];
    mesh.castShadow = SHADOW_FLAGS[role].cast;
    mesh.receiveShadow = SHADOW_FLAGS[role].receive;
  }
  materials.leather.normalScale.set(0.35, 0.35);

  parts.tray.material = materials.tray;
  parts.tray.castShadow = true;
  parts.tray.receiveShadow = true;
}

function createFeltThemeSwitcher(
  material: MeshPhysicalMaterial,
  maxAnisotropy: number,
): (theme: FeltTheme) => void {
  let current: { theme: FeltTheme; texture: CanvasTexture } | null = null;

  return (theme) => {
    if (current?.theme === theme) {
      return;
    }
    const previous = current;
    current = { theme, texture: createFeltTexture(theme, maxAnisotropy) };
    material.map = current.texture;
    material.sheenColor = new Color(getFeltSheenColor(theme));
    material.needsUpdate = true;
    previous?.texture.dispose();
  };
}

export function assembleTableModel(parts: TableParts, maxAnisotropy: number): TableModelResult {
  const materials = createTableMaterials(maxAnisotropy);
  applyMaterials(parts, materials);

  const setFeltTheme = createFeltThemeSwitcher(materials.felt, maxAnisotropy);
  setFeltTheme('emerald');

  // The tray is positioned in table meters, so it cannot live inside the centimeter-scaled model root.
  const root = new Group();
  root.name = 'table';
  root.add(parts.root, parts.tray);
  return { root, felt: parts.meshes.felt, lamp: parts.lamp, tray: parts.tray, setFeltTheme };
}

async function loadModelBytes(manager: LoadingManager): Promise<ArrayBuffer> {
  const loader = new FileLoader(manager);
  loader.setResponseType('arraybuffer');
  const bytes: unknown = await loader.loadAsync(TABLE_MODEL_URL);
  if (!(bytes instanceof ArrayBuffer)) {
    throw new Error('Falha ao baixar o modelo da mesa.');
  }
  return bytes;
}

export async function loadTableModel(manager: LoadingManager, renderer: WebGLRenderer): Promise<TableModelResult> {
  const bytes = await loadModelBytes(manager);
  const parts = parseTableModel(bytes, manager);
  return assembleTableModel(parts, renderer.capabilities.getMaxAnisotropy());
}
