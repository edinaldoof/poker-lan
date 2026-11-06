import { describe, expect, it } from 'vitest';
import { chooseBubblePlacement, sideNudgePx } from '../src/client/ui/DealerBubble';

const viewport = { width: 1366, height: 768 };
const bubble = { width: 180, height: 40 };

describe('dealer bubble placement', () => {
  it('sits above the head when there is room on every side', () => {
    expect(chooseBubblePlacement({ anchor: { x: 780, y: 140 }, bubble, viewport })).toBe('above');
  });

  it('moves beside the head when the camera leaves no room above it', () => {
    expect(chooseBubblePlacement({ anchor: { x: 780, y: 12 }, bubble, viewport })).toBe('right');
  });

  it('moves beside the head when the bubble would cross a side of the screen', () => {
    expect(chooseBubblePlacement({ anchor: { x: 60, y: 140 }, bubble, viewport })).toBe('right');
    expect(chooseBubblePlacement({ anchor: { x: 1330, y: 140 }, bubble, viewport })).toBe('left');
  });

  it('prefers the side with more space when neither fits', () => {
    const phone = { width: 360, height: 740 };
    const wide = { width: 260, height: 40 };

    expect(chooseBubblePlacement({ anchor: { x: 250, y: 10 }, bubble: wide, viewport: phone })).toBe('left');
    expect(chooseBubblePlacement({ anchor: { x: 110, y: 10 }, bubble: wide, viewport: phone })).toBe('right');
  });

  it('nudges a side bubble down only as far as needed to stay on screen', () => {
    expect(sideNudgePx(100, 40)).toBe(0);
    expect(sideNudgePx(-30, 40)).toBeGreaterThan(0);
    expect(-30 + 36 - 20 + sideNudgePx(-30, 40)).toBe(8);
  });
});
