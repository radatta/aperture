import type { Task, TaskPlan } from '@aperture/shared';

export interface PlanRow {
  plan: TaskPlan;
  task: Task;
}

// The night "Still open — when?" step: today's plan rows whose task isn't finished, isn't already
// headed for tomorrow, and wasn't waved off ("Leave") this session. Asking *when* rather than counting
// what's left — an unfinished task gets a next step, not a tally.
export function stillOpen(
  rows: PlanRow[],
  tomorrowTaskIds: Set<string>,
  left: Set<string>,
): PlanRow[] {
  return rows.filter(
    ({ task }) =>
      (task.status === 'planned' || task.status === 'backlog' || task.status === 'in_progress') &&
      !tomorrowTaskIds.has(task.id) &&
      !left.has(task.id),
  );
}
