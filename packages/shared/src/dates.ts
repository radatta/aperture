// Pure date helpers. The day-start offset lives here so the whole app buckets days through
// ONE function — late-night activity lands on the intended day. All day keys are YYYY-MM-DD
// in the runtime's LOCAL timezone (a personal app; "my day" is my wall clock).

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function keyOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// The logical day an instant belongs to, given the day-start hour.
// e.g. dayStartHour=4 → 2am Tuesday is still "Monday"; 4am exactly is Tuesday.
export function dayKey(epochMs: number, dayStartHour: number): string {
  return keyOf(new Date(epochMs - dayStartHour * MS_PER_HOUR));
}

export function todayKey(dayStartHour: number, now: number = Date.now()): string {
  return dayKey(now, dayStartHour);
}

// Day bucketing for a FOREIGN client (the LeetCode extension) that can't run the local-getter dayKey:
// it reports an instant + its own UTC offset, and the (UTC) Lambda buckets it. Uses UTC getters so the
// result is identical in the Lambda and the browser stub — parity-safe — unlike dayKey's LOCAL getters.
// getTimezoneOffset() is (UTC - local) in minutes; local wall-clock = UTC - offset.
export function dayKeyForOffset(
  epochMs: number,
  tzOffsetMinutes: number,
  dayStartHour: number,
): string {
  const shifted = new Date(epochMs - tzOffsetMinutes * 60_000 - dayStartHour * MS_PER_HOUR);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

// Day bucketing on a server that knows the user's IANA zone but not their clock (the MCP tools): the
// calendar date in `timeZone` of the instant `dayStartHour` hours earlier. Needs ICU time-zone data
// (Node 22 ships it). Across a DST change the rollover lands an hour off for that one night.
export function dayKeyInZone(epochMs: number, timeZone: string, dayStartHour: number): string {
  // en-CA formats a date as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(epochMs - dayStartHour * MS_PER_HOUR));
}

// Parse a day key to a local Date at NOON — noon keeps ±day arithmetic safe across DST shifts.
function keyToNoon(key: string): Date {
  const p = key.split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0, 0);
}

export function addDays(key: string, days: number): string {
  const d = keyToNoon(key);
  d.setDate(d.getDate() + days);
  return keyOf(d);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((keyToNoon(b).getTime() - keyToNoon(a).getTime()) / MS_PER_DAY);
}

// True iff `s` is a real, zero-padded YYYY-MM-DD calendar date. The shape check rejects unpadded
// (2026-2-5) and garbage; the round-trip rejects impossible dates (2026-02-30 rolls to Mar 2, so the
// re-keyed value differs). This is the one gate for a `due:` token — raw ISO never reaches a component.
export function isDayKey(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return keyOf(keyToNoon(s)) === s;
}

// 0 = Sunday … 6 = Saturday (JS convention), for weekly recurrence rules.
export function weekdayOf(key: string): number {
  return keyToNoon(key).getDay();
}

// ISO-8601 week: Monday-based, the week containing the year's first Thursday.
export function isoWeek(key: string): { year: number; week: number } {
  const d = keyToNoon(key);
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // Thursday of this week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY));
  return { year: date.getUTCFullYear(), week };
}

export function isoWeekKey(key: string): string {
  const { year, week } = isoWeek(key);
  return `${year}-W${pad2(week)}`;
}

// Month-first (US) display, no leading zeros: "6/7/2026" and "6/7".
export function fmtMonthDayYear(key: string): string {
  const p = key.split('-');
  return `${Number(p[1])}/${Number(p[2])}/${Number(p[0])}`;
}
export function fmtMonthDay(key: string): string {
  const p = key.split('-');
  return `${Number(p[1])}/${Number(p[2])}`;
}

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

export function fmtWeekday(key: string): string {
  return WEEKDAYS[weekdayOf(key)]!;
}

// "Fri" — short weekday, for the compact due-date phrasing.
export function fmtWeekdayShort(key: string): string {
  return WEEKDAYS[weekdayOf(key)]!.slice(0, 3);
}

// Relative due-date phrasing, at the day granularity: "due today" / "due Fri" / "was due Tue".
// Pure over (dueDay, today) — the caller passes today = todayKey(dayStartHour), so the 4am rollover
// lives in todayKey and never here. Weekday names for ±2–6 days; month/day beyond a week (where a
// weekday alone is ambiguous); today/tomorrow/yesterday for the near cases.
export function fmtDueDay(dueDay: string, today: string): string {
  const n = daysBetween(today, dueDay); // >0 future, <0 past
  if (n === 0) return 'due today';
  if (n === 1) return 'due tomorrow';
  if (n === -1) return 'was due yesterday';
  if (n >= 2 && n <= 6) return `due ${fmtWeekdayShort(dueDay)}`;
  if (n <= -2 && n >= -6) return `was due ${fmtWeekdayShort(dueDay)}`;
  return n > 0 ? `due ${fmtMonthShortDay(dueDay)}` : `was due ${fmtMonthShortDay(dueDay)}`;
}

// Capture's due: suggestion chips: today, tomorrow, the first five Mon–Fri days in today+1..+7, and
// today+7 — deduped by day, ascending. Labels tier like fmtDueDay, so a merged day has one label.
export interface DuePreset {
  day: string;
  label: string;
}
export function duePresets(today: string): DuePreset[] {
  const days = new Set([today, addDays(today, 1), addDays(today, 7)]);
  for (let n = 1, picked = 0; n <= 7 && picked < 5; n++) {
    const d = addDays(today, n);
    const wd = weekdayOf(d);
    if (wd >= 1 && wd <= 5) {
      days.add(d);
      picked++;
    }
  }
  return [...days].sort().map((day) => {
    const n = daysBetween(today, day);
    const label =
      n === 0
        ? 'Today'
        : n === 1
          ? 'Tomorrow'
          : n <= 6
            ? fmtWeekdayShort(day)
            : fmtMonthShortDay(day);
    return { day, label };
  });
}

// Header form: "Saturday, Aug 2" — the glanceable date for the home.
export function fmtDayHeading(key: string): string {
  const p = key.split('-');
  return `${fmtWeekday(key)}, ${MONTHS[Number(p[1]) - 1]} ${Number(p[2])}`;
}

// Compact form: "Aug 2" — labels a row in a calendar grid, where the weekday is already the column.
export function fmtMonthShortDay(key: string): string {
  const p = key.split('-');
  return `${MONTHS[Number(p[1]) - 1]} ${Number(p[2])}`;
}

// Local wall-clock epoch from a day key ("YYYY-MM-DD") + "HH:mm" — the start a user picks for a
// calendar event, in their own timezone. A calendar event owns its clock; this is never stored on the
// task, so it's a plain local Date construction (not day-key math).
export function localEpochFromDayTime(dayKey: string, hhmm: string): number {
  const [y, m, d] = dayKey.split('-').map(Number) as [number, number, number];
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}
