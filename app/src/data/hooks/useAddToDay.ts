import { useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { todayKey } from '@aperture/shared';
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
      if (plans.some((p) => p.taskId === task.id)) return 'already';
      // Row first: a task moved to planned before its row exists is what the stale sweep moves back.
      await upsertPlan.mutateAsync({
        taskId: task.id,
        day: target,
        plannedMinutes: plannedDefault(task) || task.estimateMin || 30,
        order: plans.length,
      });
      // Only backlog becomes planned: a planned task already is, and in_progress → planned is illegal.
      const fresh = (await api.getTask(task.id)) ?? task;
      if (fresh.status === 'backlog') await transition.mutateAsync({ id: task.id, to: 'planned' });
      return 'added';
    } finally {
      inFlight.current.delete(key);
    }
  }

  // Take a row off its day. The task goes back to backlog when it was only planned — or, with
  // `fromInProgress` (the night "Backlog"), when it was started too; its accrued time stays.
  async function unplan(plan: TaskPlan, task: Task, opts: { fromInProgress?: boolean } = {}) {
    // Status first: removing the row first refetches the day, whose stale sweep would move the task
    // to backlog ahead of this transition (backlog → backlog throws).
    if (task.status === 'planned' || (opts.fromInProgress && task.status === 'in_progress'))
      await transition.mutateAsync({ id: task.id, to: 'backlog' });
    await removePlan.mutateAsync(plan.id);
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
