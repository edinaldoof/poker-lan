import { Box3, CylinderGeometry, Mesh, MeshStandardMaterial, Vector3, type BufferGeometry, type Object3D } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CEILING_HEIGHT } from './roomLayout';

/** Vertices this close to the top of the lamp are the cable ends. */
const CABLE_TOP_TOLERANCE = 0.006;
/** Cable ends closer than this belong to the same cable. */
const CABLE_CLUSTER_RADIUS = 0.04;
const DROP_ROD_RADIUS = 0.0035;
const CANOPY = { radius: 0.032, height: 0.03 };

/** World positions of the cable ends at the top of the lamp, one per cable. */
function findCableTops(lamp: Object3D): Vector3[] {
  lamp.updateWorldMatrix(true, true);
  const top = new Box3().setFromObject(lamp).max.y;
  const ends: Vector3[] = [];
  const vertex = new Vector3();
  lamp.traverse((object) => {
    if (!(object instanceof Mesh)) {
      return;
    }
    const position = object.geometry.getAttribute('position');
    for (let index = 0; index < position.count; index++) {
      vertex.fromBufferAttribute(position, index).applyMatrix4(object.matrixWorld);
      if (vertex.y >= top - CABLE_TOP_TOLERANCE) {
        ends.push(vertex.clone());
      }
    }
  });
  return clusterPoints(ends, CABLE_CLUSTER_RADIUS);
}

function clusterPoints(points: readonly Vector3[], radius: number): Vector3[] {
  const clusters: { sum: Vector3; count: number }[] = [];
  for (const point of points) {
    const cluster = clusters.find((candidate) => candidate.sum.clone().divideScalar(candidate.count).distanceTo(point) < radius);
    if (cluster) {
      cluster.sum.add(point);
      cluster.count += 1;
    } else {
      clusters.push({ sum: point.clone(), count: 1 });
    }
  }
  return clusters.map((cluster) => cluster.sum.divideScalar(cluster.count));
}

/**
 * The table lamp's cables end almost a metre below the ceiling. Thin drop rods continue each cable up to a small
 * canopy on the ceiling. They are attached to the lamp so Stage fades them with it: call this before
 * Stage.registerLamp. Returns the rods, whose geometry and material the caller disposes.
 */
export function extendLampToCeiling(lamp: Object3D): Mesh<BufferGeometry, MeshStandardMaterial> | null {
  const tops = findCableTops(lamp);
  if (tops.length === 0 || tops.some((top) => top.y >= CEILING_HEIGHT)) {
    return null;
  }
  const pieces: BufferGeometry[] = [];
  for (const top of tops) {
    const length = CEILING_HEIGHT - top.y;
    pieces.push(new CylinderGeometry(DROP_ROD_RADIUS, DROP_ROD_RADIUS, length, 6).translate(top.x, top.y + length / 2, top.z));
    pieces.push(new CylinderGeometry(CANOPY.radius * 0.6, CANOPY.radius, CANOPY.height, 16).translate(top.x, CEILING_HEIGHT - CANOPY.height / 2, top.z));
  }
  const geometry = mergeGeometries(pieces, false);
  pieces.forEach((piece) => piece.dispose());
  if (!geometry) {
    return null;
  }
  const material = new MeshStandardMaterial({ color: '#1f2023', roughness: 0.4, metalness: 0.6, transparent: true });
  const rods = new Mesh(geometry, material);
  rods.name = 'lampDropRods';
  // attach() keeps the world placement although the lamp lives in the table model's centimetre, Z-up frame.
  lamp.attach(rods);
  return rods;
}
