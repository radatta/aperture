import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpsertPlaceInput } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';
import { invalidateTaskData } from './invalidate';

// Places (errand lists, places.ts). Tasks store the slug, so a slug edit or a delete rewrites tasks too —
// those refresh the task data as well as the roster. Management is Settings › Places.
export function usePlaces() {
  const api = useApi();
  return useQuery({ queryKey: qk.places(), queryFn: () => api.listPlaces() });
}

// The roster for a place picker or resolver. `failed`: it didn't load — callers disable or mark the gap
// instead of offering "No place" as if that were the task's (CONVENTIONS → Failed reads).
export function usePlaceOptions() {
  const q = usePlaces();
  return {
    places: q.data ?? [],
    loaded: q.data !== undefined,
    failed: q.isError && q.data === undefined,
    retry: () => void q.refetch(),
  };
}

const placesChanged = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: qk.places() });
  void invalidateTaskData(qc);
};

export function useUpsertPlace() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertPlaceInput) => api.upsertPlace(input),
    onSettled: () => placesChanged(qc),
  });
}

// Moves its errands to `reassignToSlug` (another place) or off any list (null), then deletes it.
export function useDeletePlace() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; reassignToSlug: string | null }) =>
      api.deletePlace(v.id, v.reassignToSlug),
    onSettled: () => placesChanged(qc),
  });
}

// The Shortcut's digest for one place, as Settings' "Test" shows it — read when the panel opens, fresh
// each time (staleTime 0: the errands may have changed since the last look).
export function usePlaceDigest(slug: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.placeDigest(slug),
    queryFn: () => api.listPlaceTasks(slug),
    staleTime: 0,
  });
}

export function usePlaceTokenStatus() {
  const api = useApi();
  return useQuery({ queryKey: qk.placeToken(), queryFn: () => api.getPlaceTokenStatus() });
}

// Mints a new token (the old one stops working). The plaintext is in the result only — the caller shows
// it once; the cache keeps just the status.
export function useRotatePlaceToken() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.rotatePlaceToken(),
    onSuccess: (r) => qc.setQueryData(qk.placeToken(), r.status),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.placeToken() }),
  });
}

export function useRevokePlaceToken() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.revokePlaceToken(),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.placeToken() }),
  });
}
