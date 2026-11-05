import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { areaOf, isTimed, LIFE_AREAS } from '@aperture/shared';
import type { Category, Task } from '@aperture/shared';
import { useApi } from '../api-context';
import { useCategories } from './useCategories';
import { tasksQuery } from './useTasks';

// What's waiting to be planned, newest first — derived from the one tasks query so it moves with every
// write (taskCache.ts). The morning "plan today" card counts it: the backlog tasks "+ Add" can pull in —
// no timed task (its time is its day, lenses.md D13), no parent (its parts are the work), and only the
// life areas (no Aperture-area task: it waits behind the Backlog's chip, D14). Not the server's
// listBacklog rule — MCP keeps that.
export const waiting = (ts: Task[], categories: Category[]): Task[] => {
  const parents = new Set(ts.map((t) => t.parentId).filter((id): id is string => !!id));
  const byId = new Map(categories.map((c) => [c.id, c]));
  const life = (t: Task) =>
    LIFE_AREAS.includes(areaOf(t.categoryId ? byId.get(t.categoryId) : null));
  return ts
    .filter((t) => t.status === 'backlog' && !isTimed(t) && !parents.has(t.id) && life(t))
    .sort((a, b) => b.createdAt - a.createdAt);
};

export function useBacklog() {
  const api = useApi();
  const qc = useQueryClient();
  // Until the roster is in (or if it failed) every task reads as Personal — the same fallback as a task
  // with no category — so the count is never blank for want of categories.
  const { data: categories } = useCategories();
  const select = useCallback((ts: Task[]) => waiting(ts, categories ?? []), [categories]);
  return useQuery({ ...tasksQuery(api, qc), select });
}
