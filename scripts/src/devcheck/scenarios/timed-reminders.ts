// Timed reminders — Web Push from the push-dispatch poller (docs/areas/tasks/reminders.md). The deployed
// schedule is the engine: nothing here invokes the poller, so every send this scenario sees came from a real
// tick on dev. The cheap rows run first and depend on no tick. The two that do form one chain at the end,
// each fuse lit where it's waited on, so the chain can defer as a whole:
//   Send test → its tick drops C, a device whose keys no push service takes (no request at all) — then a
//   task due at the minute after the next tick, and A, a device with a real P-256 key pair on an Apple
//   endpoint that was never issued (`devcheck-e2e`), subscribed well before that minute so it's armed in time
//   (§3); the reminder's tick encrypts, signs and POSTs to A — the one malformed POST to Apple a run makes
//   (plan Q7, approved) — and Apple's refusal comes back on the health line. A goes the moment it's read.
//   Beside A in that tick, N: real keys on an allowlisted push host under a name never issued
//   (`devcheck-nx.notify.windows.com`), so its POST never resolves — a network failure, the retry chain's
//   transient fault. N is retried on the next 3 ticks, runs out, and 5 minutes later its one catch-up fails
//   the same way; each step is read off N's error. N goes once the catch-up's failure is read.
// Batching a reminder and a test into one notification is a unit test only (the maintainer, review round 3).
//
// Devices sit on fixed endpoints (api.ts HARNESS_PUSH_SLOTS), so their ids repeat run to run: a re-subscribe
// revives last run's tombstone instead of adding one (the ledger reads an id created again as pending again —
// ledger.ts pendingIds), and a live one is known as the harness's even when the ledger missed it. They're
// ledgered from the server's answer (api.ts, or the browser's subscribePush response via recorder.ts) and
// removed by id. The reminder toggles are recorded as `reminder-toggles:<run>` before any flip, so cleanup
// switches them back on whatever happens. This browser's opt-in and its launch-resync error are seeded in
// localStorage where a row needs them (headless Chromium reads notification permission as denied, so it can't
// subscribe itself, and the launch resync — which only runs when permission is granted — never touches
// them). Titles are `devcheck-rm <nonce> …` — the parts scenarios sweep `devcheck <nonce>`. The rows are the
// plan's dev-test matrix (localNotes/plan.md §5 E), with the removal rule and the armed-before-it-fires rule.
import { createECDH, randomBytes } from 'node:crypto';
import {
  harnessPushId,
  isHarnessPushId,
  type DevPushDevice,
  type DevPushStatus,
  type DevSubscribePushInput,
  type DevTask,
} from '../api';
import { laDay, needsYou, noConsoleErrors, type Ctx, type Scenario } from '../scenario';

// packages/shared/src/reminders.ts PUSH_ENDPOINT_ERROR (scripts doesn't depend on shared).
const PUSH_ENDPOINT_ERROR = "That push endpoint isn't a known push service";
// The schedule's rate, and how long past a tick's due time the poller may take (Lambda, Apple).
const TICK_MS = 60_000;
const TICK_WAIT_MS = 150_000;
// Server and harness clocks differ by a little; a stamp this much before a moment still counts as after it.
const CLOCK_SLACK_MS = 5_000;
// A is subscribed at least this long before the reminder's minute (it and the registry row arm it in time).
const A_LEAD_MS = 10_000;
// The reminder is due at a minute boundary at least this far past the tick that takes the test, so A has
// time to subscribe between the two.
const PING_LEAD_MS = 25_000;

const title = (ctx: Ctx, what: string) => `devcheck-rm ${ctx.nonce} ${what}`;
const label = (ctx: Ctx, which: string) => `Devcheck ${which} ${ctx.nonce}`;
const linkTo = (id: string) => `/tasks?lens=today&task=${id}&n=${id}`;

// "HH:MM" of `d` on the LA clock — with laDay, the deadline a task due this minute has.
export const laClock = (d: Date): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);

// A browser's subscription keys: a fresh P-256 public point and a 16-octet auth secret, base64url — what
// the poller encrypts to (RFC 8291). The private half is dropped: nothing ever decrypts.
export function pushKeys(): DevSubscribePushInput['keys'] {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
}
// Keys of the right shape that are no P-256 point: the poller drops the device without a request.
const UNUSABLE_KEYS = { p256dh: 'devcheck-not-a-point', auth: 'devcheck-not-a-secret' };

// A stage fault (dispatch.ts STAGE_ERROR: no key, a malformed key, no APP_URL) — all end the same way.
export const stageFault = (s: DevPushStatus): boolean =>
  /— reminders are off$/.test(s.poller.lastError ?? '');
// The health line's error, one entry per device that refused in that tick (dispatch.ts joins them).
const errorsOf = (s: DevPushStatus): string[] => (s.poller.lastError ?? '').split(' · ');
// "<label> stopped accepting reminders (its keys are invalid) — …": the poller dropped an unusable device.
export const droppedForKeys = (label: string) =>
  `${label} stopped accepting reminders (its keys are invalid)`;

// What the tick past `since` did to the end-to-end device, read from the status by the copy push/dispatch.ts
// writes. Apple refuses a never-issued endpoint, and a refusal is an error, never a send (lastSentAt moves
// only when a push service accepts), so the error's time says the attempt happened:
//   404/410 → the device is deleted and an entry of the user's health line names it:
//             "<label> stopped accepting reminders (push service answered 404|410) — …"
//   400/403 → the device stays, carrying "Last reminder didn't reach this device (push service answered 400|403)"
// null = not yet. Anything else a send can produce (a 5xx, 429, a timeout, a network failure, a 2xx, the
// stage's own error, the daily guard) is a failure, named.
export function e2eOutcome(
  s: DevPushStatus,
  deviceId: string,
  deviceLabel: string,
  since: number,
): { ok: true; how: string } | { ok: false; why: string } | null {
  const err = s.poller.lastError ?? '';
  if (stageFault(s)) return { ok: false, why: `the stage can't send: ${err}` };
  const fresh = (s.poller.lastErrorAt ?? 0) >= since - CLOCK_SLACK_MS;
  // Each run spends two of the test user's 50 a day (the reminder and Send test, one batch when they share a
  // tick): a run deep into a busy day finds the guard shut — named, not a timeout.
  if (fresh && err.startsWith('Daily reminder limit'))
    return { ok: false, why: `the daily guard held it back: ${err}` };
  const device = s.devices.find((d) => d.id === deviceId);
  if ((s.poller.lastSentAt ?? 0) >= since - CLOCK_SLACK_MS && device?.lastOkAt != null)
    return { ok: false, why: `Apple accepted a never-issued endpoint: ${JSON.stringify(device)}` };
  if (!device) {
    if (!fresh) return null;
    const re = new RegExp(
      `^${escape(deviceLabel)} stopped accepting reminders \\(push service answered (404|410)\\)`,
    );
    const gone = errorsOf(s)
      .map((e) => re.exec(e))
      .find(Boolean);
    if (gone && !s.removedDeviceIds.includes(deviceId))
      return { ok: true, how: `Apple answered ${gone[1]}: the poller deleted the device` };
    return { ok: false, why: `the device left without a 404/410: ${JSON.stringify(s.poller)}` };
  }
  if ((device.lastErrorAt ?? 0) < since - CLOCK_SLACK_MS) return null;
  const kept = /^Last reminder didn't reach this device \(push service answered (400|403)\)$/.exec(
    device.lastError ?? '',
  );
  if (kept) return { ok: true, how: `Apple answered ${kept[1]}: the device carries the error` };
  return { ok: false, why: `unexpected outcome: ${JSON.stringify({ device, poller: s.poller })}` };
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// N's state as push/deliver.ts writes it: its error and when. A send that never resolves reads as a network
// failure (or, if the resolver stalls past the 10 s cap, a timeout) — both retried.
// Exported for timed-reminders.test.ts, which pins them to push/deliver.ts's copy.
export const RETRYING =
  /^Last reminder didn't reach this device \((network error|timed out)\) — retrying$/;
