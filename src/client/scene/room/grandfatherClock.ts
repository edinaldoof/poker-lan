import { Mesh, type Object3D } from 'three';
import { clockHandAngles, clockwiseAngleOf, handRotationZ } from './clockHands';

const HAND_NODE_SUFFIXES = ['_HourHand', '_MinuteHand'] as const;

interface ClockHand {
  node: Object3D;
  /** Where the modelled hand points, clockwise from 12. */
  restAngle: number;
  length: number;
}

/** The modelled hand's tip: its vertex farthest from the pivot (the node origin) on the clock face. */
function measureHand(node: Object3D): ClockHand | null {
  if (!(node instanceof Mesh)) {
    return null;
  }
  const position = node.geometry.getAttribute('position');
  let tipX = 0;
  let tipY = 0;
  let length = 0;
  for (let index = 0; index < position.count; index++) {
    const x = position.getX(index);
    const y = position.getY(index);
    const distance = Math.hypot(x, y);
    if (distance > length) {
      length = distance;
      tipX = x;
      tipY = y;
    }
  }
  return { node, restAngle: clockwiseAngleOf(tipX, tipY), length };
}

/**
 * The grandfather clock keeps the device's local time. The model's node names do not say which hand is which
 * reliably, so the longer hand is taken as the minute hand.
 */
export class GrandfatherClock {
  private readonly hour: ClockHand;
  private readonly minute: ClockHand;

  private constructor(hour: ClockHand, minute: ClockHand) {
    this.hour = hour;
    this.minute = minute;
  }

  /** Null when the model has no separate hands (then the clock simply stays as modelled). */
  static fromModel(clock: Object3D): GrandfatherClock | null {
    const hands: ClockHand[] = [];
    clock.traverse((object) => {
      if (HAND_NODE_SUFFIXES.some((suffix) => object.name.endsWith(suffix))) {
        const hand = measureHand(object);
        if (hand) {
          hands.push(hand);
        }
      }
    });
    if (hands.length !== 2) {
      return null;
    }
    const [shorter, longer] = [...hands].sort((first, second) => first.length - second.length);
    return new GrandfatherClock(shorter, longer);
  }

  show(time: Date): void {
    const angles = clockHandAngles(time);
    this.hour.node.rotation.z = handRotationZ(this.hour.restAngle, angles.hour);
    this.minute.node.rotation.z = handRotationZ(this.minute.restAngle, angles.minute);
    this.hour.node.updateMatrix();
    this.minute.node.updateMatrix();
  }
}
