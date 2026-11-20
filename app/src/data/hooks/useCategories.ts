import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Area, Category, UpsertCategoryInput } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';
import { invalidateTaskData } from './invalidate';

// Categories resolve labels live (renames propagate). Reads here; management is the Settings page.
// The full list (retired included) is for resolving labels — CategoryTag, Settings.
export function useCategories() {
  const api = useApi();
  return useQuery({ queryKey: qk.categories(), queryFn: () => api.listCategories() });
}

// Stable module-level select → React Query memoizes the filtered array; shares the cache above.
const onlyActive = (cats: Category[]) => cats.filter((c) => c.active);

// Pickers offer active categories only; a retired one leaves every picker but keeps its label.
export function useActiveCategories() {
  const api = useApi();
  return useQuery({
    queryKey: qk.categories(),
    queryFn: () => api.listCategories(),
    select: onlyActive,
  });
}

// Select options for a category picker: the active ones, plus `currentId` when it's retired (shown as
// "X (retired)") — an edit form must still show what the item is filed under, not "Uncategorized".
// `failed`: the roster didn't load, so the picker would offer only "Uncategorized" — callers disable it
// and say so (CategoryPickerError) rather than let it read as the item's category.
export function useCategoryOptions(currentId: string | null | undefined) {
  const q = useCategories();
  const options = (q.data ?? [])
    .filter((c) => c.active || c.id === currentId)
    .map((c) => ({ value: c.id, label: c.active ? c.label : `${c.label} (retired)` }));
  return { options, failed: q.isError && q.data === undefined, retry: () => void q.refetch() };
}

export function useUpsertCategory() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertCategoryInput) => api.upsertCategory(input),
    onSettled: (_d, _e, input) => {
      void qc.invalidateQueries({ queryKey: qk.categories() });
      // calibration points carry their category's area, joined at read (docs/areas/calibration/dev-lane.md)
      if (input.area !== undefined) void qc.invalidateQueries({ queryKey: ['calibration'] });
    },
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

// The category's life area (areas.ts): a live grouping, nothing snapshotted — one write, no backfill ask.
export function useSetCategoryArea() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; area: Area | null }) => api.setCategoryArea(v.id, v.area),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.categories() }),
        qc.invalidateQueries({ queryKey: ['calibration'] }), // the points' lane is the area, read live
      ]),
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
      void invalidateTaskData(qc);
    },
  });
}
