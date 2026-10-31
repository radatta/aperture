import { dayKey, DEFAULT_EVENT_MIN, isTimed, placedByTime } from '@aperture/shared';
import type { Task, TaskPlan } from '@aperture/shared';
import { plannedDefault } from './taskMath';

// A row of today's work. `byTime`: on Today because its time falls today (option 3, lenses.md D13) —
// listed by clock, never unplanned or made a focus. `plan`: today's row for it, if any (a timed task's
// is a legacy row: history, its minutes still count).
export interface TodayRow {
  task: Task;
  plan: TaskPlan | null;
  byTime: boolean;
}

const finished = (t: Task) => t.status === 'done' || t.status === 'cancelled';

// Today's work: every timed task whose time falls today, by clock (a parent's deadline is its marker,
// never a row; one finished before today is gone), then the plan rows in their order. A plan row on a
// timed task is history and places nothing.
export function todayRows(
  plans: TaskPlan[],
  tasks: Task[],
  today: string,
  dayStartHour: number,
): TodayRow[] {
  const parents = new Set(tasks.map((t) => t.parentId).filter((id): id is string => !!id));
  const rowOf = new Map<string, TaskPlan>();
  for (const p of plans) if (!rowOf.has(p.taskId)) rowOf.set(p.taskId, p);
  const doneToday = (t: Task) =>
    t.status === 'done' && t.completedAt != null && dayKey(t.completedAt, dayStartHour) === today;
  const timed = tasks
    .filter((t) => placedByTime(t, today) && !parents.has(t.id) && (!finished(t) || doneToday(t)))
    .sort((a, b) => a.dueTime!.localeCompare(b.dueTime!) || a.createdAt - b.createdAt)
    .map((task) => ({ task, plan: rowOf.get(task.id) ?? null, byTime: true }));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const planned = plans.flatMap((plan) => {
    const task = byId.get(plan.taskId);
    return task && !isTimed(task) ? [{ task, plan, byTime: false }] : [];
  });
  return [...timed, ...planned];
}

// What a row asks of the day: its plan row's minutes, else the block it takes on the calendar.
export const rowMinutes = (r: TodayRow): number =>
  r.plan?.plannedMinutes ?? (plannedDefault(r.task) || DEFAULT_EVENT_MIN);
