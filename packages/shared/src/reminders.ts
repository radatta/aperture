// Reminders — Web Push pings to the installed PWA (docs/areas/tasks/reminders.md). Pure rules shared by
// the stub, the BFF and the push-dispatch poller: when a task or plan fires, what the notification says,
// the declarative payload Safari shows without a service-worker handler, and which push services a
// subscription may point at. The poller (lambdas/src/push/dispatch.ts) is the only sender.

import { fmtClock12 } from './dates';
import type { DueEpoch } from './due';
import type { Settings, Task, TaskPlan } from './types';

// A day-only deadline and a planned day both ping at this wall-clock time (user's zone). A constant, not
// a setting — each kind's toggle is the off switch.
export const DAY_REMINDER_TIME = '09:00';
// How far back a tick looks: a reminder missed by a failed tick or a short outage still fires within
// this; anything older is missed (and the health line shows the gap), never fired hours late.
export const REMINDER_WINDOW_MS = 30 * 60_000;
// Hidden per-user daily cap on sends (user's day) — a guard against a bug spamming, not a setting.
// Past it the poller refuses and stamps the health line's error.
export const PUSH_DAILY_GUARD = 50;
// The poller runs every minute; a heartbeat older than this reads as "paused" in Settings.
export const PUSH_STALE_MS = 5 * 60_000;
// How long a push service keeps an undelivered message (the TTL header), seconds.
export const PUSH_TTL_S = 3600;
// The encrypted record must fit a 4 KB push message; the plaintext stays under this.
export const PUSH_PAYLOAD_MAX = 3900;
export const PUSH_TITLE_MAX = 120;
export const PUSH_BODY_MAX = 400;
export const PUSH_LABEL_MAX = 60;

// The push services a subscription may point at — the poller POSTs to stored endpoints, so this is the
// one gate against the server being aimed elsewhere (SSRF). `*.` admits subdomains only.
export const PUSH_ENDPOINT_HOSTS = [
  'web.push.apple.com',
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  '*.notify.windows.com',
] as const;

export const PUSH_ENDPOINT_ERROR = "That push endpoint isn't a known push service";
export const PUSH_UNCONFIGURED_ERROR = "Reminders aren't set up on this stage yet";
export const PUSH_NO_DEVICE_ERROR = 'Turn on reminders on a device first';

export type ReminderSettingKey =
  'remindTimed' | 'remindDueDay' | 'remindPlanned' | 'nudgeMorning' | 'nudgeNight';
export const REMINDER_SETTINGS_DEFAULTS: Pick<Settings, ReminderSettingKey> = {
  remindTimed: true,
  remindDueDay: true,
  remindPlanned: true,
  nudgeMorning: true,
  nudgeNight: true,
};

// timed = a deadline with a clock time, dueDay = a day-only deadline, planned = on a day's plan,
// test = Settings' Send test, ritualMorning / ritualNight = the day's two ritual nudges (RITUAL_TIMES).
export type ReminderKind = 'timed' | 'dueDay' | 'planned' | 'test' | RitualKind;
export type RitualKind = 'ritualMorning' | 'ritualNight';

export const SETTING_OF_KIND: Record<Exclude<ReminderKind, 'test'>, ReminderSettingKey> = {
  timed: 'remindTimed',
  dueDay: 'remindDueDay',
  planned: 'remindPlanned',
  ritualMorning: 'nudgeMorning',
  ritualNight: 'nudgeNight',
};

// The ritual nudges' wall-clock times (user's zone): plan the day, close the day. Constants like
// DAY_REMINDER_TIME — each nudge's toggle is the off switch. No auto-mute (the maintainer, 11-18).
export const RITUAL_TIMES: Record<RitualKind, string> = {
  ritualMorning: '08:30',
  ritualNight: '21:30',
};
export const RITUAL_KINDS = Object.keys(RITUAL_TIMES) as RitualKind[];
export const isRitual = (kind: ReminderKind): kind is RitualKind => kind in RITUAL_TIMES;

