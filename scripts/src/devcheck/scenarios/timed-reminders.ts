// Timed reminders — Web Push from the push-dispatch poller (docs/areas/tasks/reminders.md). The deployed
// schedule is the engine: nothing here invokes the poller, so every send this scenario sees came from a real
// tick on dev. The end-to-end proof subscribes a device with a real P-256 key pair on an Apple endpoint that
// was never issued (`devcheck-e2e`) and makes a task due at the next LA minute — armed before it fires, as the
// poller requires (§3); the first tick past it encrypts, signs and POSTs it, and Apple's refusal comes back on
// the health line — the one malformed POST to Apple a run makes (plan Q7, approved). Settings' Send test is
// clicked between the last tick before that minute and the first after it, so both ride that one tick: one
// notification, one POST (asserted). Every other device carries keys no push service could use, so the
// poller drops it at encrypt time without a request (dispatch.ts — the keys outcome), and a device Enable
// manages to subscribe here is removed in the same step. The cheap UI rows run first; the two waits for the
// poller end the scenario, and nothing reads their results.
//
// Devices use fixed endpoints (`devcheck-e2e`, `-b`, `-c`, `-r`), so their ids repeat run to run: a
// re-subscribe revives last run's tombstone instead of adding one (the ledger reads an id created again as
// pending again — ledger.ts pendingIds). They're ledgered from the server's answer (api.ts, or the browser's
// subscribePush response via recorder.ts) and removed by id. The reminder toggles are recorded as
// `reminder-toggles:<run>` before any flip, so cleanup switches them back on whatever happens. "Removed from
// another device" is proven on a device subscribed and removed through the API, its id seeded as this
// browser's opt-in (headless Chromium can't subscribe itself). Titles are `devcheck-rm <nonce> …` — the
// parts scenarios sweep `devcheck <nonce>`. The rows are the plan's dev-test matrix (localNotes/plan.md §5 E),
// with the removal rule (PushStatus.removedDeviceIds) and the armed-before-it-fires rule.
import { createECDH, randomBytes } from 'node:crypto';
import type { DevPushDevice, DevPushStatus, DevSubscribePushInput, DevTask } from '../api';
import { laDay, noConsoleErrors, type Ctx, type Scenario } from '../scenario';

// packages/shared/src/reminders.ts PUSH_ENDPOINT_ERROR (scripts doesn't depend on shared).
const PUSH_ENDPOINT_ERROR = "That push endpoint isn't a known push service";
// The schedule's rate, and how long past a tick's due time the poller may take (Lambda, Apple).
const TICK_MS = 60_000;
const TICK_WAIT_MS = 150_000;
// Server and harness clocks differ by a little; a stamp this much before a moment still counts as after it.
const CLOCK_SLACK_MS = 5_000;
// Send test is clicked only this far ahead of the next tick, so the click's request lands before it.
const CLICK_MARGIN_MS = 12_000;
// The end-to-end task is due at a minute boundary at least this far ahead: created (armed) before it fires.
const ARM_LEAD_MS = 10_000;

