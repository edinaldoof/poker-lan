/** Clock-face maths for the grandfather clock: its hands show the local time of the device. */

const FULL_TURN = Math.PI * 2;

export interface ClockHandAngles {
  /** Radians clockwise from 12 o'clock. */
  hour: number;
  minute: number;
}

export function clockHandAngles(date: Date): ClockHandAngles {
  const minutes = date.getMinutes() + date.getSeconds() / 60;
  const hours = (date.getHours() % 12) + minutes / 60;
  return { hour: (hours / 12) * FULL_TURN, minute: (minutes / 60) * FULL_TURN };
}

/** Clockwise angle from 12 o'clock of a direction drawn on a face that looks toward +Z (x right, y up). */
export function clockwiseAngleOf(x: number, y: number): number {
  const angle = Math.atan2(x, y);
  return angle < 0 ? angle + FULL_TURN : angle;
}

/**
 * rotation.z that moves a hand modelled pointing at `restAngle` to `targetAngle` (both clockwise from 12).
 * Seen from the front (+Z), a positive rotation about Z turns counter-clockwise, hence the sign.
 */
export function handRotationZ(restAngle: number, targetAngle: number): number {
  return restAngle - targetAngle;
}
