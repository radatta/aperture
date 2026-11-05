import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PushStatus, SubscribePushInput } from '@aperture/shared';
import { useApi } from '../api-context';
import { qk } from '../queryKeys';
import {
  currentSubscription,
  deviceIdHere,
  dropIfRemovedHere,
  forgetHere,
  notificationPermission,
  rememberHere,
  resyncHere,
} from '../../modules/push/browserPush';

// Reminders (Web Push, docs/areas/tasks/reminders.md): this user's devices and the poller's health, as
// Settings › Notifications shows them, plus the launch-time re-subscribe (usePushSync).

// `poll`: while Settings is open the health line keeps moving (a Send test lands within a minute). Each
// fresh read also settles a removal from another device (dropIfRemovedHere) before anything renders it —
// judged on the read itself, never a cached copy that predates a re-Enable.
export function usePushStatus(opts: { poll?: boolean; enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: qk.pushStatus(),
    queryFn: async () => {
      const askedAt = Date.now();
      const status = await api.getPushStatus();
      await dropIfRemovedHere(status, askedAt);
      return status;
    },
    refetchInterval: opts.poll ? 30_000 : false,
    enabled: opts.enabled ?? true,
  });
}

const refresh = (qc: ReturnType<typeof useQueryClient>) =>
  qc.invalidateQueries({ queryKey: qk.pushStatus() });

// Takes the browser's subscription (browserPush.subscribeHere, run inside the tap) and registers it; this
// device then remembers it opted in.
export function useSubscribePush() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SubscribePushInput) => api.subscribePush(input),
    onSuccess: (device) => {
      // The cached status goes first: until the refetch lands it still lists a revived id as removed,
      // and Settings would read that as "removed elsewhere" and drop the opt-in just made.
      qc.setQueryData<PushStatus>(
        qk.pushStatus(),
        (s) =>
          s && {
            ...s,
            devices: [...s.devices.filter((d) => d.id !== device.id), device],
            removedDeviceIds: s.removedDeviceIds.filter((id) => id !== device.id),
          },
      );
      rememberHere(device, Date.now());
    },
    onSettled: () => refresh(qc),
  });
}

// Removing this device also drops the browser's subscription and its opt-in, so the next launch doesn't
// put it back; another device's row returns when that device next launches (D7).
export function useUnsubscribePush() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.unsubscribePush(id);
      if (id !== deviceIdHere()) return;
      forgetHere();
      try {
        await (await currentSubscription())?.unsubscribe();
      } catch {
        // The server row is gone, so nothing pushes to it; a browser that won't let go is harmless.
      }
    },
    onSettled: () => refresh(qc),
  });
}

export function useSendTestPush() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.sendTestPush(),
    onSettled: () => refresh(qc),
  });
}

// D7: once per launch, on a device that turned reminders on and still has permission, heal the
// subscription (resyncHere). Http mode only — the stub has no push service behind it. A failure is kept
// on the device (browserPush.syncErrorHere) and shown in Settings, not thrown at the shell.
export function usePushSync(enabled: boolean) {
  const api = useApi();
  const qc = useQueryClient();
  const armed = enabled && deviceIdHere() !== null && notificationPermission() === 'granted';
  const { data } = usePushStatus({ enabled: armed });
  const ran = useRef(false);
  useEffect(() => {
    if (!armed || !data || ran.current) return;
    ran.current = true;
    resyncHere(data, Date.now(), (input) => api.subscribePush(input)).then(
      (wrote) => wrote && void refresh(qc),
      () => void refresh(qc),
    );
  }, [armed, data, api, qc]);
}
