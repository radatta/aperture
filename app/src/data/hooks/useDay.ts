import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';
import { invalidateTaskData } from './invalidate';
import { useSettings } from './useSettings';

// getDay lazily materializes due recurring occurrences and sweeps stale planned tasks back to backlog
// (stub + Lambda both). Sibling task queries may have resolved before those writes landed, so refetch
// them once the day comes back — once per real fetch, not per mounted consumer. Waits for settings:
// callers derive `day` from dayStartHour with a fallback, and a fallback that lands on tomorrow would
// be refused by the server (FUTURE_DAY_ERROR, a visible error) — the guard is the server's; waiting
// just avoids showing it.
export function useDay(day: string) {
  const api = useApi();
  const qc = useQueryClient();
  // Settings' data, not its status: a failed background refetch flips the status to error with the data still
  // there, and a new day key (the 4am rollover, app left open) must still load.
  const { data: settings } = useSettings();
  return useQuery({
    queryKey: qk.day(day),
    enabled: settings !== undefined,
    queryFn: async () => {
      const d = await api.getDay(day);
      for (const key of [qk.tasks(), qk.plans(day)]) qc.invalidateQueries({ queryKey: key });
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
