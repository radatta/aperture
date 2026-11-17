import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isSittingOpen } from '@aperture/shared';
import type { DateRange, SittingReviewInput, Task } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';
import { useSettings } from './useSettings';

// LeetCode sittings (heads), newest first. Written by the extension; a rep's Done ends one, which is why
// every task write invalidates this prefix (invalidate.ts).
export function useSittings(range?: DateRange, opts: { enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: qk.sittings(range?.from, range?.to),
    queryFn: () => api.listSittings(range),
    enabled: opts.enabled ?? true,
  });
}

// One sitting with its events, live row and problem doc — the detail page.
export function useSitting(id: string) {
  const api = useApi();
  return useQuery({ queryKey: qk.sitting(id), queryFn: () => api.getSitting(id) });
}

// The review saves whole; the list (its reviewed dot), the detail and the coach's day (its cause) refresh.
export function useSetSittingReview() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, review }: { id: string; review: SittingReviewInput }) =>
      api.setSittingReview(id, review),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['sittings'] }),
        qc.invalidateQueries({ queryKey: qk.coach() }),
      ]),
  });
}

// The stored review as the server has it right now — a first review's Save reads it before sending its
// suggestions, so a review Claude wrote over MCP since the page loaded wins (F169).
export function useReadSittingReview() {
  const api = useApi();
  const qc = useQueryClient();
  return (id: string) =>
    qc
      .fetchQuery({ queryKey: qk.sitting(id), queryFn: () => api.getSitting(id), staleTime: 0 })
      .then((d) => d.sitting.review ?? null);
}

export function useSetSittingPrepTarget() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, prepTarget }: { id: string; prepTarget: string }) =>
      api.setSittingPrepTarget(id, prepTarget),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sittings'] }),
  });
}

// Claude's draft: a mutation, never a query — a model call only when the user presses the button, never on open.
export function useDraftSittingReview() {
  const api = useApi();
  return useMutation({ mutationFn: (id: string) => api.draftSittingReview(id) });
}

// The open sitting a rep stands for, if any — Home's link and Done prefill. Only a LeetCode-roll rep in progress
// asks, so an ordinary day costs no read; the list it reads is the Sittings page's own cache entry. `undefined`
// while that read is still pending (a failed read is `null`: no link, the task's own Done).
export function useOpenSittingFor(task: Task | null | undefined, now: number) {
  const { data: settings } = useSettings();
  const lcRoll = settings?.leetcodeRollId ?? null;
  const wanted = !!task && !!lcRoll && task.rollId === lcRoll && task.status === 'in_progress';
  const q = useSittings(undefined, { enabled: wanted });
  if (!wanted) return null;
  if (q.isPending) return undefined; // not known yet — Home's Done waits rather than guess
  return q.data?.find((s) => s.repTaskId === task.id && isSittingOpen(s, now)) ?? null;
}
