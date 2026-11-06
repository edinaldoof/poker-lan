import type { DealerActivity, IdleActionId } from './dealerIdle';
import { DECK_POSITION } from './SeatLayout';
import {
  createRestPose,
  handShape,
  restHandTarget,
  type HandShape,
  type HandSide,
  type HandShapeName,
  type PoseGoal,
  type Vec3Like,
} from './dealerPose';

export type GazeTarget = { kind: 'point'; point: Vec3Like } | { kind: 'camera' } | { kind: 'hand'; side: HandSide };

export interface IdleKey {
  at: number;
  duration: number;
  goal: PoseGoal;
  ease?: string;
}

export interface PropWindow {
  from: number;
  to: number;
  /** Held in the left hand, or between both palms. */
  mode: 'left' | 'between';
}

export interface IdleScript {
  id: IdleActionId;
  seconds: number;
  keys: IdleKey[];
  gazes: { at: number; target: GazeTarget | null }[];
  deck: PropWindow | null;
  chips: { from: number; to: number } | null;
}

export interface IdleBuildContext {
  activity: DealerActivity;
  reducedMotion: boolean;
  random: () => number;
  /** World positions of the seats worth a glance (occupied ones when known). */
  seatPoints: readonly Vec3Like[];
  potPoint: Vec3Like | null;
  /** The seat a welcome is aimed at: its world point and the unit direction from the dealer, in dealer space. */
  focus: { point: Vec3Like; direction: Vec3Like } | null;
}

/** Torso postures. The table top is below the dealer's reach unless he bends at the waist. */
const POSTURE = {
  /** Hands in front of the chest. */
  chest: { lean: 0.3, hinge: 0.1 },
  /** Hands down over the deck on the felt. */
  stoop: { lean: 0.5, hinge: 0.34 },
  /** Elbows locked, resting the weight on the hands. */
  rail: { lean: 0.5, hinge: 0.4 },
} as const;

const RIGHT_REST = restHandTarget('right');
/** Where the deck lies on the felt, in dealer space: the wrists hover just behind it. */
const DECK_WRISTS = { left: { x: 0.0, y: 0.95, z: 0.42 }, right: { x: -0.19, y: 0.95, z: 0.42 } } as const;
const DECK_ROLL = 1.45;
const SHUFFLE_WRISTS = { left: { x: 0.1, y: 1.08, z: 0.33 }, right: { x: -0.1, y: 1.08, z: 0.33 } } as const;
const RAIL_WRISTS = { left: { x: 0.2, y: 0.92, z: 0.2 }, right: { x: -0.2, y: 0.92, z: 0.2 } } as const;
/** Bends the hands back so the palms lie flat on the rail instead of hanging off the wrist. */
const RAIL_WRIST_EXTENSION = 0.95;

/** Writes a script one beat at a time: `move` advances the clock, `alongside` layers a move on top of the current beat. */
class ScriptWriter {
  private cursor = 0;
  private readonly keys: IdleKey[] = [];
  private readonly gazes: IdleScript['gazes'] = [];
  private deckWindow: PropWindow | null = null;
  private chipsWindow: IdleScript['chips'] = null;

  constructor(private readonly id: IdleActionId) {}

  get now(): number {
    return this.cursor;
  }

  move(duration: number, goal: PoseGoal, ease?: string): this {
    this.keys.push({ at: this.cursor, duration, goal, ease });
    this.cursor += duration;
    return this;
  }

  alongside(offset: number, duration: number, goal: PoseGoal, ease?: string): this {
    this.keys.push({ at: this.cursor + offset, duration, goal, ease });
    return this;
  }

  wait(duration: number): this {
    this.cursor += duration;
    return this;
  }

  gaze(target: GazeTarget | null): this {
    this.gazes.push({ at: this.cursor, target });
    return this;
  }

  holdDeck(from: number, to: number, mode: PropWindow['mode']): this {
    this.deckWindow = { from, to, mode };
    return this;
  }

  holdChips(from: number, to: number): this {
    this.chipsWindow = { from, to };
    return this;
  }

