import { useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { addDays, todayKey } from '@aperture/shared';
import type { Task, TaskPlan } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';
import { plannedDefault } from '../../modules/tasks/taskMath';
import { useRemovePlan, useUpsertPlan } from './usePlans';
import { useSettings } from './useSettings';
import { useCreateTask, useTransitionTask } from './useTasks';

export type AddResult = 'added' | 'already';

// The one way a task lands on (or leaves) a day's plan — the tasks page, Home "+ Add", capture
// "→ today", the night "Tomorrow". It owns the write order and the dedupe so no surface re-derives
// them. `day` defaults to today; never pass it to getDay (other days are read via listPlansForDay).
export function useAddToDay(day?: string) {
  const api = useApi();
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const target = day ?? todayKey(settings?.dayStartHour ?? 4);
  const upsertPlan = useUpsertPlan();
  const removePlan = useRemovePlan();
  const transition = useTransitionTask();
  const createTask = useCreateTask();
  // upsertPlan has no server-side dedupe, so a double tap must not reach it twice.
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

  // Resolve only once the lists have refetched, so a caller acting on "done" (moving focus off a row
  // that just left its list) sees the new lists, not the old ones.
  const settled = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.tasks() }),
      qc.invalidateQueries({ queryKey: ['plans'] }),
    ]);

  async function addToDay(task: Task): Promise<AddResult> {
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
      await settled();
      return exists ? 'already' : 'added';
    } finally {
      inFlight.current.delete(key);
    }
  }

  // Take a row off its day. The task goes back to backlog when it was only planned — or, with
  // `fromInProgress` (the night "Backlog"), when it was started too; its accrued time stays. A task
  // that's also on tomorrow's plan (the night "Tomorrow") keeps its status: only this row goes.
  async function unplan(plan: TaskPlan, task: Task, opts: { fromInProgress?: boolean } = {}) {
    if (inFlight.current.has(plan.id)) return;
    inFlight.current.add(plan.id);
    try {
      // Fresh, not cached: the status decides the transition, and a stale "planned" could send a
      // task started elsewhere back to the backlog.
      const fresh = (await api.getTask(task.id)) ?? task;
      const next = await api.listPlansForDay(addDays(plan.day, 1));
      const staysPlanned = next.some((p) => p.taskId === task.id);
      // Status first: removing the row first refetches the day, whose stale sweep would move the
      // task to backlog ahead of this transition (backlog → backlog throws).
      if (
        !staysPlanned &&
        (fresh.status === 'planned' || (opts.fromInProgress && fresh.status === 'in_progress'))
      )
        await transition.mutateAsync({ id: task.id, to: 'backlog' });
      await removePlan.mutateAsync(plan.id);
      await settled();
    } finally {
      inFlight.current.delete(plan.id);
    }
  }

  // Create + plan in one gesture. Two writes, not atomic: if planning fails the task still exists
  // (in the backlog), and the caller says so rather than pretending it landed on the day.
  async function createToday(title: string): Promise<{ task: Task; planned: boolean }> {
    const task = await createTask.mutateAsync(title);
    try {
      await addToDay(task);
      return { task, planned: true };
    } catch {
      return { task, planned: false };
    }
  }

  const isPending =
    upsertPlan.isPending || removePlan.isPending || transition.isPending || createTask.isPending;
  return { day: target, addToDay, unplan, createToday, isPending };
}
