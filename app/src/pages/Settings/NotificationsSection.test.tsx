import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PUSH_NO_DEVICE_ERROR, PUSH_UNCONFIGURED_ERROR } from '@aperture/shared';
import type { PushStatus } from '@aperture/shared';
import { createStubClient } from '../../data/stubClient';
import { renderWithProviders } from '../../test/utils';
import {
  deviceIdHere,
  PUSH_INSTALL_COPY,
  PUSH_UNSUPPORTED_COPY,
  rememberHere,
  removedElsewhereHere,
} from '../../modules/push/browserPush';
import { NotificationsSection, REMOVED_ELSEWHERE_COPY } from './NotificationsSection';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';

const stub = () => createStubClient({ seed: false, storageKey: `notif-${Math.random()}` });
const sub = (endpoint = 'https://web.push.apple.com/QGdev') => ({
  endpoint,
  keys: { p256dh: 'pk', auth: 'au' },
  label: 'iPhone · Safari',
});
const toggle = (name: RegExp) => screen.findByRole<HTMLInputElement>('checkbox', { name });
const ua = (s: string) => vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(s);

// A Safari-shaped browser: Notification + window.pushManager; the prompt answers `ask`.
function safari(opts: { permission?: NotificationPermission; ask?: NotificationPermission } = {}) {
  const requestPermission = vi.fn(async () => opts.ask ?? 'granted');
  vi.stubGlobal('Notification', { permission: opts.permission ?? 'default', requestPermission });
  const endpoint = 'https://web.push.apple.com/QGhere';
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
  return { requestPermission, pm };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { pushManager?: unknown }).pushManager;
});

describe('Settings › Notifications: the toggles', () => {
  it('all three start on, and each persists on its own', async () => {
    const api = stub();
    const user = userEvent.setup();
    renderWithProviders(<NotificationsSection />, { api });
    const timed = await toggle(/^Timed deadlines$/);
    const day = await toggle(/^Day-only deadlines at 9am$/);
    const planned = await toggle(/^Planned tasks at 9am$/);
    expect([timed.checked, day.checked, planned.checked]).toEqual([true, true, true]);
    expect(timed.getAttribute('aria-describedby')).toBeTruthy();

    await user.click(planned);
    await waitFor(async () =>
      expect(await api.getSettings()).toMatchObject({
        remindTimed: true,
        remindDueDay: true,
        remindPlanned: false,
      }),
    );
    await waitFor(() => expect(planned.checked).toBe(false));
  });

  it('a refused save says so and the toggle keeps the saved value', async () => {
    const api = stub();
    vi.spyOn(api, 'updateSettings').mockRejectedValueOnce(new Error('updateSettings failed (503)'));
    const user = userEvent.setup();
    renderWithProviders(<NotificationsSection />, { api });
    const timed = await toggle(/^Timed deadlines$/);
    await user.click(timed);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn't save that/);
    expect(timed.checked).toBe(true);
    expect((await api.getSettings()).remindTimed).toBe(true);
  });
});

