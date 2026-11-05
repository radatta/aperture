import { afterEach, describe, expect, it, vi } from 'vitest';
import { PUSH_LABEL_MAX } from '@aperture/shared';
import type { PushStatus } from '@aperture/shared';
import { STUB_VAPID_PUBLIC_KEY } from '../../data/stubClient';
import {
  afterResync,
  deviceIdHere,
  deviceLabel,
  dismissRemovedElsewhere,
  dismissSyncError,
  dropIfRemovedHere,
  forgetHere,
  PUSH_INSTALL_COPY,
  PUSH_UNSUPPORTED_COPY,
  pushManagerOf,
  pushSupport,
  rememberHere,
  removedElsewhereHere,
  resyncHere,
  subscribeHere,
  syncErrorHere,
  syncErrorUndismissed,
  urlBase64ToUint8Array,
} from './browserPush';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const WIN_EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';
const IOS_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1';

const KEY = urlBase64ToUint8Array(STUB_VAPID_PUBLIC_KEY);
const OTHER_KEY = new Uint8Array(65).fill(7);
const NOW = new Date(2026, 10, 4, 9, 0).getTime();

const status = (over: Partial<PushStatus> = {}): PushStatus => ({
  configured: true,
  vapidPublicKey: STUB_VAPID_PUBLIC_KEY,
  devices: [],
  removedDeviceIds: [],
  poller: { lastRunAt: null, lastSentAt: null, lastError: null, lastErrorAt: null },
  ...over,
});

function fakeSub(endpoint: string, key: Uint8Array = KEY) {
  return {
    endpoint,
    options: { applicationServerKey: key.slice().buffer },
    toJSON: () => ({ endpoint, keys: { p256dh: 'pk', auth: 'au' } }),
    unsubscribe: vi.fn(async () => true),
  };
}

// A Safari-shaped browser: Notification + window.pushManager, permission as given.
function safari(opts: { permission?: NotificationPermission; ask?: NotificationPermission } = {}) {
  const requestPermission = vi.fn(async () => opts.ask ?? 'granted');
  vi.stubGlobal('Notification', { permission: opts.permission ?? 'default', requestPermission });
  let current: ReturnType<typeof fakeSub> | null = null;
  const pm = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async () => (current = fakeSub('https://web.push.apple.com/new'))),
    set: (s: ReturnType<typeof fakeSub> | null) => (current = s),
  };
  Object.defineProperty(window, 'pushManager', { value: pm, configurable: true });
  return { requestPermission, pm };
}

const ua = (s: string) => vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(s);

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { pushManager?: unknown }).pushManager;
});

describe('urlBase64ToUint8Array', () => {
  it('decodes the VAPID key to its 65-byte uncompressed point', () => {
    expect(KEY.length).toBe(65);
    expect(KEY[0]).toBe(4);
    expect([...urlBase64ToUint8Array('-_8')]).toEqual([0xfb, 0xff]);
  });
});

describe('deviceLabel', () => {
  it('names the device and browser', () => {
    expect(deviceLabel(IPHONE)).toBe('iPhone · Safari');
    expect(deviceLabel(MAC_SAFARI)).toBe('Mac · Safari');
    expect(deviceLabel(MAC_CHROME)).toBe('Mac · Chrome');
    expect(deviceLabel(WIN_EDGE)).toBe('Windows · Edge');
    expect(deviceLabel(IOS_CHROME)).toBe('iPhone · Chrome');
    expect(deviceLabel(MAC_SAFARI, 5)).toBe('iPad · Safari'); // iPadOS reports a Mac
  });

  it('falls back when it recognises nothing, and stays within the label limit', () => {
    expect(deviceLabel('curl')).toBe('This device');
    expect(deviceLabel('Mozilla/5.0 (X11; Linux x86_64) Gecko Firefox/140.0')).toBe(
      'Linux · Firefox',
    );
    expect(deviceLabel(`${'x'.repeat(200)} iPhone Safari/1`).length).toBeLessThanOrEqual(
      PUSH_LABEL_MAX,
    );
  });
});

describe('pushSupport', () => {
  it('iOS Safari outside the Home Screen app is told to install; elsewhere, unsupported', () => {
    ua(IPHONE);
    expect(pushSupport()).toBe('install');
    ua(MAC_CHROME);
    expect(pushSupport()).toBe('unsupported');
  });

  it('a browser with Notification and a push manager is ok', () => {
    safari();
    expect(pushSupport()).toBe('ok');
  });
});