export const RAN_OUT =
  /^Last reminder didn't reach this device \((network error|timed out)\) after 4 tries$/;
export const CAUGHT_UP =
  /^Couldn't deliver the catch-up for 1 missed reminder \((network error|timed out)\)$/;
async function nState(ctx: Ctx): Promise<{ error: string; at: number }> {
  const s = await status(ctx);
  if (stageFault(s)) throw new Error(`the stage can't send: ${s.poller.lastError}`);
  const d = s.devices.find((x) => x.id === deviceN.id);
  if (!d) throw new Error(`N is gone: ${JSON.stringify(s.poller)}`);
  return { error: d.lastError ?? '', at: d.lastErrorAt ?? 0 };
}

// Steps share what earlier ones made; a failed step skips the rest, so these are set when read.
let fireAt = 0; // the reminder's fire time: a minute boundary past the tick that takes the test
let ping: DevTask; // the end-to-end reminder
let linked: DevTask; // the tap-through's task
let deviceA: DevPushDevice; // the end-to-end device (real keys, Apple)
let deviceB: DevPushDevice; // removed in Settings
let deviceC: DevPushDevice; // the one device left for Send test
let testAt = 0; // just before Send test was clicked
let deviceR: DevPushDevice; // "this browser's" device, removed by the API as if from another device
let deviceN: DevPushDevice; // the retry chain's device: real keys on a host that never resolves
let ranOutAt = 0; // when N's retries ran out (read off its error)
let e2eStatus: DevPushStatus | null = null; // the status that showed A's outcome: that tick's health line

