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
    mutationFn: ({ text, isPrivate }: { text: string; isPrivate?: boolean }) =>
      api.createLogEntry(text, day, { private: isPrivate === true }),
    onMutate: async ({ text, isPrivate }) => {
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
        private: isPrivate === true,
      };
      qc.setQueryData<LogEntry[]>(qk.log(day), [...(prev ?? []), optimistic]);
      return { prev };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.log(day), ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.log(day) }),
  });
}

// A text edit and a lock toggle each put the whole entry, so two in flight could undo each other (an
// edit's blur and a lock tap land in the same tick). One scope runs log writes in order.
const LOG_WRITE_SCOPE = { id: 'log-write' };

export function useUpdateLogEntry(day: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    scope: LOG_WRITE_SCOPE,
    mutationFn: (vars: { id: string; text: string }) => api.updateLogEntry(vars.id, vars.text),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.log(day) }),
  });
}

// Optimistic: the lock flips on tap, rolls back if the write fails.
export function useSetLogEntryPrivate(day: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    scope: LOG_WRITE_SCOPE,
    mutationFn: (vars: { id: string; isPrivate: boolean }) =>
      api.setLogEntryPrivate(vars.id, vars.isPrivate),
    onMutate: async ({ id, isPrivate }) => {
      await qc.cancelQueries({ queryKey: qk.log(day) });
      const prev = qc.getQueryData<LogEntry[]>(qk.log(day));
      qc.setQueryData<LogEntry[]>(
        qk.log(day),
        prev?.map((e) => (e.id === id ? { ...e, private: isPrivate } : e)),
      );
      return { prev };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.log(day), ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.log(day) }),
  });
}
