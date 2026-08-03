import { describe, it, expect } from 'vitest';
import {
  addDays,
  dayKey,
  daysBetween,
  fmtMonthDay,
  fmtMonthDayYear,
  isoWeekKey,
  weekdayOf,
} from './dates';

// Build a local-time epoch, so these assertions are timezone-independent (we create and read
// back through the same local clock).
const at = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

describe('dayKey — day-start offset', () => {
  it('3am with a 4am start belongs to the previous day', () => {
    expect(dayKey(at(2026, 6, 7, 3), 4)).toBe('2026-06-06');
  });
  it('4am exactly rolls to the new day', () => {
    expect(dayKey(at(2026, 6, 7, 4), 4)).toBe('2026-06-07');
  });
  it('5am is the same day', () => {
    expect(dayKey(at(2026, 6, 7, 5), 4)).toBe('2026-06-07');
  });
  it('with a 0 offset, midnight is that calendar day', () => {
    expect(dayKey(at(2026, 6, 7, 0), 0)).toBe('2026-06-07');
  });
});

describe('date arithmetic', () => {
  it('addDays crosses month and year boundaries', () => {
    expect(addDays('2026-06-30', 1)).toBe('2026-07-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
  it('daysBetween counts calendar days', () => {
    expect(daysBetween('2026-06-01', '2026-06-08')).toBe(7);
  });
  it('weekdayOf (0=Sun): 2026-06-07 is a Sunday', () => {
    expect(weekdayOf('2026-06-07')).toBe(0);
  });
});

describe('iso week & formatting', () => {
  it('2026-01-01 (a Thursday) is W01', () => {
    expect(isoWeekKey('2026-01-01')).toBe('2026-W01');
  });
  it('formats month-first with no leading zeros', () => {
    expect(fmtMonthDayYear('2026-06-07')).toBe('6/7/2026');
    expect(fmtMonthDay('2026-06-07')).toBe('6/7');
  });
});
