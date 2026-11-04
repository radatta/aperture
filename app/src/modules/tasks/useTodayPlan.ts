import { todayKey } from '@aperture/shared';
import { useDay } from '../../data/hooks/useDay';
import { usePlansForDay } from '../../data/hooks/usePlans';
import { useSettings } from '../../data/hooks/useSettings';
import { useAllTasks } from '../../data/hooks/useTasks';
import { plannedVsAvailable, type PlannedVsAvailable } from '../calibration/calibration';
import { rowMinutes, todayRows, type TodayRow } from './todayRows';

export interface TodayPlan {
  day: string;
  dayStartHour: number; // the one `day` was keyed with, for bucketing other instants into it
  rows: TodayRow[]; // timed-today first (by clock), then the plan in order (todayRows.ts)
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
  // The day record (capacity) failed, or settings did so it never ran — the plan still shows, its capacity can't.
  dayError: boolean;
  retry: () => void; // refetch whichever halves failed
}

// Today's work — the timed tasks whose time falls today, then the day's plan — shared by the morning
// plan card, the daytime tasks + budget cards, so they agree and don't each re-derive it.
export function useTodayPlan(): TodayPlan {
  const settingsQ = useSettings();
  const { data: settings } = settingsQ;
  const dayStartHour = settings?.dayStartHour ?? 4;
  const day = todayKey(dayStartHour);
  const dayQ = useDay(day);
  const dayRec = dayQ.data;
  const plansQ = usePlansForDay(day);
  const tasksQ = useAllTasks();
  const { data: plans = [], isPending: plansPending, isError: plansError } = plansQ;
  const { data: tasks = [], isPending: tasksPending, isError: tasksError } = tasksQ;

  const rows = todayRows(plans, tasks, day, dayStartHour);

  // A dropped task leaves the day's load (lenses.md D11): its row stays as history but stops counting.
  const kept = rows.filter((r) => r.task.status !== 'cancelled');
  const plannedMin = kept.reduce((s, r) => s + rowMinutes(r), 0);
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
    // Only when there's nothing to show: a failed background refetch keeps the plan on screen.
    isError: (plansError && plansQ.data === undefined) || (tasksError && tasksQ.data === undefined),
    // useDay waits for settings, so a failed settings read leaves the day pending for good — a failure too.
    dayError: dayRec === undefined && (dayQ.isError || (settingsQ.isError && !settings)),
    retry: () => {
      if (settingsQ.isError) void settingsQ.refetch();
      if (plansQ.isError) void plansQ.refetch();
      if (tasksQ.isError) void tasksQ.refetch();
      if (dayQ.isError) void dayQ.refetch();
    },
  };
}
