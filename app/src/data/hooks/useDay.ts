import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';
import { invalidateTaskData } from './invalidate';

// getDay lazily materializes due recurring occurrences and sweeps stale planned tasks back to backlog
// (stub + Lambda both). Sibling task queries may have resolved before those writes landed, so refetch
// them once the day comes back — once per real fetch, not per mounted consumer.
export function useDay(day: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useQuery({
    queryKey: qk.day(day),
    queryFn: async () => {
      const d = await api.getDay(day);
      for (const key of [qk.tasks(), qk.backlog(), qk.plans(day)]) qc.invalidateQueries({ queryKey: key });
      return d;
    },
  });
}

export function useSetCapacity(day: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (capacityHours: number | null) => api.setDayCapacity(day, capacityHours),
    onSettled: () => invalidateTaskData(qc),
  });
}

export function useSetIntent(day: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (intent: string) => api.setDayIntent(day, intent),
    onSuccess: (next) => qc.setQueryData(qk.day(day), next),
  });
}

export function useSetReflection(day: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { prompt: string; text: string }) =>
      api.setDayReflection(day, v.prompt, v.text),
    onSuccess: (next) => qc.setQueryData(qk.day(day), next),
  });
}