describe('pushManagerOf', () => {
  it("prefers Safari's window manager", async () => {
    const { pm } = safari();
    expect(await pushManagerOf()).toBe(pm);
  });

  it('is null with no service worker registered (vite dev), without waiting on ready', async () => {
    vi.stubGlobal('PushManager', class {});
    const ready = new Promise(() => {});
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { getRegistration: async () => undefined, ready },
      configurable: true,
    });
    try {
      expect(await pushManagerOf()).toBeNull();
    } finally {
      delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    }
  });

  it('is null where the browser has no push at all', async () => {
    expect(await pushManagerOf()).toBeNull();
  });
});

describe('subscribeHere', () => {
  it('asks for permission before its first await, so the tap is still the gesture', async () => {
    const { requestPermission } = safari();
    ua(IPHONE);
    const done = subscribeHere(STUB_VAPID_PUBLIC_KEY);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(await done).toEqual({
      endpoint: 'https://web.push.apple.com/new',
      keys: { p256dh: 'pk', auth: 'au' },
      label: 'iPhone · Safari',
    });
  });

  it('asks first on the service-worker path too (no window manager), then subscribes there', async () => {
    const requestPermission = vi.fn(async () => 'granted' as const);
    vi.stubGlobal('Notification', { permission: 'default', requestPermission });
    vi.stubGlobal('PushManager', class {});
    const pm = {
      getSubscription: vi.fn(async () => null),
      subscribe: vi.fn(async () => fakeSub('https://fcm.googleapis.com/fcm/send/sw')),
    };
    const reg = { pushManager: pm };
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { getRegistration: async () => reg, ready: Promise.resolve(reg) },
      configurable: true,
    });
    ua(MAC_CHROME);
    try {
      const done = subscribeHere(STUB_VAPID_PUBLIC_KEY);
      expect(requestPermission).toHaveBeenCalledTimes(1); // before any await
      expect((await done).endpoint).toBe('https://fcm.googleapis.com/fcm/send/sw');
      expect(pm.subscribe).toHaveBeenCalledTimes(1);
    } finally {
      delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    }
  });

  it('a denial on iPhone says where to turn it back on', async () => {
    const { pm } = safari({ ask: 'denied' });
    ua(IPHONE);
    await expect(subscribeHere(STUB_VAPID_PUBLIC_KEY)).rejects.toThrow(
      'iOS Settings › Notifications › Aperture',
    );
    expect(pm.subscribe).not.toHaveBeenCalled();
  });

  it('a dismissed prompt asks to try again', async () => {
    safari({ ask: 'default' });
    await expect(subscribeHere(STUB_VAPID_PUBLIC_KEY)).rejects.toThrow(/tap Enable/);
  });

  it('replaces a subscription made with another key, and keeps one made with this key', async () => {
    const { pm } = safari();
    const old = fakeSub('https://web.push.apple.com/old', OTHER_KEY);
    pm.set(old);
    expect((await subscribeHere(STUB_VAPID_PUBLIC_KEY)).endpoint).toBe(
      'https://web.push.apple.com/new',
    );
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(pm.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: KEY });

    pm.subscribe.mockClear();
    expect((await subscribeHere(STUB_VAPID_PUBLIC_KEY)).endpoint).toBe(
      'https://web.push.apple.com/new',
    );
    expect(pm.subscribe).not.toHaveBeenCalled();
  });

  it('says it isn’t available — with the Home Screen hint on iPhone Safari', async () => {
    ua(MAC_CHROME);
    await expect(subscribeHere(STUB_VAPID_PUBLIC_KEY)).rejects.toThrow(PUSH_UNSUPPORTED_COPY);
    ua(IPHONE);
    await expect(subscribeHere(STUB_VAPID_PUBLIC_KEY)).rejects.toThrow(PUSH_INSTALL_COPY);
  });
});

