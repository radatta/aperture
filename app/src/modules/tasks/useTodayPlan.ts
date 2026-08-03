import { todayKey } from '@aperture/shared';
import type { Task, TaskPlan } from '@aperture/shared';
import { useDay } from '../../data/hooks/useDay';
import { usePlansForDay } from '../../data/hooks/usePlans';
import { useSettings } from '../../data/hooks/useSettings';
import { useAllTasks } from '../../data/hooks/useTasks';
import { plannedVsAvailable, type PlannedVsAvailable } from '../calibration/calibration';

export interface TodayPlan {
  day: string;
  rows: { plan: TaskPlan; task: Task }[];
  plannedMin: number;
  spentMin: number;
  doneCount: number;
  totalCount: number;
  pva: PlannedVsAvailable;
}

// The day's plan joined to its tasks — shared by the morning plan card, the daytime tasks + budget
// cards, so they agree and don't each re-derive the join.
export function useTodayPlan(): TodayPlan {
  const { data: settings } = useSettings();
  const day = todayKey(settings?.dayStartHour ?? 4);
  const { data: dayRec } = useDay(day);
  const { data: plans = [] } = usePlansForDay(day);
  const { data: tasks = [] } = useAllTasks();

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rows = plans
    .map((plan) => ({ plan, task: byId.get(plan.taskId) }))
    .filter((r): r is { plan: TaskPlan; task: Task } => !!r.task);

  const plannedMin = plans.reduce((s, p) => s + p.plannedMinutes, 0);
  const spentMin = rows.reduce((s, r) => s + r.task.actualAccruedMin, 0);
  const doneCount = rows.filter((r) => r.task.status === 'done').length;

  return {
    day,
    rows,
    plannedMin,
    spentMin,
    doneCount,
    totalCount: rows.length,
    pva: plannedVsAvailable(plannedMin, dayRec?.capacityHours ?? null),
  };
}