// Rows written before the toggles existed read back undefined — on, like the defaults.
export const reminderEnabled = (
  kind: ReminderKind,
  settings: Partial<Pick<Settings, ReminderSettingKey>>,
): boolean => kind === 'test' || settings[SETTING_OF_KIND[kind]] !== false;

const isOpen = (t: Pick<Task, 'status' | 'deletedAt'>): boolean =>
  t.deletedAt === null && t.status !== 'done' && t.status !== 'cancelled';

// The kind a task's deadline pings as, or null when it has none (a plan is the other source).
export const reminderKind = (t: Pick<Task, 'dueDay' | 'dueTime'>): 'timed' | 'dueDay' | null =>
  !t.dueDay ? null : t.dueTime ? 'timed' : 'dueDay';

// When an open task's deadline pings: at its due time, or DAY_REMINDER_TIME on a day-only due day.
// null for a finished, tombstoned or undated task. Errands and parts ping like any task.
export function taskFireAt(
  t: Pick<Task, 'status' | 'deletedAt' | 'dueDay' | 'dueTime'>,
  epoch: DueEpoch,
): number | null {
  if (!isOpen(t) || !t.dueDay) return null;
  return epoch(t.dueDay, t.dueTime || DAY_REMINDER_TIME);
}

// When a plan pings: DAY_REMINDER_TIME on its day. Whether its task is still open and untimed is checked
// at fire time (a timed task is never planned — machines.ts TIMED_NO_PLAN_ERROR).
export const planFireAt = (
  p: Pick<TaskPlan, 'day' | 'deletedAt'>,
  epoch: DueEpoch,
): number | null => (p.deletedAt === null ? epoch(p.day, DAY_REMINDER_TIME) : null);

// The ritual nudges that fall in [from, to]: each kind's time on the day keys `from` and `to` fall on,
// as epochs (DST-safe through `epoch`), oldest first. `dayKeyOf` maps an epoch to its day key in the
// user's zone.
export function ritualFireAts(
  from: number,
  to: number,
  epoch: DueEpoch,
  dayKeyOf: (at: number) => string,
): { kind: RitualKind; day: string; fireAt: number }[] {
  const days = [...new Set([dayKeyOf(from), dayKeyOf(to)])];
  return days
    .flatMap((day) =>
      RITUAL_KINDS.map((kind) => ({ kind, day, fireAt: epoch(day, RITUAL_TIMES[kind]) })),
    )
    .filter((r) => r.fireAt >= from && r.fireAt <= to)
    .sort((a, b) => a.fireAt - b.fireAt);
}

// One thing to ping about, as the poller found it.
export interface ReminderCandidate {
  kind: ReminderKind;
  fireAt: number;
  taskId: string | null; // null for test and the rituals
  title: string;
  dueTime: string | null; // timed only
  body?: string; // a ritual's count line, set by the poller
}

// A ritual's count line — counts only, never "missed" (the maintainer, 11-03). `open` and `done` are
// the day's planned tasks (cancelled ones left out).
export function ritualCopy(
  kind: RitualKind,
  counts: { open: number; done: number },
): { title: string; body: string } {
  if (kind === 'ritualMorning') {
    const n = counts.open + counts.done;
    return { title: 'Plan your day', body: n > 0 ? `${n} planned today` : 'Nothing planned yet' };
  }
  const parts = [
    ...(counts.open > 0 ? [`${counts.open} left open`] : []),
    ...(counts.done > 0 ? [`${counts.done} done`] : []),
  ];
  return {
    title: 'Close the day',
    body: parts.length > 0 ? parts.join(' · ') : 'Nothing on today’s plan',
  };
}

