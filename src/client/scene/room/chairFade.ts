import type { Vector3 } from 'three';
import { FELT_Y } from '../SeatLayout';

/**
 * Seen from the game camera, high above the viewer's side, the chairs on that side stand between the lens and the
 * near rail, right where the viewer's own cards, plate and bet are drawn. They fade out as the camera climbs and
 * turns toward them; from the low lobby orbit every chair stays, because there they give the room its depth.
 */
export const CHAIR_FADE_TUNING = Object.freeze({
  /** Cosine between the chair's outward direction and the camera's bearing where the fade starts / completes. */
  facingStart: 0.5,
  facingEnd: 0.8,
  /** Camera elevation above the felt (radians) where the fade starts / completes. */
  elevationStart: 0.45,
  elevationEnd: 0.8,
});

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** 1 = fully drawn, 0 = hidden. `outward` is the chair's unit direction away from the table centre (xz). */
export function chairOpacityForCamera(outward: Vector3, cameraPosition: Vector3): number {
  const horizontalDistance = Math.hypot(cameraPosition.x, cameraPosition.z);
  if (horizontalDistance < 1e-6) {
    return 1;
  }
  const facing = (outward.x * cameraPosition.x + outward.z * cameraPosition.z) / horizontalDistance;
  const elevation = Math.atan2(cameraPosition.y - FELT_Y, horizontalDistance);
  const fade =
    smoothstep(CHAIR_FADE_TUNING.facingStart, CHAIR_FADE_TUNING.facingEnd, facing) *
    smoothstep(CHAIR_FADE_TUNING.elevationStart, CHAIR_FADE_TUNING.elevationEnd, elevation);
  return 1 - fade;
}

/** Below this a chair is not drawn at all; above its mirror it is drawn as a solid, opaque chair. */
const SETTLE_MARGIN = { hidden: 0.01, solid: 0.005 };

/**
 * Snaps an opacity within a hair of hidden or solid to exactly 0 or 1, so a chair never lingers a fraction short of
 * solid on its transparent mesh, and small camera drifts there change nothing.
 */
export function settleChairOpacity(opacity: number): number {
  if (opacity < SETTLE_MARGIN.hidden) {
    return 0;
  }
  return opacity > 1 - SETTLE_MARGIN.solid ? 1 : opacity;
}

export function isSolidOpacity(opacity: number): boolean {
  return opacity === 1;
}
