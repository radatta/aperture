import { useQuery } from '@tanstack/react-query';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';

// Read-only backlog list — the morning "plan today" card counts what's waiting to be scoped.
// The plan-pass UI that acts on these lands in Phase 5.
export function useBacklog() {
  const api = useApi();
  return useQuery({ queryKey: qk.backlog(), queryFn: () => api.listBacklog() });
}
