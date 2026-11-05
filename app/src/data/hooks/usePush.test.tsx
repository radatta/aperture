import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { createStubClient } from '../stubClient';
import { renderWithProviders } from '../../test/utils';
import {
  deviceIdHere,
  rememberHere,
  removedElsewhereHere,
  syncErrorHere,
} from '../../modules/push/browserPush';
import { usePushSync } from './usePush';

const stub = () => createStubClient({ seed: false, storageKey: `push-sync-${Math.random()}` });
const DAY = 86_400_000;

function Sync({ on }: { on: boolean }) {
  usePushSync(on);
  return null;
}

// Granted permission and a Safari window manager whose subscription iOS dropped.
function grantedSafari() {
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn() });
  const endpoint = 'https://web.push.apple.com/QGsync';
  const pm = {
    getSubscription: vi.fn(async () => null),
    subscribe: vi.fn(async () => ({
      endpoint,
      options: { applicationServerKey: null },
      toJSON: () => ({ endpoint, keys: { p256dh: 'pk', auth: 'au' } }),
      unsubscribe: vi.fn(async () => true),
    })),
  };
  Object.defineProperty(window, 'pushManager', { value: pm, configurable: true });
  return pm;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { pushManager?: unknown }).pushManager;
});

const device = {
  id: 'old',
  label: 'iPhone · Safari',
  createdAt: 0,
  lastOkAt: null,
  lastError: null,
  lastErrorAt: null,
};

describe('usePushSync (D7)', () => {
  it('re-subscribes once on launch when iOS dropped the subscription', async () => {
    const pm = grantedSafari();
    rememberHere(device, Date.now() - DAY);
    const api = stub();
    const upsert = vi.spyOn(api, 'subscribePush');
    renderWithProviders(<Sync on />, { api });
    await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
    expect(pm.subscribe).toHaveBeenCalledTimes(1);
    expect((await api.getPushStatus()).devices).toHaveLength(1);
  });

  it('reads nothing off http mode, or on a device that never turned reminders on', async () => {
    grantedSafari();
    const api = stub();
    const status = vi.spyOn(api, 'getPushStatus');
    const { unmount } = renderWithProviders(<Sync on />, { api });
    rememberHere(device, Date.now());
    unmount();
    renderWithProviders(<Sync on={false} />, { api });
    await new Promise((r) => setTimeout(r, 20));
    expect(status).not.toHaveBeenCalled();
  });

  it('a device removed elsewhere stays removed: no re-subscribe, no upsert, the opt-in goes', async () => {
    const pm = grantedSafari();
    const api = stub();
    const d = await api.subscribePush({
      endpoint: 'https://web.push.apple.com/QGsync',
      keys: { p256dh: 'pk', auth: 'au' },
      label: 'iPhone · Safari',
    });
    rememberHere(d, Date.now() - DAY);
    await api.unsubscribePush(d.id);
    const upsert = vi.spyOn(api, 'subscribePush');
    renderWithProviders(<Sync on />, { api });
    await waitFor(() => expect(removedElsewhereHere()).toBe(true));
    expect(deviceIdHere()).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
    expect(pm.subscribe).not.toHaveBeenCalled();
    expect((await api.getPushStatus()).removedDeviceIds).toEqual([d.id]);
  });

  it('keeps a failure on the device for Settings, never throwing at the shell', async () => {
    grantedSafari();
    rememberHere(device, Date.now() - DAY);
    const api = stub();
    vi.spyOn(api, 'subscribePush').mockRejectedValue(new Error('subscribePush failed (503)'));
    renderWithProviders(<Sync on />, { api });
    await waitFor(() => expect(syncErrorHere()).toBe('subscribePush failed (503)'));
  });
});
