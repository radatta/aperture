import { useQuery } from '@tanstack/react-query';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';

// Flux's weekly note (D62): one cached line per week, null under two sets. Keyed under fluxSets so the
// outbox's flush and a delete refresh it with the sets.
// `enabled` false skips the read where the line can't show (the night home on a day without sets).
export function useFluxWeekNote(enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qk.fluxWeekNote(), queryFn: () => api.getFluxWeekNote(), enabled });
}
