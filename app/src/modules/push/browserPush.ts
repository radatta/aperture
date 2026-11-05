import { dayKey, PUSH_LABEL_MAX } from '@aperture/shared';
import type { PushDevice, PushStatus, SubscribePushInput } from '@aperture/shared';

// The browser half of reminders (docs/areas/tasks/reminders.md): find this browser's push manager, ask
// for permission inside the tap, subscribe with the stage's VAPID key, and remember on this device that
// it opted in, so a launch can quietly heal a subscription iOS dropped (D7). No service-worker push
// handler: Safari shows a declarative push itself.

export const PUSH_UNSUPPORTED_COPY = 'Reminders aren’t available in this browser.';
export const PUSH_INSTALL_COPY =
  'Reminders aren’t available in Safari itself — add Aperture to your Home Screen (Share › Add to Home Screen) and open it from there.';
const IOS_DENIED_COPY =
  'Notifications are off for Aperture — re-enable in iOS Settings › Notifications › Aperture.';
const DENIED_COPY =
  'Notifications are blocked for Aperture in this browser — allow them in its site settings, then try again.';
const NO_PERMISSION_COPY = 'Notifications weren’t allowed — tap Enable to be asked again.';

const SW_READY_MS = 5000;
const ENABLED_KEY = 'aperture.push.enabled'; // this device's id, set when it opted in here
const SYNCED_KEY = 'aperture.push.syncedDay'; // the day a launch last confirmed the subscription
const SYNC_ERROR_KEY = 'aperture.push.syncError'; // why the last launch couldn't re-subscribe

// iPadOS reports a Mac UA; its touch points give it away.
const isIOS = (ua: string, touchPoints = 0) =>
  /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);

const standalone = () =>
  (navigator as Navigator & { standalone?: boolean }).standalone === true ||
  (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches);

const windowPushManager = (): PushManager | null =>
  (window as Window & { pushManager?: PushManager }).pushManager ?? null;

// ok = this browser can subscribe; install = iOS Safari outside the Home Screen app, where Web Push only
// works once installed; unsupported = no Web Push here at all.
export type PushSupport = 'ok' | 'install' | 'unsupported';
export function pushSupport(): PushSupport {
  const hasApi =
    typeof Notification !== 'undefined' &&
    (!!windowPushManager() || ('PushManager' in window && 'serviceWorker' in navigator));
  if (hasApi) return 'ok';
  return isIOS(navigator.userAgent, navigator.maxTouchPoints) && !standalone()
    ? 'install'
    : 'unsupported';
}

export const notificationPermission = (): NotificationPermission | 'unsupported' =>
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

export const deniedCopy = (ua = navigator.userAgent, touchPoints = navigator.maxTouchPoints) =>
  isIOS(ua, touchPoints) ? IOS_DENIED_COPY : DENIED_COPY;

// Safari's window-level manager first (it shares the root service worker's subscription), then the
// service worker's. null = not available here — no worker registered (vite dev) or it never activated.
export async function pushManagerOf(): Promise<PushManager | null> {
  const own = windowPushManager();
  if (own) return own;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  try {
    if (!(await navigator.serviceWorker.getRegistration())) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>(
      (resolve) => (timer = setTimeout(resolve, SW_READY_MS, null)),
    );
    const reg = await Promise.race([navigator.serviceWorker.ready, timeout]);
    clearTimeout(timer);
    return reg?.pushManager ?? null;
  } catch {
    return null;
  }
}

