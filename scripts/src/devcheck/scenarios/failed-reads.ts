// A failed read never fails silently (docs/product/CONVENTIONS.md → Failed reads). Dev proves the one path the
// stub can't run — real fetch → http client → query layer → screen — once per distinct path: a read whose 429
// the http client retries away, a read whose dropped connection the query layer retries and then shows (with
// Retry), a write whose 429 is retried away, and a Pomodoro stop that fails (then a paused stop's credit). The harness fails dev's /api/<method> itself (ctx.intercept — nothing in the app
// switches). Every other case runs one of those paths on another screen, so its named test covers it
// (DEV-CHECK.md → Rows: same path as a dev-proven row).
import type { DevSession } from '../api';
import { laDay, noConsoleErrors, type Ctx, type Row, type Scenario } from '../scenario';

// Counted on /settings: task cards each mount a categories reader, and React Query refetches a failed query
// when a new reader mounts — on /tasks the injected count would depend on how fast listTasks is.
const SETTINGS_CATEGORIES = 'Couldn’t load categories.';
const FOCUS = '[title="Start a 25-minute focus block"]';
const title = (nonce: string) => `devcheck-fr ${nonce}`;
// The app gets an injected response a moment after the route counts it, then React renders: wait that out
// before asserting something is NOT on screen.
const SETTLE_MS = 1_500;
const PAUSE_MS = 4_000;

// The completed sessions before this run's timer, so the check after it finds this run's own.
let completedBefore = new Set<string>();
const isCompleted = (x: DevSession) => x.status === 'completed' && x.endedAt !== null;
// The app's day, not the calendar's; and the day before, for a run that crossed the day start.
async function sessionsAround(ctx: Ctx): Promise<DevSession[]> {
  const { dayStartHour } = await ctx.api.reads.getSettings();
  const now = Date.now() - dayStartHour * 3_600_000;
  const days = [laDay(new Date(now)), laDay(new Date(now - 86_400_000))];
  return (await Promise.all(days.map((d) => ctx.api.reads.listSessionsForDay(d)))).flat();
}

const button = (ctx: Ctx, name: string) =>
  ctx.page.getByRole('button', { name, exact: true }).first();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(200);
  }
}

// A run that died mid-timer leaves one running (or stale) on the test user. Clear it through the dock, judged
// by the server's list — the dock's idle Focus shows before that read lands. Timers live only in the test
// user's partition.
async function clearTimers(ctx: Ctx) {
  for (let i = 0; i < 8; i++) {
    if (!(await ctx.api.reads.listRunningSessions()).length) return;
    if (i === 0) await ctx.ui.goto('/settings');
    const discard = button(ctx, 'Discard');
    const stop = button(ctx, 'Stop');
    await discard.or(stop).first().waitFor({ timeout: 15_000 });
    if (await discard.isVisible()) await discard.click();
    else await stop.click();
    await wait(1_500);
  }
  throw new Error('a timer left running on the test user would not clear');
}

const FR = 'app/src/pages/failedReads.test.tsx';
const RETRY = 'app/src/data/retry.test.ts';
const HTTP = 'app/src/data/httpClient.test.ts';
const POMO = 'app/src/modules/pomodoro/PomodoroProvider.test.tsx';
const row = (id: string, what: string, file: string, test: string, why: string): Row => ({
  id,
  entry: 'ui',
  kind: 'edge',
  what,
  offDev: { file, test, why },
});
// The reasons, by the dev-proven row whose path a case shares.
const READ_PATH =
  'same path as error-shown (proven on dev): a read fails through the real client and the screen says so — this is another screen’s copy of it';
const DOCK_PATH =
  'same path as stop-fails (proven on dev): a Pomodoro call fails and its row says so — this is another call';
const NO_GOOGLE = 'the dev test user has no Google account, so these reads never run on dev';
const NO_SEED =
  'needs data the harness can’t write on the test user (no habit, roll, category or plan writes are declared)';

