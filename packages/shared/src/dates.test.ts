import { describe, it, expect } from 'vitest';
import {
  addDays,
  dayKey,
  dayKeyForOffset,
  dayKeyInZone,
  daysBetween,
  duePresets,
  fmtDayHeading,
  fmtDueDay,
  localEpochFromDayTime,
  fmtMonthDay,
  fmtMonthDayYear,
  fmtMonthShortDay,
  fmtWeekday,
  fmtWeekdayShort,
  isDayKey,
  isoWeekKey,
  todayKey,
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

describe('fmtDueDay — relative deadline phrasing', () => {
  // 2026-06-15 is a Monday (2026-06-07 is a Sunday, per weekdayOf above).
  const today = '2026-06-15';
  it('names the near days explicitly', () => {
    expect(fmtDueDay(today, today)).toBe('due today');
    expect(fmtDueDay('2026-06-16', today)).toBe('due tomorrow');
    expect(fmtDueDay('2026-06-14', today)).toBe('was due yesterday');
  });
  it('uses the weekday for ±2–6 days', () => {
    expect(fmtWeekdayShort('2026-06-19')).toBe('Fri');
    expect(fmtDueDay('2026-06-19', today)).toBe('due Fri'); // +4
    expect(fmtDueDay('2026-06-21', today)).toBe('due Sun'); // +6
    expect(fmtDueDay('2026-06-09', today)).toBe('was due Tue'); // -6
  });
  it('falls back to month/day beyond a week either direction', () => {
    expect(fmtDueDay('2026-06-22', today)).toBe('due Jun 22'); // +7
    expect(fmtDueDay('2026-06-08', today)).toBe('was due Jun 8'); // -7
  });

  // The trap: at 2:30am the wall-clock date has rolled but the logical day (4am start) hasn't. A task
  // due "yesterday's calendar date" must still read "due today". The boundary lives in todayKey, and
  // fmtDueDay is pure over (dueDay, today) — so composing the two is the honest test.
  const at = (y: number, mo: number, d: number, h: number) =>
    new Date(y, mo - 1, d, h, 0, 0, 0).getTime();
  it('respects the dayStartHour rollover via todayKey', () => {
    expect(fmtDueDay('2026-06-06', todayKey(4, at(2026, 6, 7, 3)))).toBe('due today'); // 3am, pre-rollover
    expect(fmtDueDay('2026-06-06', todayKey(4, at(2026, 6, 7, 4)))).toBe('was due yesterday'); // 4am exactly
    expect(fmtDueDay('2026-06-07', todayKey(4, at(2026, 6, 7, 3)))).toBe('due tomorrow'); // same wall date, not today
    expect(fmtDueDay('2026-06-06', todayKey(0, at(2026, 6, 7, 0)))).toBe('was due yesterday'); // offset-0 control
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

describe('isDayKey', () => {
  it('accepts a real zero-padded date', () => {
    expect(isDayKey('2026-09-25')).toBe(true);
    expect(isDayKey('2026-01-01')).toBe(true);
    expect(isDayKey('2024-02-29')).toBe(true); // leap day
  });
  it('rejects impossible calendar dates via the round-trip', () => {
    expect(isDayKey('2026-02-30')).toBe(false);
    expect(isDayKey('2026-13-01')).toBe(false);
    expect(isDayKey('2025-02-29')).toBe(false); // 2025 is not a leap year
  });
  it('rejects unpadded and malformed shapes', () => {
    expect(isDayKey('2026-2-5')).toBe(false);
    expect(isDayKey('2026-09-5')).toBe(false);
    expect(isDayKey('26-09-25')).toBe(false);
    expect(isDayKey('2026/09/25')).toBe(false);
    expect(isDayKey('garbage')).toBe(false);
    expect(isDayKey('')).toBe(false);
    expect(isDayKey('2026-09-25 ')).toBe(false);
  });
});

describe('localEpochFromDayTime', () => {
  it('builds a local wall-clock epoch from a day key + HH:mm', () => {
    // Compared against a locally-constructed Date, so it holds in any runner timezone.
    expect(localEpochFromDayTime('2026-10-01', '09:30')).toBe(
      new Date(2026, 9, 1, 9, 30, 0, 0).getTime(),
    );
  });
});

describe('dayKeyInZone', () => {
  const LA = 'America/Los_Angeles';
  const at = (iso: string) => Date.parse(iso);
  it('is the calendar day in the zone, not UTC', () => {
    expect(dayKeyInZone(at('2026-09-27T06:00:00Z'), LA, 0)).toBe('2026-09-26'); // 23:00 PDT
    expect(dayKeyInZone(at('2026-09-27T08:00:00Z'), LA, 0)).toBe('2026-09-27'); // 01:00 PDT
  });
  it('rolls over at dayStartHour', () => {
    expect(dayKeyInZone(at('2026-09-27T10:30:00Z'), LA, 4)).toBe('2026-09-26'); // 03:30 PDT
    expect(dayKeyInZone(at('2026-09-27T11:30:00Z'), LA, 4)).toBe('2026-09-27'); // 04:30 PDT
  });
  it('follows standard time in winter', () => {
    expect(dayKeyInZone(at('2026-12-15T07:30:00Z'), LA, 0)).toBe('2026-12-14'); // 23:30 PST
    expect(dayKeyInZone(at('2026-12-15T08:30:00Z'), LA, 0)).toBe('2026-12-15'); // 00:30 PST
  });
  it('stays on the right day across both DST changes', () => {
    expect(dayKeyInZone(at('2026-03-08T12:00:00Z'), LA, 4)).toBe('2026-03-08'); // 05:00 PDT
    expect(dayKeyInZone(at('2026-11-01T12:00:00Z'), LA, 4)).toBe('2026-11-01'); // 04:00 PST
  });
});

describe('duePresets', () => {
  const at = (y: number, mo: number, d: number, h: number) =>
    new Date(y, mo - 1, d, h, 0, 0, 0).getTime();
  const flat = (today: string) => duePresets(today).map((p) => `${p.day} ${p.label}`);

  it('Wednesday: Thursday merges into Tomorrow, +7 is a date', () => {
    expect(flat('2026-09-30')).toEqual([
      '2026-09-30 Today',
      '2026-10-01 Tomorrow',
      '2026-10-02 Fri',
      '2026-10-05 Mon',
      '2026-10-06 Tue',
      '2026-10-07 Oct 7',
    ]);
  });
  it('Friday: the fifth weekday is +7, labelled as a date', () => {
    const p = flat('2026-10-02');
    expect(p).toHaveLength(7);
    expect(p.at(-1)).toBe('2026-10-09 Oct 9');
  });
  it('Saturday: eight chips, Tomorrow is Sunday', () => {
    const p = flat('2026-10-03');
    expect(p).toHaveLength(8);
    expect(p[1]).toBe('2026-10-04 Tomorrow');
    expect(p.at(-1)).toBe('2026-10-10 Oct 10');
  });
  it('Sunday: Monday is labelled Tomorrow', () => {
    const p = flat('2026-10-04');
    expect(p).toHaveLength(7);
    expect(p[1]).toBe('2026-10-05 Tomorrow');
  });
  it('crosses the year boundary', () => {
    const p = flat('2026-12-31');
    expect(p[1]).toBe('2027-01-01 Tomorrow');
    expect(p.at(-1)).toBe('2027-01-07 Jan 7');
  });
  it('respects the dayStartHour rollover via todayKey', () => {
    expect(duePresets(todayKey(4, at(2026, 10, 3, 2)))[0]!.day).toBe('2026-10-02');
    expect(duePresets(todayKey(0, at(2026, 10, 3, 2)))[0]!.day).toBe('2026-10-03');
  });
  it('stays on consecutive keys across DST', () => {
    const days = duePresets('2026-10-31').map((p) => p.day);
    expect(days).toContain('2026-11-02');
    expect(days.at(-1)).toBe('2026-11-07');
  });
});
