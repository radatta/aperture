// Pure head-pose math. No DOM, no MediaPipe types — just numbers in/out so it
// can be unit-tested and later moved into the worker "engine" unchanged.

import type { Euler } from '@aperture/shared/flux';

export const ZERO: Euler = { pitch: 0, yaw: 0, roll: 0 };

const RAD2DEG = 180 / Math.PI;

// Decompose MediaPipe's 4x4 facial transformation matrix into Euler angles
// (degrees). MediaPipe hands the matrix back column-major as a length-16 array;
// the upper-left 3x3 is the rotation. This is the standard R = Rz·Ry·Rx
// extraction (same one OpenCV documents).
export function matrixToEuler(m: ArrayLike<number>): Euler {
  // column-major → R[row][col]. MediaPipe always hands back 16 cells; `?? 0` only satisfies
  // noUncheckedIndexedAccess.
  const at = (i: number): number => m[i] ?? 0;
  const r00 = at(0);
  const r10 = at(1);
  const r20 = at(2);
  const r11 = at(5);
  const r21 = at(6);
  const r22 = at(10);

  const sy = Math.hypot(r00, r10);
  let pitch: number;
  let yaw: number;
  let roll: number;
  if (sy > 1e-6) {
    pitch = Math.atan2(r21, r22);
    yaw = Math.atan2(-r20, sy);
    roll = Math.atan2(r10, r00);
  } else {
    // gimbal-lock fallback
    pitch = Math.atan2(-r21, r11);
    yaw = Math.atan2(-r20, sy);
    roll = 0;
  }
  return { pitch: pitch * RAD2DEG, yaw: yaw * RAD2DEG, roll: roll * RAD2DEG };
}

// Angle relative to a calibrated neutral pose (null neutral → raw angle).
export function relativeTo(current: Euler, neutral: Euler | null): Euler {
  if (!neutral) return current;
  return {
    pitch: current.pitch - neutral.pitch,
    yaw: current.yaw - neutral.yaw,
    roll: current.roll - neutral.roll,
  };
}

// Overall angular deviation of a pose (3D magnitude, degrees).
export function magnitude(e: Euler): number {
  return Math.hypot(e.pitch, e.yaw, e.roll);
}

// Angular speed (deg/s) below which the head counts as "still" — shared by the evaluator and the
// core's auto-calibrate.
export const STILL_SPEED = 6;

// Angular speed (deg/s) between two poses `dtv` seconds apart; 0 with no previous pose.
export function speedOf(rel: Euler, lastRel: Euler | null, dtv: number): number {
  if (!lastRel) return 0;
  const delta: Euler = {
    pitch: rel.pitch - lastRel.pitch,
    yaw: rel.yaw - lastRel.yaw,
    roll: rel.roll - lastRel.roll,
  };
  return magnitude(delta) / (dtv || 1);
}

// The 1€ (One-Euro) filter — adaptive low-pass that kills jitter when you hold
// still but doesn't lag when you move fast. This is the industry default for
// smoothing noisy pose signals; ~30 lines and no tuning of a motion model.
export class OneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;

  constructor(minCutoff = 1.2, beta = 0.02, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  // tSec: timestamp in seconds
  filter(x: number, tSec: number): number {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = tSec;
      return x;
    }
    const dt = Math.max(1e-3, tSec - this.tPrev);
    this.tPrev = tSec;

    const dx = (x - this.xPrev) / dt;
    const aD = this.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    this.dxPrev = dxHat;

    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this.alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    return xHat;
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = 0;
  }
}

// Tracks min/max of a signal to report range-of-motion.
export class RomTracker {
  min = Number.POSITIVE_INFINITY;
  max = Number.NEGATIVE_INFINITY;

  add(v: number): void {
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
  }

  get range(): number {
    if (!Number.isFinite(this.min) || !Number.isFinite(this.max)) return 0;
    return this.max - this.min;
  }

  reset(): void {
    this.min = Number.POSITIVE_INFINITY;
    this.max = Number.NEGATIVE_INFINITY;
  }
}
