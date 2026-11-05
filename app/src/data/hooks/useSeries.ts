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
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.series() }),
        qc.invalidateQueries({ queryKey: ['day'] }),
        invalidateTaskData(qc),
      ]),
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