  /** The last beat: everything returns to the rest pose. */
  settle(duration: number): IdleScript {
    this.move(duration, restGoal(), 'sine.inOut');
    return {
      id: this.id,
      seconds: this.cursor,
      keys: this.keys,
      gazes: this.gazes,
      deck: this.deckWindow,
      chips: this.chipsWindow,
    };
  }
}

function restGoal(): PoseGoal {
  return createRestPose();
}

function wrists(left: Vec3Like, right: Vec3Like): PoseGoal {
  return { leftHand: { ...left }, rightHand: { ...right } };
}

function shapes(left: HandShapeName, right: HandShapeName): PoseGoal {
  return { leftShape: handShape(left), rightShape: handShape(right) };
}

function between(random: () => number, low: number, high: number): number {
  return low + random() * (high - low);
}

function pointAt(world: Vec3Like): GazeTarget {
  return { kind: 'point', point: { x: world.x, y: world.y, z: world.z } };
}

/** The ring order of the seats is arbitrary, so glances pick a few different ones in random order. */
function pickDistinct<T>(items: readonly T[], count: number, random: () => number): T[] {
  const pool = [...items];
  const picked: T[] = [];
  while (picked.length < count && pool.length > 0) {
    picked.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  }
  return picked;
}

/**
 * Picks the deck up off the felt, shuffles it in front of his chest (`riffles` times), squares it and puts it back.
 * The deck prop eases between the felt and his hands, so nothing pops.
 */
function deckScript(id: 'shuffleDeck' | 'squareDeck', riffles: number, context: IdleBuildContext): IdleScript {
  const writer = new ScriptWriter(id);
  const { left, right } = DECK_WRISTS;
  writer
    .gaze(pointAt(DECK_POSITION))
    .move(0.7, { ...POSTURE.stoop, ...wrists(left, right), leftRoll: DECK_ROLL, rightRoll: DECK_ROLL, ...shapes('open', 'open') }, 'power2.inOut')
    .move(0.25, shapes('hold', 'hold'), 'power2.out');
  const pickedUp = writer.now;
  writer
    .gaze({ kind: 'hand', side: 'left' })
    .move(0.6, { ...POSTURE.chest, ...wrists(SHUFFLE_WRISTS.left, SHUFFLE_WRISTS.right) }, 'power2.inOut');

  for (let cycle = 0; cycle < riffles; cycle++) {
    const spread = between(context.random, 0.012, 0.02);
    writer
      .move(0.22, {
        ...wrists(
          { ...SHUFFLE_WRISTS.left, x: SHUFFLE_WRISTS.left.x + spread, y: SHUFFLE_WRISTS.left.y + 0.012 },
          { ...SHUFFLE_WRISTS.right, x: SHUFFLE_WRISTS.right.x - spread, y: SHUFFLE_WRISTS.right.y + 0.012 },
        ),
        ...shapes('cupped', 'cupped'),
      }, 'sine.out')
      .move(0.2, { ...wrists(SHUFFLE_WRISTS.left, SHUFFLE_WRISTS.right), ...shapes('hold', 'hold') }, 'power2.in')
      .move(0.12, { ...wrists({ ...SHUFFLE_WRISTS.left, y: SHUFFLE_WRISTS.left.y - 0.01 }, { ...SHUFFLE_WRISTS.right, y: SHUFFLE_WRISTS.right.y - 0.01 }) }, 'power3.out');
  }

  // Squaring: two sharp knocks of the deck's edge against the palms.
  for (let knock = 0; knock < 2; knock++) {
    writer
      .move(0.16, wrists({ ...SHUFFLE_WRISTS.left, y: SHUFFLE_WRISTS.left.y + 0.025 }, { ...SHUFFLE_WRISTS.right, y: SHUFFLE_WRISTS.right.y + 0.025 }), 'power2.out')
      .move(0.1, wrists(SHUFFLE_WRISTS.left, SHUFFLE_WRISTS.right), 'power3.in');
  }

  writer
    .wait(0.15)
    .gaze(pointAt(DECK_POSITION))
    .move(0.6, { ...POSTURE.stoop, ...wrists(left, right), leftRoll: DECK_ROLL, rightRoll: DECK_ROLL }, 'power2.inOut')
    .move(0.2, shapes('open', 'open'), 'power2.out');
  const putDown = writer.now;
  writer.wait(0.1);
  return writer.holdDeck(pickedUp, putDown, 'between').settle(0.7);
}

