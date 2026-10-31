import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Task } from '@aperture/shared';
import { useApi } from '../api-context';
import { tasksQuery } from './useTasks';

// The backlog, newest first — the server's listBacklog rule, derived from the one tasks query so it
// moves with every write (taskCache.ts). The morning "plan today" card counts what's waiting.
const onlyBacklog = (ts: Task[]) =>
  ts.filter((t) => t.status === 'backlog').sort((a, b) => b.createdAt - a.createdAt);

export function useBacklog() {
  const api = useApi();
  const qc = useQueryClient();
  return useQuery({ ...tasksQuery(api, qc), select: onlyBacklog });
}
