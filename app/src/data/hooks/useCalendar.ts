import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PULL_THROTTLE_MS } from '@aperture/shared';
import type { GetCalendarBusyInput, InsertCalendarEventInput, Task } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';
import { putTasks } from '../taskCache';
import { invalidateTaskData } from './invalidate';
import { useSettings } from './useSettings';

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
    onSuccess: (t: Task) => putTasks(qc, [t]),
    onSettled: () => void invalidateTaskData(qc),
  });
}

// Retry a failed auto-sync (task.gcalSyncError).
export function useSyncCalendarEvent() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => api.syncCalendarEvent(taskId),
    onSuccess: (t: Task) => putTasks(qc, [t]),
    onSettled: () => void invalidateTaskData(qc),
  });
}

export function useDeleteCalendarEvent() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => api.deleteCalendarEvent(taskId),
    onSuccess: (t: Task) => putTasks(qc, [t]),
    onSettled: () => void invalidateTaskData(qc),
  });
}

// Two-way sync: pull edits made in Google back onto their tasks when the app opens and whenever it
// comes back to the foreground — at most once a minute from here (the server throttles too). Only
// with an account connected and auto-sync on. Never blocks or fails the app: a Google failure comes
// back on the account status (Settings shows it), and tasks refetch only when something changed.
export function useCalendarPull(): void {
  const api = useApi();
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const enabled = (settings?.googleAccounts.length ?? 0) > 0 && settings?.autoCalendar !== false;
  const lastRef = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const pull = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastRef.current < PULL_THROTTLE_MS) return;
      lastRef.current = Date.now();
      api
        .pullCalendar()
        .then((res) => {
          // The day too: a pulled edit can give a planned task a time, which getDay's sweep settles.
          if (res.changedTaskIds.length > 0) {
            void invalidateTaskData(qc);
            void qc.invalidateQueries({ queryKey: ['day'] });
          }
          if (res.pulled) qc.invalidateQueries({ queryKey: qk.googleStatus() });
        })
        .catch(() => {
          /* a network or auth failure here is the app's, surfaced by its own query errors */
        });
    };
    pull();
    document.addEventListener('visibilitychange', pull);
    return () => document.removeEventListener('visibilitychange', pull);
  }, [api, qc, enabled]);
}
