import { describe, it, expect } from 'vitest';
import { miniBar } from './miniBar';

describe('miniBar', () => {
  it('fills proportionally when under capacity', () => {
    const m = miniBar(240, 360);
    expect(m.over).toBe(false);
    expect(Math.round(m.fillPct)).toBe(67);
  });
  it('clamps the fill and flags when over capacity', () => {
    const m = miniBar(660, 360);
    expect(m.over).toBe(true);
    expect(m.fillPct).toBe(100);
  });
  it('treats plans against zero capacity as over', () => {
    expect(miniBar(60, 0).over).toBe(true);
    expect(miniBar(0, 0).over).toBe(false);
  });
});
