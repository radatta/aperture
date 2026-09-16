import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TaskStatus } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';
import { invalidateTaskData } from './invalidate';

// All live tasks (any status) — views derive backlog/planned/in-progress/done from this.
export function useAllTasks() {
  const api = useApi();
  return useQuery({ queryKey: qk.tasks(), queryFn: () => api.listTasks() });
}

// Capture creates title-only backlog tasks — never asks for structure (estimate/category come later
// in the plan pass).
export function useCreateTask() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (title: string) => api.createTask({ title }),
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
export function useSetDueDay() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; dueDay: string | null }) => api.setTaskDueDay(v.id, v.dueDay),
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
