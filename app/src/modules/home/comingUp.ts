import type { Task } from '@aperture/shared';
import { daysBetween, timedDay } from '@aperture/shared';
import { byDueHint } from '../tasks/taskMath';

// The deadline radar: a capped, soonest-due-first glance you plan FROM. No countdown, no overdue tally
// (due-dates D5); a TIMED row takes the urgency colour (D5 revisited, due.ts) — untimed stay flat.
// Overdue sorts first only because it's the soonest date.
export const RADAR_CAP = 3;

export interface ComingUp {
  items: Task[]; // ≤ RADAR_CAP, soonest-due first
  moreThisWeek: number; // additional dated tasks due within 6 days, beyond the cap
  moreLater: number; // additional dated tasks further out
}

// `excludeIds` = everything already shown in Right Now (the tight plane), so a deadline never appears
// twice. Undated / done / cancelled never reach the radar, and neither do parts: a part's own time is
// when its block ends, not a deadline — the deadline is its parent's, which is on the radar (parts.ts).
// "This week" counts by the same day as /tasks' Week: a timed task's is its deadline's app day.
export function comingUp(
  tasks: Task[],
  today: string,
  excludeIds: Set<string>,
  dayStartHour: number,
): ComingUp {
  const dated = tasks.filter(
    (t) =>
      !!t.dueDay &&
      !t.parentId &&
      t.status !== 'done' &&
      t.status !== 'cancelled' &&
      !excludeIds.has(t.id),
  );
  const sorted = byDueHint(dated); // dated ascending, stable, non-mutating
  const items = sorted.slice(0, RADAR_CAP);
  const rest = sorted.slice(RADAR_CAP);
  const dayOf = (t: Task) => timedDay(t, dayStartHour) ?? t.dueDay!;
  const moreThisWeek = rest.filter((t) => daysBetween(today, dayOf(t)) <= 6).length;
  return { items, moreThisWeek, moreLater: rest.length - moreThisWeek };
}
