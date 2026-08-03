import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpsertPlanInput } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';
import { invalidateTaskData } from './invalidate';

export function usePlansForDay(day: string) {
  const api = useApi();
  return useQuery({ queryKey: qk.plans(day), queryFn: () => api.listPlansForDay(day) });
}

export function useUpsertPlan() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertPlanInput) => api.upsertPlan(input),
    onSettled: () => invalidateTaskData(qc),
  });
}

export function useRemovePlan() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.removePlan(id),
    onSettled: () => invalidateTaskData(qc),
  });
}
