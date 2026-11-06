import { describe, expect, it } from 'vitest';
import {
  ACTION_COOLDOWN_SECONDS,
  ACTIVITY_PROFILES,
  DealerIdleScheduler,
  REDUCED_MOTION_ACTIONS,
  type DealerActivity,
  type IdleActionId,
} from '../src/client/scene/dealerIdle';

/** A repeatable random source: a small linear congruential generator seeded per test. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const FRAME = 0.1;

/** Runs the scheduler like the render loop does and records every action it starts, finishing each one after `duration`. */
function simulate(
  scheduler: DealerIdleScheduler,
  seconds: number,
  duration = 1.5,
): { action: IdleActionId; at: number }[] {
  const started: { action: IdleActionId; at: number }[] = [];
  let finishAt = -1;
  for (let time = 0; time < seconds; time += FRAME) {
    const action = scheduler.tick(FRAME);
    if (action !== null) {
      started.push({ action, at: time });
      finishAt = time + duration;
    }
    if (finishAt >= 0 && time >= finishAt) {
      scheduler.actionFinished();
      finishAt = -1;
    }
  }
  return started;
}

function schedulerFor(activity: DealerActivity, seed = 7): DealerIdleScheduler {
  const scheduler = new DealerIdleScheduler(seededRandom(seed));
  scheduler.setContext({ activity });
  return scheduler;
}

describe('dealer idle scheduler', () => {
  it('never starts the same action twice in a row', () => {
    for (const activity of ['lobby', 'waiting', 'hand'] as const) {
      const actions = simulate(schedulerFor(activity), 600, 0.4).map((entry) => entry.action);

      expect(actions.length).toBeGreaterThan(10);
      actions.slice(1).forEach((action, index) => expect(action).not.toBe(actions[index]));
    }
  });

  it('prefers actions that have rested over ones still cooling down', () => {
    const started = simulate(schedulerFor('lobby'), 1200, 1.5);
    const lastSeen = new Map<IdleActionId, number>();
    let tooSoon = 0;

    for (const { action, at } of started) {
      const previous = lastSeen.get(action);
      if (previous !== undefined && at - previous < ACTION_COOLDOWN_SECONDS[action]) tooSoon += 1;
      lastSeen.set(action, at);
    }

    expect(tooSoon / started.length).toBeLessThan(0.1);
  });

  it('keeps the dealer busy in the lobby: something starts within a few seconds, all the time', () => {
    const started = simulate(schedulerFor('lobby'), 300, 1);
    const gaps = started.slice(1).map((entry, index) => entry.at - started[index].at);

    expect(Math.max(...gaps)).toBeLessThan(ACTIVITY_PROFILES.lobby.maxDelay + 2 + 1 + FRAME * 2);
    expect(started.length).toBeGreaterThan(300 / 6);
  });

  it('is calmer during a hand than in the lobby', () => {
    const lobby = simulate(schedulerFor('lobby'), 300, 1).length;
    const hand = simulate(schedulerFor('hand'), 300, 1).length;

    expect(hand).toBeLessThan(lobby * 0.7);
  });

  it('uses a varied repertoire rather than a loop of a few actions', () => {
    const distinct = new Set(simulate(schedulerFor('lobby'), 300).map((entry) => entry.action));

    expect(distinct.size).toBeGreaterThanOrEqual(6);
  });

  it('does not run the same wait twice: delays vary instead of ticking like a metronome', () => {
    const started = simulate(schedulerFor('waiting'), 300, 0.2);
    const gaps = new Set(started.slice(1).map((entry, index) => (entry.at - started[index].at).toFixed(1)));

    expect(gaps.size).toBeGreaterThan(5);
  });

  it('checks the pot only when there is one, and never during the lobby', () => {
    const withoutPot = schedulerFor('hand');
    const withPot = schedulerFor('hand');
    withPot.setContext({ potVisible: true });

    expect(simulate(withoutPot, 600, 0.3).map((entry) => entry.action)).not.toContain('checkPot');
    expect(simulate(withPot, 600, 0.3).map((entry) => entry.action)).toContain('checkPot');
    expect(simulate(schedulerFor('lobby'), 600, 0.3).map((entry) => entry.action)).not.toContain('checkPot');
  });

  it('only picks glances and looks up at the camera under reduced motion', () => {
    const scheduler = schedulerFor('lobby');
    scheduler.setContext({ reducedMotion: true });

    const actions = new Set(simulate(scheduler, 300, 0.5).map((entry) => entry.action));

    expect(actions.size).toBeGreaterThan(0);
    for (const action of actions) {
      expect(REDUCED_MOTION_ACTIONS).toContain(action);
    }
  });

  it('starts nothing while a gameplay gesture is running and waits a quiet moment after it', () => {
    const scheduler = schedulerFor('waiting');
    scheduler.gestureStarted();

    const during = simulate(scheduler, 30);
    scheduler.gestureEnded();
    const after = simulate(scheduler, 10);

    expect(during).toEqual([]);
    expect(after.length).toBeGreaterThan(0);
    expect(after[0].at).toBeGreaterThanOrEqual(ACTIVITY_PROFILES.waiting.quietAfterInterruption - FRAME * 2);
  });

  it('forgets the running action when a gesture interrupts it and starts a fresh one later', () => {
    const scheduler = schedulerFor('lobby');
    let first: IdleActionId | null = null;
    for (let step = 0; step < 100 && first === null; step++) first = scheduler.tick(FRAME);

    expect(scheduler.isActionRunning).toBe(true);
    scheduler.gestureStarted();
    expect(scheduler.isActionRunning).toBe(false);
    scheduler.gestureEnded();

    expect(simulate(scheduler, 20).length).toBeGreaterThan(0);
  });

  it('holds off after a gaze order cancels an action', () => {
    const scheduler = schedulerFor('hand');
    scheduler.actionInterrupted();

    const started = simulate(scheduler, 20);

    expect(started[0].at).toBeGreaterThanOrEqual(ACTIVITY_PROFILES.hand.quietAfterInterruption - FRAME * 2);
  });

  it('lets a welcome through immediately, but not while a gameplay gesture is running', () => {
    const scheduler = schedulerFor('waiting');

    expect(scheduler.request('welcome')).toBe(true);
    expect(scheduler.isActionRunning).toBe(true);

    scheduler.gestureStarted();
    expect(scheduler.request('welcome')).toBe(false);
  });

  it('reads the same activity back that it was told', () => {
    const scheduler = schedulerFor('lobby');
    scheduler.setContext({ activity: 'hand' });

    expect(scheduler.activity).toBe('hand');
  });
});