describe('resyncHere (D7)', () => {
  const device = (id: string) => ({
    id,
    label: 'iPhone · Safari',
    createdAt: 0,
    lastOkAt: null,
    lastError: null,
    lastErrorAt: null,
  });
  const fresh = (pm: ReturnType<typeof safari>['pm']) =>
    pm.subscribe.mock.results[0]!.value as Promise<ReturnType<typeof fakeSub>>;

  it('does nothing on a device that never turned reminders on', async () => {
    const { pm } = safari({ permission: 'granted' });
    const upsert = vi.fn();
    expect(await resyncHere(status(), NOW, upsert)).toBe(false);
    expect(pm.getSubscription).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('a healthy launch writes nothing — no daily re-upsert — and clears an old failure', async () => {
    const { pm } = safari({ permission: 'granted' });
    pm.set(fakeSub('https://web.push.apple.com/a'));
    rememberHere(device('d1'), NOW - 3 * 86_400_000);
    localStorage.setItem('aperture.push.syncError', 'subscribePush failed (503)');
    const upsert = vi.fn();
    expect(await resyncHere(status({ devices: [device('d1')] }), NOW, upsert)).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
    expect(pm.subscribe).not.toHaveBeenCalled();
    expect(syncErrorHere()).toBeNull();
  });

  it('re-subscribes when iOS dropped the subscription, and remembers the new id', async () => {
    const { pm } = safari({ permission: 'granted' });
    rememberHere(device('d1'), NOW);
    const upsert = vi.fn(async () => device('d2'));
    expect(await resyncHere(status({ devices: [device('d1')] }), NOW, upsert)).toBe(true);
    expect(pm.subscribe).toHaveBeenCalledTimes(1);
    expect(deviceIdHere()).toBe('d2');
  });

  it('re-subscribes when the stage’s key changed', async () => {
    const { pm } = safari({ permission: 'granted' });
    const old = fakeSub('https://web.push.apple.com/old', OTHER_KEY);
    pm.set(old);
    rememberHere(device('d1'), NOW);
    await resyncHere(status({ devices: [device('d1')] }), NOW, async () => device('d2'));
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(pm.subscribe).toHaveBeenCalledTimes(1);
  });

  it('the server dropped the device (a dead endpoint): drops it and subscribes fresh, never re-sending it', async () => {
    const { pm } = safari({ permission: 'granted' });
    const dead = fakeSub('https://web.push.apple.com/a'); // made with this key, so it looks healthy
    pm.set(dead);
    rememberHere(device('d1'), NOW);
    const upsert = vi.fn(async () => device('d2'));
    expect(await resyncHere(status(), NOW, upsert)).toBe(true);
    expect(dead.unsubscribe).toHaveBeenCalled();
    expect(pm.subscribe).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://web.push.apple.com/new' }),
    );
    expect(deviceIdHere()).toBe('d2');
  });

  it('a device removed elsewhere is left to the status read — the resync neither heals nor drops it', async () => {
    const { pm } = safari({ permission: 'granted' });
    pm.set(fakeSub('https://web.push.apple.com/a'));
    rememberHere(device('d1'), NOW);
    const upsert = vi.fn();
    expect(await resyncHere(status({ removedDeviceIds: ['d1'] }), NOW, upsert)).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
    expect(pm.subscribe).not.toHaveBeenCalled();
    expect(deviceIdHere()).toBe('d1');
  });

  it('a read from before this device last opted in can’t speak for it', async () => {
    const { pm } = safari({ permission: 'granted' });
    rememberHere(device('d1'), NOW);
    const upsert = vi.fn();
    expect(await resyncHere(status(), NOW, upsert, NOW - 1)).toBe(false);
    expect(pm.getSubscription).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('removed here while it subscribed: the new subscription goes and nothing is upserted', async () => {
    const { pm } = safari({ permission: 'granted' });
    rememberHere(device('d1'), NOW);
    const subscribe = pm.subscribe.getMockImplementation()!;
    pm.subscribe.mockImplementationOnce(async () => {
      forgetHere(); // a Remove on this device lands meanwhile
      return subscribe();
    });
    const upsert = vi.fn();
    expect(await resyncHere(status(), NOW, upsert)).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
    expect((await fresh(pm)).unsubscribe).toHaveBeenCalled();
    expect(deviceIdHere()).toBeNull();
  });

  it('removed here while the upsert was out: not remembered, and the subscription goes', async () => {
    const { pm } = safari({ permission: 'granted' });
    rememberHere(device('d1'), NOW);
    const upsert = vi.fn(async () => {
      forgetHere();
      return device('d2');
    });
    expect(await resyncHere(status(), NOW, upsert)).toBe(false);
    expect(deviceIdHere()).toBeNull();
    expect((await fresh(pm)).unsubscribe).toHaveBeenCalled();
  });

  it('a new Enable meanwhile owns the subscription: the resync stands down and leaves it', async () => {
    const { pm } = safari({ permission: 'granted' });
    rememberHere(device('d1'), NOW);
    const upsert = vi.fn(async () => {
      rememberHere(device('d3'), NOW + 5);
      return device('d2');
    });
    expect(await resyncHere(status(), NOW, upsert)).toBe(false);
    expect(deviceIdHere()).toBe('d3');
    expect((await fresh(pm)).unsubscribe).not.toHaveBeenCalled();
  });

  it('afterResync waits for the run in flight', async () => {
    safari({ permission: 'granted' });
    rememberHere(device('d1'), NOW);
    let release!: () => void;
    const upsert = vi.fn(
      () => new Promise<ReturnType<typeof device>>((r) => (release = () => r(device('d1')))),
    );
    const run = resyncHere(status(), NOW, upsert);
    let waited = false;
    const after = afterResync().then(() => (waited = true));
    await vi.waitFor(() => expect(upsert).toHaveBeenCalled());
    expect(waited).toBe(false);
    release();
    await run;
    await after;
    expect(waited).toBe(true);
  });

  it('stays out when permission went away or the stage has no key', async () => {
    safari({ permission: 'denied' });
    rememberHere(device('d1'), NOW);
    const upsert = vi.fn();
    expect(await resyncHere(status(), NOW, upsert)).toBe(false);
    vi.stubGlobal('Notification', { permission: 'granted' });
    expect(await resyncHere(status({ configured: false, vapidPublicKey: null }), NOW, upsert)).toBe(
      false,
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('remembers a failure for Settings and Home; a dismissal holds until a new one; success clears it', async () => {
    safari({ permission: 'granted' });
    rememberHere(device('d1'), NOW);
    const failing = async () => {
      throw new Error('subscribePush failed (503)');
    };
    await expect(resyncHere(status(), NOW, failing)).rejects.toThrow('503');
    expect(syncErrorHere()).toBe('subscribePush failed (503)');
    expect(syncErrorUndismissed()).toBe('subscribePush failed (503)');
    dismissSyncError();
    expect(syncErrorUndismissed()).toBeNull();
    expect(syncErrorHere()).toBe('subscribePush failed (503)'); // Settings still says it
    await expect(resyncHere(status(), NOW, failing)).rejects.toThrow('503');
    expect(syncErrorUndismissed()).toBe('subscribePush failed (503)'); // a new failure shows again
    await resyncHere(status(), NOW, async () => device('d1'));
    expect(syncErrorHere()).toBeNull();
    expect(syncErrorUndismissed()).toBeNull();
    forgetHere();
    expect(deviceIdHere()).toBeNull();
  });
});

describe('dropIfRemovedHere', () => {
  const device = (id: string) => ({
    id,
    label: 'iPhone · Safari',
    createdAt: 0,
    lastOkAt: null,
    lastError: null,
    lastErrorAt: null,
  });

  it('removed on another device: the removal sticks — drops the opt-in and subscription, leaves a note', async () => {
    const { pm } = safari({ permission: 'granted' });
    const sub = fakeSub('https://web.push.apple.com/a');
    pm.set(sub);
    rememberHere(device('d1'), NOW);
    expect(await dropIfRemovedHere(status({ removedDeviceIds: ['d1'] }), NOW + 1)).toBe(true);
    expect(pm.subscribe).not.toHaveBeenCalled();
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(deviceIdHere()).toBeNull();
    expect(removedElsewhereHere()).toBe(true);
    // No opt-in left, so a later read changes nothing; the note stays until dismissed or re-enabled.
    expect(await dropIfRemovedHere(status({ removedDeviceIds: ['d1'] }), NOW + 2)).toBe(false);
    expect(removedElsewhereHere()).toBe(true);
    dismissRemovedElsewhere();
    expect(removedElsewhereHere()).toBe(false);
  });

  it('a read asked for before this device re-enabled can’t drop the new opt-in', async () => {
    safari({ permission: 'granted' });
    rememberHere(device('d1'), NOW);
    const removed = status({ removedDeviceIds: ['d1'] });
    expect(await dropIfRemovedHere(removed, NOW - 1)).toBe(false);
    expect(deviceIdHere()).toBe('d1');
    expect(await dropIfRemovedHere(removed, NOW + 1)).toBe(true);
    expect(deviceIdHere()).toBeNull();
  });

  it('another device’s removal leaves this one alone; enabling again clears the note', async () => {
    safari({ permission: 'granted' });
    rememberHere(device('d1'), NOW);
    expect(await dropIfRemovedHere(status({ removedDeviceIds: ['d9'] }), NOW + 1)).toBe(false);
    expect(deviceIdHere()).toBe('d1');
    localStorage.setItem('aperture.push.removedElsewhere', '1');
    rememberHere(device('d1'), NOW);
    expect(removedElsewhereHere()).toBe(false);
  });
});
