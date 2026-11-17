import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PatternId } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';

// The Patterns tab's reads (docs/areas/recruiting/coach.md): the stats and the day's focus, both derived on read
// under the 'coach' prefix, so a sitting, review or focus write refreshes them with one invalidation.
export function useCoachStats() {
  const api = useApi();
  return useQuery({ queryKey: qk.coachStats(), queryFn: () => api.getCoachStats() });
}
// The focus as the day's plan holds it: the getCoachToday query under qk.coachToday(), one cache entry for any
// view of the day.
export function useCoachFocus() {
  const api = useApi();
  return useQuery({
    queryKey: qk.coachToday(),
    queryFn: () => api.getCoachToday(),
    select: (t) => t.focus,
  });
}
// The focus override moves the whole plan and the ranking's marker: everything under 'coach' is read again.
export function useSetFocusPattern() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pattern: PatternId | null) => api.setCoachFocus(pattern),
    // Settled, not success: a failed write may still have landed (a 5xx), so the focus is read again either way.
    onSettled: () => qc.invalidateQueries({ queryKey: qk.coach() }),
  });
}
