/**
 * Adaptive render quality: watches real frame times and trades resolution (then bloom) for frame rate.
 * Pure logic, so the stepping rules can be tested without WebGL.
 */

export type RenderQuality = 'high' | 'low';

export interface RenderLevel {
  pixelRatio: number;
  bloom: boolean;
  shadowMapSize: number;
}

export interface GovernorTuning {
  /** Length of one evaluation window, in measured frame time. */
  windowMs: number;
  /** A window whose median frame is slower than this counts as slow (below ~45 fps). */
  slowFrameMs: number;
  /** A window whose median frame is at least this fast counts as fast (a 60 Hz vsync frame passes). */
  fastFrameMs: number;
  slowWindowsToStepDown: number;
  fastWindowsToStepUp: number;
  /** Ceiling for the step-up wait, which doubles each time a retried level turns out too slow again. */
  maxFastWindowsToStepUp: number;
  /** A step down this many windows after a step up means the retried level failed. */
  failedRetryWindows: number;
  /** Frames this long are tab switches or debugger pauses, not rendering cost. */
  ignoreFrameMs: number;
  /** Time skipped after a start or a level change: shader compiles and texture uploads are not steady state. */
  settleMs: number;
}

export const DEFAULT_GOVERNOR_TUNING: GovernorTuning = {
  windowMs: 1000,
  slowFrameMs: 22,
  fastFrameMs: 17.5,
  slowWindowsToStepDown: 2,
  fastWindowsToStepUp: 15,
  maxFastWindowsToStepUp: 120,
  failedRetryWindows: 5,
  ignoreFrameMs: 250,
  settleMs: 2000,
};

/** Above 1.5 device pixels per CSS pixel the extra sharpness is hard to see but the fill cost keeps growing. */
export const HIGH_QUALITY_PIXEL_RATIO_CAP = 1.5;
const RESOLUTION_STEPS = [1.5, 1.25, 1, 0.85, 0.75];
const FULL_SHADOW_MAP_SIZE = 2048;
const REDUCED_SHADOW_MAP_SIZE = 1024;

/** Ordered from best to cheapest. High quality ends with bloom switched off; low quality never uses bloom. */
export function buildRenderLevels(devicePixelRatio: number, quality: RenderQuality): RenderLevel[] {
  const ratioCap = quality === 'high' ? Math.min(Math.max(devicePixelRatio, 1), HIGH_QUALITY_PIXEL_RATIO_CAP) : 1;
  const ratios = [ratioCap, ...RESOLUTION_STEPS.filter((ratio) => ratio < ratioCap)];

  if (quality === 'low') {
    return ratios.map((pixelRatio) => ({ pixelRatio, bloom: false, shadowMapSize: REDUCED_SHADOW_MAP_SIZE }));
  }

  const levels = ratios.map((pixelRatio) => ({
    pixelRatio,
    bloom: true,
    shadowMapSize: pixelRatio > 1 ? FULL_SHADOW_MAP_SIZE : REDUCED_SHADOW_MAP_SIZE,
  }));
  const cheapest = levels[levels.length - 1];
  return [...levels, { ...cheapest, bloom: false }];
}

export class FrameBudgetGovernor {
  private readonly levels: RenderLevel[];
  private readonly tuning: GovernorTuning;
  private levelIndex = 0;

  private windowFrames: number[] = [];
  private windowElapsedMs = 0;
  private settleRemainingMs: number;

  private slowWindows = 0;
  private fastWindows = 0;
  private windowsSinceStepUp = Number.POSITIVE_INFINITY;
  private fastWindowsNeeded: number;

  constructor(levels: RenderLevel[], tuning: GovernorTuning = DEFAULT_GOVERNOR_TUNING) {
    if (levels.length === 0) {
      throw new Error('FrameBudgetGovernor needs at least one render level');
    }
    this.levels = levels;
    this.tuning = tuning;
    this.settleRemainingMs = tuning.settleMs;
    this.fastWindowsNeeded = tuning.fastWindowsToStepUp;
  }

  get level(): RenderLevel {
    return this.levels[this.levelIndex];
  }

  /** Feed the time since the previous frame; returns the new level when it changes, otherwise null. */
  recordFrame(frameMs: number): RenderLevel | null {
    if (!Number.isFinite(frameMs) || frameMs <= 0 || frameMs >= this.tuning.ignoreFrameMs) {
      return null;
    }
    if (this.settleRemainingMs > 0) {
      this.settleRemainingMs -= frameMs;
      return null;
    }

    this.windowFrames.push(frameMs);
    this.windowElapsedMs += frameMs;
    if (this.windowElapsedMs < this.tuning.windowMs) {
      return null;
    }

    const medianFrameMs = median(this.windowFrames);
    this.windowFrames = [];
    this.windowElapsedMs = 0;
    return this.evaluateWindow(medianFrameMs);
  }

  private evaluateWindow(medianFrameMs: number): RenderLevel | null {
    this.windowsSinceStepUp += 1;

    if (medianFrameMs > this.tuning.slowFrameMs) {
      this.slowWindows += 1;
      this.fastWindows = 0;
    } else if (medianFrameMs <= this.tuning.fastFrameMs) {
      this.fastWindows += 1;
      this.slowWindows = 0;
    } else {
      this.slowWindows = 0;
      this.fastWindows = 0;
    }

    if (this.slowWindows >= this.tuning.slowWindowsToStepDown && this.levelIndex < this.levels.length - 1) {
      this.stepDown();
      return this.level;
    }
    if (this.fastWindows >= this.fastWindowsNeeded && this.levelIndex > 0) {
      this.stepUp();
      return this.level;
    }
    return null;
  }

  private stepDown(): void {
    const retriedLevelFailed = this.windowsSinceStepUp <= this.tuning.failedRetryWindows;
    if (retriedLevelFailed) {
      this.fastWindowsNeeded = Math.min(this.fastWindowsNeeded * 2, this.tuning.maxFastWindowsToStepUp);
    }
    this.levelIndex += 1;
    this.resetAfterChange();
  }

  private stepUp(): void {
    this.levelIndex -= 1;
    this.windowsSinceStepUp = 0;
    this.resetAfterChange();
  }

  private resetAfterChange(): void {
    this.slowWindows = 0;
    this.fastWindows = 0;
    this.windowFrames = [];
    this.windowElapsedMs = 0;
    this.settleRemainingMs = this.tuning.settleMs;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
