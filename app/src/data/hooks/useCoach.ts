import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CoachSlotInput, CoachToday, PatternId } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';

// The LeetCode coach's day (docs/areas/recruiting/coach.md): derived on read, so a write elsewhere (a sitting, a
// review's cause, a rep's Done) only needs the 'coach' prefix invalidated.
export function useCoachToday(opts: { enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: qk.coachToday(),
    queryFn: () => api.getCoachToday(),
    enabled: opts.enabled ?? true,
  });
}

// Slot and floor writes hand back the day's plan after them: it lands in the cache as is.
function usePlanWrite<T>(fn: (input: T) => Promise<CoachToday>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (today) => qc.setQueryData(qk.coachToday(), today),
  });
}
export function useSetCoachSlot() {
  const api = useApi();
  return usePlanWrite((input: CoachSlotInput) => api.setCoachSlot(input));
}
export function useSetCoachFloor() {
  const api = useApi();
  return usePlanWrite((on: boolean) => api.setCoachFloor(on));
}

// The focus override moves the whole plan, so the day is read again.
export function useSetCoachFocus() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pattern: PatternId | null) => api.setCoachFocus(pattern),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.coach() }),
  });
}
