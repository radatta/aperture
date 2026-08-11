import { describe, expect, it } from 'vitest';
import { deltaBar } from './deltaBar';

describe('deltaBar', () => {
  it('fills the track with the actual when it overran, marking the estimate short of the end', () => {
    const m = deltaBar(60, 90); // an hour estimated, 90 minutes spent
    expect(m.actualPct).toBe(100);
    expect(m.estimatePct).toBeCloseTo(66.67, 1);
    expect(m.overhangPct).toBeCloseTo(33.33, 1);
    expect(m.over).toBe(true);
    expect(m.under).toBe(false);
  });

  it('fills the track with the estimate when the actual came in under, and never overhangs', () => {
    const m = deltaBar(60, 30);
    expect(m.estimatePct).toBe(100);
    expect(m.actualPct).toBe(50);
    expect(m.overhangPct).toBe(0);
    expect(m.under).toBe(true);
  });

  it('sits flat when estimate and actual match', () => {
    const m = deltaBar(45, 45);
    expect(m.estimatePct).toBe(100);
    expect(m.actualPct).toBe(100);
    expect(m.overhangPct).toBe(0);
    expect(m.over).toBe(false);
    expect(m.under).toBe(false);
  });

  it('degrades to an empty track rather than dividing by zero', () => {
    expect(deltaBar(0, 0)).toEqual({
      estimatePct: 0,
      actualPct: 0,
      overhangPct: 0,
      over: false,
      under: false,
    });
  });

  it('treats a zero estimate with real time spent as all overhang', () => {
    const m = deltaBar(0, 30);
    expect(m.estimatePct).toBe(0);
    expect(m.actualPct).toBe(100);
    expect(m.overhangPct).toBe(100);
    expect(m.over).toBe(true);
  });
});