// By code points, so an emoji at the cut isn't split into half a surrogate pair.
const clip = (s: string, max: number): string => {
  const chars = Array.from(s);
  return chars.length <= max
    ? s
    : `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
};
const titleOf = (c: ReminderCandidate): string =>
  c.kind === 'test' ? 'Aperture test' : c.title.trim() || 'Untitled task';

const BODY_OF: Record<ReminderKind, (c: ReminderCandidate) => string> = {
  timed: (c) => `Due now · ${fmtClock12(c.dueTime ?? DAY_REMINDER_TIME)}`,
  dueDay: () => 'Due today',
  planned: () => 'Planned for today',
  test: () => 'Reminders reach this device',
  ritualMorning: (c) => c.body ?? '',
  ritualNight: (c) => c.body ?? '',
};

// What the notification says. Several candidates in one tick become one notification — what keeps
// 09:00 from being a burst when day-only and planned tasks coincide.
export function reminderCopy(cands: readonly ReminderCandidate[]): { title: string; body: string } {
  if (cands.length === 0) throw new Error('reminderCopy needs a candidate');
  if (cands.length === 1) {
    const c = cands[0]!;
    return { title: clip(titleOf(c), PUSH_TITLE_MAX), body: BODY_OF[c.kind](c) };
  }
  const titles = cands.map((c) => clip(titleOf(c), PUSH_TITLE_MAX));
  return { title: `${cands.length} reminders`, body: clip(titles.join(' · '), PUSH_BODY_MAX) };
}

// The notification's tag (a later one with the same tag replaces it) and the push Topic header: the task
// id (a ULID — 26 chars, inside Topic's 32), the ritual's kind, or a batch's minute.
export const reminderTag = (cands: readonly ReminderCandidate[]): string => {
  if (cands.length > 1) return `b${Math.floor(cands[0]!.fireAt / 60_000)}`;
  const c = cands[0]!;
  return c.taskId ?? (c.kind === 'test' ? 'test' : c.kind);
};

// Where a tap lands: the task's modal on Today, or Today for a batch. `n` is the notification's tag (for
// PR 3's "opened" signal; ignored today).
export const taskPushPath = (taskId: string | null, tag: string): string =>
  `/tasks?lens=today${taskId ? `&task=${encodeURIComponent(taskId)}` : ''}&n=${encodeURIComponent(tag)}`;

// Safari's declarative push (iOS/macOS 26): shown by the system as-is, no push handler needed.
// `web_push: 8030`, a non-empty title and an absolute navigate URL are the required members.
export interface DeclarativePush {
  web_push: 8030;
  notification: {
    title: string;
    body: string;
    navigate: string;
    tag: string;
    silent: false;
    lang: 'en-US';
  };
}

function declarative(
  title: string,
  body: string,
  path: string,
  tag: string,
  appUrl: string,
): DeclarativePush {
  const payload: DeclarativePush = {
    web_push: 8030,
    notification: {
      title,
      body,
      navigate: `${appUrl.replace(/\/+$/, '')}${path}`,
      tag,
      silent: false,
      lang: 'en-US',
    },
  };
  if (new TextEncoder().encode(JSON.stringify(payload)).length > PUSH_PAYLOAD_MAX)
    throw new Error('push payload too large');
  return payload;
}

// The plaintext a send encrypts. `appUrl` is the stage's origin (config), never stored data. A retry
// passes the tag its first try went out under, so the push service replaces an undelivered first copy
// (RFC 8030 §5.4 Topic). A ritual is always alone in its notification and opens Home, whose clock mode
// is the ritual's (morning at 08:30, night at 21:30).
export function reminderPayload(
  cands: readonly ReminderCandidate[],
  appUrl: string,
  tag: string = reminderTag(cands),
): DeclarativePush {
  const { title, body } = reminderCopy(cands);
  const only = cands.length === 1 ? cands[0]! : null;
  const path = only && isRitual(only.kind) ? '/' : taskPushPath(only?.taskId ?? null, tag);
  return declarative(title, body, path, tag, appUrl);
}

// The one catch-up after reminders that never reached a device (retries ran out, or the poller was down
// past the window): "N reminders didn't reach you", their titles, opening Today. Its tag is its minute.
export const catchUpTag = (now: number): string => `c${Math.floor(now / 60_000)}`;
export function catchUpPayload(
  cands: readonly ReminderCandidate[],
  appUrl: string,
  now: number,
): DeclarativePush {
  if (cands.length === 0) throw new Error('catchUpPayload needs a candidate');
  const n = cands.length;
  const title = n === 1 ? '1 reminder didn’t reach you' : `${n} reminders didn’t reach you`;
  const body = clip(cands.map((c) => clip(titleOf(c), PUSH_TITLE_MAX)).join(' · '), PUSH_BODY_MAX);
  const tag = catchUpTag(now);
  return declarative(title, body, taskPushPath(null, tag), tag, appUrl);
}

const hostAllowed = (host: string): boolean =>
  PUSH_ENDPOINT_HOSTS.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) : host === h));

// An https URL on an allowlisted push service, no credentials, no custom port.
export function pushEndpointOk(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  return (
    u.protocol === 'https:' &&
    !u.username &&
    !u.password &&
    u.port === '' &&
    hostAllowed(u.hostname)
  );
}

// subscribePush's input — the browser's PushSubscription.toJSON() plus a label for the device list.
export interface SubscribePushInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label: string;
}

// subscribePush's input is untrusted JSON, checked the same way by the stub and the BFF (parsePushInput).
// The keys are opaque here (base64url, bounded): they're checked as a P-256 point + 16-octet secret only
// when the poller encrypts to them, and a device whose keys can't work is dropped then (push/dispatch.ts).
export const PUSH_ENDPOINT_MAX = 2048;
export const PUSH_KEY_MAX = 256;
export const PUSH_KEYS_ERROR = 'That push subscription is missing its keys';
// unsubscribePush with no id at all; an id that matches nothing is a no-op, not this.
export const PUSH_UNKNOWN_DEVICE_ERROR = 'Unknown device';
export const pushKeyOk = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= PUSH_KEY_MAX && /^[A-Za-z0-9_-]+=*$/.test(v);
// Whitespace collapsed, clipped to PUSH_LABEL_MAX; nothing usable reads "This device".
export const pushLabel = (v: unknown): string => {
  const label = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, PUSH_LABEL_MAX) : '';
  return label || 'This device';
};
// The input as stored, or a refusal: PUSH_ENDPOINT_ERROR (not a string, too long, off the allowlist) or
// PUSH_KEYS_ERROR (a key missing, empty, too long or not base64url).
export function parsePushInput(input: unknown): SubscribePushInput {
  const given = (input ?? {}) as Partial<SubscribePushInput>;
  const endpoint = given.endpoint;
  if (
    typeof endpoint !== 'string' ||
    endpoint.length > PUSH_ENDPOINT_MAX ||
    !pushEndpointOk(endpoint)
  )
    throw new Error(PUSH_ENDPOINT_ERROR);
  const p256dh = given.keys?.p256dh;
  const auth = given.keys?.auth;
  if (!pushKeyOk(p256dh) || !pushKeyOk(auth)) throw new Error(PUSH_KEYS_ERROR);
  return { endpoint, keys: { p256dh, auth }, label: pushLabel(given.label) };
}

// A device as Settings sees it. Never carries the endpoint keys (p256dh/auth are credentials: anyone with
// them and the endpoint can push to the device).
export interface PushDevice {
  id: string;
  label: string;
  createdAt: number;
  lastOkAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

export interface PushPollerHealth {
  lastRunAt: number | null;
  lastSentAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

export interface PushStatus {
  configured: boolean; // this stage has a VAPID public key
  vapidPublicKey: string | null; // base64url — the browser's applicationServerKey
  devices: PushDevice[];
  // Devices the user removed (unsubscribePush), so the removed device's own launch-time resync stops
  // instead of re-adding itself. A subscription the push service expired (404/410) is just gone — not
  // listed here — so that device heals itself on its next launch. Re-subscribing takes an id off.
  removedDeviceIds: string[];
  poller: PushPollerHealth;
}

// The subscription's id: a prefix of sha256(endpoint), so re-subscribing the same endpoint is an upsert.
export const PUSH_DEVICE_ID_LEN = 16;
