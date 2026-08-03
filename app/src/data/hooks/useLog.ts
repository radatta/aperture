import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LogEntry } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';

export function useLog(day: string) {
  const api = useApi();
  return useQuery({ queryKey: qk.log(day), queryFn: () => api.listLogEntries(day) });
}

// Optimistic: the new entry appears instantly (capture must feel below memory cost), then the real
// record from the stub replaces it on settle. Rolls back on error.
export function useCreateLogEntry(day: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => api.createLogEntry(text),
    onMutate: async (text) => {
      await qc.cancelQueries({ queryKey: qk.log(day) });
      const prev = qc.getQueryData<LogEntry[]>(qk.log(day));
      const now = Date.now();
      const optimistic: LogEntry = {
        id: `tmp-${now}`,
        userId: 'local',
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        day,
        text,
      };
      qc.setQueryData<LogEntry[]>(qk.log(day), [...(prev ?? []), optimistic]);
      return { prev };
    },
    onError: (_e, _text, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.log(day), ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.log(day) }),
  });
}

export function useUpdateLogEntry(day: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; text: string }) => api.updateLogEntry(vars.id, vars.text),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.log(day) }),
  });
}
