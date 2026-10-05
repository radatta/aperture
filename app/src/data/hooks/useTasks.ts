import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateTaskInput, SetTaskDueInput, TaskStatus } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';
import { invalidateTaskData } from './invalidate';

// All live tasks (any status) — views derive backlog/planned/in-progress/done from this.
export function useAllTasks() {
  const api = useApi();
  return useQuery({ queryKey: qk.tasks(), queryFn: () => api.listTasks() });
}

// Capture creates backlog tasks and never asks for structure: a bare string is title-only, and a Task
// capture's optional ' | ' tokens (the bulk grammar, parsed before this) arrive as a full input.
export function useCreateTask() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: string | CreateTaskInput) =>
      api.createTask(typeof input === 'string' ? { title: input } : input),
    onSettled: () => invalidateTaskData(qc),
  });
}

// Bulk add — the plan-pass surface (PRODUCT §2: batch entry is the morning plan, not capture). Inputs
// come pre-parsed from the bulk grammar; every one lands as an unlocked backlog task.
export function useCreateTasks() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (inputs: CreateTaskInput[]) => api.createTasks(inputs),
    onSettled: () => invalidateTaskData(qc),
  });
}

// Estimate + buffer — only accepted while backlog|planned (the stub throws once frozen, via the
// shared machine). Category is set here too.
export function useSetEstimate() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; estimateMin: number | null; bufferMin: number | null }) =>
      api.setTaskEstimate(v.id, v.estimateMin, v.bufferMin),
    onSettled: () => invalidateTaskData(qc),
  });
}

// Category assignment — no freeze constraint (see the contract note).
export function useSetCategory() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; categoryId: string | null }) =>
      api.setTaskCategory(v.id, v.categoryId),
    onSettled: () => invalidateTaskData(qc),
  });
}

// Due date — day-granular deadline metadata. No freeze constraint: settable at any status.
// Deadline day + optional time, one write (and one calendar sync — see setTaskDue).
export function useSetDue() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; due: SetTaskDueInput }) => api.setTaskDue(v.id, v.due),
    onSettled: () => invalidateTaskData(qc),
  });
}

// Rename. Display text — settable at any status, never touches the estimate lock (see setTaskTitle).
export function useSetTaskTitle() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; title: string }) => api.setTaskTitle(v.id, v.title),
    onSettled: () => invalidateTaskData(qc),
  });
}

// Notes. Like the title, settable at any status and never part of the estimate lock (see setTaskNotes).
export function useSetTaskNotes() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; notes: string | null }) => api.setTaskNotes(v.id, v.notes),
    onSettled: () => invalidateTaskData(qc),
  });
}

// The lifecycle move. Crossing out of planning (→ in_progress|done) freezes estimateLockedMin inside
// the shared machine — this hook doesn't need to know, it just calls it.
export function useTransitionTask() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; to: TaskStatus }) => api.transitionTask(v.id, v.to),
    onSettled: () => invalidateTaskData(qc),
  });
}

// Records the actual on "done" (prefilled from pomodoro time, but editable).
export function useSetActual() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; actualMin: number }) => api.setTaskActual(v.id, v.actualMin),
    onSettled: () => invalidateTaskData(qc),
  });
}

// Scope change = split (finish/cancel the original, spawn a fresh backlog follow-up). Never edits the
// locked estimate — that's the calibration integrity.
export function useSplitTask() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; finishStatus: 'done' | 'cancelled'; followUpTitle: string }) =>
      api.splitTask(v.id, v.finishStatus, v.followUpTitle),
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
    onSettled: () => {
      invalidateTaskData(qc);
      qc.invalidateQueries({ queryKey: qk.attachments() });
    },
  });
}