// The server (or the page) catches up: the poller's tick, a save the page already showed.
async function until<T>(
  what: string,
  read: () => Promise<T>,
  ok: (v: T) => boolean,
  timeoutMs = 15_000,
  everyMs = 500,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`${what}: still ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
// Every read logs a tick start it hasn't seen, so the run's log shows where in the minute the schedule fires
// (cron at :00 — reminders.md → §3).
const ticksSeen = new Set<number>();
async function status(ctx: Ctx) {
  const s = await ctx.api.reads.getPushStatus();
  const at = s.poller.lastRunAt;
  if (at !== null && !ticksSeen.has(at)) {
    ticksSeen.add(at);
    ctx.log(
      `poller tick started ${new Date(at).toISOString()} (:${String(new Date(at).getUTCSeconds()).padStart(2, '0')} past the minute)`,
    );
  }
  return s;
}
// Every alert's text on the page (most are empty until something goes wrong).
async function alertTexts(ctx: Ctx): Promise<string[]> {
  const alerts = ctx.page.getByRole('alert');
  const out: string[] = [];
  for (let i = 0, n = await alerts.count(); i < n; i++) {
    const t = ((await alerts.nth(i).textContent()) ?? '').trim();
    if (t) out.push(t);
  }
  return out;
}
const health = (ctx: Ctx) => ctx.page.getByRole('group', { name: 'Reminder health', exact: true });
const toggle = (ctx: Ctx, name: string) => ctx.page.getByRole('checkbox', { name, exact: true });
const TOGGLES = ['Timed deadlines', 'Day-only deadlines at 9am', 'Planned tasks at 9am'];
// Where the off-dev rows' tests live.
const DISPATCH_TEST = 'lambdas/src/push/dispatch.test.ts';
const NUDGES = ['Plan your day at 8:30am', 'Close the day at 9:30pm'];
const dialogOf = (ctx: Ctx, t: string) => ctx.page.getByRole('dialog', { name: `Task: ${t}` });
// The tap-through's params leave the URL once handled (replaced, so Back doesn't reopen the task).
const linkStripped = (ctx: Ctx) =>
  ctx.page.waitForURL(
    (u) => u.pathname === '/tasks' && !u.searchParams.has('task') && !u.searchParams.has('n'),
    { timeout: 15_000 },
  );

export const timedReminders: Scenario = {
  id: 'timed-reminders',
  title: 'Timed reminders: Web Push from the minute poller',
  tiers: ['full'],
  // The poller chain (fuse-test → api-e2e-sent) waits on real ticks, ~3.5 min: slow, so it runs only where a
  // branch changes the reminder code itself — the BFF's push service and the poller (push/**), the registry,
  // the fire-time rules, the push UI and the schedule. The shared files every branch touches (backend.ts's
  // one-line delegates, repo, handler, rpc, dates) stay out, as timer-credit's do: the contract suite and
  // push/dispatch.test.ts cover them off dev (DEV-CHECK.md → Slow tier).
  slowPaths: [
    'lambdas/src/push/**',
    'lambdas/src/pushDispatch.ts',
    'lambdas/src/ddb/pushRegistry.ts',
    'packages/shared/src/reminders.ts',
    'app/src/pages/Settings/NotificationsSection.tsx',
    'app/src/data/hooks/usePush.ts',
    'app/src/modules/push/**',
    'cdk/src/lib/push-dispatch.ts',
    'scripts/src/devcheck/scenarios/timed-reminders.ts',
  ],
  rows: [
    {
      id: 'api-e2e',
      entry: 'api',
      kind: 'nominal',
      what: 'A device with real keys and a task due in a couple of minutes → the first tick past it encrypts, signs and POSTs it, and the push service’s answer lands on the health line (Apple refuses a never-issued endpoint: 404/410 drops the device, 400/403 marks it)',
    },
    {
      id: 'api-ssrf',
      entry: 'api',
      kind: 'edge',
      what: 'An endpoint off the push-service allowlist (https://evil.example/x) is refused with the endpoint error, and nothing is written',
    },
    {
      id: 'api-same-endpoint',
      entry: 'api',
      kind: 'edge',
      what: 'Subscribing the same endpoint twice is one device (an upsert: same id, the new label)',
    },
    {
      id: 'ui-toggles',
      entry: 'ui',
      kind: 'nominal',
      what: 'Settings › Notifications shows the three toggles on; Timed deadlines off saves, survives a reload, and back on saves',
    },
    {
      id: 'ui-nudge-toggles',
      entry: 'ui',
      kind: 'nominal',
      what: 'The two ritual nudges (Plan your day at 8:30am, Close the day at 9:30pm) read on; Close the day off saves and survives a reload while Plan your day stays on; back on saves',
    },
    {
      id: 'nudge-toggle-invalid',
      entry: 'api',
      kind: 'edge',
      what: 'A nudge toggle that isn’t a real boolean is refused, and the saved value stands',
      offDev: {
        file: 'lambdas/src/backend.push.test.ts',
        test: 'the nudge toggles: on by default, a boolean only, and one switched back on is armed from then',
        why: 'the harness has no raw settings call — its one settings writer takes real booleans for the reminder keys only, so a restore can’t write anything else; the contract suite runs the same refusal against the stub too',
      },
    },
    {
      id: 'nudge-fires',
      entry: 'api',
      kind: 'nominal',
      what: '08:30 “Plan your day · N planned today” and 21:30 “Close the day · N left open · M done”, once each, opening Home; zero still nudges by count; never “missed”',
      offDev: {
        file: DISPATCH_TEST,
        test: '08:30 says how many are planned; 21:30 how many are open and done — each once, opening Home',
        why: 'an 08:30 or 21:30 fire needs the run at that minute LA, and a time switch in shipped code is ruled out (as nine-am)',
      },
    },
    {
      id: 'nudge-armed',
      entry: 'api',
      kind: 'edge',
      what: 'Each nudge’s toggle silences only it; one switched on after its time stays quiet that day',
      offDev: {
        file: DISPATCH_TEST,
        test: 'each toggle silences its own nudge; one switched on after its time stays quiet that day',
        why: 'needs a fire at 08:30 or 21:30 (nudge-fires)',
      },
    },
    {
      id: 'nudge-own-notification',
      entry: 'api',
      kind: 'edge',
      what: 'A nudge in the same minute as a reminder goes as its own notification',
      offDev: {
        file: DISPATCH_TEST,
        test: 'a nudge in the same minute as a reminder is its own notification',
        why: 'needs a fire at 08:30 or 21:30 (nudge-fires)',
      },
    },
    {
      id: 'nudge-dst',
      entry: 'api',
      kind: 'edge',
      what: 'A nudge keeps its wall-clock time on a DST change day',
      offDev: {
        file: DISPATCH_TEST,
        test: 'keeps its wall-clock time across a DST change',
        why: 'needs a DST change day at 08:30',
      },
    },
    {
      id: 'ui-health',
      entry: 'ui',
      kind: 'nominal',
      what: 'The health line says the poller checked within the last 5 minutes — the deployed schedule fires',
    },
    {
      id: 'ui-deep-link',
      entry: 'ui',
      kind: 'nominal',
      what: 'A reminder’s tap-through (/tasks?lens=today&task=<id>&n=<tag>) opens that task’s modal, and the link leaves the URL',
    },
    {
      id: 'ui-link-clears-search',
      entry: 'ui',
      kind: 'edge',
      what: 'A search typed on Tasks earlier is cleared by the tap-through: the search box is empty when the modal opens and after it closes',
    },
    {
      id: 'ui-deep-link-gone',
      entry: 'ui',
      kind: 'edge',
      what: 'A tap-through to a task deleted since says the task is gone, and the link leaves the URL',
    },
    {
      id: 'ui-remove',
      entry: 'ui',
      kind: 'nominal',
      what: 'Remove <device> in Settings: its row goes, and the server lists it as removed (the removal sticks)',
    },
    {
      id: 'ui-send-test',
      entry: 'ui',
      kind: 'nominal',
      what: 'Send test says “Sending within a minute…”, and the next tick sends it to the one device there',
    },
    {
      id: 'ui-enable',
      entry: 'ui',
      kind: 'edge',
      what: 'Enable on this device in a browser that may not take push: a device row or a refusal on screen — never a silent no-op',
    },
    {
      id: 'toggle-off-silent',
      entry: 'api',
      kind: 'edge',
      what: 'A kind switched off never pings',
      offDev: {
        file: 'lambdas/src/push/dispatch.test.ts',
        test: 'a toggle that is off silences its kind only',
        why: 'dev could show it only by waiting out a tick for a silence; kept off dev to hold the run’s time (the maintainer, review round 2) — the toggle check runs whole in the test',
      },
    },
    {
      id: 'no-double-send',
      entry: 'api',
      kind: 'edge',
      what: 'A reminder never pings twice, tick after tick',
      offDev: {
        file: 'lambdas/src/push/dispatch.test.ts',
        test: 'never pings twice: the dedup row is written before the send',
        why: 'showing a second tick sends nothing would take another tick’s wait and a second POST to Apple (one a run is approved); kept off dev (the maintainer, review round 2)',
      },
    },
    {
      id: 'daily-guard',
      entry: 'api',
      kind: 'edge',
      what: 'Past 50 notifications in a day the poller holds back and says so',
      offDev: {
        file: 'lambdas/src/push/dispatch.test.ts',
        test: 'the hidden guard refuses past 50 a day and says so',
        why: 'reaching the 51st needs 50 real sends to the test user in one day',
      },
    },
    {
      id: 'finished-silent',
      entry: 'api',
      kind: 'edge',
      what: 'A done, cancelled or deleted task never pings, even while the index still lists it',
      offDev: {
        file: 'lambdas/src/push/dispatch.test.ts',
        test: 'never a done, cancelled or deleted task — the stale index row is re-read',
        why: 'dev could show it only by finishing a task and waiting out a tick for a silence; kept off dev to hold the run’s time (the maintainer, review round 2)',
      },
    },
    {
      id: 'batching',
      entry: 'api',
      kind: 'nominal',
      what: 'Several reminders in one tick — a test among them — go as one notification to each device',
      offDev: {
        file: 'lambdas/src/push/dispatch.test.ts',
        test: 'one notification per device: a batch goes to each of them once',
        why: 'riding a reminder and a test on one dev tick needs a timed wait for the tick; a unit test only (the maintainer, review round 3)',
      },
    },
    {
      id: 'ui-home-banner',
      entry: 'ui',
      kind: 'edge',
      what: 'When reminders couldn’t refresh on this device, Home says so with a link to Settings; Dismiss hides it, and it stays hidden after a reload',
    },
    {
      id: 'armed-late',
      entry: 'api',
      kind: 'edge',
      what: 'A task created or re-dated after its fire time — or planned after 9am for today — never pings; the window catches up only what was set in time',
      offDev: {
        file: 'lambdas/src/push/dispatch.test.ts',
        test: 'a task created after its fire time never pings, even inside the window',
        why: 'dev could show it only by waiting out a tick for a silence; kept off dev like toggle-off (review round 2) — the arm rule runs whole in the dispatch tests, which cover each way in',
      },
    },
    {
      id: 'stale-row',
      entry: 'api',
      kind: 'edge',
      what: 'A task re-dated since the index row was written pings at its new time, not the old',
      offDev: {
        file: 'lambdas/src/push/dispatch.test.ts',
        test: 'a row whose fire time has moved since is stale and skipped',
        why: 'needs the index to lag a write, which dev’s GSI does only by chance',
      },
    },
    {
      id: 'nine-am',
      entry: 'api',
      kind: 'nominal',
      what: 'A day-only deadline and a task planned for the day ping at 9am LA, batched into one notification',
      offDev: {
        file: 'lambdas/src/push/dispatch.test.ts',
        test: 'a day-only deadline and a planned day ping at 09:00 in the user zone',
        why: 'a 9am fire needs the run at 9am LA, and a time switch in shipped code is ruled out',
      },
    },
    {
      id: 'ownership',
      entry: 'api',
      kind: 'edge',
      what: 'Removing a device touches only the caller’s own partition',
      offDev: {
        file: 'lambdas/src/backend.push.test.ts',
        test: "unsubscribe touches only the caller's own partition",
        why: 'dev has one test user, so there is no second partition to try',
      },
    },
    {
      id: 'ios-enable',
      entry: 'ios',
      kind: 'nominal',
      what: 'Install the dev app to the Home Screen, Settings › Notifications › Enable: the system prompt, then the device row',
      needsYou:
        'iOS’s permission prompt and APNs subscription exist only in the installed PWA on an iPhone',
    },
    {
      id: 'ios-test-banner',
      entry: 'ios',
      kind: 'nominal',
      what: 'Send test → a banner within a minute; tapping it opens the PWA (not Safari) on Today',
      needsYou: 'a real APNs delivery and iOS’s tap-through',
    },
    {
      id: 'ios-timed-banner',
      entry: 'ios',
      kind: 'nominal',
      what: 'A task due in 2 minutes → its banner at that minute; tapping opens its modal',
      needsYou: 'a real APNs delivery and iOS’s tap-through',
    },
    {
      id: 'ios-nine-am',
      entry: 'ios',
      kind: 'nominal',
      what: 'The 9am batch: a day-only deadline and a planned task as one banner',
      needsYou: 'waiting for 9am with a phone',
    },
    {
      id: 'ios-toggle-off',
      entry: 'ios',
      kind: 'edge',
      what: 'Timed deadlines off → a timed task due in 2 minutes brings nothing',
      needsYou: 'only the phone shows a banner didn’t come',
    },
    {
      id: 'ios-lock-screen',
      entry: 'ios',
      kind: 'nominal',
      what: 'The PWA killed, the phone locked → the banner on the lock screen',
      needsYou: 'iOS’s lock screen',
    },
    {
      id: 'ios-focus-low-power',
      entry: 'ios',
      kind: 'edge',
      what: 'Focus on: delivered but muted; Low Power Mode: note any delay',
      needsYou: 'iOS Focus and Low Power Mode',
    },
    {
      id: 'ios-days-closed',
      entry: 'ios',
      kind: 'edge',
      what: 'The app unopened for 2–3 days → a day-only deadline’s 9am banner still comes',
      needsYou: 'days of a real subscription on a phone',
    },
    {
      id: 'ios-resubscribe',
      entry: 'ios',
      kind: 'edge',
      what: 'After a 410 (the subscription expired), reopening the PWA brings the device row back without a prompt',
      needsYou: 'an APNs subscription iOS dropped',
    },
    {
      id: 'ios-gcal-popup',
      entry: 'ios',
      kind: 'nominal',
      what: 'A timed task with an estimate → its Google Calendar event alerts at its start on the phone',
      needsYou: 'a Google account and the phone’s calendar app (the test user has neither)',
    },
    {
      id: 'ios-redate',
      entry: 'ios',
      kind: 'edge',
      what: 'Moving a task that already pinged 3 minutes later → a second banner at the new time, not before',
      needsYou: 'a real APNs delivery, twice',
    },
    {
      id: 'ui-removed-elsewhere',
      entry: 'ui',
      kind: 'edge',
      what: 'This browser’s device removed from another one → Settings drops its opt-in instead of re-adding it, and says “Removed from another device”',
    },
    {
      id: 'ui-removed-dismiss',
      entry: 'ui',
      kind: 'edge',
      what: 'Dismiss on that note: it goes, and stays gone across a reload',
    },
    {
      id: 'retry-network',
      entry: 'api',
      kind: 'edge',
      what: 'A send that fails in transit (a network failure) is retried on the next ticks — the device reads “— retrying” — and after 4 tries says so',
    },
    {
      id: 'retry-neighbour',
      entry: 'api',
      kind: 'edge',
      what: 'In the same tick, a neighbour device Apple refuses (404/410) is dropped as before; only the failed device is retried',
    },
    {
      id: 'catch-up',
      entry: 'api',
      kind: 'nominal',
      what: 'Retries that ran out leave the reminder for one catch-up, “1 reminder didn’t reach you”, 5 minutes on — tried once, its outcome on the device',
    },
    {
      id: 'retry-statuses',
      entry: 'api',
      kind: 'edge',
      what: '429, 500, 502, 503 and a timeout are retried under the same Topic, and the retry lands; 400, 403 and 413 stay final',
      offDev: {
        file: DISPATCH_TEST,
        test: 'a timeout, a network failure, 429 or a 5xx is retried on the next tick, under the same Topic',
        why: 'no push service answers a status on demand, and an accepting endpoint is a real device (ios-nudge-banner); final statuses: “400, 403 and 413 are final: stamped, never retried”',
      },
    },
    {
      id: 'retry-quiet',
      entry: 'api',
      kind: 'edge',
      what: 'A task finished or re-dated before its retry stays quiet',
      offDev: {
        file: DISPATCH_TEST,
        test: 'a task finished or re-dated before its retry stays quiet',
        why: 'finishing the task mid-chain would leave nothing to retry, losing retry-network and catch-up for the run',
      },
    },
    {
      id: 'retry-deadline',
      entry: 'api',
      kind: 'edge',
      what: 'A device the tick’s deadline skipped goes on the next tick, no try spent',
      offDev: {
        file: DISPATCH_TEST,
        test: 'a device the deadline skipped goes on the next tick, with no try spent',
        why: 'a tick running out of time on dev can’t be arranged',
      },
    },
    {
      id: 'gap-catch-up',
      entry: 'api',
      kind: 'edge',
      what: 'After a poller outage, what fell due in it (12 h back, open tasks only) goes once as a catch-up',
      offDev: {
        file: DISPATCH_TEST,
        test: 'after a poller gap, what fell due in it goes once as a catch-up (12 h back, open tasks only)',
        why: 'dev’s schedule can’t be stopped from the harness',
      },
    },
    {
      id: 'ios-nudge-banner',
      entry: 'ios',
      kind: 'nominal',
      what: 'At 8:30am (or 9:30pm) a “Plan your day” (“Close the day”) banner with today’s count; tapping it opens the PWA on Home',
      needsYou: 'a real APNs delivery at that minute and iOS’s tap-through',
    },
  ],
  steps: [
    {
      id: 'ui-toggles',
      entry: 'ui',
      proves: ['ui-toggles'],
      title:
        'The three toggles read on; Timed deadlines off saves and survives a reload; back on saves',
      async run(ctx) {
        await ctx.ui.goto('/settings');
        for (const name of TOGGLES) {
          await toggle(ctx, name).waitFor({ state: 'visible', timeout: 15_000 });
          if (!(await toggle(ctx, name).isChecked())) throw new Error(`${name} reads off`);
        }
        ctx.api.writes.recordReminderToggles(); // before the flip: cleanup turns it back on regardless
        await toggle(ctx, 'Timed deadlines').click();
        await until(
          'Timed deadlines off',
          () => ctx.api.reads.getSettings(),
          (s) => s.remindTimed === false && s.remindDueDay && s.remindPlanned,
        );
        await ctx.page.reload({ waitUntil: 'domcontentloaded' });
        await toggle(ctx, 'Timed deadlines').waitFor({ state: 'visible', timeout: 15_000 });
        await until(
          'the reload',
          () => toggle(ctx, 'Timed deadlines').isChecked(),
          (c) => !c,
          10_000,
        );
        await ctx.shot('timed-off');
        await toggle(ctx, 'Timed deadlines').click();
        await until(
          'Timed deadlines back on',
          () => ctx.api.reads.getSettings(),
          (s) => s.remindTimed === true,
        );
      },
    },
    {
      id: 'ui-nudge-toggles',
      entry: 'ui',
      proves: ['ui-nudge-toggles'],
      title:
        'The two nudge toggles read on; Close the day off saves and survives a reload, Plan your day untouched; back on saves',
      async run(ctx) {
        await ctx.ui.goto('/settings');
        for (const name of NUDGES) {
          await toggle(ctx, name).waitFor({ state: 'visible', timeout: 15_000 });
          if (!(await toggle(ctx, name).isChecked())) throw new Error(`${name} reads off`);
        }
        ctx.api.writes.recordReminderToggles(); // before the flip: cleanup turns it back on regardless
        await toggle(ctx, NUDGES[1]!).click();
        await until(
          'Close the day off',
          () => ctx.api.reads.getSettings(),
          (s) => s.nudgeNight === false && s.nudgeMorning && s.remindTimed,
        );
        await ctx.page.reload({ waitUntil: 'domcontentloaded' });
        await toggle(ctx, NUDGES[1]!).waitFor({ state: 'visible', timeout: 15_000 });
        await until(
          'the reload',
          () => toggle(ctx, NUDGES[1]!).isChecked(),
          (c) => !c,
          10_000,
        );
        if (!(await toggle(ctx, NUDGES[0]!).isChecked()))
          throw new Error('Plan your day went off with Close the day');
        await ctx.shot('nudge-night-off');
        await toggle(ctx, NUDGES[1]!).click();
        await until(
          'Close the day back on',
          () => ctx.api.reads.getSettings(),
          (s) => s.nudgeNight === true,
        );
      },
    },
    {
      id: 'ui-enable',
      entry: 'ui',
      proves: ['ui-enable'],
      title: 'Enable on this device: a device row, or a refusal on screen — never nothing',
      async run(ctx) {
        await ctx.ui.goto('/settings');
        const on = ctx.page.getByText('On for this device.', { exact: true });
        const enable = ctx.page.getByRole('button', { name: 'Enable on this device', exact: true });
        // A browser Settings already judges unable shows its line instead of the button.
        const cannot = ctx.page
          .getByText('Reminders aren’t available in this browser.', { exact: true })
          .or(ctx.page.getByText(/^Notifications are (blocked|off) for Aperture/));
        await enable.or(cannot).or(on).first().waitFor({ state: 'visible', timeout: 15_000 });
        if (await enable.isVisible()) {
          const before = await alertTexts(ctx);
          await enable.click();
          // Done once Enabling… settles: either the row, or a refusal in the alert under the button.
          const v = await until(
            'Enable (still busy, or nothing on screen)',
            async () => ({
              on: await on.isVisible(),
              said: (await alertTexts(ctx)).filter((t) => !before.includes(t)),
              busy: await ctx.page.getByRole('button', { name: 'Enabling…' }).isVisible(),
            }),
            (x) => !x.busy && (x.on || x.said.length > 0),
            20_000,
          );
          if (!v.on) ctx.log(`Enable refused on screen: ${v.said.join(' | ')}`);
        } else if (!(await on.isVisible()))
          ctx.log(
            `Settings can't offer Enable here: ${(await cannot.first().textContent()) ?? ''}`,
          );
        await ctx.shot('enable');
        if (!(await on.isVisible())) return;
        // It subscribed: the device is the run's (recorder.ts, from the response) — remove it now, before
        // anything can ping it.
        const s = await status(ctx);
        const fresh = await until(
          'the ledger recording Enable’s device',
          async () => s.devices.filter((d) => ctx.createdIds().includes(d.id)),
          (ds) => ds.length > 0,
          5_000,
        );
        for (const d of fresh) await ctx.api.writes.unsubscribePush(d.id);
        ctx.log(`Enable subscribed in headless Chromium (${fresh.map((d) => d.label).join(', ')})`);
      },
    },
    {
      id: 'api-endpoints',
      entry: 'api',
      proves: ['api-ssrf', 'api-same-endpoint'],
      title: 'evil.example is refused and writes nothing; the same endpoint twice is one device',
      async run(ctx) {
        const before = await status(ctx);
        if (!before.configured) throw new Error('reminders aren’t set up on dev (no VAPID key)');
        const refused = await ctx.api.writes.subscribePushExpectingRefusal({
          endpoint: 'https://evil.example/x',
          keys: pushKeys(),
          label: label(ctx, 'evil'),
        });
        if (refused !== PUSH_ENDPOINT_ERROR) throw new Error(`refused with “${refused}”`);
        if (JSON.stringify((await status(ctx)).devices) !== JSON.stringify(before.devices))
          throw new Error('the refused subscribe changed the device list');
        // Its own slot, with keys no push service takes: nothing can ever be sent to it.
        const first = await ctx.api.writes.subscribeHarnessPush(
          'dup',
          UNUSABLE_KEYS,
          `${label(ctx, 'D')} first`,
        );
        const again = await ctx.api.writes.subscribeHarnessPush(
          'dup',
          UNUSABLE_KEYS,
          label(ctx, 'D'),
        );
        if (again.id !== first.id)
          throw new Error(`two devices for one endpoint: ${first.id}, ${again.id}`);
        const mine = (await status(ctx)).devices.filter((d) => d.id === first.id);
        if (mine.length !== 1 || mine[0]!.label !== label(ctx, 'D'))
          throw new Error(`the server lists ${JSON.stringify(mine)}`);
        await ctx.api.writes.unsubscribePush(first.id);
      },
    },
    {
      id: 'stage-remove',
      entry: 'api',
      title: 'A device no push service could use, to remove in Settings',
      async run(ctx) {
        deviceB = await ctx.api.writes.subscribeHarnessPush('b', UNUSABLE_KEYS, label(ctx, 'B'));
      },
    },
    {
      id: 'ui-remove',
      entry: 'ui',
      proves: ['ui-remove'],
      title: 'Settings › Remove <device B>: its row goes',
      async run(ctx) {
        await ctx.ui.goto('/settings');
        const remove = ctx.page.getByRole('button', {
          name: `Remove ${label(ctx, 'B')}`,
          exact: true,
        });
        await remove.click({ timeout: 15_000 });
        await remove.waitFor({ state: 'hidden', timeout: 15_000 });
        await ctx.shot('removed');
      },
    },
    {
      id: 'server-removed',
      entry: 'api',
      proves: ['ui-remove'],
      title: 'The server lists B as removed, and no longer among the devices',
      async run(ctx) {
        const s = await until(
          'the removal',
          () => status(ctx),
          (v) => v.removedDeviceIds.includes(deviceB.id),
        );
        if (s.devices.some((d) => d.id === deviceB.id))
          throw new Error('B is still among the devices');
      },
    },
    {
      id: 'ui-removed-elsewhere',
      entry: 'ui',
      proves: ['ui-removed-elsewhere', 'ui-removed-dismiss'],
      title:
        'This browser opted in as a device the API then removes: Settings drops the opt-in and says so; Dismiss holds across a reload',
      async run(ctx) {
        // Headless Chromium can't subscribe (its permission reads denied), so this browser's opt-in is
        // seeded: a device subscribed and removed through the API — the BFF's own id for it — written where
        // Enable keeps it (browserPush.ts, aperture.push.enabled / .enabledAt), stamped before the read.
        deviceR = await ctx.api.writes.subscribeHarnessPush('r', UNUSABLE_KEYS, label(ctx, 'R'));
        await ctx.api.writes.unsubscribePush(deviceR.id);
        await until(
          'R listed as removed',
          () => status(ctx),
          (v) => v.removedDeviceIds.includes(deviceR.id),
        );
        await ctx.ui.goto('/settings');
        await ctx.page.evaluate(
          `localStorage.setItem('aperture.push.enabled', ${JSON.stringify(deviceR.id)});
           localStorage.setItem('aperture.push.enabledAt', String(Date.now() - 60000));`,
        );
        await ctx.page.reload({ waitUntil: 'domcontentloaded' });
        const note = ctx.page.getByRole('status').getByText(/^Removed from another device —/); // worded for what this browser can do next
        await note.waitFor({ state: 'visible', timeout: 15_000 });
        const optIn = await ctx.page.evaluate<string | null>(
          `localStorage.getItem('aperture.push.enabled')`,
        );
        if (optIn !== null) throw new Error(`the opt-in survived the removal: ${optIn}`);
        if ((await status(ctx)).devices.some((d) => d.id === deviceR.id))
          throw new Error('R came back alive');
        await ctx.shot('removed-elsewhere');
        await ctx.page.getByRole('button', { name: 'Dismiss', exact: true }).click();
        await note.waitFor({ state: 'hidden', timeout: 5_000 });
        await ctx.page.reload({ waitUntil: 'domcontentloaded' });
        await health(ctx).waitFor({ state: 'visible', timeout: 15_000 });
        if (await note.isVisible()) throw new Error('the dismissed note came back after a reload');
      },
    },
    {
      id: 'ui-home-banner',
      entry: 'ui',
      proves: ['ui-home-banner'],
      title:
        'A failed launch resync: Home says so and links to Settings; Dismiss holds across a reload',
      async run(ctx) {
        // Seeded as browserPush.ts keeps them: an opt-in (a harness slot never subscribed, so no status read
        // can call it removed) and a resync failure. The resync that would overwrite or clear them runs only
        // with permission granted — headless reads denied.
        await ctx.ui.goto('/');
        const permission = await ctx.page.evaluate<string>(
          `typeof Notification === 'undefined' ? 'unsupported' : Notification.permission`,
        );
        if (permission === 'granted')
          needsYou(
            'this browser grants notifications, so its launch resync would replace the seeded failure',
          );
        const keys = ['enabled', 'enabledAt', 'syncError', 'syncErrorAt', 'syncErrorDismissed'].map(
          (k) => `aperture.push.${k}`,
        );
        const seed = {
          'aperture.push.enabled': harnessPushId('banner'),
          'aperture.push.enabledAt': String(Date.now() - 3_600_000),
          'aperture.push.syncError': 'Registration failed - devcheck',
          'aperture.push.syncErrorAt': `${Date.now()}-devchk`,
        };
        await ctx.page.evaluate(
          `Object.entries(${JSON.stringify(seed)}).forEach(([k, v]) => localStorage.setItem(k, v))`,
        );
        try {
          await ctx.page.reload({ waitUntil: 'domcontentloaded' });
          const banner = ctx.page
            .getByRole('alert')
            .filter({ hasText: 'Reminders couldn’t refresh on this device' });
          await banner.waitFor({ state: 'visible', timeout: 15_000 });
          await ctx.shot('home-banner');
          await banner.getByRole('link', { name: 'open Settings', exact: true }).click();
          await ctx.page.waitForURL(
            (u) => u.pathname === '/settings' && u.hash === '#notifications',
            {
              timeout: 15_000,
            },
          );
          await ctx.ui.goto('/');
          await banner.waitFor({ state: 'visible', timeout: 15_000 });
          await banner.getByRole('button', { name: 'Dismiss', exact: true }).click();
          await banner.waitFor({ state: 'hidden', timeout: 5_000 });
          await ctx.page.reload({ waitUntil: 'domcontentloaded' });
          await ctx.ui.settle();
          await ctx.page
            .getByRole('button', { name: 'Task', exact: true })
            .waitFor({ timeout: 15_000 });
          if (await banner.isVisible())
            throw new Error('the dismissed banner came back after a reload');
        } finally {
          await ctx.page.evaluate(
            `${JSON.stringify(keys)}.forEach((k) => localStorage.removeItem(k))`,
          );
        }
      },
    },
    {
      id: 'ui-deep-link',
      entry: 'ui',
      proves: ['ui-deep-link'],
      title: 'A reminder’s tap-through opens its task’s modal, and the link leaves the URL',
      async run(ctx) {
        linked = await ctx.api.writes.createTask({ title: title(ctx, 'linked') });
        await ctx.ui.goto(linkTo(linked.id));
        await dialogOf(ctx, linked.title).waitFor({ state: 'visible', timeout: 15_000 });
        await linkStripped(ctx);
        await ctx.shot('deep-link');
      },
    },
    {
      id: 'ui-link-clears-search',
      entry: 'ui',
      proves: ['ui-link-clears-search'],
      title:
        'A search typed on Tasks is gone after a reminder’s tap-through; closing the modal shows Today',
      async run(ctx) {
        await ctx.ui.goto('/tasks');
        const search = ctx.page.getByRole('searchbox', { name: 'Search tasks', exact: true });
        await search.fill(title(ctx, 'no such task'));
        // Sticky for the session (sessionStorage), so it survives the navigation the tap is.
        await ctx.ui.goto(linkTo(linked.id));
        await dialogOf(ctx, linked.title).waitFor({ state: 'visible', timeout: 15_000 });
        await linkStripped(ctx);
        await until(
          'the search cleared',
          () => search.inputValue(),
          (v) => v === '',
          10_000,
        );
        await ctx.page.keyboard.press('Escape');
        await dialogOf(ctx, linked.title).waitFor({ state: 'hidden', timeout: 10_000 });
        await ctx.shot('link-cleared-search');
      },
    },
    {
      id: 'ui-deep-link-gone',
      entry: 'ui',
      proves: ['ui-deep-link-gone'],
      title: 'The tap-through to a task deleted since says it’s gone, and the link leaves the URL',
      async run(ctx) {
        const gone = await ctx.api.writes.createTask({ title: title(ctx, 'gone') });
        await ctx.api.writes.deleteTask(gone.id);
        await ctx.ui.goto(linkTo(gone.id));
        await ctx.ui.expectText(
          'That reminder’s task is gone — it was deleted after the reminder went out.',
          15_000,
        );
        await linkStripped(ctx);
        await ctx.shot('deep-link-gone');
      },
    },
    {
      id: 'ui-health',
      entry: 'ui',
      proves: ['ui-health'],
      title:
        'Settings › Notifications: the health line says the poller checked in the last 5 minutes',
      async run(ctx) {
        await ctx.ui.goto('/settings');
        const line = health(ctx).getByText(/^Reminders on · checked (just now|[0-4] min ago)/);
        await line.waitFor({ state: 'visible', timeout: 15_000 });
        await ctx.shot('health');
      },
    },
    {
      id: 'fuse-test',
      cost: 'slow',
      entry: 'ui',
      proves: ['ui-send-test'],
      title:
        'No real device on the test user; C (keys no service takes) subscribed; Send test → “Sending within a minute…”',
      async run(ctx) {
        // A live device other than the harness's would get this chain's sends: refuse it, by name. The
        // harness's own (a fixed-slot id) are removed through the guarded path.
        for (const d of (await status(ctx)).devices) {
          if (!isHarnessPushId(d.id))
            throw new Error(`a real device is subscribed as the test user: ${d.label}`);
          ctx.log(`removing the harness's own live device ${d.label}`);
          await ctx.api.writes.removeHarnessStray(d.id, d.label);
        }
        // The nudges off for the chain: one falling inside it (08:30, 21:30 LA) would be another notification
        // on its devices, and the retry chain reads N's error alone. Cleanup turns them back on regardless.
        ctx.api.writes.recordReminderToggles();
        await ctx.api.writes.setReminderSettings({ nudgeMorning: false, nudgeNight: false });
        deviceC = await ctx.api.writes.subscribeHarnessPush('c', UNUSABLE_KEYS, label(ctx, 'C'));
        await ctx.ui.goto('/settings');
        const send = ctx.page.getByRole('button', { name: 'Send test', exact: true });
        await send.waitFor({ state: 'visible', timeout: 15_000 });
        testAt = Date.now();
        await send.click({ timeout: 15_000 });
        await ctx.page
          .getByRole('status')
          .getByText('Sending within a minute…', { exact: true })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await ctx.shot('send-test');
      },
    },
    {
      id: 'fuse-ping',
      cost: 'slow',
      entry: 'api',
      proves: ['api-e2e'],
      title: 'A task due at the first minute boundary well past the tick that takes the test',
      async run(ctx) {
        // That tick is the next one: about a rate past the last heartbeat (or now, if none is fresh).
        const last = (await status(ctx)).poller.lastRunAt ?? 0;
        const nextTick = last + TICK_MS > Date.now() ? last + TICK_MS : Date.now() + TICK_MS;
        fireAt = Math.ceil((nextTick + PING_LEAD_MS) / TICK_MS) * TICK_MS;
        const due = new Date(fireAt);
        ping = await ctx.api.writes.createTask({
          title: title(ctx, 'ping'),
          dueDay: laDay(due),
          dueTime: laClock(due),
        });
        ctx.log(`reminder due ${laDay(due)} ${laClock(due)} (${due.toISOString()})`);
      },
    },
    {
      id: 'server-test-sent',
      cost: 'slow',
      entry: 'api',
      proves: ['ui-send-test'],
      title:
        'The tick after the click took the test: C, whose keys no service takes, is dropped and named — before the reminder could fire',
      async run(ctx) {
        // Only the test can reach C here: C is the user's one device, its first (so its registry row starts
        // now, and nothing due before can fire), and the reminder isn't due until after this tick.
        const s = await until(
          'the test’s tick',
          () => status(ctx),
          (v) => {
            // A stage that can't send fails now, by its own message — not after the wait.
            if (stageFault(v)) throw new Error(`the stage can't send: ${v.poller.lastError}`);
            return (
              (v.poller.lastErrorAt ?? 0) >= testAt - CLOCK_SLACK_MS &&
              errorsOf(v).some((e) => e.startsWith(droppedForKeys(label(ctx, 'C'))))
            );
          },
          Math.max(testAt + TICK_WAIT_MS - Date.now(), 10_000),
          3_000,
        );
        if (s.devices.some((d) => d.id === deviceC.id)) throw new Error('C is still listed');
        if ((s.poller.lastErrorAt ?? 0) >= fireAt)
          throw new Error(
            'C was dropped only after the reminder fell due — not provably by the test',
          );
      },
    },
    {
      id: 'fuse-device',
      cost: 'slow',
      entry: 'api',
      proves: ['api-e2e'],
      title:
        'A — a real P-256 key pair on a never-issued Apple endpoint — subscribed well before the minute',
      async run(ctx) {
        // Late (a slow tick): move the reminder on a minute — re-dated still ahead of it, so armed in time.
        if (fireAt - Date.now() < A_LEAD_MS) {
          fireAt = Math.ceil((Date.now() + PING_LEAD_MS) / TICK_MS) * TICK_MS;
          const due = new Date(fireAt);
          await ctx.api.writes.setTaskDue(ping.id, { dueDay: laDay(due), dueTime: laClock(due) });
          ctx.log(`reminder moved to ${due.toISOString()}`);
        }
        deviceA = await ctx.api.writes.subscribeHarnessPush('e2e', pushKeys(), label(ctx, 'A'));
        deviceN = await ctx.api.writes.subscribeHarnessPush('nx', pushKeys(), label(ctx, 'N'));
      },
    },
    {
      id: 'api-e2e-sent',
      cost: 'slow',
      entry: 'api',
      proves: ['api-e2e'],
      title:
        'The tick past the minute sent the reminder to A, Apple’s answer (404/410 dropped, or 400/403 marked) is on the health line, and A goes',
      async run(ctx) {
        let outcome: ReturnType<typeof e2eOutcome> = null;
        try {
          await until(
            'the poller’s send',
            () => status(ctx),
            (v) => {
              outcome = e2eOutcome(v, deviceA.id, label(ctx, 'A'), fireAt);
              if (outcome !== null) e2eStatus = v;
              return outcome !== null;
            },
            Math.max(fireAt + TICK_WAIT_MS - Date.now(), 10_000),
            3_000,
          );
        } finally {
          // A goes the moment its outcome is read (or the wait gives up): no later tick sends to it.
          if ((await status(ctx)).devices.some((d) => d.id === deviceA.id))
            await ctx.api.writes.unsubscribePush(deviceA.id);
        }
        const o = outcome as ReturnType<typeof e2eOutcome>;
        if (!o || !o.ok) throw new Error(o ? o.why : 'no outcome');
        ctx.log(o.how);
      },
    },
    {
      id: 'retry-first',
      cost: 'slow',
      entry: 'api',
      proves: ['retry-network', 'retry-neighbour'],
      title:
        'The same tick failed N in transit: its error reads “— retrying”, and that tick’s health line names A’s final answer beside it',
      async run(ctx) {
        const v = await until(
          'N’s first try',
          () => nState(ctx),
          (x) => x.at >= fireAt - CLOCK_SLACK_MS,
          Math.max(fireAt + TICK_WAIT_MS - Date.now(), 10_000),
          3_000,
        );
        if (!RETRYING.test(v.error))
          throw new Error(`N’s first failure isn’t a retrying network failure: ${v.error}`);
        ctx.log(`N: ${v.error}`);
        // The neighbour: the tick that showed A's final answer named N as retrying beside it, and A not.
        const line = errorsOf(e2eStatus!);
        const a = line.filter((e) => e.startsWith(label(ctx, 'A')));
        const n = line.filter((e) => e.startsWith(`${label(ctx, 'N')}: `));
        if (a.length !== 1 || a[0]!.endsWith('— retrying'))
          throw new Error(`A's entry on that tick's health line: ${JSON.stringify(line)}`);
        if (n.length !== 1 || !RETRYING.test(n[0]!.slice(`${label(ctx, 'N')}: `.length)))
          throw new Error(`N's entry on that tick's health line: ${JSON.stringify(line)}`);
      },
    },
    {
      id: 'retry-ran-out',
      cost: 'slow',
      entry: 'api',
      proves: ['retry-network'],
      title: 'N is retried on the next 3 ticks, then its error says “after 4 tries”',
      async run(ctx) {
        const v = await until(
          'N’s retries running out',
          () => nState(ctx),
          (x) => RAN_OUT.test(x.error) || !RETRYING.test(x.error),
          4 * TICK_MS + TICK_WAIT_MS,
          5_000,
        );
        if (!RAN_OUT.test(v.error)) throw new Error(`N’s retries ended otherwise: ${v.error}`);
        ranOutAt = v.at;
        ctx.log(`N: ${v.error}`);
      },
    },
    {
      id: 'catch-up-sent',
      cost: 'slow',
      entry: 'api',
      proves: ['catch-up'],
      title:
        'Five minutes on, N’s one catch-up went (and failed in transit): “Couldn’t deliver the catch-up for 1 missed reminder”',
      async run(ctx) {
        try {
          const v = await until(
            'N’s catch-up',
            () => nState(ctx),
            (x) => x.at > ranOutAt + CLOCK_SLACK_MS,
            Math.max(ranOutAt + 5 * TICK_MS + TICK_WAIT_MS - Date.now(), 10_000),
            5_000,
          );
          if (!CAUGHT_UP.test(v.error))
            throw new Error(`N’s next error isn’t its catch-up: ${v.error}`);
          if (v.at < ranOutAt + 5 * TICK_MS - CLOCK_SLACK_MS)
            throw new Error('the catch-up went before its 5 minutes settled');
          ctx.log(`N: ${v.error}`);
        } finally {
          if ((await status(ctx)).devices.some((d) => d.id === deviceN.id))
            await ctx.api.writes.unsubscribePush(deviceN.id);
          await ctx.api.writes.setReminderSettings({ nudgeMorning: true, nudgeNight: true });
        }
      },
    },
    noConsoleErrors,
  ],
};