function riffleChipsScript(context: IdleBuildContext): IdleScript {
  const writer = new ScriptWriter('riffleChips');
  const hand: Vec3Like = { x: -0.08, y: 1.1, z: 0.33 };
  const waves = Math.round(between(context.random, 3, 5));
  writer
    .gaze({ kind: 'hand', side: 'right' })
    .move(0.6, { ...POSTURE.chest, rightHand: hand, rightRoll: 0.5, ...shapes('relaxed', 'cupped'), leftHand: { x: 0.13, y: 1.04, z: 0.28 } }, 'power2.inOut');
  const taken = writer.now;
  for (let wave = 0; wave < waves; wave++) {
    // The fingers roll the chips over one another, index first and pinky last.
    writer
      .move(0.14, { rightShape: { ...handShape('cupped'), index: 0.9, middle: 0.7 } }, 'sine.inOut')
      .move(0.14, { rightShape: { ...handShape('cupped'), index: 0.55, middle: 0.95, ring: 0.8 }, rightRoll: 0.65 }, 'sine.inOut')
      .move(0.14, { rightShape: { ...handShape('cupped'), index: 0.5, middle: 0.6, ring: 1, pinky: 0.95 }, rightRoll: 0.5 }, 'sine.inOut');
  }
  writer.move(0.25, { rightShape: handShape('cupped') }, 'sine.inOut');
  const dropped = writer.now;
  writer.wait(0.2);
  return writer.holdChips(taken, dropped).settle(0.6);
}

function glanceScript(context: IdleBuildContext): IdleScript {
  const writer = new ScriptWriter('glanceAround');
  const count = context.activity === 'hand' ? 2 : 3 + Math.floor(context.random() * 2);
  const targets = pickDistinct(context.seatPoints, count, context.random);
  for (const point of targets) {
    writer.gaze(pointAt(point)).wait(between(context.random, 0.7, 1.4));
  }
  writer.gaze(null);
  return writer.wait(0.3).settle(0.1);
}

function cameraScript(context: IdleBuildContext): IdleScript {
  const writer = new ScriptWriter('lookAtCamera');
  writer.gaze({ kind: 'camera' }).wait(0.45);
  if (context.reducedMotion) {
    writer.wait(1);
  } else {
    writer.move(0.18, { nod: 0.1 }, 'power2.out').wait(0.5).move(0.3, { nod: 0 }, 'sine.inOut');
  }
  writer.gaze(null);
  return writer.wait(0.4).settle(0.1);
}

function rubHandsScript(context: IdleBuildContext): IdleScript {
  const writer = new ScriptWriter('rubHands');
  const rubs = Math.round(between(context.random, 3, 5));
  const leftBase: Vec3Like = { x: 0.035, y: 1.12, z: 0.3 };
  const rightBase: Vec3Like = { x: -0.035, y: 1.16, z: 0.3 };
  writer
    .gaze({ kind: 'hand', side: 'left' })
    .move(0.55, { ...POSTURE.chest, ...wrists(leftBase, rightBase), leftRoll: 0.9, rightRoll: 0, ...shapes('flat', 'flat') }, 'power2.inOut');
  for (let rub = 0; rub < rubs; rub++) {
    const sign = rub % 2 === 0 ? 1 : -1;
    writer
      .move(0.28, wrists({ ...leftBase, z: leftBase.z - 0.02 * sign }, { ...rightBase, z: rightBase.z + 0.04 * sign }), 'sine.inOut')
      .alongside(0, 0.28, shapes('relaxed', 'relaxed'), 'sine.inOut');
  }
  writer.wait(0.2).gaze(null);
  return writer.settle(0.6);
}

