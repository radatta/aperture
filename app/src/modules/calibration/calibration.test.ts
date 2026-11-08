import { describe, it, expect } from 'vitest';
import type { CalibrationPoint } from '@aperture/shared';
import { aggregate, driftLabel, plannedVsAvailable, recentPoints } from './calibration';

const pt = (estimateLockedMin: number, actualAccruedMin: number): CalibrationPoint => ({
  taskId: 't',
  day: '2026-08-01',
  estimateMin: estimateLockedMin,
  estimateLockedMin,
  estimateSource: 'planned',
  actualAccruedMin,
  categoryId: null,
  reflection: null,
  parts: 0,
});

describe('aggregate', () => {
  it('sums estimate/actual and reports the over-ratio', () => {
    const a = aggregate([pt(60, 90), pt(40, 40)]); // 100 est → 130 actual
    expect(a.count).toBe(2);
    expect(a.totalEstimateMin).toBe(100);
    expect(a.totalActualMin).toBe(130);
    expect(a.ratio).toBeCloseTo(1.3);
    expect(a.overPct).toBe(30);
  });
  it('leaves a parent’s rollup out — its parts are points already', () => {
    const a = aggregate([pt(60, 90), { ...pt(100, 200), parts: 2 }]);
    expect(a.count).toBe(1);
    expect(a.totalEstimateMin).toBe(60);
    expect(a.totalActualMin).toBe(90);
  });
  it('stays honest (null ratio) with no estimate to compare', () => {
    const a = aggregate([]);
    expect(a.count).toBe(0);
    expect(a.ratio).toBeNull();
    expect(a.overPct).toBeNull();
  });
});

describe('plannedVsAvailable', () => {
  it('flags over-scoping against capacity', () => {
    const r = plannedVsAvailable(11 * 60, 6); // 11h planned into a 6h day
    expect(r.availableMin).toBe(360);
    expect(r.over).toBe(true);
    expect(r.overByMin).toBe(300);
  });
  it('is not over when within capacity', () => {
    expect(plannedVsAvailable(240, 6).over).toBe(false);
  });
  it('reports unknown (not over) when capacity is unset', () => {
    const r = plannedVsAvailable(240, null);
    expect(r.availableMin).toBeNull();
    expect(r.over).toBe(false);
  });
});

describe('recentPoints', () => {
  const point = (taskId: string, day: string): CalibrationPoint => ({
    taskId,
    day,
    estimateMin: 30,
    estimateLockedMin: 30,
    estimateSource: 'planned',
    actualAccruedMin: 30,
    categoryId: null,
    reflection: null,
    parts: 0,
  });
  it('newest day first; within a day, the later completion first', () => {
    const at: Record<string, number> = { a: 300, b: 100, c: 200, d: 50 };
    const points = [
      point('a', '2026-10-12'),
      point('b', '2026-10-12'),
      point('c', '2026-10-12'),
      point('d', '2026-10-13'),
    ];
    expect(recentPoints(points, (id) => at[id]).map((p) => p.taskId)).toEqual(['d', 'a', 'c', 'b']);
  });
  it('keeps the latest n; an unknown completion sorts oldest in its day', () => {
    const points = [point('x', '2026-10-12'), point('y', '2026-10-12'), point('z', '2026-10-11')];
    const at = (id: string) => (id === 'y' ? 10 : undefined);
    expect(recentPoints(points, at, 2).map((p) => p.taskId)).toEqual(['y', 'x']);
  });
});

describe('calibration integrity on the page', () => {
  const at = (over: Partial<CalibrationPoint>): CalibrationPoint => ({
    taskId: 't',
    day: '2026-11-05',
    estimateLockedMin: 30,
    estimateMin: 30,
    estimateSource: 'planned',
    actualAccruedMin: 40,
    categoryId: null,
    reflection: null,
    parts: 0,
    ...over,
  });

  it('counts retro points, leaving rollups out', () => {
    const agg = aggregate([
      at({ estimateSource: 'retro' }),
      at({}),
      at({ estimateSource: 'retro', parts: 2 }),
    ]);
    expect(agg).toMatchObject({ count: 2, retroCount: 1 });
  });

  it('a rescoped row reads est → actual; the headline stays the lock', () => {
    const p = at({ estimateMin: 60, estimateSource: 'revised', actualAccruedMin: 75 });
    expect(driftLabel(p)).toBe('est 30m → 1h · actual 1h 15m');
    expect(aggregate([p]).totalEstimateMin).toBe(30);
  });

  it('no label when it never moved, on a retro point, on a rollup, or from an older Lambda', () => {
    expect(driftLabel(at({}))).toBeNull();
    expect(driftLabel(at({ estimateSource: 'retro' }))).toBeNull();
    expect(driftLabel(at({ estimateMin: null, parts: 2 }))).toBeNull();
    expect(driftLabel(at({ estimateMin: undefined as unknown as null }))).toBeNull();
  });
});