describe('Settings › Notifications: this device', () => {
  it('a browser without Web Push says so, offers no Enable, and Send test waits for a device', async () => {
    renderWithProviders(<NotificationsSection />, { api: stub() });
    expect(await screen.findByText(PUSH_UNSUPPORTED_COPY)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Enable on this device' })).toBeNull();
    expect(screen.getByText(/No devices yet/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send test' }).disabled).toBe(
      true,
    );
    expect(screen.getByText(`${PUSH_NO_DEVICE_ERROR}.`)).toBeTruthy();
  });

  it('plain Safari on iPhone is told to add Aperture to the Home Screen first', async () => {
    ua(IPHONE);
    renderWithProviders(<NotificationsSection />, { api: stub() });
    expect(await screen.findByText(PUSH_INSTALL_COPY)).toBeTruthy();
  });

  it('denied permission on iPhone says where to turn it back on', async () => {
    ua(IPHONE);
    safari({ permission: 'denied' });
    renderWithProviders(<NotificationsSection />, { api: stub() });
    expect(
      await screen.findByText(/re-enable in iOS Settings › Notifications › Aperture/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Enable on this device' })).toBeNull();
  });

  it('Enable asks inside the tap, subscribes, and lists this device', async () => {
    ua(IPHONE);
    const { requestPermission, pm } = safari();
    const api = stub();
    const user = userEvent.setup();
    renderWithProviders(<NotificationsSection />, { api });
    await user.click(await screen.findByRole('button', { name: 'Enable on this device' }));
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('iPhone · Safari (this device)')).toBeTruthy();
    expect(screen.getByText('On for this device.')).toBeTruthy();
    expect(pm.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect((await api.getPushStatus()).devices).toHaveLength(1);
  });

  it('a refused prompt or a refused subscribe shows why, and nothing is listed', async () => {
    ua(IPHONE);
    safari({ ask: 'denied' });
    const api = stub();
    vi.spyOn(api, 'subscribePush').mockRejectedValueOnce(new Error('subscribePush failed (503)'));
    const user = userEvent.setup();
    renderWithProviders(<NotificationsSection />, { api });
    const enable = await screen.findByRole('button', { name: 'Enable on this device' });
    await user.click(enable);
    expect(await screen.findByText(/iOS Settings › Notifications › Aperture/)).toBeTruthy();

    safari({ ask: 'granted' });
    await user.click(enable);
    expect(await screen.findByText('subscribePush failed (503)')).toBeTruthy();
    expect((await api.getPushStatus()).devices).toEqual([]);
  });
});

describe('Settings › Notifications: health and devices', () => {
  const at = (minAgo: number) => Date.now() - minAgo * 60_000;
  function withStatus(over: Partial<PushStatus>) {
    const api = stub();
    vi.spyOn(api, 'getPushStatus').mockResolvedValue({
      configured: true,
      vapidPublicKey: 'BAAA',
      devices: [],
      removedDeviceIds: [],
      poller: { lastRunAt: null, lastSentAt: null, lastError: null, lastErrorAt: null },
      ...over,
    });
    return api;
  }
  const health = async () =>
    (await screen.findByRole('group', { name: 'Reminder health' })).textContent;

  it('a stage with no key says reminders aren’t set up, with no device controls', async () => {
    renderWithProviders(<NotificationsSection />, {
      api: withStatus({ configured: false, vapidPublicKey: null }),
    });
    expect(await screen.findByText(PUSH_UNCONFIGURED_ERROR)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send test' })).toBeNull();
  });

  it('a failed status read says so with a Retry', async () => {
    const api = stub();
    vi.spyOn(api, 'getPushStatus').mockRejectedValue(new Error('getPushStatus failed (503)'));
    renderWithProviders(<NotificationsSection />, { api });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Couldn’t load reminder status/);
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('never ran reads neutral; a stale heartbeat reads paused; a fresh one reads on', async () => {
    const { unmount } = renderWithProviders(<NotificationsSection />, { api: withStatus({}) });
    expect(await health()).toMatch(/haven’t run yet/);
    unmount();

    const stale = renderWithProviders(<NotificationsSection />, {
      api: withStatus({
        poller: {
          lastRunAt: at(10),
          lastSentAt: null,
          lastError: 'push_guard_tripped',
          lastErrorAt: at(11),
        },
      }),
    });
    expect(await health()).toMatch(/^Reminders paused since \d{1,2}(:\d\d)?(am|pm)/);
    expect(await health()).toMatch(/Last problem: push_guard_tripped/);
    stale.unmount();

    renderWithProviders(<NotificationsSection />, {
      api: withStatus({
        poller: { lastRunAt: at(2), lastSentAt: at(3), lastError: 'old', lastErrorAt: at(30) },
      }),
    });
    expect(await health()).toMatch(/^Reminders on · checked 2 min ago · last sent /);
    expect(await health()).not.toMatch(/Last problem/); // a send since superseded it
  });

  it("shows a device's last error, and Remove takes it off the list", async () => {
    const api = stub();
    const d = await api.subscribePush(sub());
    const status = await api.getPushStatus();
    const getStatus = vi.spyOn(api, 'getPushStatus');
    getStatus.mockResolvedValueOnce({
      ...status,
      devices: [{ ...d, lastError: '410 Gone', lastErrorAt: Date.now() }],
    });
    const user = userEvent.setup();
    renderWithProviders(<NotificationsSection />, { api });
    expect(await screen.findByText(/^Last error: 410 Gone/)).toBeTruthy();
    expect(screen.getByText(/nothing sent yet/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove iPhone · Safari' }));
    expect(await screen.findByText(/No devices yet/)).toBeTruthy();
    expect((await api.getPushStatus()).devices).toEqual([]);
  });

  it('a refused Remove says so and keeps the row', async () => {
    const api = stub();
    await api.subscribePush(sub());
    vi.spyOn(api, 'unsubscribePush').mockRejectedValueOnce(
      new Error('unsubscribePush failed (503)'),
    );
    const user = userEvent.setup();
    renderWithProviders(<NotificationsSection />, { api });
    await user.click(await screen.findByRole('button', { name: 'Remove iPhone · Safari' }));
    expect(
      await screen.findByText(/Couldn’t remove it: unsubscribePush failed \(503\)/),
    ).toBeTruthy();
    expect(screen.getByText('iPhone · Safari')).toBeTruthy();
  });

  it('Send test queues, says so, and the health line moves', async () => {
    const api = stub();
    await api.subscribePush(sub());
    const user = userEvent.setup();
    renderWithProviders(<NotificationsSection />, { api });
    expect(await health()).toMatch(/haven’t run yet/);
    await user.click(screen.getByRole('button', { name: 'Send test' }));
    expect(await screen.findByText('Sending within a minute…')).toBeTruthy();
    await waitFor(async () =>
      expect(await health()).toMatch(/^Reminders on · checked just now · last sent /),
    );
    expect(screen.getByText(/last sent/, { selector: 'li p' })).toBeTruthy();
  });

  it('a refused Send test says why', async () => {
    const api = stub();
    await api.subscribePush(sub());
    vi.spyOn(api, 'sendTestPush').mockRejectedValueOnce(new Error('sendTestPush failed (503)'));
    const user = userEvent.setup();
    renderWithProviders(<NotificationsSection />, { api });
    await user.click(await screen.findByRole('button', { name: 'Send test' }));
    expect(
      await screen.findByText(/Couldn’t send a test: sendTestPush failed \(503\)/),
    ).toBeTruthy();
  });
});

describe('Settings › Notifications: removed on another device', () => {
  it('a removal seen while Settings is open sticks here: the opt-in goes, and a note says why', async () => {
    ua(IPHONE);
    safari({ permission: 'granted' });
    const api = stub();
    const d = await api.subscribePush(sub());
    rememberHere(d, Date.now());
    await api.unsubscribePush(d.id); // from the Mac
    const upsert = vi.spyOn(api, 'subscribePush');
    renderWithProviders(<NotificationsSection />, { api });
    expect(await screen.findByText(REMOVED_ELSEWHERE_COPY)).toBeTruthy();
    expect(deviceIdHere()).toBeNull();
    expect(screen.getByRole('button', { name: 'Enable on this device' })).toBeTruthy();
    expect(upsert).not.toHaveBeenCalled();
    expect((await api.getPushStatus()).removedDeviceIds).toEqual([d.id]);
  });

  it('the note survives a reload, Dismiss clears it for good', async () => {
    ua(IPHONE);
    safari();
    localStorage.setItem('aperture.push.removedElsewhere', '1');
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<NotificationsSection />, { api: stub() });
    expect(await screen.findByText(REMOVED_ELSEWHERE_COPY)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(REMOVED_ELSEWHERE_COPY)).toBeNull();
    unmount();
    renderWithProviders(<NotificationsSection />, { api: stub() });
    await screen.findByRole('button', { name: 'Enable on this device' });
    expect(screen.queryByText(REMOVED_ELSEWHERE_COPY)).toBeNull();
  });

  it('tapping Enable clears the note and revives the device under its id', async () => {
    ua(IPHONE);
    safari();
    const api = stub();
    const d = await api.subscribePush(sub('https://web.push.apple.com/QGhere'));
    await api.unsubscribePush(d.id);
    localStorage.setItem('aperture.push.removedElsewhere', '1');
    const user = userEvent.setup();
    renderWithProviders(<NotificationsSection />, { api });
    await screen.findByText(REMOVED_ELSEWHERE_COPY);
    await user.click(screen.getByRole('button', { name: 'Enable on this device' }));
    expect(screen.queryByText(REMOVED_ELSEWHERE_COPY)).toBeNull();
    expect(await screen.findByText('iPhone · Safari (this device)')).toBeTruthy();
    expect(removedElsewhereHere()).toBe(false);
    const status = await api.getPushStatus();
    expect(status.devices.map((x) => x.id)).toEqual([d.id]);
    expect(status.removedDeviceIds).toEqual([]);
  });
});
