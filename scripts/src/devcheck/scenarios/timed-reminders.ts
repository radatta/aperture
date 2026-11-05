// Timed reminders — Web Push from the push-dispatch poller (docs/areas/tasks/reminders.md). The deployed
// schedule is the engine: nothing here invokes the poller, so every send this scenario sees came from a real
// tick on dev. The end-to-end proof subscribes a device with a real P-256 key pair on an Apple endpoint that
// was never issued (`devcheck-<nonce>`) and makes a task due this LA minute; the next tick encrypts, signs and
// POSTs it, and Apple's refusal comes back on the health line — the one malformed POST to Apple a run makes
// (plan Q7, approved). Every other device this run makes carries keys no push service could use, so the
// poller drops it at encrypt time without a request (dispatch.ts — the keys outcome); Settings' Send test is
// proven that way, and a device Enable manages to subscribe here is removed in the same step, before anything
// could ping it. Devices are ledgered from the server's answer (api.ts, or the browser's subscribePush response
// via recorder.ts) and removed by id; a removal is a keyless tombstone that stays. The reminder toggles are
// recorded as `reminder-toggles:<run>` before any flip, so cleanup switches them back on whatever happens.
// "Removed from another device" is proven on a device subscribed and removed through the API, its id seeded as
// this browser's opt-in (headless Chromium can't subscribe itself). Titles are `devcheck-rm <nonce> …` — the
// parts scenarios sweep `devcheck <nonce>`. The rows are the plan's
// dev-test matrix (localNotes/plan.md §5 E), with the removal rule (PushStatus.removedDeviceIds).
import { createECDH, randomBytes } from 'node:crypto';
import type { DevPushDevice, DevPushStatus, DevSubscribePushInput, DevTask } from '../api';
import { laDay, noConsoleErrors, type Ctx, type Scenario } from '../scenario';

// packages/shared/src/reminders.ts PUSH_ENDPOINT_ERROR (scripts doesn't depend on shared).
const PUSH_ENDPOINT_ERROR = "That push endpoint isn't a known push service";
// How long the poller may take: its next tick is ≤ 60 s away, plus Lambda's and Apple's time.
const TICK_WAIT_MS = 150_000;
// Server and harness clocks differ by a little; a send stamped this much before we armed still counts.
const CLOCK_SLACK_MS = 5_000;

const title = (ctx: Ctx, what: string) => `devcheck-rm ${ctx.nonce} ${what}`;
const label = (ctx: Ctx, which: string) => `Devcheck ${which} ${ctx.nonce}`;
const endpoint = (ctx: Ctx, which: string) =>
  `https://web.push.apple.com/devcheck-${ctx.nonce.toLowerCase()}${which}`;
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

