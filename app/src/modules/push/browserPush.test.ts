import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayKey, PUSH_LABEL_MAX } from '@aperture/shared';
import type { PushStatus } from '@aperture/shared';
import { STUB_VAPID_PUBLIC_KEY } from '../../data/stubClient';
import {
  deviceIdHere,
  deviceLabel,
  forgetHere,
  PUSH_INSTALL_COPY,
  PUSH_UNSUPPORTED_COPY,
  pushManagerOf,
  pushSupport,
  rememberHere,
  resyncHere,
  subscribeHere,
  syncErrorHere,
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

  it('does nothing on a device that never turned reminders on', async () => {
    const { pm } = safari({ permission: 'granted' });
    const upsert = vi.fn();
    expect(await resyncHere(status(), NOW, upsert)).toBe(false);
    expect(pm.getSubscription).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('a healthy launch already confirmed today writes nothing', async () => {
    const { pm } = safari({ permission: 'granted' });
    pm.set(fakeSub('https://web.push.apple.com/a'));
    rememberHere(device('d1'), NOW);
    const upsert = vi.fn();
    expect(await resyncHere(status({ devices: [device('d1')] }), NOW + 60_000, upsert)).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('re-upserts once on a new day, without re-subscribing', async () => {
    const { pm } = safari({ permission: 'granted' });
    pm.set(fakeSub('https://web.push.apple.com/a'));
    rememberHere(device('d1'), NOW - 86_400_000);
    const upsert = vi.fn(async () => device('d1'));
    expect(await resyncHere(status({ devices: [device('d1')] }), NOW, upsert)).toBe(true);
    expect(pm.subscribe).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://web.push.apple.com/a' }),
    );
    expect(localStorage.getItem('aperture.push.syncedDay')).toBe(dayKey(NOW, 0));
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

  it('re-upserts when the server lost the device', async () => {
    const { pm } = safari({ permission: 'granted' });
    pm.set(fakeSub('https://web.push.apple.com/a'));
    rememberHere(device('d1'), NOW);
    const upsert = vi.fn(async () => device('d1'));
    expect(await resyncHere(status(), NOW, upsert)).toBe(true);
    expect(pm.subscribe).not.toHaveBeenCalled();
  });

  it('stays out when permission went away or the stage has no key', async () => {
    safari({ permission: 'denied' });
    rememberHere(device('d1'), NOW - 86_400_000);
    const upsert = vi.fn();
    expect(await resyncHere(status(), NOW, upsert)).toBe(false);
    vi.stubGlobal('Notification', { permission: 'granted' });
    expect(await resyncHere(status({ configured: false, vapidPublicKey: null }), NOW, upsert)).toBe(
      false,
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('remembers a failure for Settings and rethrows; a later success clears it', async () => {
    safari({ permission: 'granted' });
    rememberHere(device('d1'), NOW);
    await expect(
      resyncHere(status(), NOW, async () => {
        throw new Error('subscribePush failed (503)');
      }),
    ).rejects.toThrow('503');
    expect(syncErrorHere()).toBe('subscribePush failed (503)');
    await resyncHere(status(), NOW, async () => device('d1'));
    expect(syncErrorHere()).toBeNull();
    forgetHere();
    expect(deviceIdHere()).toBeNull();
  });
});