export const failedReads: Scenario = {
  id: 'failed-reads',
  title: 'Failed reads say so, retry, and recover',
  tiers: ['full'],
  rows: [
    {
      id: 'retry-recovers',
      entry: 'ui',
      kind: 'nominal',
      what: 'One 429 on a read is retried away: no error line',
    },
    {
      id: 'error-shown',
      entry: 'ui',
      kind: 'nominal',
      what: 'A read that keeps failing says “Couldn’t load” after 3 tries, and Retry recovers it',
    },
    {
      id: 'write-429-retried',
      entry: 'ui',
      kind: 'nominal',
      what: 'A capture whose createTask gets one 429 still lands (“Task added”)',
    },
    {
      id: 'stop-fails',
      entry: 'ui',
      kind: 'edge',
      what: 'A stop that fails keeps the timer and says “Couldn’t stop”; Stop again ends it on the server',
    },
    {
      id: 'network-error',
      entry: 'ui',
      kind: 'edge',
      what: 'A dropped connection on a read is retried twice by the query layer, then shows the same line',
    },
    row(
      'throttle-gives-up',
      'A read whose 429s keep coming is retried twice, then fails',
      HTTP,
      'gives up after two retries and throws the 429',
      'same path as retry-recovers (proven on dev): the http client’s 429 loop, here running out',
    ),
    row(
      'refusal-not-retried',
      'A 400 on a read shows the line at once, without retrying',
      RETRY,
      'does not retry a 400 refusal, a 401, a 404 or a plain Error at the query layer',
      'same path as error-shown (proven on dev): the query layer’s retry decision, here declining — a pure function',
    ),
    row(
      'write-5xx-not-retried',
      'A write that gets a 500 or a dropped connection is sent once',
      HTTP,
      'never retries a write on a 500 or a dropped connection — it may have landed',
      'dev never answers a write with a 500 or drops it on its own; the http client branch is the whole case and the test drives it',
    ),
    row(
      'mutation-not-retried',
      'The query layer never retries a write',
      RETRY,
      'the app QueryClient wires the policy and leaves mutations un-retried',
      'a static setting of the client: no request on dev reaches it (a 429 is retried below it, and dev never fails a write on its own)',
    ),
    row(
      'keeps-data',
      'A failed background refetch keeps the loaded data and shows no error',
      FR,
      'a failed background refetch keeps the loaded categories and shows no error',
      'same path as error-shown (proven on dev): the same failed read, landing on a screen that already has data — the test asserts it stays quiet',
    ),
    row(
      'settings-fails',
      'Settings failing says so on /settings, once',
      FR,
      'a failed settings read shows an error, not an empty page — once, not twice',
      READ_PATH,
    ),
    row(
      'settings-cascade',
      'With settings failing, Intent says it couldn’t load instead of a field that never loads',
      FR,
      'a failed settings read disables Intent and says why, instead of a field that never loads',
      READ_PATH,
    ),
    row(
      'day-failed',
      'The day read failing disables Intent instead of letting it overwrite',
      FR,
      'a failed day read disables Intent instead of overwriting it',
      READ_PATH,
    ),
    row(
      'capacity-failed',
      'With the day unreadable, the capacity field is hidden and says why',
      FR,
      'a failed settings read hides the Today capacity field instead of an empty one',
      READ_PATH,
    ),
    row(
      'plan-failed',
      'The plan read failing says so, not “Nothing planned yet”',
      FR,
      'a failed plan read says so instead of “Nothing planned yet”',
      READ_PATH,
    ),
    row(
      'time-budget-failed',
      'The plan read failing on Daytime says so, not “No plan to budget against”',
      FR,
      'a failed plan read on Daytime says so instead of “No plan to budget against”',
      READ_PATH,
    ),
    row(
      'log-failed',
      'Night Home with the log failing says so, not “Nothing logged yet”',
      FR,
      'a failed log read says so instead of “Nothing logged yet”',
      READ_PATH,
    ),
    row(
      'habits-failed',
      'Night Home with habits failing says so, not “No habits yet”',
      FR,
      'a failed habits read says so instead of “No habits yet”',
      READ_PATH,
    ),
    row(
      'glances',
      'The Flux and Finance lines on night Home say couldn’t load instead of vanishing',
      FR,
      'the Flux and Finance lines say couldn’t load instead of vanishing',
      READ_PATH,
    ),
    row(
      'recurring-failed',
      'The series read failing says so, not “No recurring tasks yet”',
      FR,
      'a failed series read says so instead of “No recurring tasks yet”',
      READ_PATH,
    ),
    row(
      'calibration-failed',
      'The calibration read failing says so, not “No finished tasks with an estimate yet”',
      FR,
      'a failed calibration read says so instead of the empty state',
      READ_PATH,
    ),
    row(
      'add-to-today-failed',
      'Add to today with the tasks read failing says so, not “Nothing waiting”',
      FR,
      'a failed tasks read in Add to today says so instead of an empty list',
      READ_PATH,
    ),
    row(
      'bulk-add-failed',
      'Bulk add with a #label and categories failing says to remove the label, and stays blocked',
      FR,
      'a #label paste with failed categories says so and stays blocked',
      READ_PATH,
    ),
    row(
      'category-picker-failed',
      'The task editor’s category picker is disabled, not “Uncategorized”, when categories fail',
      FR,
      'a failed categories read disables the task’s category picker',
      READ_PATH,
    ),
    row(
      'adopt-error',
      'The running-timers read failing shows “Couldn’t check for running timers”, never an empty dock',
      POMO,
      'a failed adopt-load shows an error row, never an empty dock',
      READ_PATH,
    ),
    row(
      'adopt-retry',
      'Retry on that row re-reads running timers',
      POMO,
      'Retry on the adopt row re-reads running sessions',
      READ_PATH,
    ),
    row(
      'start-fails',
      'A focus start that fails says so',
      POMO,
      'a failed start says so',
      DOCK_PATH,
    ),
    row(
      'resume-fails',
      'A resume that fails stays paused and says so',
      POMO,
      'a failed resume stays paused and says so',
      DOCK_PATH,
    ),
    row(
      'heartbeat-fails',
      'Two failed heartbeats mark the timer “not syncing”; a good one clears it',
      POMO,
      'two failed heartbeats mark the timer not syncing; a good one clears it',
      'same path as stop-fails (proven on dev): a Pomodoro call failing — the miss counting on top is timer logic the fake-timer test drives',
    ),
    {
      id: 'paused-stop',
      entry: 'ui',
      kind: 'edge',
      what: 'Stopping a paused timer never counts the pause as worked time',
    },
    row(
      'capture-500',
      'A capture whose save fails says “Couldn’t save” and puts the text back',
      'app/src/modules/capture/CaptureBar.test.tsx',
      'puts the text back and says so when the write fails',
      'same path as write-429-retried (proven on dev): the same capture write, here failing',
    ),
    row(
      'defaults-notice',
      'With settings failing, every screen says “running on defaults”, with Retry',
      'app/src/components/AppShell.test.tsx',
      'shows the defaults notice with Retry; a pending one shows nothing',
      READ_PATH,
    ),
    row(
      'day-shape-failed',
      'A failed calendar read never shows a free day',
      FR,
      'a failed calendar read never shows a free day',
      NO_GOOGLE,
    ),
    row(
      'add-to-calendar-failed',
      'Add to calendar with the calendars read failing never says to connect an account',
      FR,
      'a failed calendars read never says to connect an account',
      NO_GOOGLE,
    ),
    row(
      'habit-checks-failed',
      'Failed check-ins blank the Habits page counts and lock the cells',
      FR,
      'failed checks blank the Habits page counts and lock the cells',
      NO_SEED,
    ),
    row(
      'roll-reps-failed',
      'The Rolls page says its reps couldn’t load instead of empty sheets',
      FR,
      'a failed tasks read says so above the roll sheets',
      NO_SEED,
    ),
    row(
      'category-pill',
      'A task whose category can’t resolve shows a “—” pill, not nothing',
      FR,
      'a failed categories read says so with Retry, and marks the tags it can’t resolve',
      NO_SEED,
    ),
    row(
      'hero-done-failed-stop',
      'Done on the hero with a failed stop keeps the timer and never opens the Actual form',
      'app/src/pages/Home/RightNow.test.tsx',
      'Done on the hero with a failed stop keeps the timer and never opens the Actual form',
      'the hero is the first task on the test user’s plan for today; the harness can add one but not put it first',
    ),
    row(
      'stale-keep-failed',
      'Keep on a timer left running, when the save fails, keeps the prompt and says so',
      POMO,
      'a failed keep keeps the stale prompt and says so',
      DOCK_PATH,
    ),
    {
      id: 'ios-offline',
      entry: 'ios',
      kind: 'edge',
      what: 'Airplane mode on the iPhone PWA: reads say couldn’t load instead of sitting on “Loading…”',
      needsYou: 'a real radio drop on iOS Safari',
    },
  ],
  steps: [
    {
      id: 'recover',
      entry: 'ui',
      proves: ['retry-recovers'],
      title: 'One 429 on listCategories is retried away',
      async run(ctx) {
        const i = await ctx.intercept('listCategories', { times: 1 });
        await ctx.ui.goto('/settings');
        await until('the retried categories read', () => i.passed() >= 1);
        await wait(SETTLE_MS);
        if (await ctx.page.getByText(SETTINGS_CATEGORIES).count())
          throw new Error('the error line shows after a retried 429');
        if (i.hits() !== 1) throw new Error(`expected 1 injected 429, got ${i.hits()}`);
        await i.release();
      },
    },
    {
      id: 'shown',
      entry: 'ui',
      proves: ['error-shown', 'network-error'],
      title:
        'listCategories’ connection keeps dropping → the query layer retries twice, then the line',
      async run(ctx) {
        // Dropped, not 429: a 429 is retried inside the http client and never reaches the query layer's retry.
        const i = await ctx.intercept('listCategories', { abort: true });
        await ctx.ui.goto('/settings');
        await ctx.ui.expectText(SETTINGS_CATEGORIES, 15_000);
        const tries = i.hits(); // at the moment it shows, before any later reader refetches
        if (tries !== 3) throw new Error(`expected 3 tries (1 + 2 retries), saw ${tries}`);
        await ctx.shot('categories-failed');
        await i.release();
      },
    },
    {
      id: 'retry',
      entry: 'ui',
      proves: ['error-shown'],
      title: 'Retry clears it once the read works',
      async run(ctx) {
        await button(ctx, 'Retry').click();
        await ctx.page
          .getByText(SETTINGS_CATEGORIES)
          .first()
          .waitFor({ state: 'hidden', timeout: 10_000 });
      },
    },
    {
      id: 'write-429',
      entry: 'ui',
      proves: ['write-429-retried'],
      title: 'A capture whose createTask gets one 429 still lands',
      async run(ctx) {
        const i = await ctx.intercept('createTask', { times: 1 });
        await ctx.ui.goto('/tasks');
        await ctx.ui.captureTask(`${title(ctx.nonce)} | ~15`);
        if (i.hits() !== 1 || i.passed() < 1)
          throw new Error(
            `expected 1 injected 429 then a real call, saw ${i.hits()}/${i.passed()}`,
          );
        await i.release();
      },
    },
    {
      id: 'start',
      entry: 'ui',
      title: 'Start a focus (leftover timers cleared first)',
      async run(ctx) {
        await clearTimers(ctx);
        completedBefore = new Set((await sessionsAround(ctx)).filter(isCompleted).map((x) => x.id));
        await ctx.ui.goto('/settings');
        await ctx.page.locator(FOCUS).first().click();
        await button(ctx, 'Pause').waitFor({ timeout: 15_000 });
      },
    },
    {
      id: 'stop',
      entry: 'ui',
      proves: ['stop-fails', 'paused-stop'],
      title: 'A failed stop keeps the timer and says so; then paused, Stop ends it',
      async run(ctx) {
        const i = await ctx.intercept('stopSession');
        try {
          await button(ctx, 'Stop').click();
          await ctx.ui.expectText('Couldn’t stop — try again.', 15_000);
          await button(ctx, 'Pause').waitFor({ timeout: 2_000 });
          await ctx.shot('stop-failed');
        } finally {
          await i.release();
        }
        await button(ctx, 'Pause').click();
        await button(ctx, 'Resume').waitFor({ timeout: 15_000 });
        await wait(PAUSE_MS);
        await button(ctx, 'Stop').click();
        await ctx.page.locator(FOCUS).first().waitFor({ timeout: 15_000 });
      },
    },
    {
      id: 'no-timer-left',
      entry: 'api',
      proves: ['stop-fails'],
      title: 'No timer left running; this run’s stopped one wasn’t credited its pause',
      async run(ctx) {
        const left = await ctx.api.reads.listRunningSessions();
        if (left.length) throw new Error(`${left.length} timer(s) still running on the test user`);
        const mine = (await sessionsAround(ctx))
          .filter((x) => isCompleted(x) && !completedBefore.has(x.id))
          .sort((a, b) => b.endedAt! - a.endedAt!)[0];
        if (!mine) throw new Error('this run’s stopped timer is not among the completed sessions');
        const wallSec = (mine.endedAt! - mine.startedAt) / 1000;
        const creditedSec = mine.activeMinutes * 60;
        // Short of the wall clock by at least the pause, less 1.5 s for the pause beat's own round trip.
        if (creditedSec > wallSec - PAUSE_MS / 1000 + 1.5)
          throw new Error(
            `credited ${creditedSec.toFixed(1)} s of a ${wallSec.toFixed(1)} s timer`,
          );
      },
    },
    noConsoleErrors,
  ],
};
