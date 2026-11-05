import { useCallback } from 'react';
import { suggestCategory, type CategorySuggestion, type SuggestableTask } from '@aperture/shared';
import { useActiveCategories } from './useCategories';
import { useAllTasks } from './useTasks';

// A confident-only category for an uncategorised task (shared `suggestCategory`), scored on the client
// from the live task list and the active categories — both already in the cache, so no request of its
// own. Null until both have loaded, and whenever the scorer isn't sure.
export function useSuggestCategory(): (task: SuggestableTask) => CategorySuggestion | null {
  const tasks = useAllTasks().data;
  const cats = useActiveCategories().data;
  return useCallback(
    (task: SuggestableTask) => (tasks && cats ? suggestCategory(task, tasks, cats) : null),
    [tasks, cats],
  );
}
