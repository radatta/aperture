import type { QueryClient } from '@tanstack/react-query';

// A task change ripples into several views (planned day, calibration, the tasks list — and the backlog
// derived from it — the day singleton). Rather than track each precisely, invalidate the small local
// task-data keys — at single-user volume the refetch is cheap and correctness beats surgical
// invalidation.
export function invalidateTaskData(qc: QueryClient): void {
  for (const key of ['tasks', 'plans', 'calibration', 'day']) {
    qc.invalidateQueries({ queryKey: [key] });
  }
}
