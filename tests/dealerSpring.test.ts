import { describe, expect, it } from 'vitest';
import {
  HAND_SHAPES,
  HAND_SHAPE_LIMITS,
  applyGoal,
  clampHandShape,
  createRestPose,
  handShape,
  type HandShape,
} from '../src/client/scene/dealerPose';
import {
  dealerSpringTuning,
  followTree,
  snapTree,
  stepSpring,
  zeroTreeLike,
  type SpringTuning,
} from '../src/client/scene/dealerSpring';

const CRITICAL: SpringTuning = { omega: 20, zeta: 1 };
const SPRINGY: SpringTuning = { omega: 20, zeta: 0.5 };

function run(tuning: SpringTuning, target: number, seconds: number, frame: number): { value: number; peak: number } {
  const state = { value: 0, velocity: 0 };
  let peak = 0;
  for (let time = 0; time < seconds - 1e-9; time += frame) {
    stepSpring(state, target, tuning, frame);
    peak = Math.max(peak, state.value);
  }
  return { value: state.value, peak };
}

describe('second-order spring', () => {
  it('settles on the target without overshooting when critically damped', () => {
    const { value, peak } = run(CRITICAL, 1, 1.5, 1 / 60);

    expect(value).toBeCloseTo(1, 3);
    expect(peak).toBeLessThanOrEqual(1.0001);
  });

  it('overshoots a little and then settles when under-damped', () => {
    const { value, peak } = run(SPRINGY, 1, 3, 1 / 60);

    expect(peak).toBeGreaterThan(1.05);
    expect(peak).toBeLessThan(1.3);
    expect(value).toBeCloseTo(1, 2);
  });

  it('gives the same motion at 30, 60 and 144 frames per second', () => {
    const at30 = run(CRITICAL, 1, 0.3, 1 / 30).value;
    const at60 = run(CRITICAL, 1, 0.3, 1 / 60).value;
    const at144 = run(CRITICAL, 1, 0.3, 1 / 144).value;

    expect(Math.abs(at30 - at60)).toBeLessThan(0.01);
    expect(Math.abs(at144 - at60)).toBeLessThan(0.01);
  });

  it('stays stable after a long frame hitch', () => {
    const state = { value: 0, velocity: 0 };
    stepSpring(state, 1, { omega: 40, zeta: 0.6 }, 0.1);

    expect(Number.isFinite(state.value)).toBe(true);
    expect(Math.abs(state.value)).toBeLessThan(2);
  });

  it('keeps the speed it had when the target changes, so an interruption blends instead of snapping', () => {
    const state = { value: 0, velocity: 0 };
    for (let frame = 0; frame < 6; frame++) stepSpring(state, 1, CRITICAL, 1 / 60);
    const velocityBeforeChange = state.velocity;
    const valueBeforeChange = state.value;

    stepSpring(state, -1, CRITICAL, 1 / 60);

    expect(velocityBeforeChange).toBeGreaterThan(0);
    expect(Math.abs(state.value - valueBeforeChange)).toBeLessThan(0.1);
  });
});

describe('following a pose', () => {
  it('moves every channel of a nested pose toward its target, leaving other keys alone', () => {
    const current = createRestPose();
    const velocity = zeroTreeLike(createRestPose());
    const target = applyGoal(createRestPose(), { lean: 0.6, rightHand: { x: -0.2, y: 0.9, z: 0.5 }, rightShape: handShape('spread') });
    (target as unknown as Record<string, unknown>)._gsap = { id: 7 };

    for (let frame = 0; frame < 120; frame++) followTree(current, velocity, target, dealerSpringTuning, 1 / 60);

    expect(current.lean).toBeCloseTo(0.6, 2);
    expect(current.rightHand.z).toBeCloseTo(0.5, 2);
    expect(current.rightShape.spread).toBeCloseTo(1, 1);
    expect(current).not.toHaveProperty('_gsap');
  });

  it('closes the fingers one after another, index first and pinky last', () => {
    const current = createRestPose();
    const velocity = zeroTreeLike(createRestPose());
    const target = applyGoal(createRestPose(), {
      rightShape: { ...handShape('relaxed'), index: 1, middle: 1, ring: 1, pinky: 1 },
    });
    const start = { ...current.rightShape };

    for (let frame = 0; frame < 4; frame++) followTree(current, velocity, target, dealerSpringTuning, 1 / 60);
    const progress = (finger: 'index' | 'pinky'): number =>
      (current.rightShape[finger] - start[finger]) / (1 - start[finger]);

    expect(progress('index')).toBeGreaterThan(progress('pinky'));
  });

  it('snaps and stops dead when asked to', () => {
    const current = createRestPose();
    const velocity = zeroTreeLike(createRestPose());
    velocity.lean = 3;
    const target = applyGoal(createRestPose(), { lean: 0.5, leftShape: handShape('pinch') });

    snapTree(current, velocity, target);

    expect(current.lean).toBe(0.5);
    expect(current.leftShape).toEqual(handShape('pinch'));
    expect(velocity.lean).toBe(0);
  });
});

describe('hand shapes', () => {
  it('clamps every channel to the joint limits of a finger', () => {
    const wild: HandShape = { thumb: 9, thumbOpposition: -3, index: 40, middle: -1, ring: 2, pinky: 1.5, spread: 8 };

    const clamped = clampHandShape(wild);

    for (const channel of Object.keys(HAND_SHAPE_LIMITS) as (keyof HandShape)[]) {
      expect(clamped[channel]).toBeGreaterThanOrEqual(HAND_SHAPE_LIMITS[channel].min);
      expect(clamped[channel]).toBeLessThanOrEqual(HAND_SHAPE_LIMITS[channel].max);
    }
    expect(clamped.index).toBe(HAND_SHAPE_LIMITS.index.max);
    expect(clamped.middle).toBe(HAND_SHAPE_LIMITS.middle.min);
  });

  it('never changes a shape that is already within its limits', () => {
    for (const name of Object.keys(HAND_SHAPES) as (keyof typeof HAND_SHAPES)[]) {
      expect(clampHandShape(handShape(name))).toEqual(handShape(name));
    }
  });

  it('does not let the spring overshoot push a curl past its limit once it is clamped', () => {
    const current = createRestPose();
    const velocity = zeroTreeLike(createRestPose());
    const target = applyGoal(createRestPose(), { rightShape: { ...handShape('relaxed'), index: HAND_SHAPE_LIMITS.index.max } });
    let highest = 0;

    for (let frame = 0; frame < 180; frame++) {
      followTree(current, velocity, target, dealerSpringTuning, 1 / 60);
      highest = Math.max(highest, clampHandShape(current.rightShape).index);
    }

    expect(highest).toBeLessThanOrEqual(HAND_SHAPE_LIMITS.index.max);
  });

  it('describes a pinch as the thumb working against a curled index finger, and a flat hand as nearly straight', () => {
    expect(HAND_SHAPES.pinch.thumbOpposition).toBeGreaterThan(HAND_SHAPES.flat.thumbOpposition);
    expect(HAND_SHAPES.pinch.index).toBeGreaterThan(HAND_SHAPES.relaxed.index);
    expect(Math.max(HAND_SHAPES.flat.index, HAND_SHAPES.flat.middle)).toBeLessThan(0.1);
    expect(HAND_SHAPES.spread.spread).toBeGreaterThan(HAND_SHAPES.relaxed.spread);
  });
});
