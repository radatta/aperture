import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpsertCategoryInput } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';
import { invalidateTaskData } from './invalidate';

// Categories resolve labels live (renames propagate). Reads here; management is the Settings page.
export function useCategories() {
  const api = useApi();
  return useQuery({ queryKey: qk.categories(), queryFn: () => api.listCategories() });
}

export function useUpsertCategory() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertCategoryInput) => api.upsertCategory(input),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.categories() }),
  });
}

// Flip isWork, optionally backfilling past sessions' snapshotted wasWork.
export function useSetCategoryWork() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; isWork: boolean; backfillPast: boolean }) =>
      api.setCategoryWork(v.id, v.isWork, v.backfillPast),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.categories() }),
  });
}

// Delete forces reassignment of referencing items first (the stub throws otherwise), then soft-deletes.
export function useDeleteCategory() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; reassignToId: string | null }) =>
      api.deleteCategory(v.id, v.reassignToId),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qk.categories() });
      invalidateTaskData(qc);
    },
  });
}
