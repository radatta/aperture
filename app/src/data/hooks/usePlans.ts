import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TaskPlan, UpsertPlanInput } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';

export function usePlansForDay(day: string) {
  const api = useApi();
  return useQuery({ queryKey: qk.plans(day), queryFn: () => api.listPlansForDay(day) });
}

// A plan write touches no task, so the plan hooks own their key: the row the server returned goes into
// that day's list now, then every mounted plans query refetches once (the server dedupes per (task, day)
// and may have answered with a row another device wrote). Resolves once that refetch lands.
export function useUpsertPlan() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertPlanInput) => api.upsertPlan(input),
    onSuccess: (row, input) =>
      qc.setQueryData<TaskPlan[]>(
        qk.plans(input.day),
        (rows) =>
          rows &&
          (rows.some((r) => r.id === row.id)
            ? rows.map((r) => (r.id === row.id ? row : r))
            : [...rows, row]),
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: ['plans'] }),
  });
}

// Takes the row's day too, so the removal shows in that day's list before the refetch.
export function useRemovePlan() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; day: string }) => api.removePlan(v.id),
    onSuccess: (_v: void, { id, day }) =>
      qc.setQueryData<TaskPlan[]>(qk.plans(day), (rows) => rows?.filter((r) => r.id !== id)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['plans'] }),
  });
}
