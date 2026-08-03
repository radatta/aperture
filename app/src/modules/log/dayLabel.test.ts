import { describe, it, expect } from 'vitest';
import { dayLabel } from './dayLabel';

describe('dayLabel', () => {
  const today = '2026-06-15';
  it('labels today and yesterday relatively', () => {
    expect(dayLabel('2026-06-15', today)).toBe('Today');
    expect(dayLabel('2026-06-14', today)).toBe('Yesterday');
  });
  it('falls back to a month-first date', () => {
    expect(dayLabel('2026-06-07', today)).toBe('6/7/2026');
  });
});
