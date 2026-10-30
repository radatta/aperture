import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FluxSetFilter } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';

// Saved Flux sets (D47). Saving goes through the Flux outbox (modules/flux/useFluxOutbox), not a
// mutation here — a set must survive a failed save.
export function useFluxSets(filter: FluxSetFilter = {}) {
  const api = useApi();
  return useQuery({
    queryKey: qk.fluxSets(filter.from, filter.to, filter.exerciseId),
    queryFn: () => api.listFluxSets(filter),
  });
}

export function useDeleteFluxSet() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteFluxSet(id),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.fluxSetsAll() }),
  });
}
