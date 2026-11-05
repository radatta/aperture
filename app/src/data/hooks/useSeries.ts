import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpsertSeriesInput } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';
import { invalidateTaskData } from './invalidate';

export function useSeries() {
  const api = useApi();
  return useQuery({ queryKey: qk.series(), queryFn: () => api.listSeries() });
}

export function useUpsertSeries() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertSeriesInput) => api.upsertSeries(input),
    // The day too: a new series' occurrence due today materializes on the next getDay (lazy recurrence).
    // Not awaited — the form clears on the write's own answer, like every task write (useTasks.ts).
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.series() });
      void qc.invalidateQueries({ queryKey: ['day'] });
      void invalidateTaskData(qc);
    },
  });
}

export function useDeactivateSeries() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deactivateSeries(id),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.series() }),
  });
}
