import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStubClient } from '../stubClient';
import { renderWithProviders } from '../../test/utils';
import {
  afterResync,
  deviceIdHere,
  rememberHere,
  removedElsewhereHere,
  syncErrorHere,
} from '../../modules/push/browserPush';
import { usePushSync, useUnsubscribePush } from './usePush';
import { realWait } from '../../test/realWait';

const stub = () => createStubClient({ seed: false, storageKey: `push-sync-${Math.random()}` });
const DAY = 86_400_000;

function Sync({ on }: { on: boolean }) {
  usePushSync(on);
  return null;
}

// The launch resync beside a Remove of this device, as Settings would offer it.
function SyncAndRemove({ id }: { id: string }) {
  usePushSync(true);
  const remove = useUnsubscribePush();
  return (
    <button type="button" onClick={() => remove.mutate(id)}>
      Remove here
    </button>
  );
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
    await realWait(20);
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

  it('a Remove tapped while the launch resync is mid-upsert waits for it, so the removal sticks', async () => {
    const pm = grantedSafari(); // iOS dropped the subscription: the resync re-subscribes and upserts
    const api = stub();
    const d = await api.subscribePush({
      endpoint: 'https://web.push.apple.com/QGsync',
      keys: { p256dh: 'pk', auth: 'au' },
      label: 'iPhone · Safari',
    });
    rememberHere(d, Date.now() - DAY);
    const real = api.subscribePush.bind(api);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(api, 'subscribePush').mockImplementationOnce(async (input) => {
      await gate;
      return real(input);
    });
    const user = userEvent.setup();
    renderWithProviders(<SyncAndRemove id={d.id} />, { api });
    await waitFor(() => expect(pm.subscribe).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Remove here' }));
    await realWait(30); // an unserialised Remove would finish here
    await act(async () => {
      release();
      await afterResync();
    });
    await waitFor(() => expect(deviceIdHere()).toBeNull()); // the Remove has run
    expect(await api.getPushStatus()).toMatchObject({ devices: [], removedDeviceIds: [d.id] });
  });

  it('a re-subscribe under a new endpoint retires the old row: one device, and no false removal', async () => {
    const pm = grantedSafari(); // iOS dropped the old subscription; the browser hands out QGsync
    const api = stub();
    const old = await api.subscribePush({
      endpoint: 'https://web.push.apple.com/QGold',
      keys: { p256dh: 'pk', auth: 'au' },
      label: 'iPhone · Safari',
    });
    rememberHere(old, Date.now() - DAY);
    renderWithProviders(<Sync on />, { api });
    await waitFor(() => expect(deviceIdHere()).not.toBe(old.id));
    await act(() => afterResync());
    const s = await api.getPushStatus();
    expect(pm.subscribe).toHaveBeenCalledTimes(1);
    expect(s.devices.map((d) => d.id)).toEqual([deviceIdHere()]);
    expect(s.removedDeviceIds).toEqual([old.id]);
    // The refresh after it reads the old id's tombstone — not taken for a removal elsewhere.
    await realWait(30);
    expect(removedElsewhereHere()).toBe(false);
    expect(deviceIdHere()).toBe(s.devices[0]!.id);
  });

  it('a read requested before a newer opt-in can’t drive the resync, however late it answers', async () => {
    const pm = grantedSafari();
    rememberHere(device, Date.now() - DAY);
    const api = stub(); // lists no device: a resync acting on this read would subscribe fresh
    const real = api.getPushStatus.bind(api);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(api, 'getPushStatus').mockImplementationOnce(async () => {
      const s = await real();
      await gate;
      return s;
    });
    renderWithProviders(<Sync on />, { api });
    await waitFor(() => expect(api.getPushStatus).toHaveBeenCalled());
    await realWait(5);
    rememberHere(device, Date.now()); // a fresh Enable while the read is out
    await realWait(5);
    release();
    await realWait(30);
    await afterResync();
    expect(pm.subscribe).not.toHaveBeenCalled();
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
