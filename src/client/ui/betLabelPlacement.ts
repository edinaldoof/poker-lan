export interface ScreenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ScreenOffset {
  x: number;
  y: number;
}

/** Enough for a pill squeezed between two plates; more passes would only chase a layout that cannot fit. */
const MAX_PASSES = 4;

export function boxAround(centerX: number, centerY: number, width: number, height: number): ScreenBox {
  return { left: centerX - width / 2, top: centerY - height / 2, right: centerX + width / 2, bottom: centerY + height / 2 };
}

export function translateBox(box: ScreenBox, offset: ScreenOffset): ScreenBox {
  return { left: box.left + offset.x, top: box.top + offset.y, right: box.right + offset.x, bottom: box.bottom + offset.y };
}

/**
 * Shortest axis-aligned move that takes the pill out of one obstacle, leaving `gap` pixels between them.
 * The pill leaves on the side it already leans toward, along the axis it overlaps least.
 */
function pushOutOf(pill: ScreenBox, obstacle: ScreenBox, gap: number): ScreenOffset | null {
  const overlapX = Math.min(pill.right, obstacle.right + gap) - Math.max(pill.left, obstacle.left - gap);
  const overlapY = Math.min(pill.bottom, obstacle.bottom + gap) - Math.max(pill.top, obstacle.top - gap);
  if (overlapX <= 0 || overlapY <= 0) return null;

  if (overlapX <= overlapY) {
    const leansRight = pill.left + pill.right >= obstacle.left + obstacle.right;
    return { x: leansRight ? overlapX : -overlapX, y: 0 };
  }
  const leansDown = pill.top + pill.bottom >= obstacle.top + obstacle.bottom;
  return { x: 0, y: leansDown ? overlapY : -overlapY };
}

/**
 * Bet pills are projected from the table while plates have a fixed pixel size, so on a small screen a pill can land
 * on a plate. This returns how far to slide the pill (in screen pixels) so it stops covering any obstacle.
 */
export function clearOfObstacles(pill: ScreenBox, obstacles: readonly ScreenBox[], gap: number): ScreenOffset {
  let offset: ScreenOffset = { x: 0, y: 0 };
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const moved = translateBox(pill, offset);
    let push: ScreenOffset | null = null;
    for (const obstacle of obstacles) {
      push = pushOutOf(moved, obstacle, gap);
      if (push !== null) break;
    }
    if (push === null) break;
    offset = { x: offset.x + push.x, y: offset.y + push.y };
  }
  return offset;
}
