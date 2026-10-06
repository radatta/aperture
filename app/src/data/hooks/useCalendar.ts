import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GetCalendarBusyInput, InsertCalendarEventInput } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';
import { invalidateTaskData } from './invalidate';

// Per-account connection health — drives the Settings account list and Home's connect/reconnect prompt.
export function useGoogleStatus() {
  const api = useApi();
  return useQuery({ queryKey: qk.googleStatus(), queryFn: () => api.getGoogleStatus() });
}

// The calendar picker's options, across all connected accounts. Only worth fetching once connected.
export function useGoogleCalendars(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: qk.googleCalendars(),
    queryFn: () => api.listGoogleCalendars(),
    enabled,
  });
}

// Raw busy intervals for the day's full focus window (the client computes the shape from these, and
// re-clips for daytime mode without refetching). Cached ~10 min; keyed by day only, so the fetch is
// stable across a morning→daytime transition.
export function useCalendarBusy(input: GetCalendarBusyInput, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: qk.calendarBusy(input.day),
    queryFn: () => api.getCalendarBusy(input),
    enabled,
    staleTime: 10 * 60_000,
  });
}

// Connect (or add another account): the BFF builds a signed consent URL; we hand the browser to it.
export function useConnectGoogle() {
  const api = useApi();
  return useMutation({
    mutationFn: async () => {
      const { url } = await api.googleConnectUrl();
      window.location.assign(url);
    },
  });
}

export function useDisconnectGoogleAccount() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accountSub: string) => api.disconnectGoogleAccount(accountSub),
    onSettled: () => {
      for (const key of ['googleStatus', 'googleCalendars', 'calendarBusy', 'settings']) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

export function useInsertCalendarEvent() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InsertCalendarEventInput) => api.insertCalendarEvent(input),
    onSettled: () => invalidateTaskData(qc),
  });
}

// Retry a failed auto-sync (task.gcalSyncError).
export function useSyncCalendarEvent() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => api.syncCalendarEvent(taskId),
    onSettled: () => invalidateTaskData(qc),
  });
}

export function useDeleteCalendarEvent() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => api.deleteCalendarEvent(taskId),
    onSettled: () => invalidateTaskData(qc),
  });
}
