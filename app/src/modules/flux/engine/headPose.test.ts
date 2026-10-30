import { describe, expect, it } from 'vitest';
import { matrixToEuler, OneEuroFilter, RomTracker, relativeTo, speedOf } from './headPose';

// Column-major 4x4 rotation matrices (as MediaPipe hands them back).
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function rotY(deg: number): number[] {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  // rows [c,0,s] [0,1,0] [-s,0,c] → column-major
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

function rotX(deg: number): number[] {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  // rows [1,0,0] [0,c,-s] [0,s,c] → column-major
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}

describe('matrixToEuler', () => {
  it('identity → all zero', () => {
    const e = matrixToEuler(IDENTITY);
    expect(e.pitch).toBeCloseTo(0);
    expect(e.yaw).toBeCloseTo(0);
    expect(e.roll).toBeCloseTo(0);
  });

  it('pure yaw rotation → yaw only', () => {
    const e = matrixToEuler(rotY(30));
    expect(e.yaw).toBeCloseTo(30, 3);
    expect(e.pitch).toBeCloseTo(0, 3);
    expect(e.roll).toBeCloseTo(0, 3);
  });

  it('pure pitch rotation → pitch only', () => {
    const e = matrixToEuler(rotX(20));
    expect(e.pitch).toBeCloseTo(20, 3);
    expect(e.yaw).toBeCloseTo(0, 3);
    expect(e.roll).toBeCloseTo(0, 3);
  });
});

describe('relativeTo', () => {
  it('null neutral returns current unchanged', () => {
    const cur = { pitch: 5, yaw: 10, roll: -3 };
    expect(relativeTo(cur, null)).toEqual(cur);
  });

  it('subtracts neutral per axis', () => {
    const cur = { pitch: 5, yaw: 10, roll: -3 };
    const neutral = { pitch: 2, yaw: 4, roll: -1 };
    expect(relativeTo(cur, neutral)).toEqual({ pitch: 3, yaw: 6, roll: -2 });
  });
});

describe('speedOf', () => {
  it('is the 3D angular distance over the gap, and 0 with no previous pose', () => {
    expect(speedOf({ pitch: 3, yaw: 4, roll: 0 }, { pitch: 0, yaw: 0, roll: 0 }, 0.5)).toBe(10);
    expect(speedOf({ pitch: 3, yaw: 4, roll: 0 }, null, 0.5)).toBe(0);
  });
});

describe('RomTracker', () => {
  it('range is 0 before any samples', () => {
    expect(new RomTracker().range).toBe(0);
  });

  it('tracks max minus min', () => {
    const r = new RomTracker();
    for (const v of [10, -5, 3, 20, -8]) r.add(v);
    expect(r.range).toBe(28);
  });

  it('reset clears the accumulated range', () => {
    const r = new RomTracker();
    r.add(5);
    r.add(15);
    r.reset();
    expect(r.range).toBe(0);
  });
});

describe('OneEuroFilter', () => {
  it('passes the first sample through unchanged', () => {
    expect(new OneEuroFilter().filter(42, 0)).toBe(42);
  });

  it('moves toward a new input without overshooting it', () => {
    const f = new OneEuroFilter();
    f.filter(0, 0);
    const out = f.filter(10, 1 / 30);
    expect(out).toBeGreaterThan(0);
    expect(out).toBeLessThan(10);
  });
});

function rotZ(deg: number): number[] {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  // rows [c,-s,0] [s,c,0] [0,0,1] → column-major
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

describe('matrixToEuler (Aperture additions)', () => {
  it('pure roll rotation → roll only', () => {
    const e = matrixToEuler(rotZ(25));
    expect(e.roll).toBeCloseTo(25, 3);
    expect(e.pitch).toBeCloseTo(0, 3);
    expect(e.yaw).toBeCloseTo(0, 3);
  });

  it('takes the gimbal-lock branch at yaw ±90° (roll pinned to 0)', () => {
    const e = matrixToEuler(rotY(90));
    expect(e.yaw).toBeCloseTo(90, 3);
    expect(e.roll).toBe(0);
  });

  it('treats a short matrix as zeros instead of NaN', () => {
    const e = matrixToEuler([]);
    expect(Number.isNaN(e.pitch) || Number.isNaN(e.yaw) || Number.isNaN(e.roll)).toBe(false);
  });
});
