import { describe, it, expect } from 'vitest';
import { countIn, mondayOf, recentWeeks, weekDates } from './habitWeek';

describe('mondayOf', () => {
  it('finds the Monday of the ISO week', () => {
    // 2026-08-03 is a Monday; 2026-08-02 is the Sunday that ends the prior week.
    expect(mondayOf('2026-08-03')).toBe('2026-08-03');
    expect(mondayOf('2026-08-05')).toBe('2026-08-03'); // Wed → same Monday
    expect(mondayOf('2026-08-02')).toBe('2026-07-27'); // Sun → previous Monday
  });
});

describe('weekDates', () => {
  it('returns Mon..Sun of the week', () => {
    const w = weekDates('2026-08-05');
    expect(w).toHaveLength(7);
    expect(w[0]).toBe('2026-08-03');
    expect(w[6]).toBe('2026-08-09');
  });
});

describe('recentWeeks', () => {
  it('returns n weeks oldest-first, ending with this week', () => {
    const weeks = recentWeeks('2026-08-05', 4);
    expect(weeks).toHaveLength(4);
    expect(weeks[3]![0]).toBe('2026-08-03'); // current week's Monday last
    expect(weeks[0]![0]).toBe('2026-07-13'); // 3 weeks earlier
  });
});

describe('countIn', () => {
  it('counts how many of the days are present', () => {
    const set = new Set(['2026-08-03', '2026-08-05']);
    expect(countIn(set, weekDates('2026-08-05'))).toBe(2);
  });
});
