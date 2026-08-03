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

// Header form: "Saturday, Aug 2" — the glanceable date for the home.
export function fmtDayHeading(key: string): string {
  const p = key.split('-');
  return `${fmtWeekday(key)}, ${MONTHS[Number(p[1]) - 1]} ${Number(p[2])}`;
}