// The VAPID key as subscribe wants it: base64url → bytes.
export function urlBase64ToUint8Array(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = (b64url + '='.repeat((4 - (b64url.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(have: ArrayBuffer | null | undefined, want: Uint8Array): boolean {
  if (!have || have.byteLength !== want.length) return false;
  const bytes = new Uint8Array(have);
  return bytes.every((b, i) => b === want[i]);
}

// What the device list calls this browser: "iPhone · Safari", "Mac · Chrome". Every iOS browser is
// WebKit, so there the brand comes from its UA token.
export function deviceLabel(ua: string, touchPoints = 0): string {
  const device = /iPhone|iPod/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh|Mac OS X/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /CrOS/.test(ua)
              ? 'Chromebook'
              : /Linux/.test(ua)
                ? 'Linux'
                : null;
  const browser = /EdgiOS|Edg\//.test(ua)
    ? 'Edge'
    : /FxiOS|Firefox\//.test(ua)
      ? 'Firefox'
      : /CriOS|Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua) || /AppleWebKit/.test(ua)
          ? 'Safari'
          : null;
  const label = [device, browser].filter(Boolean).join(' · ') || 'This device';
  return label.length <= PUSH_LABEL_MAX ? label : label.slice(0, PUSH_LABEL_MAX);
}

function toInput(sub: PushSubscription): SubscribePushInput {
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth)
    throw new Error('This browser’s subscription came back without its keys — try again.');
  return {
    endpoint: json.endpoint,
    keys: { p256dh, auth },
    label: deviceLabel(navigator.userAgent, navigator.maxTouchPoints),
  };
}

// Subscribed with `key`, replacing one made with another (a rotated VAPID key: its pushes would be refused).
async function subscribeWith(pm: PushManager, key: Uint8Array<ArrayBuffer>) {
  const had = await pm.getSubscription();
  if (had && sameKey(had.options.applicationServerKey, key)) return had;
  await had?.unsubscribe();
  return pm.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

// Asks for permission and subscribes. Call it from the tap itself: on Safari the permission request is
// the first thing it does, before any await, so the tap still counts as the gesture.
export async function subscribeHere(publicKey: string): Promise<SubscribePushInput> {
  if (typeof Notification === 'undefined') throw new Error(unavailableCopy());
  const own = windowPushManager();
  const asked = own ? Notification.requestPermission() : null;
  const pm = own ?? (await pushManagerOf());
  if (!pm) throw new Error(unavailableCopy());
  const permission = await (asked ?? Notification.requestPermission());
  if (permission === 'denied') throw new Error(deniedCopy());
  if (permission !== 'granted') throw new Error(NO_PERMISSION_COPY);
  return toInput(await subscribeWith(pm, urlBase64ToUint8Array(publicKey)));
}

const unavailableCopy = () =>
  pushSupport() === 'install' ? PUSH_INSTALL_COPY : PUSH_UNSUPPORTED_COPY;

export async function currentSubscription(): Promise<PushSubscription | null> {
  const pm = await pushManagerOf();
  return pm ? pm.getSubscription() : null;
}

// --- this device's stamps (localStorage; storage can throw — then nothing is remembered) ----------
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // not remembered — the next launch just checks again
  }
}

// The id this device's subscription has on the server, when it turned reminders on here.
export const deviceIdHere = (): string | null => read(ENABLED_KEY);
export const syncErrorHere = (): string | null => read(SYNC_ERROR_KEY);

export function rememberHere(device: PushDevice, now: number): void {
  write(ENABLED_KEY, device.id);
  write(SYNCED_KEY, dayKey(now, 0));
  write(SYNC_ERROR_KEY, null);
}
export function forgetHere(): void {
  for (const k of [ENABLED_KEY, SYNCED_KEY, SYNC_ERROR_KEY]) write(k, null);
}

// D7, on launch: when this device turned reminders on and still has permission, make sure the server and
// the browser agree — re-subscribe when iOS dropped the subscription or the stage's key changed, and
// re-upsert when the server lost the device (a 410 cleanup) or once a day. A healthy launch writes
// nothing else. Resolves true when it wrote. A failure is remembered for Settings to show, then rethrown.
export async function resyncHere(
  status: PushStatus,
  now: number,
  upsert: (input: SubscribePushInput) => Promise<PushDevice>,
): Promise<boolean> {
  const id = deviceIdHere();
  if (!id || !status.configured || !status.vapidPublicKey) return false;
  if (notificationPermission() !== 'granted') return false;
  try {
    const pm = await pushManagerOf();
    if (!pm) return false;
    const key = urlBase64ToUint8Array(status.vapidPublicKey);
    const had = await pm.getSubscription();
    const healthy = !!had && sameKey(had.options.applicationServerKey, key);
    const known = status.devices.some((d) => d.id === id);
    if (healthy && known && read(SYNCED_KEY) === dayKey(now, 0)) return false;
    const sub = healthy ? had : await subscribeWith(pm, key);
    rememberHere(await upsert(toInput(sub)), now);
    return true;
  } catch (e) {
    write(SYNC_ERROR_KEY, e instanceof Error ? e.message : String(e));
    throw e;
  }
}
