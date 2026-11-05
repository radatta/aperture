import { useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isTimed, todayKey } from '@aperture/shared';
import type { CreateTaskInput, Task, TaskPlan, TaskStatus } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';
import { plannedDefault } from '../../modules/tasks/taskMath';
import { invalidateTaskData } from './invalidate';
import { useRemovePlan, useUpsertPlan } from './usePlans';
import { useSettings } from './useSettings';
import { useCreateTask, useTransitionTask } from './useTasks';

// 'timed': a timed task's day is its time — it's never planned (lenses.md D13); nothing was written.
export type AddResult = 'added' | 'already' | 'timed';

// The one way a task lands on (or leaves) a day's plan — the tasks page, Home "+ Add", capture
// "→ today", the night "Tomorrow". It owns the write order and the dedupe so no surface re-derives
// them. `day` defaults to today; never pass it to getDay (other days are read via listPlansForDay).
// Each write's hook refetches what it changed and resolves only once the lists are new, so a caller
// acting on "done" (moving focus off a row that just left its list) sees the new lists — one tasks
// read and no day read per add (useAddToDay.test.tsx counts them; lenses.md D5).
export function useAddToDay(day?: string) {
  const api = useApi();
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const target = day ?? todayKey(settings?.dayStartHour ?? 4);
  const upsertPlan = useUpsertPlan();
  const removePlan = useRemovePlan();
  const transition = useTransitionTask({ settled: true }); // the row leaves its list before we resolve
  const createTask = useCreateTask();
  // upsertPlan dedupes per (task, day) server-side; the set still guards the status step from a
  // double tap, and the pre-read below still sets `order` and `already`.
  const inFlight = useRef(new Set<string>());

  // Settings may still be loading at first render, when `target` is the 4am fallback — resolve the
  // real today before writing, or an early add could land on the wrong day.
  async function resolveDay(): Promise<string> {
    if (day) return day;
    const s = await qc.ensureQueryData({
      queryKey: qk.settings(),
      queryFn: () => api.getSettings(),
    });
    return todayKey(s.dayStartHour);
  }

  async function addToDay(task: Task): Promise<AddResult> {
    if (isTimed(task)) return 'timed';
    const target = await resolveDay();
    const key = `${target}:${task.id}`;
    if (inFlight.current.has(key)) return 'already';
    inFlight.current.add(key);
    try {
      // A fresh read, not the cached list: another tab, device or the MCP may have planned it since.
      const plans = await qc.fetchQuery({
        queryKey: qk.plans(target),
        queryFn: () => api.listPlansForDay(target),
        staleTime: 0,
      });
      const exists = plans.some((p) => p.taskId === task.id);
      // Row first: a task moved to planned before its row exists is what the stale sweep moves back.
      if (!exists)
        await upsertPlan.mutateAsync({
          taskId: task.id,
          day: target,
          plannedMinutes: plannedDefault(task) || task.estimateMin || 30,
          order: plans.length,
        });
      // Only backlog becomes planned: a planned task already is, and in_progress → planned is illegal.
      // Runs on the "already" path too, so a retry repairs a half-done add (row written, transition
      // lost) instead of leaving a backlog task sitting on the day's plan.
      const fresh = (await api.getTask(task.id)) ?? task;
      if (fresh.status === 'backlog') await transition.mutateAsync({ id: task.id, to: 'planned' });
      return exists ? 'already' : 'added';
    } finally {
      inFlight.current.delete(key);
    }
  }

  // Take a row off its day. A planned task goes back to backlog unless it's still planned for a later
  // day (the night "Tomorrow", or a row the MCP wrote) — the stale sweep owns that rule, so today's
  // rows let it decide rather than re-deriving it here. With `fromInProgress` (the night "Backlog") a
  // started task goes back too; its accrued time stays. A status moved here before the row's removal
  // is put back when that removal fails: a failed unplan leaves the task where it found it, so a retry
  // — or the night row's restarted timer — meets the same task, not a backlog one still on the plan.
  async function unplan(plan: TaskPlan, task: Task, opts: { fromInProgress?: boolean } = {}) {
    if (inFlight.current.has(plan.id)) return;
    inFlight.current.add(plan.id);
    let moved: TaskStatus | null = null; // the status before our move, to restore
    const move = async (fresh: Task, to: TaskStatus) => {
      await transition.mutateAsync({ id: task.id, to });
      moved = fresh.status;
    };
    const remove = async () => {
      try {
        await removePlan.mutateAsync({ id: plan.id, day: plan.day });
      } catch (err) {
        if (moved) await transition.mutateAsync({ id: task.id, to: moved }).catch(() => undefined);
        throw err;
      }
    };
    try {
      // Fresh, not cached: a stale status could send a task started elsewhere back to the backlog.
      const fresh = (await api.getTask(task.id)) ?? task;
      // The sweep never touches in_progress, so that move is explicit (and safe to do first).
      if (opts.fromInProgress && fresh.status === 'in_progress') await move(fresh, 'backlog');
      if (plan.day === (await resolveDay())) {
        await remove();
        // getDay(today) sweeps a planned task with no row today or later to backlog, and leaves one
        // that's planned ahead alone. Fetched with its own queryFn, so useDay's cascade doesn't run;
        // the one refetch after it is for what the sweep moved.
        await qc.fetchQuery({
          queryKey: qk.day(plan.day),
          queryFn: () => api.getDay(plan.day),
          staleTime: 0,
        });
        await invalidateTaskData(qc);
      } else {
        // Not today's row, so no sweep to lean on: the status move is explicit. Status first — a task
        // planned on two days keeps its status once its other row is gone (backlog → backlog throws).
        if (fresh.status === 'planned') await move(fresh, 'backlog');
        await remove();
      }
    } finally {
      inFlight.current.delete(plan.id);
    }
  }

  // Create + plan in one gesture. Two writes, not atomic: if planning fails the task still exists
  // (in the backlog), and the caller says so rather than pretending it landed on the day.
  // A tokenised capture's estimate flows into plannedMinutes via plannedDefault, same as any add. A
  // timed capture isn't planned (`timed`): it's on its own day by its time, and the caller says that.
  async function createToday(
    input: string | CreateTaskInput,
  ): Promise<{ task: Task; planned: boolean; timed: boolean }> {
    const task = await createTask.mutateAsync(input);
    try {
      const timed = (await addToDay(task)) === 'timed';
      return { task, planned: !timed, timed };
    } catch {
      return { task, planned: false, timed: false };
    }
  }

  const isPending =
    upsertPlan.isPending || removePlan.isPending || transition.isPending || createTask.isPending;
  return { day: target, addToDay, unplan, createToday, isPending };
}
