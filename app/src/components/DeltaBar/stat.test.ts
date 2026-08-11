import { describe, it, expect } from 'vitest';
import { statDelta } from './stat';

describe('statDelta', () => {
  it('reports over-run as a positive pct', () => {
    expect(statDelta(60, 78)).toEqual({ deltaMin: 18, pct: 30, over: true });
  });
  it('reports under-run as negative', () => {
    expect(statDelta(60, 45)).toEqual({ deltaMin: -15, pct: -25, over: false });
  });
  it('is null without an estimate to compare against', () => {
    expect(statDelta(0, 30)).toBeNull();
  });
});
