import { describe, it, expect } from 'vitest';
import type { CalibrationPoint } from '@aperture/shared';
import { aggregate, plannedVsAvailable } from './calibration';

const pt = (estimateLockedMin: number, actualAccruedMin: number): CalibrationPoint => ({
  taskId: 't',
  day: '2026-08-01',
  estimateLockedMin,
  actualAccruedMin,
  categoryId: null,
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
