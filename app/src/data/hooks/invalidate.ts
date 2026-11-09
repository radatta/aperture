import type { QueryClient } from '@tanstack/react-query';

// A task change ripples into several views (the tasks list — and the backlog derived from it — plan
// rows, calibration). Rather than track each precisely, invalidate those three keys. Not the day
// singleton: a task write never changes it, and its refetch cascades into tasks and plans again
// (useDay) — the one write that needs the day's sweep, a planned task gaining a time, asks for it
// itself (useSetDue). Resolves once the refetches land, for the callers that must hand back lists
// already showing the write (the plan hooks, useAddToDay); a task write's hook drops it (useTasks.ts).
export function invalidateTaskData(qc: QueryClient): Promise<void> {
  return Promise.all(
    ['tasks', 'plans', 'calibration', 'sittings'].map((key) =>
      qc.invalidateQueries({ queryKey: [key] }),
    ),
  ).then(() => undefined);
}
