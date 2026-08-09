import { describe, it, expect } from 'vitest';
import {
  addDays,
  dayKey,
  dayKeyForOffset,
  daysBetween,
  fmtDayHeading,
  fmtMonthDay,
  fmtMonthDayYear,
  fmtMonthShortDay,
  fmtWeekday,
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
  it('names the weekday and the header date', () => {
    // 2026-08-02 is a Sunday.
    expect(fmtWeekday('2026-08-02')).toBe('Sunday');
    expect(fmtDayHeading('2026-08-02')).toBe('Sunday, Aug 2');
    expect(fmtDayHeading('2026-12-25')).toBe('Friday, Dec 25');
  });
  // Labels a calendar row, where the weekday is already the column header.
  it('drops the weekday and the leading zero for the compact form', () => {
    expect(fmtMonthShortDay('2026-08-03')).toBe('Aug 3');
    expect(fmtMonthShortDay('2026-08-31')).toBe('Aug 31');
    expect(fmtMonthShortDay('2026-12-28')).toBe('Dec 28');
    expect(fmtMonthShortDay('2027-01-04')).toBe('Jan 4');
  });
});

describe('dayKeyForOffset (foreign-client bucketing, e.g. the LeetCode extension)', () => {
  it('buckets by reported tz offset + dayStartHour via UTC getters (runner-TZ-independent)', () => {
    // 1_700_000_000_000 = 2023-11-14T22:13:20Z; UTC-5 (offset 300), dayStartHour 4 → Nov 14.
    expect(dayKeyForOffset(1_700_000_000_000, 300, 4)).toBe('2023-11-14');
    // 2:30am local (UTC 07:30 at offset 300), dayStartHour 4 → still the previous day.
    expect(dayKeyForOffset(Date.UTC(2026, 7, 5, 7, 30, 0), 300, 4)).toBe('2026-08-04');
    // 4:00am local exactly (UTC 09:00 at offset 300) → rolls to the new day.
    expect(dayKeyForOffset(Date.UTC(2026, 7, 5, 9, 0, 0), 300, 4)).toBe('2026-08-05');
    // East of UTC: 5am JST Aug 5 (UTC+9, offset -540) → Aug 5.
    expect(dayKeyForOffset(Date.UTC(2026, 7, 4, 20, 0, 0), -540, 4)).toBe('2026-08-05');
  });
});
