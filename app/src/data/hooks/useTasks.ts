import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import type {
  ApiClient,
  CreateTaskInput,
  ParseTaskResult,
  SetTaskDueInput,
  SplitTaskInput,
  Task,
  TaskStatus,
} from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';
import { mergeServerList, putTasks, removeTask } from '../taskCache';
import { invalidateTaskData } from './invalidate';

// The one tasks query: the server's list merged with what our own writes returned (taskCache.ts), so a
// stale read never undoes a write. Shared with useBacklog, which derives from it.
export const tasksQuery = (api: ApiClient, qc: QueryClient) => ({
  queryKey: qk.tasks(),
  queryFn: async () => mergeServerList(qc, await api.listTasks()),
});

// All live tasks (any status) — views derive backlog/planned/in-progress/done from this.
export function useAllTasks() {
  const api = useApi();
  const qc = useQueryClient();
  return useQuery(tasksQuery(api, qc));
}

// Every task write: its answer goes into the list now (taskCache.ts); the invalidate still runs for what
// the answer doesn't carry (a parent's lock, a dropped parent's parts, plan rows). Not awaited: a surface
// acting on the write's own answer (the modal's close, PR 77) never waits on the list. With `settled`
// the mutation resolves only once the refetch lands — for a caller moving focus off a row that just left
// its list (useAddToDay).
const written = (qc: QueryClient, settled = false) => ({
  onSuccess: (t: Task) => putTasks(qc, [t]),
  onSettled: () => (settled ? invalidateTaskData(qc) : void invalidateTaskData(qc)),
});

// Capture creates backlog tasks and never asks for structure: a bare string is title-only, and a Task
// capture's optional ' | ' tokens (the bulk grammar, parsed before this) arrive as a full input.
export function useCreateTask() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: string | CreateTaskInput) =>
      api.createTask(typeof input === 'string' ? { title: input } : input),
    ...written(qc),
  });
}

// Quick add's parse (Haiku, server-side). A read that writes nothing and caches nothing — each line is
// parsed once, on demand — so a plain call rather than a query or a mutation.
export function useParseTask(): (text: string) => Promise<ParseTaskResult> {
  const api = useApi();
  return useCallback((text: string) => api.parseTask(text), [api]);
}

// Bulk add — the plan-pass surface (PRODUCT §2: batch entry is the morning plan, not capture). Inputs
// come pre-parsed from the bulk grammar; every one lands as an unlocked backlog task.
export function useCreateTasks() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (inputs: CreateTaskInput[]) => api.createTasks(inputs),
    onSuccess: (ts: Task[]) => putTasks(qc, ts),
    onSettled: () => void invalidateTaskData(qc),
  });
}

// Estimate + buffer — the working estimate, accepted at any open status (done/cancelled throw, via the
// shared machine). The calibration baseline frozen at start never moves. Category is set here too.
export function useSetEstimate() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; estimateMin: number | null; bufferMin: number | null }) =>
      api.setTaskEstimate(v.id, v.estimateMin, v.bufferMin),
    ...written(qc),
  });
}

// Category assignment — no freeze constraint (see the contract note).
export function useSetCategory() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; categoryId: string | null }) =>
      api.setTaskCategory(v.id, v.categoryId),
    ...written(qc),
  });
}

// The errand list a task is on (a Place slug, or null) — settable while it's open (a finished task's place is
// history) and on a parent, whose open parts move with it; a part follows its parent, an unknown slug is refused.
export function useSetTaskPlace() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; place: string | null }) => api.setTaskPlace(v.id, v.place),
    ...written(qc),
  });
}

// One-tap errand check-off (Places lens). backlog → done isn't a legal edge (machines.ts), so an unstarted
// errand is started then finished, as complete_task chains it. No actual is asked: an errand is never a
// calibration point. If the finish fails the errand is left started — the invalidate shows it in Today.
export function useCheckOffErrand() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (task: Task) => {
      if (task.status !== 'in_progress')
        putTasks(qc, [await api.transitionTask(task.id, 'in_progress')]);
      return api.transitionTask(task.id, 'done');
    },
    ...written(qc),
  });
}

// Due date — day-granular deadline metadata. No freeze constraint: settable at any status.
// Deadline day + optional time, one write (and one calendar sync — see setTaskDue). The one task write
// that also refetches the day: a planned task gaining a time is on its day by that time now (lenses.md
// D13), and getDay's sweep is what moves it off the plan's status.
export function useSetDue() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; due: SetTaskDueInput }) => api.setTaskDue(v.id, v.due),
    onSuccess: (t: Task) => putTasks(qc, [t]),
    onSettled: () => {
      void invalidateTaskData(qc);
      void qc.invalidateQueries({ queryKey: ['day'] });
    },
  });
}

// Rename. Display text — settable at any status, never touches the estimate lock (see setTaskTitle).
export function useSetTaskTitle() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; title: string }) => api.setTaskTitle(v.id, v.title),
    ...written(qc),
  });
}

// The reflection (reflection.md): settable at any status, never part of the estimate lock.
export function useSetTaskReflection() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; reflection: string | null }) =>
      api.setTaskReflection(v.id, v.reflection),
    ...written(qc),
  });
}

// Notes. Like the title, settable at any status and never part of the estimate lock (see setTaskNotes).
export function useSetTaskNotes() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; notes: string | null }) => api.setTaskNotes(v.id, v.notes),
    ...written(qc),
  });
}

// The lifecycle move. Crossing out of planning (→ in_progress|done) freezes estimateLockedMin inside
// the shared machine — this hook doesn't need to know, it just calls it. `settled`: see `written`.
export function useTransitionTask(opts: { settled?: boolean } = {}) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; to: TaskStatus }) => api.transitionTask(v.id, v.to),
    ...written(qc, opts.settled),
  });
}

// Records the actual on "done" (prefilled from pomodoro time, but editable).
export function useSetActual() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    // reflection undefined keeps the task's current one; null clears it.
    mutationFn: (v: { id: string; actualMin: number; reflection?: string | null }) =>
      api.setTaskActual(v.id, v.actualMin, v.reflection),
    ...written(qc),
  });
}

// Split: the original finishes or keeps going, the rest becomes a linked follow-up (split.ts). Never
// cancels, never edits the locked estimate — that's the calibration integrity.
export function useSplitTask() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; input: SplitTaskInput }) => api.splitTask(v.id, v.input),
    onSuccess: (r) => putTasks(qc, [r.parent, r.original, r.followUp]),
    onSettled: () => void invalidateTaskData(qc),
  });
}

// Permanent delete (distinct from cancel). Cascade-tombstones the task's plans + attachment metadata,
// so also refresh the attachments key — invalidateTaskData doesn't cover it.
export function useDeleteTask() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteTask(id),
    onSuccess: (_v: void, id: string) => removeTask(qc, id),
    onSettled: () => {
      void invalidateTaskData(qc);
      void qc.invalidateQueries({ queryKey: qk.attachments() });
    },
  });
}
