import { useEffect } from 'react';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import type { CoachSlotInput, CoachToday, MockInput, PatternId } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';

// The LeetCode coach's day (docs/areas/recruiting/coach.md): derived on read, so a write elsewhere (a sitting, a
// review's cause, a rep's Done) only needs the 'coach' prefix invalidated. The day's AI pick rides on it: the first
// read that finds it `due` starts it (once per day per client — the server's claim is the real once), and the day is
// polled while it's `pending`; a claim that never lands reads back as a fallback, so polling always ends.
const PICK_POLL_MS = 2_500;
const PICK_START = ['coach', 'pick-start'] as const;
const started = new WeakMap<QueryClient, Set<string>>();
export function useCoachToday(opts: { enabled?: boolean } = {}) {
  const api = useApi();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: qk.coachToday(),
    queryFn: () => api.getCoachToday(),
    enabled: opts.enabled ?? true,
    refetchInterval: (q) => (q.state.data?.ai?.status === 'pending' ? PICK_POLL_MS : false),
  });
  // `day` rides as the variables, so only today's starts count; kept in the cache all session (a few a day), since
  // the once-a-day guard below outlives any GC — a collected failure would read as "picking" with no Retry.
  const start = useMutation<CoachToday, Error, string>({
    mutationKey: PICK_START,
    gcTime: Infinity,
    mutationFn: () => api.startCoachPick(),
    onSuccess: (today) => qc.setQueryData(qk.coachToday(), today),
  });
  const day = query.data?.ai?.status === 'due' ? query.data.day : null;
  // Shared by every reader (Home's line and the card): the newest start's outcome for the plan's day, wherever it was
  // fired. Filtered here, not in the cache filter, which is only re-run on a mutation event.
  const starts = useMutationState({
    filters: { mutationKey: PICK_START },
    select: (m) => ({ day: m.state.variables, status: m.state.status }),
  });
  const startFailed = starts.filter((x) => x.day === query.data?.day).at(-1)?.status === 'error';
  useEffect(() => {
    if (!day) return;
    const seen = started.get(qc) ?? started.set(qc, new Set()).get(qc)!;
    if (seen.has(day)) return;
    seen.add(day);
    start.mutate(day);
  }, [day, qc, start]);
  return {
    ...query,
    startFailed,
    retryStart: () => query.data && start.mutate(query.data.day),
  };
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

// Mock interviews (coach.md → Mocks): the list, and the writes. Both writes read the day again (its mock line)
// and the list, settled rather than on success: a failed write may still have landed (a 5xx).
export function useMocks() {
  const api = useApi();
  return useQuery({ queryKey: qk.coachMocks(), queryFn: () => api.listMocks() });
}
export function useUpsertMock() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MockInput) => api.upsertMock(input),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.coach() }),
  });
}
// Whether the cached plan still lists a planned mock — after a write's refetch settled, a failed refetch leaves it.
export function useMockListed() {
  const qc = useQueryClient();
  return (id: string) => {
    const m = qc.getQueryData<CoachToday>(qk.coachToday())?.mock;
    return !!m && [...m.upcoming, ...(m.unlogged ?? [])].some((x) => x.id === id);
  };
}

export function useDeleteMock() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteMock(id),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.coach() }),
  });
}