function armGoal(side: HandSide, parts: { hand?: Vec3Like; roll?: number; shape?: HandShape }): PoseGoal {
  const goal: PoseGoal = {};
  if (side === 'left') {
    if (parts.hand) goal.leftHand = parts.hand;
    if (parts.roll !== undefined) goal.leftRoll = parts.roll;
    if (parts.shape) goal.leftShape = parts.shape;
  } else {
    if (parts.hand) goal.rightHand = parts.hand;
    if (parts.roll !== undefined) goal.rightRoll = parts.roll;
    if (parts.shape) goal.rightShape = parts.shape;
  }
  return goal;
}

/** One hand pinches the cuff of the other forearm and tugs it twice. */
function cuffScript(context: IdleBuildContext): IdleScript {
  const writer = new ScriptWriter('adjustCuffs');
  const cuffSide: HandSide = context.random() < 0.5 ? 'left' : 'right';
  const fixerSide: HandSide = cuffSide === 'left' ? 'right' : 'left';
  const outward = cuffSide === 'left' ? 1 : -1;
  const cuff: Vec3Like = { x: 0.1 * outward, y: 1.12, z: 0.26 };
  const fixer: Vec3Like = { x: -0.04 * outward, y: 1.1, z: 0.3 };
  writer
    .gaze({ kind: 'hand', side: cuffSide })
    .move(0.5, {
      ...POSTURE.chest,
      ...armGoal(cuffSide, { hand: cuff, roll: 0.7 }),
      ...armGoal(fixerSide, { hand: fixer, shape: handShape('pinch') }),
    }, 'power2.inOut');
  for (let tug = 0; tug < 2; tug++) {
    writer
      .move(0.18, armGoal(fixerSide, { hand: { ...fixer, x: fixer.x + 0.03 * outward, z: fixer.z - 0.02 } }), 'sine.out')
      .move(0.2, armGoal(fixerSide, { hand: fixer }), 'sine.inOut');
  }
  writer.wait(0.25).gaze(null);
  return writer.settle(0.6);
}

function tieScript(): IdleScript {
  const writer = new ScriptWriter('adjustTie');
  const knot: Vec3Like = { x: -0.05, y: 1.33, z: 0.2 };
  writer
    .gaze({ kind: 'camera' })
    .move(0.6, { lean: 0.15, rightHand: knot, rightRoll: 0.4, rightShape: handShape('pinch'), nod: -0.05 }, 'power2.inOut')
    .move(0.2, { rightHand: { ...knot, y: knot.y - 0.04 } }, 'sine.inOut')
    .move(0.2, { rightHand: { ...knot, y: knot.y + 0.01 } }, 'sine.inOut')
    .move(0.2, { rightHand: { ...knot, y: knot.y - 0.03 } }, 'sine.inOut')
    .wait(0.2)
    .gaze(null);
  return writer.settle(0.6);
}

function leanOnRailScript(context: IdleBuildContext): IdleScript {
  const writer = new ScriptWriter('leanOnRail');
  const shift = between(context.random, 0.015, 0.03);
  writer
    .gaze(null)
    .move(0.9, { ...POSTURE.rail, ...wrists(RAIL_WRISTS.left, RAIL_WRISTS.right), ...shapes('flat', 'flat'), leftRoll: 0, rightRoll: 0, leftWrist: RAIL_WRIST_EXTENSION, rightWrist: RAIL_WRIST_EXTENSION }, 'power2.inOut')
    .move(0.5, { leftShape: handShape('relaxed'), rightShape: handShape('relaxed') }, 'sine.out')
    .move(1.1, { lean: POSTURE.rail.lean + 0.03, hinge: POSTURE.rail.hinge + 0.02, ...wrists({ ...RAIL_WRISTS.left, x: RAIL_WRISTS.left.x + shift }, { ...RAIL_WRISTS.right, x: RAIL_WRISTS.right.x - shift }) }, 'sine.inOut')
    .wait(0.3);
  return writer.settle(0.8);
}

