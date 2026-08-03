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
    onSuccess: (next) => qc.setQueryData(qk.settings(), next),
  });
}
