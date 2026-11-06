/** A numeric channel, or a bundle of them (a hand position, a hand shape). */
export type NumericTree = { [key: string]: number | NumericTree };

export interface SpringTuning {
  /** Natural frequency in rad/s: higher follows the target faster. */
  omega: number;
  /** 1 = critically damped (no overshoot), below 1 settles with a small overshoot. */
  zeta: number;
}

const MAX_SUBSTEP_SECONDS = 1 / 180;

/** Semi-implicit Euler in small substeps: stable for any frame time and independent of the frame rate. */
export function stepSpring(
  state: { value: number; velocity: number },
  target: number,
  tuning: SpringTuning,
  deltaSeconds: number,
): void {
  if (deltaSeconds <= 0) {
    return;
  }
  const substeps = Math.ceil(deltaSeconds / MAX_SUBSTEP_SECONDS);
  const step = deltaSeconds / substeps;
  const stiffness = tuning.omega * tuning.omega;
  const damping = 2 * tuning.zeta * tuning.omega;
  for (let index = 0; index < substeps; index++) {
    state.velocity += (stiffness * (target - state.value) - damping * state.velocity) * step;
    state.value += state.velocity * step;
  }
}

export function zeroTreeLike<T extends object>(tree: T): T {
  const zero: NumericTree = {};
  for (const [key, value] of Object.entries(tree as NumericTree)) {
    zero[key] = typeof value === 'number' ? 0 : zeroTreeLike(value);
  }
  return zero as unknown as T;
}

/** Moves every channel of `current` toward `target` with its own spring. Only the channels `velocity` has are used: GSAP stamps private keys onto the objects it tweens. */
export function followTree<T extends object>(
  current: T,
  velocity: T,
  target: T,
  tuningFor: (path: readonly string[]) => SpringTuning,
  deltaSeconds: number,
  path: readonly string[] = [],
): void {
  const channels = current as unknown as NumericTree;
  const speeds = velocity as unknown as NumericTree;
  const goals = target as unknown as NumericTree;
  for (const key of Object.keys(speeds)) {
    const channelPath = [...path, key];
    const goal = goals[key];
    if (typeof goal === 'number') {
      const state = { value: channels[key] as number, velocity: speeds[key] as number };
      stepSpring(state, goal, tuningFor(channelPath), deltaSeconds);
      channels[key] = state.value;
      speeds[key] = state.velocity;
    } else {
      followTree(channels[key] as NumericTree, speeds[key] as NumericTree, goal, tuningFor, deltaSeconds, channelPath);
    }
  }
}

/** Jumps straight to the target and stops (reduced motion, or a pose that must be exact). */
export function snapTree<T extends object>(current: T, velocity: T, target: T): void {
  const channels = current as unknown as NumericTree;
  const speeds = velocity as unknown as NumericTree;
  const goals = target as unknown as NumericTree;
  for (const key of Object.keys(speeds)) {
    const goal = goals[key];
    if (typeof goal === 'number') {
      channels[key] = goal;
      speeds[key] = 0;
    } else {
      snapTree(channels[key] as NumericTree, speeds[key] as NumericTree, goal);
    }
  }
}

const FINGER_FOLLOW_OMEGA: Record<string, number> = {
  thumb: 24,
  thumbOpposition: 22,
  index: 28,
  middle: 26,
  ring: 24,
  pinky: 22,
  spread: 20,
};

/**
 * Per-channel feel of the dealer. The torso leads (soft), the hands follow, the wrist rolls with a little overshoot and
 * the fingers close one after another from the index to the pinky, which gives the follow-through of a real hand.
 */
export function dealerSpringTuning(path: readonly string[]): SpringTuning {
  const channel = path[0];
  if (channel === 'lean' || channel === 'hinge') {
    return { omega: 12, zeta: 0.9 };
  }
  if (channel === 'nod') {
    return { omega: 30, zeta: 0.7 };
  }
  if (channel === 'leftHand' || channel === 'rightHand') {
    return { omega: 27, zeta: 0.88 };
  }
  if (channel === 'leftRoll' || channel === 'rightRoll' || channel === 'leftWrist' || channel === 'rightWrist') {
    return { omega: 18, zeta: 0.6 };
  }
  return { omega: FINGER_FOLLOW_OMEGA[path[1] ?? ''] ?? 22, zeta: 0.68 };
}
