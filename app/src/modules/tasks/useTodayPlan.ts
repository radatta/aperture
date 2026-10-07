import { todayKey } from '@aperture/shared';
import type { Task, TaskPlan } from '@aperture/shared';
import { useDay } from '../../data/hooks/useDay';
import { usePlansForDay } from '../../data/hooks/usePlans';
import { useSettings } from '../../data/hooks/useSettings';
import { useAllTasks } from '../../data/hooks/useTasks';
import { plannedVsAvailable, type PlannedVsAvailable } from '../calibration/calibration';

export interface TodayPlan {
  day: string;
  dayStartHour: number; // the one `day` was keyed with, for bucketing other instants into it
  rows: { plan: TaskPlan; task: Task }[];
  plannedMin: number;
  spentMin: number;
  doneCount: number;
  totalCount: number;
  pva: PlannedVsAvailable;
  // True until BOTH halves of the join have landed. Consumers render "nothing planned today"
  // off totalCount === 0, which is also what an in-flight query looks like.
  isPending: boolean;
  // ...and what a FAILED one looks like. Without this, an error renders as a confident empty plan.
  isError: boolean;
}

// The day's plan joined to its tasks — shared by the morning plan card, the daytime tasks + budget
// cards, so they agree and don't each re-derive the join.
export function useTodayPlan(): TodayPlan {
  const { data: settings } = useSettings();
  const dayStartHour = settings?.dayStartHour ?? 4;
  const day = todayKey(dayStartHour);
  const { data: dayRec } = useDay(day);
  const { data: plans = [], isPending: plansPending, isError: plansError } = usePlansForDay(day);
  const { data: tasks = [], isPending: tasksPending, isError: tasksError } = useAllTasks();

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rows = plans
    .map((plan) => ({ plan, task: byId.get(plan.taskId) }))
    .filter((r): r is { plan: TaskPlan; task: Task } => !!r.task);

  // A dropped task leaves the day's load (lenses.md D11): its row stays as history but stops counting.
  const kept = plans.filter((p) => byId.get(p.taskId)?.status !== 'cancelled');
  const plannedMin = kept.reduce((s, p) => s + p.plannedMinutes, 0);
  const spentMin = rows.reduce((s, r) => s + r.task.actualAccruedMin, 0);
  const doneCount = rows.filter((r) => r.task.status === 'done').length;

  return {
    day,
    dayStartHour,
    rows,
    plannedMin,
    spentMin,
    doneCount,
    totalCount: rows.filter((r) => r.task.status !== 'cancelled').length,
    pva: plannedVsAvailable(plannedMin, dayRec?.capacityHours ?? null),
    isPending: plansPending || tasksPending,
    isError: plansError || tasksError,
  };
}