// What a tick did to the end-to-end device, read from the status, by the copy push/dispatch.ts writes:
//   404/410 → the device is deleted and the user's health line names it:
//             "<label> stopped accepting reminders (push service answered 404|410) — …"
//   400/403 → the device stays, carrying "Last reminder didn't reach this device (push service answered 400|403)"
// null = not yet (no send stamped since `since`). Anything else a send can produce (a 5xx, 429, a timeout, a
// network failure, the stage's own error) is a failure, named.
export function e2eOutcome(
  s: DevPushStatus,
  deviceId: string,
  deviceLabel: string,
  since: number,
): { ok: true; how: string } | { ok: false; why: string } | null {
  if (s.poller.lastError && s.poller.lastError.startsWith('No VAPID key'))
    return { ok: false, why: `the stage can't send: ${s.poller.lastError}` };
  // Each run spends two of the test user's 50 a day (this send and Send test's): the 26th run in one LA day
  // finds the guard shut — named, not a timeout.
  if (
    s.poller.lastError?.startsWith('Daily reminder limit') &&
    (s.poller.lastErrorAt ?? 0) >= since - CLOCK_SLACK_MS
  )
    return { ok: false, why: `the daily guard held it back: ${s.poller.lastError}` };
  if (s.poller.lastSentAt === null || s.poller.lastSentAt < since - CLOCK_SLACK_MS) return null;
  const device = s.devices.find((d) => d.id === deviceId);
  if (!device) {
    const gone = new RegExp(
      `^${escape(deviceLabel)} stopped accepting reminders \\(push service answered (404|410)\\)`,
    ).exec(s.poller.lastError ?? '');
    if (gone && !s.removedDeviceIds.includes(deviceId))
      return { ok: true, how: `Apple answered ${gone[1]}: the poller deleted the device` };
    return { ok: false, why: `the device left without a 404/410: ${JSON.stringify(s.poller)}` };
  }
  const kept = /^Last reminder didn't reach this device \(push service answered (400|403)\)$/.exec(
    device.lastError ?? '',
  );
  if (kept) return { ok: true, how: `Apple answered ${kept[1]}: the device carries the error` };
  if (device.lastError === null && device.lastOkAt === null) return null; // sent for another device first
  return { ok: false, why: `unexpected outcome: ${JSON.stringify({ device, poller: s.poller })}` };
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Steps share what earlier ones made; a failed step skips the rest, so these are set when read.
let armedAt = 0; // just before the end-to-end task was made
let ping: DevTask; // due this LA minute — the end-to-end reminder
let deviceA: DevPushDevice; // the end-to-end device (real keys, Apple)
let deviceB: DevPushDevice; // removed in Settings
let deviceC: DevPushDevice; // the one device left for Send test
let testAt = 0; // just before Send test was clicked
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
      what: 'A device with real keys and a task due this minute → within a tick the poller encrypts, signs and POSTs it, and the push service’s answer lands on the health line (Apple refuses a never-issued endpoint: 404/410 drops the device, 400/403 marks it)',
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
      what: 'Send test says “Sending within a minute…”, and the next tick acts on it for the one device there',
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
        why: 'same path as api-e2e (proven on dev): the tick, the window read and the send are that row’s; whether a kind’s toggle drops a candidate is a pure decision in the task source, run whole in the test',
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
        why: 'same path as api-e2e (proven on dev): its dedup write is that row’s; showing a second tick sends nothing would take a second POST to Apple, and one a run is approved',
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
        why: 'same path as api-e2e (proven on dev): its guard counter write is that row’s; reaching the 51st needs 50 real sends in one day',
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
        why: 'same path as api-e2e (proven on dev): that row’s tick re-reads its task strongly; a finished one is the pure check after that read',
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
      id: 'arm',
      entry: 'api',
      proves: ['api-e2e', 'api-ssrf', 'api-same-endpoint'],
      title:
        'Toggles on; evil.example refused; a real-keyed Apple device subscribed twice is one; a task due this LA minute',
      async run(ctx) {
        const st = await ctx.api.reads.getSettings();
        if (!st.remindTimed || !st.remindDueDay || !st.remindPlanned)
          throw new Error(`a reminder toggle is off before the run: ${JSON.stringify(st)}`);
        const before = await status(ctx);
        if (!before.configured) throw new Error('reminders aren’t set up on dev (no VAPID key)');

        const refused = await ctx.api.writes.subscribePushExpectingRefusal({
          endpoint: 'https://evil.example/x',
          keys: pushKeys(),
          label: label(ctx, 'evil'),
        });
        if (refused !== PUSH_ENDPOINT_ERROR) throw new Error(`refused with “${refused}”`);
        const afterRefusal = await status(ctx);
        if (JSON.stringify(afterRefusal.devices) !== JSON.stringify(before.devices))
          throw new Error('the refused subscribe changed the device list');

        // The task first, the device second: until the device exists nothing can send, so the first tick
        // that sees it carries this task (and anything else due in the window) as one notification — one
        // POST to Apple.
        armedAt = Date.now();
        const now = new Date();
        ping = await ctx.api.writes.createTask({
          title: title(ctx, 'ping'),
          dueDay: laDay(now),
          dueTime: laClock(now),
        });
        ctx.log(`armed at ${now.toISOString()}: due ${laDay(now)} ${laClock(now)}`);

        const keys = pushKeys();
        const first = await ctx.api.writes.subscribePush({
          endpoint: endpoint(ctx, ''),
          keys,
          label: `${label(ctx, 'A')} first`,
        });
        deviceA = await ctx.api.writes.subscribePush({
          endpoint: endpoint(ctx, ''),
          keys,
          label: label(ctx, 'A'),
        });
        if (deviceA.id !== first.id)
          throw new Error(`two devices for one endpoint: ${first.id}, ${deviceA.id}`);
        const mine = (await status(ctx)).devices.filter((d) => d.id === deviceA.id);
        if (mine.length !== 1 || mine[0]!.label !== label(ctx, 'A'))
          throw new Error(`the server lists ${JSON.stringify(mine)}`);
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
      id: 'api-e2e-sent',
      entry: 'api',
      proves: ['api-e2e'],
      title:
        'Within a tick: the poller sent the reminder to Apple, and its answer (404/410 dropped, or 400/403 marked) is on the health line',
      async run(ctx) {
        const left = Math.max(TICK_WAIT_MS - (Date.now() - armedAt), 10_000);
        let outcome: ReturnType<typeof e2eOutcome> = null;
        await until(
          'the poller’s send',
          () => status(ctx),
          (s) => (outcome = e2eOutcome(s, deviceA.id, label(ctx, 'A'), armedAt)) !== null,
          left,
          5_000,
        );
        const o = outcome as ReturnType<typeof e2eOutcome>;
        if (!o || !o.ok) throw new Error(o ? o.why : 'no outcome');
        ctx.log(o.how);
      },
    },
    {
      id: 'stage-devices',
      entry: 'api',
      title:
        'Two devices no push service could use (B to remove, C for Send test); A out of the way',
      async run(ctx) {
        deviceB = await ctx.api.writes.subscribePush({
          endpoint: endpoint(ctx, '-b'),
          keys: UNUSABLE_KEYS,
          label: label(ctx, 'B'),
        });
        deviceC = await ctx.api.writes.subscribePush({
          endpoint: endpoint(ctx, '-c'),
          keys: UNUSABLE_KEYS,
          label: label(ctx, 'C'),
        });
        // A 400/403 left A in place: take it off, so Send test reaches no real push service.
        if ((await status(ctx)).devices.some((d) => d.id === deviceA.id))
          await ctx.api.writes.unsubscribePush(deviceA.id);
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
        await ctx.page
          .getByRole('button', { name: `Remove ${label(ctx, 'C')}`, exact: true })
          .waitFor({ state: 'visible', timeout: 5_000 }); // the neighbour stays
        await ctx.shot('removed');
      },
    },
    {
      id: 'server-removed',
      entry: 'api',
      proves: ['ui-remove'],
      title: 'The server lists B as removed, and C alive',
      async run(ctx) {
        const s = await until(
          'the removal',
          () => status(ctx),
          (v) => v.removedDeviceIds.includes(deviceB.id),
        );
        if (s.devices.some((d) => d.id === deviceB.id))
          throw new Error('B is still among the devices');
        if (!s.devices.some((d) => d.id === deviceC.id)) throw new Error('C went too');
      },
    },
    {
      id: 'ui-send-test',
      entry: 'ui',
      proves: ['ui-send-test'],
      title: 'Send test → “Sending within a minute…”',
      async run(ctx) {
        // Still on Settings from the removal; C is the one device listed.
        testAt = Date.now();
        await ctx.page
          .getByRole('button', { name: 'Send test', exact: true })
          .click({ timeout: 15_000 });
        await ctx.page
          .getByRole('status')
          .getByText('Sending within a minute…', { exact: true })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await ctx.shot('send-test');
      },
    },
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
      id: 'server-test-sent',
      entry: 'api',
      proves: ['ui-send-test'],
      title:
        'Within a tick the poller acted on the test: C, whose keys no service takes, is dropped and named',
      async run(ctx) {
        const left = Math.max(TICK_WAIT_MS - (Date.now() - testAt), 10_000);
        const want = `${label(ctx, 'C')} stopped accepting reminders (its keys are invalid)`;
        const s = await until(
          'the test’s tick',
          () => status(ctx),
          (v) =>
            (v.poller.lastSentAt ?? 0) >= testAt - CLOCK_SLACK_MS &&
            (v.poller.lastError ?? '').startsWith(want),
          left,
          5_000,
        );
        if (s.devices.some((d) => d.id === deviceC.id)) throw new Error('C is still listed');
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
          endpoint: endpoint(ctx, '-r'),
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
    noConsoleErrors,
  ],
};
