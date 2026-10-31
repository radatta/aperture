import type { TodayRow } from '../tasks/todayRows';

// The night "Still open — when?" step: today's rows whose task isn't finished, isn't already
// headed for tomorrow, and wasn't waved off ("Leave") this session. Asking *when* rather than counting
// what's left — an unfinished task gets a next step, not a tally.
export function stillOpen(
  rows: TodayRow[],
  tomorrowTaskIds: Set<string>,
  left: Set<string>,
): TodayRow[] {
  return rows.filter(
    ({ task }) =>
      (task.status === 'planned' || task.status === 'backlog' || task.status === 'in_progress') &&
      !tomorrowTaskIds.has(task.id) &&
      !left.has(task.id),
  );
}
