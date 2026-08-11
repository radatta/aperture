import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';
import { invalidateTaskData } from './invalidate';

// getDay lazily materializes any due recurring-series occurrences for the day (stub + Lambda both).
export function useDay(day: string) {
  const api = useApi();
  return useQuery({ queryKey: qk.day(day), queryFn: () => api.getDay(day) });
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
