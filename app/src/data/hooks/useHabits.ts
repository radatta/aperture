import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpsertHabitInput } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';

// Read-only habits list — the home surfaces them (morning: due today, night: check).
export function useHabits() {
  const api = useApi();
  return useQuery({ queryKey: qk.habits(), queryFn: () => api.listHabits() });
}

export function useHabitChecks(from: string, to: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.habitChecks(from, to),
    queryFn: () => api.listHabitChecks({ from, to }),
  });
}

export function useUpsertHabit() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertHabitInput) => api.upsertHabit(input),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.habits() }),
  });
}

// Check / uncheck a habit for a date. Unique on (habitId, date) — the stub no-ops a double check.
// No streaks, no guilt: a miss is just an unchecked cell, repair-friendly (past days stay editable).
export function useCheckHabit() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { habitId: string; date: string; checked: boolean }) => {
      if (v.checked) await api.checkHabit(v.habitId, v.date);
      else await api.uncheckHabit(v.habitId, v.date);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['habitChecks'] }),
  });
}
