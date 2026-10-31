import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isTimed } from '@aperture/shared';
import type { Task } from '@aperture/shared';
import { useApi } from '../api-context';
import { tasksQuery } from './useTasks';

// What's waiting to be planned, newest first — derived from the one tasks query so it moves with every
// write (taskCache.ts). The morning "plan today" card counts it, so it's what "+ Add" can pull in: no
// timed task (its time is its day, lenses.md D13), no parent (its parts are the work). Not the server's
// listBacklog rule — MCP keeps that.
const waiting = (ts: Task[]) => {
  const parents = new Set(ts.map((t) => t.parentId).filter((id): id is string => !!id));
  return ts
    .filter((t) => t.status === 'backlog' && !isTimed(t) && !parents.has(t.id))
    .sort((a, b) => b.createdAt - a.createdAt);
};

export function useBacklog() {
  const api = useApi();
  const qc = useQueryClient();
  return useQuery({ ...tasksQuery(api, qc), select: waiting });
}
