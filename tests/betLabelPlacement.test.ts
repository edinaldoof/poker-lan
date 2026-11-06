import { describe, expect, it } from 'vitest';
import { boxAround, clearOfObstacles, translateBox } from '../src/client/ui/betLabelPlacement';

const GAP = 4;

describe('bet pill placement', () => {
  it('leaves a pill alone when nothing is under it', () => {
    const pill = boxAround(100, 100, 40, 19);
    const plate = { left: 300, top: 300, right: 400, bottom: 350 };

    expect(clearOfObstacles(pill, [plate], GAP)).toEqual({ x: 0, y: 0 });
  });

  it('keeps the gap even when the pill only comes close to a plate', () => {
    const plate = { left: 0, top: 0, right: 100, bottom: 50 };
    const pill = boxAround(118, 25, 40, 19);

    const offset = clearOfObstacles(pill, [plate], GAP);

    expect(translateBox(pill, offset).left).toBeGreaterThanOrEqual(plate.right + GAP);
  });

  it('slides a pill sideways off a side plate it overlaps mostly horizontally', () => {
    const plate = { left: 192, top: 130, right: 305, bottom: 178 };
    const pill = boxAround(317, 144, 40, 19);

    const offset = clearOfObstacles(pill, [plate], GAP);

    expect(offset.y).toBe(0);
    expect(offset.x).toBeGreaterThan(0);
    expect(translateBox(pill, offset).left).toBe(plate.right + GAP);
  });

  it('slides a pill that sits under a top plate further down, away from the plate', () => {
    const plate = { left: 285, top: 60, right: 392, bottom: 108 };
    const pill = boxAround(330, 112, 40, 19);

    const offset = clearOfObstacles(pill, [plate], GAP);

    expect(offset.x).toBe(0);
    expect(translateBox(pill, offset).top).toBe(plate.bottom + GAP);
  });

  it('slides a pill that sits above a bottom plate further up', () => {
    const plate = { left: 245, top: 172, right: 355, bottom: 220 };
    const pill = boxAround(300, 168, 40, 19);

    const offset = clearOfObstacles(pill, [plate], GAP);

    expect(offset.x).toBe(0);
    expect(translateBox(pill, offset).bottom).toBe(plate.top - GAP);
  });

  it('clears the plate and the tag strip under it, not just the first obstacle', () => {
    const plate = { left: 285, top: 60, right: 392, bottom: 108 };
    const tags = { left: 300, top: 108, right: 380, bottom: 126 };
    const pill = boxAround(330, 110, 40, 19);

    const moved = translateBox(pill, clearOfObstacles(pill, [plate, tags], GAP));

    expect(moved.top).toBeGreaterThanOrEqual(tags.bottom + GAP);
  });

  it('keeps two pills apart when they are placed one after the other', () => {
    const firstPill = boxAround(290, 173, 40, 19);
    const secondPill = boxAround(292, 190, 38, 19);

    const moved = translateBox(secondPill, clearOfObstacles(secondPill, [firstPill], GAP));

    expect(moved.top).toBeGreaterThanOrEqual(firstPill.bottom + GAP);
  });

  it('gives up after a few passes when the obstacles leave no room', () => {
    const pill = boxAround(50, 50, 40, 19);
    const wall = { left: -1000, top: -1000, right: 1000, bottom: 1000 };

    const offset = clearOfObstacles(pill, [wall], GAP);

    expect(Number.isFinite(offset.x + offset.y)).toBe(true);
  });
});
