import { dayKey } from '@aperture/shared';
import type { Task } from '@aperture/shared';
import type { TodayRow } from './todayRows';

export interface TodaySplit {
  open: TodayRow[];
  done: Task[];
}

// Today's rows split for the lens: open rows stay in order (by time, then the plan); finished work drops to "Done today".
// That group is today's done plan rows (plan order) and then anything else completed today, oldest
// first, so a task finished off-plan doesn't vanish. Dropped rows go nowhere: the Done lens is their
// home. The rows themselves are untouched; capacity, Big 3 and rolls still read them as history.
export function doneToday(
  rows: TodayRow[],
  tasks: Task[],
  today: string,
  dayStartHour: number,
): TodaySplit {
  const open = rows.filter(({ task }) => task.status !== 'done' && task.status !== 'cancelled');
  // A Map keeps the first row's place, so a task with two rows today (plan writes have no server
  // dedupe yet, lenses.md §3) is listed once.
  const onPlan = new Map(
    rows.filter(({ task }) => task.status === 'done').map(({ task }) => [task.id, task] as const),
  );
  const seen = new Set(rows.map(({ task }) => task.id));
  const offPlan = tasks
    .filter(
      (t) =>
        !seen.has(t.id) &&
        t.status === 'done' &&
        t.completedAt != null &&
        dayKey(t.completedAt, dayStartHour) === today,
    )
    .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
  return { open, done: [...onPlan.values(), ...offPlan] };
}
