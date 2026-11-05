import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Task, UpsertRollInput } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';
import { putTasks } from '../taskCache';
import { invalidateTaskData } from './invalidate';

// Rolls list — the /rolls page and the morning picker read it (includes archived; callers filter).
export function useRolls() {
  const api = useApi();
  return useQuery({ queryKey: qk.rolls(), queryFn: () => api.listRolls() });
}

export function useUpsertRoll() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertRollInput) => api.upsertRoll(input),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.rolls() }),
  });
}

// Pick a roll for a day → a planned rep task on that day's plan. Touches task data (the rep lands on
// the plan and in the tasks list) as well as rolls, so both are invalidated.
export function usePickRollToday() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { rollId: string; day: string }) => api.pickRollToday(v.rollId, v.day),
    onSuccess: ({ task }: { task: Task }) => putTasks(qc, [task]),
    onSettled: () => {
      void invalidateTaskData(qc);
      qc.invalidateQueries({ queryKey: qk.rolls() });
    },
  });
}
