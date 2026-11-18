import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SettingsPatch } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';

export function useSettings() {
  const api = useApi();
  return useQuery({ queryKey: qk.settings(), queryFn: () => api.getSettings() });
}

export function useUpdateSettings() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => api.updateSettings(patch),
    onSuccess: (next, patch) => {
      qc.setQueryData(qk.settings(), next);
      // The finance overview is computed from the budget and payment day — re-read it.
      if ('financeBudgetCents' in patch || 'financePaymentDay' in patch)
        void qc.invalidateQueries({ queryKey: qk.finance() });
      // The AI pick switch, the plan mode and Premium move the day's plan (a stored pick shows or not, the slot mix,
      // the candidates) — re-read the plan, the stats and the records.
      if ('coachAiPick' in patch || 'coachPlanMode' in patch || 'leetcodePremium' in patch)
        void qc.invalidateQueries({ queryKey: qk.coach() });
    },
  });
}