const title = (ctx: Ctx, what: string) => `devcheck-rm ${ctx.nonce} ${what}`;
const label = (ctx: Ctx, which: string) => `Devcheck ${which} ${ctx.nonce}`;
// Fixed per slot, so a device's id (a hash of its endpoint) repeats run to run (see the header).
const endpoint = (slot: 'e2e' | 'b' | 'c' | 'r') => `https://web.push.apple.com/devcheck-${slot}`;
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
  if (err.startsWith('No VAPID key') || err.startsWith('VAPID private key is malformed'))
    return { ok: false, why: `the stage can't send: ${err}` };
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
// Both the end-to-end device's refusal and C's drop are entries of ONE health-line error: they came from one
// tick, so the reminder and the test went as one notification — one POST to Apple.
export function sameTick(s: DevPushStatus, deviceLabel: string, cLabel: string): boolean {
  const errs = errorsOf(s);
  return (
    errs.some((e) => e.startsWith(droppedForKeys(cLabel))) &&
    errs.some(
      (e) => e.startsWith(`${deviceLabel} stopped accepting`) || e.startsWith(`${deviceLabel}: `),
    )
  );
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Steps share what earlier ones made; a failed step skips the rest, so these are set when read.
let fireAt = 0; // the end-to-end task's fire time: a minute boundary after it was made
let ping: DevTask; // the end-to-end reminder
let deviceA: DevPushDevice; // the end-to-end device (real keys, Apple)
let deviceB: DevPushDevice; // removed in Settings
let deviceC: DevPushDevice; // the one device left for Send test
let testAt = 0; // just before Send test was clicked
let batched = false; // the click landed before the tick that sends the reminder
let deviceR: DevPushDevice; // "this browser's" device, removed by the API as if from another device

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
const status = (ctx: Ctx) => ctx.api.reads.getPushStatus();
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
  rows: [
    {
      id: 'api-e2e',
      entry: 'api',
      kind: 'nominal',
      what: 'A device with real keys and a task due at the next minute → the first tick past it encrypts, signs and POSTs it, and the push service’s answer lands on the health line (Apple refuses a never-issued endpoint: 404/410 drops the device, 400/403 marks it)',
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
      what: 'Send test says “Sending within a minute…”, and the next tick acts on it — batched with a reminder due in that tick when there is one (one notification per device)',
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
        why: 'dev could show it only by waiting out a tick for a silence; kept off dev to hold the run’s time (Rahul, review round 2) — the toggle check runs whole in the test',
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
        why: 'showing a second tick sends nothing would take another tick’s wait and a second POST to Apple (one a run is approved); kept off dev (Rahul, review round 2)',
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
        why: 'dev could show it only by finishing a task and waiting out a tick for a silence; kept off dev to hold the run’s time (Rahul, review round 2)',
      },
    },
    {
      id: 'armed-late',
      entry: 'api',
      kind: 'edge',
      what: 'A task created, re-dated or reopened after its fire time — or planned after 9am for today — never pings; the window catches up only what was set in time',
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
      id: 'stage-remove',
      entry: 'api',
      title: 'A device no push service could use, to remove in Settings',
      async run(ctx) {
        deviceB = await ctx.api.writes.subscribePush({
          endpoint: endpoint('b'),
          keys: UNUSABLE_KEYS,
          label: label(ctx, 'B'),
        });
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
        deviceR = await ctx.api.writes.subscribePush({
          endpoint: endpoint('r'),
          keys: UNUSABLE_KEYS,
          label: label(ctx, 'R'),
        });
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
        const note = ctx.page
          .getByRole('status')
          .getByText('Removed from another device — tap Enable to turn reminders back on here.', {
            exact: true,
          });
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
      id: 'arm',
      entry: 'api',
      proves: ['api-e2e', 'api-ssrf', 'api-same-endpoint'],
      title:
        'Toggles on; evil.example refused; a task due at the next LA minute; a real-keyed Apple device subscribed twice is one; C for Send test',
      async run(ctx) {
        const st = await ctx.api.reads.getSettings();
        if (!st.remindTimed || !st.remindDueDay || !st.remindPlanned)
          throw new Error(`a reminder toggle is off before the run: ${JSON.stringify(st)}`);
        const before = await status(ctx);
        if (!before.configured) throw new Error('reminders aren’t set up on dev (no VAPID key)');
        // No live device yet, so A's subscribe starts the user's reminders afresh (the registry's createdAt):
        // nothing already due can ride along — A's one POST is this run's reminder (and Send test's).
        if (before.devices.length)
          throw new Error(
            `the test user already has a live device (${before.devices.map((d) => d.label).join(', ')}) — a stray from a crashed run; remove it in Settings`,
          );

        const refused = await ctx.api.writes.subscribePushExpectingRefusal({
          endpoint: 'https://evil.example/x',
          keys: pushKeys(),
          label: label(ctx, 'evil'),
        });
        if (refused !== PUSH_ENDPOINT_ERROR) throw new Error(`refused with “${refused}”`);
        const afterRefusal = await status(ctx);
        if (JSON.stringify(afterRefusal.devices) !== JSON.stringify(before.devices))
          throw new Error('the refused subscribe changed the device list');

        // Due at a minute boundary ahead, so it's armed before it fires (the poller skips one set after).
        fireAt = Math.ceil((Date.now() + ARM_LEAD_MS) / TICK_MS) * TICK_MS;
        const due = new Date(fireAt);
        ping = await ctx.api.writes.createTask({
          title: title(ctx, 'ping'),
          dueDay: laDay(due),
          dueTime: laClock(due),
        });
        ctx.log(`due ${laDay(due)} ${laClock(due)} (${due.toISOString()})`);

        const keys = pushKeys();
        const first = await ctx.api.writes.subscribePush({
          endpoint: endpoint('e2e'),
          keys,
          label: `${label(ctx, 'A')} first`,
        });
        deviceA = await ctx.api.writes.subscribePush({
          endpoint: endpoint('e2e'),
          keys,
          label: label(ctx, 'A'),
        });
        if (deviceA.id !== first.id)
          throw new Error(`two devices for one endpoint: ${first.id}, ${deviceA.id}`);
        const mine = (await status(ctx)).devices.filter((d) => d.id === deviceA.id);
        if (mine.length !== 1 || mine[0]!.label !== label(ctx, 'A'))
          throw new Error(`the server lists ${JSON.stringify(mine)}`);
        deviceC = await ctx.api.writes.subscribePush({
          endpoint: endpoint('c'),
          keys: UNUSABLE_KEYS,
          label: label(ctx, 'C'),
        });
      },
    },
    {
      id: 'ui-deep-link',
      entry: 'ui',
      proves: ['ui-deep-link'],
      title: 'The tap-through to the reminder’s task opens its modal, and the link leaves the URL',
      async run(ctx) {
        await ctx.ui.goto(linkTo(ping.id));
        await dialogOf(ctx, ping.title).waitFor({ state: 'visible', timeout: 15_000 });
        await linkStripped(ctx);
        await ctx.shot('deep-link');
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
      id: 'ui-send-test',
      entry: 'ui',
      proves: ['ui-send-test'],
      title:
        'Send test, clicked inside the tick that sends the reminder → “Sending within a minute…”',
      async run(ctx) {
        await ctx.ui.goto('/settings');
        const send = ctx.page.getByRole('button', { name: 'Send test', exact: true });
        await send.waitFor({ state: 'visible', timeout: 15_000 });
        // Click after the last tick before the reminder's minute and well before the first tick past it, so
        // that tick carries both — one notification, one POST to A. If that tick has gone (or is too close),
        // A had its POST alone: wait it out, take A off, and the test reaches C alone — still one POST.
        const end = fireAt + TICK_WAIT_MS;
        for (;;) {
          const last = (await status(ctx)).poller.lastRunAt ?? 0;
          if (last >= fireAt) break; // the reminder's tick is done
          if (last >= fireAt - TICK_MS && Date.now() < last + TICK_MS - CLICK_MARGIN_MS) {
            batched = true;
            break;
          }
          if (Date.now() > end) throw new Error(`no tick past ${new Date(fireAt).toISOString()}`);
          await new Promise((r) => setTimeout(r, 2_000));
        }
        if (!batched) {
          ctx.log('missed the reminder’s tick: Send test goes alone, to C');
          if ((await status(ctx)).devices.some((d) => d.id === deviceA.id))
            await ctx.api.writes.unsubscribePush(deviceA.id);
          await ctx.page.reload({ waitUntil: 'domcontentloaded' });
          await send.waitFor({ state: 'visible', timeout: 15_000 });
        }
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
      id: 'api-e2e-sent',
      entry: 'api',
      proves: ['api-e2e'],
      title:
        'The tick past the minute sent the reminder to Apple; its answer (404/410 dropped, or 400/403 marked) is on the health line — with the test, as one notification',
      async run(ctx) {
        let outcome: ReturnType<typeof e2eOutcome> = null;
        const s = await until(
          'the poller’s send',
          () => status(ctx),
          (v) => (outcome = e2eOutcome(v, deviceA.id, label(ctx, 'A'), fireAt)) !== null,
          Math.max(fireAt + TICK_WAIT_MS - Date.now(), 10_000),
          5_000,
        );
        const o = outcome as ReturnType<typeof e2eOutcome>;
        if (!o || !o.ok) throw new Error(o ? o.why : 'no outcome');
        ctx.log(o.how);
        // Batched: the test's drop of C is in the same tick's error, so A got both in one POST.
        if (batched && !sameTick(s, label(ctx, 'A'), label(ctx, 'C')))
          throw new Error(
            `the reminder and the test went in different ticks: ${s.poller.lastError}`,
          );
      },
    },
    {
      id: 'server-test-sent',
      entry: 'api',
      proves: ['ui-send-test'],
      title:
        'Within a tick the poller acted on the test: C, whose keys no service takes, is dropped and named',
      async run(ctx) {
        const s = await until(
          'the test’s tick',
          () => status(ctx),
          (v) =>
            (v.poller.lastErrorAt ?? 0) >= testAt - CLOCK_SLACK_MS &&
            errorsOf(v).some((e) => e.startsWith(droppedForKeys(label(ctx, 'C')))),
          Math.max(testAt + TICK_WAIT_MS - Date.now(), 10_000),
          5_000,
        );
        if (s.devices.some((d) => d.id === deviceC.id)) throw new Error('C is still listed');
      },
    },
    noConsoleErrors,
  ],
};