function drumFingersScript(context: IdleBuildContext): IdleScript {
  const writer = new ScriptWriter('drumFingers');
  const rolls = Math.round(between(context.random, 3, 5));
  writer
    .gaze(null)
    .move(0.9, { ...POSTURE.rail, ...wrists(RAIL_WRISTS.left, RAIL_WRISTS.right), ...shapes('relaxed', 'flat'), leftRoll: 0, rightRoll: 0, leftWrist: RAIL_WRIST_EXTENSION, rightWrist: RAIL_WRIST_EXTENSION }, 'power2.inOut');
  for (let roll = 0; roll < rolls; roll++) {
    // Pinky to index, each finger lifting and dropping a beat after the one before it.
    writer
      .move(0.1, { rightShape: { ...handShape('flat'), pinky: 0.45 } }, 'sine.out')
      .move(0.1, { rightShape: { ...handShape('flat'), pinky: 0.05, ring: 0.45 } }, 'sine.out')
      .move(0.1, { rightShape: { ...handShape('flat'), ring: 0.05, middle: 0.45 } }, 'sine.out')
      .move(0.1, { rightShape: { ...handShape('flat'), middle: 0.05, index: 0.45 } }, 'sine.out')
      .move(0.12, { rightShape: handShape('flat') }, 'sine.in');
  }
  writer.wait(0.25);
  return writer.settle(0.8);
}

function checkPotScript(context: IdleBuildContext): IdleScript {
  const writer = new ScriptWriter('checkPot');
  if (context.potPoint) {
    writer.gaze(pointAt(context.potPoint));
  }
  writer
    .move(0.5, { lean: 0.32, hinge: 0.06 }, 'power2.inOut')
    .move(0.3, { nod: 0.1 }, 'sine.inOut')
    .wait(0.9)
    .move(0.3, { nod: 0 }, 'sine.inOut')
    .gaze(null);
  return writer.wait(0.2).settle(0.5);
}

function welcomeScript(context: IdleBuildContext): IdleScript {
  const writer = new ScriptWriter('welcome');
  const focus = context.focus;
  // Mid-hand a player sitting down gets a nod, not a show.
  if (!focus || context.activity === 'hand') {
    if (focus) {
      writer.gaze(pointAt(focus.point));
    }
    writer.move(0.4, { nod: 0.15 }, 'power2.out').move(0.3, { nod: 0 }, 'sine.inOut').wait(0.5).gaze(null);
    return writer.settle(0.3);
  }
  const palm: Vec3Like = {
    x: RIGHT_REST.x + focus.direction.x * 0.2,
    y: 1.1,
    z: RIGHT_REST.z + 0.15 + Math.max(focus.direction.z, 0) * 0.05,
  };
  writer
    .gaze(pointAt(focus.point))
    .move(0.4, { lean: 0.26, rightHand: palm, rightRoll: 1.2, rightShape: handShape('open'), nod: 0.14 }, 'power2.out')
    .move(0.3, { nod: 0 }, 'sine.inOut')
    .wait(0.7)
    .gaze(null);
  return writer.settle(0.6);
}

export function buildIdleScript(id: IdleActionId, context: IdleBuildContext): IdleScript {
  switch (id) {
    case 'shuffleDeck':
      return deckScript('shuffleDeck', 2 + Math.floor(context.random() * 2), context);
    case 'squareDeck':
      return deckScript('squareDeck', 0, context);
    case 'riffleChips':
      return riffleChipsScript(context);
    case 'glanceAround':
      return glanceScript(context);
    case 'lookAtCamera':
      return cameraScript(context);
    case 'rubHands':
      return rubHandsScript(context);
    case 'adjustCuffs':
      return cuffScript(context);
    case 'adjustTie':
      return tieScript();
    case 'leanOnRail':
      return leanOnRailScript(context);
    case 'drumFingers':
      return drumFingersScript(context);
    case 'checkPot':
      return checkPotScript(context);
    case 'welcome':
      return welcomeScript(context);
  }
}
