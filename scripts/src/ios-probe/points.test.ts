import { describe, expect, it } from 'vitest';
import { neighbours, simPoints } from './points';

const flat = (pts: { x: number; y: number }[]) => pts.map((p) => `${p.x} ${p.y}`).join(' ');

describe('simPoints', () => {
  // Expected strings are sim.sh's own sim_points (jq), run on these ops on 2026-11-12.
  it('orders a near grid as the runner does: nearest first, ties in generation order', () => {
    expect(flat(simPoints({ near: { x: 300, y: 480 }, radius: 40 }))).toBe(
      '300 480 270 480 300 450 300 510 330 480 270 450 270 510 330 450 330 510',
    );
  });

  it('drops grid points off the screen, and a radius under 30 is the point alone', () => {
    expect(flat(simPoints({ near: { x: 10, y: 940 }, radius: 60 }))).toBe(
      '10 940 10 910 40 940 40 910 10 880 70 940 40 880 70 910 70 880',
    );
    expect(flat(simPoints({ near: { x: 220, y: 895 }, radius: 10 }))).toBe('220 895');
  });

  it('defaults the radius to 40', () => {
    expect(simPoints({ near: { x: 200, y: 200 } })).toHaveLength(9);
  });

  it('scans 30 pt a step, both ends included, down or up', () => {
    expect(flat(simPoints({ scan: { x: 40, from: 300, to: 390 } }))).toBe(
      '40 300 40 330 40 360 40 390',
    );
    expect(flat(simPoints({ scan: { x: 40, from: 629, to: 540 } }))).toBe('40 629 40 599 40 569');
  });
});

describe('neighbours', () => {
  it("is the hit's column of a near grid: the dock settles vertically", () => {
    const w = { near: { x: 300, y: 480 }, radius: 40 };
    const pts = simPoints(w);
    expect(flat(neighbours(w, pts, 3))).toBe('300 480 300 450');
  });

  it("is a scan's points one step either side of the hit", () => {
    const w = { scan: { x: 40, from: 300, to: 420 } };
    const pts = simPoints(w);
    expect(flat(neighbours(w, pts, 2))).toBe('40 330 40 390');
    expect(flat(neighbours(w, pts, 0))).toBe('40 330');
  });
});

describe('a scan hint (PR 152)', () => {
  const w = { scan: { x: 300, from: 390, to: 480 }, hint: { x: 300, y: 507 } };
  it('is read first, then the scan as before', () => {
    expect(flat(simPoints(w))).toBe('300 507 300 390 300 420 300 450 300 480');
  });
  it("has its own column as neighbours when it's the hit, and never neighbours the scan", () => {
    const pts = simPoints(w);
    expect(flat(neighbours(w, pts, 0))).toBe('300 477 300 537');
    expect(flat(neighbours(w, pts, 1))).toBe('300 420');
    expect(flat(neighbours(w, pts, 3))).toBe('300 420 300 480');
  });
});
