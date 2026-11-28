import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PushStatus } from '@aperture/shared';
import { createStubClient, STUB_VAPID_PUBLIC_KEY } from '../../data/stubClient';
import { renderApp, renderWithProviders, timersAdopted } from '../../test/utils';
import { rememberHere, resyncHere } from './browserPush';
import { PushSyncNotice } from './PushSyncNotice';

const stub = () => createStubClient({ seed: false, storageKey: `sync-notice-${Math.random()}` });
const device = {
  id: 'd1',
  label: 'iPhone · Safari',
  createdAt: 0,
  lastOkAt: null,
  lastError: null,
  lastErrorAt: null,
};
const status: PushStatus = {
  configured: true,
  vapidPublicKey: STUB_VAPID_PUBLIC_KEY,
  devices: [], // the server lost it: the resync subscribes fresh and upserts
  removedDeviceIds: [],
  poller: { lastRunAt: null, lastSentAt: null, lastError: null, lastErrorAt: null },
};
// The resync's server: a subscribePush stand-in, and an unsubscribePush that records retired ids.
const srv = (subscribePush: unknown, unsubscribePush: unknown = vi.fn(async () => {})) =>
  ({ subscribePush, unsubscribePush }) as Parameters<typeof resyncHere>[2];
const NOTICE = /Reminders couldn’t refresh on this device — open Settings/;

// A granted Safari that hands out a fresh subscription.
function grantedSafari() {
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn() });
  const endpoint = 'https://web.push.apple.com/QGnotice';
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
}
const fail = () =>
  act(() =>
    resyncHere(
      status,
      Date.now(),
      srv(async () => {
        throw new Error('subscribePush failed (503)');
      }),
    ).catch(() => {}),
  );

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { pushManager?: unknown }).pushManager;
});

describe('Home: reminders couldn’t refresh', () => {
  it('appears when the launch resync fails, links to Settings › Notifications, and Dismiss holds', async () => {
    grantedSafari();
    rememberHere(device, Date.now());
    const user = userEvent.setup();
    renderWithProviders(<PushSyncNotice enabled />, { api: stub() });
    expect(screen.queryByText(NOTICE)).toBeNull();
    await fail();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(NOTICE);
    expect(screen.getByRole('link', { name: 'open Settings' }).getAttribute('href')).toBe(
      '/settings#notifications',
    );
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
    await fail(); // a new failure is news again
    expect(screen.getByRole('alert').textContent).toMatch(NOTICE);
  });

  it('a later resync that works clears it', async () => {
    grantedSafari();
    rememberHere(device, Date.now());
    renderWithProviders(<PushSyncNotice enabled />, { api: stub() });
    await fail();
    expect(screen.getByRole('alert')).toBeTruthy();
    await act(() =>
      resyncHere(
        status,
        Date.now(),
        srv(async () => device),
      ),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('stays away off http mode, and on a device that never opted in', async () => {
    grantedSafari();
    rememberHere(device, Date.now());
    await fail();
    const { unmount } = renderWithProviders(<PushSyncNotice enabled={false} />, { api: stub() });
    await timersAdopted();
    expect(screen.queryByText(NOTICE)).toBeNull();
    unmount();
    localStorage.removeItem('aperture.push.enabled');
    renderWithProviders(<PushSyncNotice enabled />, { api: stub() });
    await timersAdopted();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('Home in stub mode never shows it', async () => {
    grantedSafari();
    rememberHere(device, Date.now());
    await fail();
    renderApp({ api: stub(), path: '/' });
    await screen.findByRole('navigation');
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
