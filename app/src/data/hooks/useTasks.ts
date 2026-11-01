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
// the answer doesn't carry (a parent's lock, a dropped parent's parts, plan rows, the day's sweep).
const written = (qc: QueryClient) => ({
  onSuccess: (t: Task) => putTasks(qc, [t]),
  onSettled: () => invalidateTaskData(qc),
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
    onSettled: () => invalidateTaskData(qc),
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

// Due date — day-granular deadline metadata. No freeze constraint: settable at any status.
// Deadline day + optional time, one write (and one calendar sync — see setTaskDue).
export function useSetDue() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; due: SetTaskDueInput }) => api.setTaskDue(v.id, v.due),
    ...written(qc),
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
// the shared machine — this hook doesn't need to know, it just calls it.
export function useTransitionTask() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; to: TaskStatus }) => api.transitionTask(v.id, v.to),
    ...written(qc),
  });
}

// Records the actual on "done" (prefilled from pomodoro time, but editable).
export function useSetActual() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; actualMin: number }) => api.setTaskActual(v.id, v.actualMin),
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
    onSettled: () => invalidateTaskData(qc),
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
      invalidateTaskData(qc);
      qc.invalidateQueries({ queryKey: qk.attachments() });
    },
  });
}
