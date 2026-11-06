import { describe, expect, it } from 'vitest';
import {
  buildRenderLevels,
  DEFAULT_GOVERNOR_TUNING,
  FrameBudgetGovernor,
  HIGH_QUALITY_PIXEL_RATIO_CAP,
  type RenderLevel,
} from '../src/client/scene/adaptiveResolution';

const SLOW_FRAME_MS = 40;
const VSYNC_FRAME_MS = 1000 / 60;

/** Feeds frames of one duration for a span of time and returns every level change, in order. */
function runFrames(governor: FrameBudgetGovernor, frameMs: number, totalMs: number): RenderLevel[] {
  const changes: RenderLevel[] = [];
  for (let elapsed = 0; elapsed < totalMs; elapsed += frameMs) {
    const change = governor.recordFrame(frameMs);
    if (change) changes.push(change);
  }
  return changes;
}

const SETTLE_AND_TWO_WINDOWS_MS = DEFAULT_GOVERNOR_TUNING.settleMs + 2 * DEFAULT_GOVERNOR_TUNING.windowMs + 100;

describe('buildRenderLevels', () => {
  it('caps a retina screen at 1.5 device pixels and ends with bloom switched off', () => {
    const levels = buildRenderLevels(2, 'high');

    expect(levels[0]).toEqual({ pixelRatio: HIGH_QUALITY_PIXEL_RATIO_CAP, bloom: true, shadowMapSize: 2048 });
    expect(levels.map((level) => level.pixelRatio)).toEqual([1.5, 1.25, 1, 0.85, 0.75, 0.75]);
    expect(levels.at(-1)?.bloom).toBe(false);
    expect(levels.slice(0, -1).every((level) => level.bloom)).toBe(true);
  });

  it('starts a standard screen at its native resolution', () => {
    const levels = buildRenderLevels(1, 'high');

    expect(levels.map((level) => level.pixelRatio)).toEqual([1, 0.85, 0.75, 0.75]);
    expect(levels[0].shadowMapSize).toBe(1024);
  });

  it('keeps an odd device ratio as the top step instead of rounding it away', () => {
    expect(buildRenderLevels(1.1, 'high')[0].pixelRatio).toBe(1.1);
  });

  it('never uses bloom or more than one device pixel in low quality', () => {
    const levels = buildRenderLevels(3, 'low');

    expect(levels.map((level) => level.pixelRatio)).toEqual([1, 0.85, 0.75]);
    expect(levels.some((level) => level.bloom)).toBe(false);
  });
});

describe('FrameBudgetGovernor', () => {
  it('lowers the resolution after two seconds of slow frames', () => {
    const governor = new FrameBudgetGovernor(buildRenderLevels(2, 'high'));

    const changes = runFrames(governor, SLOW_FRAME_MS, SETTLE_AND_TWO_WINDOWS_MS);

    expect(changes).toHaveLength(1);
    expect(governor.level.pixelRatio).toBe(1.25);
  });

  it('ignores slow frames while the scene is still settling after a start', () => {
    const governor = new FrameBudgetGovernor(buildRenderLevels(2, 'high'));

    const changes = runFrames(governor, SLOW_FRAME_MS, DEFAULT_GOVERNOR_TUNING.settleMs - 50);

    expect(changes).toEqual([]);
    expect(governor.level.pixelRatio).toBe(1.5);
  });

  it('does not react to a single hitch inside an otherwise smooth window', () => {
    const governor = new FrameBudgetGovernor(buildRenderLevels(2, 'high'));
    runFrames(governor, VSYNC_FRAME_MS, DEFAULT_GOVERNOR_TUNING.settleMs);

    for (let second = 0; second < 5; second += 1) {
      governor.recordFrame(200);
      runFrames(governor, VSYNC_FRAME_MS, DEFAULT_GOVERNOR_TUNING.windowMs);
    }

    expect(governor.level.pixelRatio).toBe(1.5);
  });

  it('treats frames from a hidden tab or a debugger pause as noise', () => {
    const governor = new FrameBudgetGovernor(buildRenderLevels(2, 'high'));

    const changes = runFrames(governor, 900, 60_000);

    expect(changes).toEqual([]);
  });

  it('walks down to the cheapest level and then stays there', () => {
    const levels = buildRenderLevels(2, 'high');
    const governor = new FrameBudgetGovernor(levels);

    runFrames(governor, 80, 120_000);

    expect(governor.level).toEqual(levels.at(-1));
  });

  it('climbs back one step after a long run of smooth frames', () => {
    const governor = new FrameBudgetGovernor(buildRenderLevels(2, 'high'));
    runFrames(governor, SLOW_FRAME_MS, SETTLE_AND_TWO_WINDOWS_MS);
    expect(governor.level.pixelRatio).toBe(1.25);

    const smoothMs =
      DEFAULT_GOVERNOR_TUNING.settleMs + (DEFAULT_GOVERNOR_TUNING.fastWindowsToStepUp + 1) * DEFAULT_GOVERNOR_TUNING.windowMs;
    runFrames(governor, VSYNC_FRAME_MS, smoothMs);

    expect(governor.level.pixelRatio).toBe(1.5);
  });

  it('waits twice as long before retrying a level that was too slow again', () => {
    const governor = new FrameBudgetGovernor(buildRenderLevels(2, 'high'));
    const { settleMs, windowMs, fastWindowsToStepUp } = DEFAULT_GOVERNOR_TUNING;
    const firstRetryMs = settleMs + (fastWindowsToStepUp + 1) * windowMs;

    runFrames(governor, SLOW_FRAME_MS, SETTLE_AND_TWO_WINDOWS_MS);
    runFrames(governor, VSYNC_FRAME_MS, firstRetryMs);
    expect(governor.level.pixelRatio).toBe(1.5);
    runFrames(governor, SLOW_FRAME_MS, SETTLE_AND_TWO_WINDOWS_MS);
    expect(governor.level.pixelRatio).toBe(1.25);

    runFrames(governor, VSYNC_FRAME_MS, firstRetryMs);
    expect(governor.level.pixelRatio).toBe(1.25);
    runFrames(governor, VSYNC_FRAME_MS, fastWindowsToStepUp * windowMs);
    expect(governor.level.pixelRatio).toBe(1.5);
  });

  it('holds its level on a 120 Hz screen that keeps up', () => {
    const governor = new FrameBudgetGovernor(buildRenderLevels(2, 'high'));

    const changes = runFrames(governor, 1000 / 120, 30_000);

    expect(changes).toEqual([]);
    expect(governor.level.pixelRatio).toBe(1.5);
  });
});
