import { addDays, weekdayOf } from '@aperture/shared';

// The Monday that starts the ISO week containing `key` (weeks are Mon–Sun here).
export function mondayOf(key: string): string {
  return addDays(key, -((weekdayOf(key) + 6) % 7));
}

// The 7 day-keys (Mon…Sun) of the week containing `key`.
export function weekDates(key: string): string[] {
  const mon = mondayOf(key);
  return Array.from({ length: 7 }, (_, i) => addDays(mon, i));
}

// The last `n` weeks up to and including the week of `today`, oldest first — the calendar grid.
export function recentWeeks(today: string, n: number): string[][] {
  const mon = mondayOf(today);
  return Array.from({ length: n }, (_, i) => weekDates(addDays(mon, -(n - 1 - i) * 7)));
}

export function countIn(dates: Set<string>, days: string[]): number {
  return days.reduce((n, d) => n + (dates.has(d) ? 1 : 0), 0);
}
