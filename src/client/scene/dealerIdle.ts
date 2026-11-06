export type DealerActivity = 'lobby' | 'waiting' | 'hand';

export type IdleActionId =
  | 'shuffleDeck'
  | 'squareDeck'
  | 'riffleChips'
  | 'glanceAround'
  | 'lookAtCamera'
  | 'rubHands'
  | 'adjustCuffs'
  | 'adjustTie'
  | 'leanOnRail'
  | 'drumFingers'
  | 'checkPot'
  | 'welcome';

export interface IdleContext {
  activity: DealerActivity;
  reducedMotion: boolean;
  potVisible: boolean;
}

interface ActivityProfile {
  /** Seconds of stillness between two actions, picked uniformly from this range. */
  minDelay: number;
  maxDelay: number;
  /** Quiet time after a gameplay gesture or a gaze order before idle business resumes. */
  quietAfterInterruption: number;
  weights: Partial<Record<IdleActionId, number>>;
}

/** Busy while nobody is playing; during a hand only short, discreet things that do not pull the eye from the table. */
export const ACTIVITY_PROFILES: Record<DealerActivity, ActivityProfile> = {
  lobby: {
    minDelay: 0.3,
    maxDelay: 1.4,
    quietAfterInterruption: 0.8,
    weights: {
      shuffleDeck: 3,
      squareDeck: 1.5,
      riffleChips: 2.5,
      glanceAround: 2,
      lookAtCamera: 2.5,
      rubHands: 1.5,
      adjustCuffs: 1.5,
      adjustTie: 1.5,
      leanOnRail: 1.5,
      drumFingers: 1.5,
    },
  },
  waiting: {
    minDelay: 0.8,
    maxDelay: 2.6,
    quietAfterInterruption: 1,
    weights: {
      shuffleDeck: 2.5,
      squareDeck: 1.5,
      riffleChips: 2,
      glanceAround: 2.5,
      lookAtCamera: 1.5,
      rubHands: 1.2,
      adjustCuffs: 1.2,
      adjustTie: 1.2,
      leanOnRail: 1.5,
      drumFingers: 1.2,
    },
  },
  hand: {
    minDelay: 2.5,
    maxDelay: 6,
    quietAfterInterruption: 2.2,
    weights: {
      glanceAround: 3,
      squareDeck: 1.5,
      leanOnRail: 2,
      checkPot: 3,
      adjustTie: 0.7,
      lookAtCamera: 0.4,
    },
  },
};

/** After an action ends it cannot be picked again for this long (on top of the rule against immediate repeats). */
export const ACTION_COOLDOWN_SECONDS: Record<IdleActionId, number> = {
  shuffleDeck: 12,
  squareDeck: 8,
  riffleChips: 12,
  glanceAround: 5,
  lookAtCamera: 8,
  rubHands: 14,
  adjustCuffs: 16,
  adjustTie: 16,
  leanOnRail: 12,
  drumFingers: 14,
  checkPot: 10,
  welcome: 0,
};

/** The only idle business that keeps the body still. */
export const REDUCED_MOTION_ACTIONS: readonly IdleActionId[] = ['glanceAround', 'lookAtCamera'];

const RETRY_SECONDS = 0.5;

/**
 * Decides when the dealer starts the next piece of idle business and which one. It knows nothing about the rig:
 * the dealer reports gestures and finished actions, and asks `tick` every frame.
 */
export class DealerIdleScheduler {
  private readonly random: () => number;
  private context: IdleContext = { activity: 'waiting', reducedMotion: false, potVisible: false };
  private clock = 0;
  private countdown: number;
  private actionRunning = false;
  private gestureActive = false;
  private lastAction: IdleActionId | null = null;
  private readonly availableAgain = new Map<IdleActionId, number>();

  constructor(random: () => number = Math.random) {
    this.random = random;
    this.countdown = this.nextDelay();
  }

  get activity(): DealerActivity {
    return this.context.activity;
  }

  get isActionRunning(): boolean {
    return this.actionRunning;
  }

  setContext(change: Partial<IdleContext>): void {
    this.context = { ...this.context, ...change };
  }

  /** Advances time; returns the action to start now, if one is due. */
  tick(deltaSeconds: number): IdleActionId | null {
    this.clock += deltaSeconds;
    if (this.gestureActive || this.actionRunning) {
      return null;
    }
    this.countdown -= deltaSeconds;
    if (this.countdown > 0) {
      return null;
    }
    const chosen = this.chooseAction();
    if (chosen === null) {
      this.countdown = RETRY_SECONDS;
      return null;
    }
    this.begin(chosen);
    return chosen;
  }

  /** A requested action (a welcome) preempts the waiting period, but never a gameplay gesture. */
  request(action: IdleActionId): boolean {
    if (this.gestureActive) {
      return false;
    }
    this.begin(action);
    return true;
  }

  actionFinished(): void {
    this.actionRunning = false;
    this.countdown = this.nextDelay();
  }

  /** A gameplay gesture started: whatever idle action was running is gone. */
  gestureStarted(): void {
    this.gestureActive = true;
    this.actionRunning = false;
  }

  gestureEnded(): void {
    this.gestureActive = false;
    this.holdOffFor(this.quietPeriod());
  }

  /** Something other than a gesture (a gaze order) cancelled the running action. */
  actionInterrupted(): void {
    this.actionRunning = false;
    this.holdOffFor(this.quietPeriod());
  }

  private begin(action: IdleActionId): void {
    this.actionRunning = true;
    this.lastAction = action;
    this.availableAgain.set(action, this.clock + ACTION_COOLDOWN_SECONDS[action]);
  }

  private holdOffFor(seconds: number): void {
    this.countdown = Math.max(this.countdown, seconds);
  }

  private quietPeriod(): number {
    return ACTIVITY_PROFILES[this.context.activity].quietAfterInterruption;
  }

  private nextDelay(): number {
    const { minDelay, maxDelay } = ACTIVITY_PROFILES[this.context.activity];
    return minDelay + this.random() * (maxDelay - minDelay);
  }

  private chooseAction(): IdleActionId | null {
    const candidates = this.candidates();
    const fresh = candidates.filter(([action]) => (this.availableAgain.get(action) ?? 0) <= this.clock);
    // When everything is cooling down, repeating a rested favourite beats standing still, but never the same one twice.
    return this.pickWeighted(fresh.length > 0 ? fresh : candidates);
  }

  private candidates(): [IdleActionId, number][] {
    const weights = ACTIVITY_PROFILES[this.context.activity].weights;
    return (Object.entries(weights) as [IdleActionId, number][]).filter(([action, weight]) => {
      if (weight <= 0 || action === this.lastAction) return false;
      if (action === 'checkPot' && !this.context.potVisible) return false;
      return !this.context.reducedMotion || REDUCED_MOTION_ACTIONS.includes(action);
    });
  }

  private pickWeighted(candidates: [IdleActionId, number][]): IdleActionId | null {
    const total = candidates.reduce((sum, [, weight]) => sum + weight, 0);
    if (total <= 0) {
      return null;
    }
    let roll = this.random() * total;
    for (const [action, weight] of candidates) {
      roll -= weight;
      if (roll < 0) {
        return action;
      }
    }
    return candidates[candidates.length - 1][0];
  }
}
