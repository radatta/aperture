// A failed read never fails silently (docs/product/CONVENTIONS.md → Failed reads). The harness fails dev's
// /api/<method> itself (ctx.intercept, a Playwright route — nothing in the app switches) and checks the screen
// says so instead of an empty list or a default, that Retry recovers, and that a 429 is retried away.
import { noConsoleErrors, type Ctx, type Row, type Scenario } from '../scenario';

// Counted on /settings: task cards there would each mount a categories reader, and React Query refetches a
// failed query when a new reader mounts — so on /tasks the injected count depends on how fast listTasks is.
const SETTINGS_CATEGORIES = 'Couldn’t load categories.';
const CATEGORIES_LINE = /Couldn.t load categories — labels and category filters are off/;
const LIST_ERROR = /Couldn.t load this\. Check your connection/;
const FOCUS = '[title="Start a 25-minute focus block"]';
const title = (nonce: string) => `devcheck-fr ${nonce}`;

const button = (ctx: Ctx, name: string | RegExp) =>
  ctx.page.getByRole('button', { name, exact: typeof name === 'string' }).first();
const gone = (ctx: Ctx, text: string | RegExp, timeout = 10_000) =>
  ctx.page.getByText(text).first().waitFor({ state: 'hidden', timeout });
async function absent(ctx: Ctx, text: string | RegExp) {
  if (await ctx.page.getByText(text).count()) throw new Error(`"${String(text)}" is on screen`);
}
async function until(what: string, ok: () => boolean, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(200);
  }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The app gets an injected response a moment after the route counts it, then React renders: wait that out
// before asserting something is NOT on screen.
const SETTLE_MS = 1_500;
const PAUSE_MS = 20_000;

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

const offDev = (id: string, what: string, file: string, test: string, why: string): Row => ({
  id,
  entry: 'ui',
  kind: 'edge',
  what,
  offDev: { file, test, why },
});
const FR = 'app/src/pages/failedReads.test.tsx';
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
      what: 'One 429 on the categories read is retried away: no error line',
    },
    {
      id: 'error-shown',
      entry: 'ui',
      kind: 'nominal',
      what: 'Categories keep failing → “Couldn’t load categories” with Retry, after 3 tries (Settings and Tasks)',
    },
    {
      id: 'retry-button',
      entry: 'ui',
      kind: 'edge',
      what: 'Once the read works again, Retry clears the line',
    },
    {
      id: 'network-error',
      entry: 'ui',
      kind: 'edge',
      what: 'A dropped connection is retried twice, then shows the same line',
    },
    {
      id: 'refusal-not-retried',
      entry: 'ui',
      kind: 'edge',
      what: 'A 400 on the read shows the line at once, without retrying',
    },
    {
      id: 'write-429-retried',
      entry: 'ui',
      kind: 'nominal',
      what: 'A capture whose createTask gets one 429 still lands (“Task added”)',
    },
    {
      id: 'write-5xx-not-retried',
      entry: 'ui',
      kind: 'edge',
      what: 'A capture whose createTask gets a 500 is sent once, says “Couldn’t save”, and keeps the text',
    },
    {
      id: 'settings-fails',
      entry: 'ui',
      kind: 'edge',
      what: 'Settings failing says so on /settings, survives a reload, and Retry clears it',
    },
    {
      id: 'settings-cascade',
      entry: 'ui',
      kind: 'edge',
      what: 'With settings failing, Home says “running on defaults” and Intent says it couldn’t load',
    },
    {
      id: 'day-failed',
      entry: 'ui',
      kind: 'edge',
      what: 'The day read failing disables Intent and hides the capacity field, each saying why',
    },
    {
      id: 'plan-failed',
      entry: 'ui',
      kind: 'nominal',
      what: 'The plan read failing: Plan today and Time budget say couldn’t load, not “Nothing planned yet”',
    },
    {
      id: 'home-no-lies',
      entry: 'ui',
      kind: 'nominal',
      what: 'Night Home with habits and the log failing says couldn’t load, not “No habits yet” / “Nothing logged yet”',
    },
    {
      id: 'glances',
      entry: 'ui',
      kind: 'edge',
      what: 'The Flux and Finance lines on night Home say couldn’t load instead of vanishing',
    },
    {
      id: 'recurring-failed',
      entry: 'ui',
      kind: 'edge',
      what: 'The series read failing says so, not “No recurring tasks yet”',
    },
    {
      id: 'calibration-failed',
      entry: 'ui',
      kind: 'edge',
      what: 'The calibration read failing says so, not “No finished tasks with an estimate yet”',
    },
    {
      id: 'add-to-today-failed',
      entry: 'ui',
      kind: 'edge',
      what: 'Add to today with the tasks read failing says so, not “Nothing waiting”',
    },
    {
      id: 'bulk-add-failed',
      entry: 'ui',
      kind: 'edge',
      what: 'Bulk add with a #label and categories failing says to remove the label, and stays blocked',
    },
    {
      id: 'adopt-error',
      entry: 'ui',
      kind: 'nominal',
      what: 'The running-timers read failing shows “Couldn’t check for running timers”, never an empty dock',
    },
    {
      id: 'adopt-retry',
      entry: 'ui',
      kind: 'edge',
      what: 'Retry on that row, once the read works, clears it',
    },
    {
      id: 'start-fails',
      entry: 'ui',
      kind: 'edge',
      what: 'A focus start that fails says “Couldn’t start the timer”',
    },
    {
      id: 'keeps-data',
      entry: 'ui',
      kind: 'edge',
      what: 'A failed background refetch keeps the loaded categories and shows no error',
    },
    {
      id: 'heartbeat-fails',
      entry: 'ui',
      kind: 'edge',
      what: 'Heartbeats failing for 30 s mark the timer “not syncing”; a good beat clears it',
    },
    {
      id: 'resume-fails',
      entry: 'ui',
      kind: 'edge',
      what: 'A resume that fails stays paused and says “Couldn’t resume”; Resume again works',
    },
    {
      id: 'paused-stop',
      entry: 'ui',
      kind: 'edge',
      what: 'Stopping a paused timer never counts the pause as worked time',
    },
    {
      id: 'stop-fails',
      entry: 'ui',
      kind: 'edge',
      what: 'A stop that fails keeps the timer and says “Couldn’t stop”; Stop again ends it on the server',
    },
    {
      id: 'mutation-not-retried',
      entry: 'ui',
      kind: 'edge',
      what: 'The query layer never retries a write (a 500 on createTask is one send)',
    },
    offDev(
      'day-shape-failed',
      'A failed calendar read never shows a free day',
      FR,
      'a failed calendar read never shows a free day',
      NO_GOOGLE,
    ),
    offDev(
      'add-to-calendar-failed',
      'Add to calendar with the calendars read failing never says to connect an account',
      FR,
      'a failed calendars read never says to connect an account',
      NO_GOOGLE,
    ),
    offDev(
      'habit-checks-failed',
      'Failed check-ins blank the Habits page counts and lock the cells',
      FR,
      'failed checks blank the Habits page counts and lock the cells',
      NO_SEED,
    ),
    offDev(
      'roll-reps-failed',
      'The Rolls page says its reps couldn’t load instead of empty sheets',
      FR,
      'a failed tasks read says so above the roll sheets',
      NO_SEED,
    ),
    offDev(
      'category-pill',
      'A task whose category can’t resolve shows a “—” pill, not nothing',
      FR,
      'a failed categories read says so with Retry, and marks the tags it can’t resolve',
      NO_SEED,
    ),
    offDev(
      'hero-done-failed-stop',
      'Done on the hero with a failed stop keeps the timer and never opens the Actual form',
      'app/src/pages/Home/RightNow.test.tsx',
      'Done on the hero with a failed stop keeps the timer and never opens the Actual form',
      'the hero is the first task on the test user’s plan for today; the harness can add one but not put it first, so on dev the step would drive whatever task is there',
    ),
    offDev(
      'stale-keep-failed',
      'Keep on a timer left running, when the save fails, keeps the prompt and says so',
      'app/src/modules/pomodoro/PomodoroProvider.test.tsx',
      'a failed keep keeps the stale prompt and says so',
      'dev can make one (heartbeats failed for over 90 s, then a reload), at ~100 s of run time on top of the ~2.5 min this scenario takes — a logged trade-off (decisions.md), revisit if the full run is trimmed',
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
        await absent(ctx, SETTINGS_CATEGORIES);
        if (i.hits() !== 1) throw new Error(`expected 1 injected 429, got ${i.hits()}`);
        await i.release();
      },
    },
    {
      id: 'shown',
      entry: 'ui',
      proves: ['error-shown'],
      title: 'listCategories keeps failing → the line after 3 tries, on Settings and on Tasks',
      async run(ctx) {
        const i = await ctx.intercept('listCategories');
        await ctx.ui.goto('/settings');
        await ctx.ui.expectText(SETTINGS_CATEGORIES, 15_000);
        const tries = i.hits(); // at the moment it shows, before any later reader refetches
        if (tries !== 3) throw new Error(`expected 3 tries (1 + 2 retries), saw ${tries}`);
        await ctx.ui.goto('/tasks?lens=backlog');
        await ctx.ui.expectText(CATEGORIES_LINE, 15_000);
        await ctx.shot('categories-failed');
        await ctx.ui.goto('/settings');
        await ctx.ui.expectText(SETTINGS_CATEGORIES, 15_000);
        await i.release();
      },
    },
    {
      id: 'retry',
      entry: 'ui',
      proves: ['retry-button'],
      title: 'Retry clears it once the read works',
      async run(ctx) {
        await button(ctx, 'Retry').click();
        await gone(ctx, SETTINGS_CATEGORIES);
      },
    },
    {
      id: 'aborted',
      entry: 'ui',
      proves: ['network-error'],
      title: 'A dropped connection is retried twice, then shows the same line',
      async run(ctx) {
        const i = await ctx.intercept('listCategories', { abort: true });
        await ctx.ui.goto('/settings');
        await ctx.ui.expectText(SETTINGS_CATEGORIES, 15_000);
        const tries = i.hits();
        if (tries !== 3) throw new Error(`expected 3 tries (1 + 2 retries), saw ${tries}`);
        await i.release();
      },
    },
    {
      id: 'refusal',
      entry: 'ui',
      proves: ['refusal-not-retried'],
      title: 'A 400 on the read shows the line at once, one try',
      async run(ctx) {
        const i = await ctx.intercept('listCategories', { status: 400 });
        await ctx.ui.goto('/settings');
        await ctx.ui.expectText(SETTINGS_CATEGORIES, 15_000);
        await wait(SETTLE_MS); // past where a retry would have fired
        if (i.hits() !== 1) throw new Error(`expected 1 try, saw ${i.hits()}`);
        await i.release();
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
      id: 'write-500',
      entry: 'ui',
      proves: ['write-5xx-not-retried', 'mutation-not-retried'],
      title: 'A capture whose createTask gets a 500 is sent once and says so',
      async run(ctx) {
        const i = await ctx.intercept('createTask', { status: 500, times: 1 });
        await ctx.ui.goto('/tasks');
        await button(ctx, 'Task').click();
        const field = ctx.page.locator('textarea[aria-label="Capture task"]');
        await field.fill(`${title(ctx.nonce)} not saved | ~15`);
        await field.press('Enter');
        try {
          await ctx.ui.expectText(/Couldn.t save — your text is back in the box/, 15_000);
          await wait(SETTLE_MS * 2); // past where a retry would have fired
          if (i.hits() !== 1 || i.passed() !== 0)
            throw new Error(`expected one send, saw ${i.hits()} failed / ${i.passed()} through`);
          if (!(await field.inputValue()).includes('not saved'))
            throw new Error('the text was not kept');
          await ctx.shot('capture-500');
        } finally {
          await field.fill(''); // never leave it to be sent later
          await i.release();
        }
      },
    },
    {
      id: 'settings',
      entry: 'ui',
      proves: ['settings-fails', 'settings-cascade'],
      title:
        'getSettings failing: /settings says so (after a reload too), Home cascades, Retry clears',
      async run(ctx) {
        const i = await ctx.intercept('getSettings');
        await ctx.ui.goto('/settings');
        await ctx.ui.expectText(/Couldn.t load your settings — calendar, preferences/, 15_000);
        await ctx.page.reload({ waitUntil: 'domcontentloaded' });
        await ctx.ui.expectText(/Couldn.t load your settings — calendar, preferences/, 15_000);
        await ctx.shot('settings-failed');
        await ctx.page.getByRole('link', { name: 'Home', exact: true }).first().click();
        await ctx.ui.expectText(/running on defaults/, 15_000);
        await button(ctx, 'Morning').click();
        await ctx.ui.expectText('Couldn’t load today’s intent.', 15_000);
        await i.release();
        await button(ctx, 'Retry').click();
        await gone(ctx, /running on defaults/);
      },
    },
    {
      id: 'day',
      entry: 'ui',
      proves: ['day-failed'],
      title: 'getDay failing: Intent disabled and capacity hidden, each saying why',
      async run(ctx) {
        const i = await ctx.intercept('getDay');
        await ctx.ui.goto('/');
        await button(ctx, 'Morning').click();
        await ctx.ui.expectText('Couldn’t load today’s intent.', 15_000);
        if (!(await ctx.page.getByLabel('Day intent').isDisabled()))
          throw new Error('Intent is editable over a day that never loaded');
        await ctx.ui.goto('/tasks?lens=today');
        await ctx.ui.expectText('Couldn’t load today’s capacity.', 15_000);
        if (await ctx.page.getByLabel('Hours available today').count())
          throw new Error('the capacity field shows over a day that never loaded');
        await ctx.shot('capacity-failed');
        await i.release();
      },
    },
    {
      id: 'plan',
      entry: 'ui',
      proves: ['plan-failed'],
      title: 'listPlansForDay failing: Plan today and Time budget say couldn’t load',
      async run(ctx) {
        const i = await ctx.intercept('listPlansForDay');
        await ctx.ui.goto('/');
        await button(ctx, 'Morning').click();
        await ctx.ui.expectText(LIST_ERROR, 15_000);
        await absent(ctx, /Nothing planned yet/);
        await button(ctx, 'Daytime').click();
        await ctx.ui.expectText(LIST_ERROR, 15_000);
        await absent(ctx, /No plan to budget against/);
        await i.release();
      },
    },
    {
      id: 'home',
      entry: 'ui',
      proves: ['home-no-lies', 'glances'],
      title: 'Night Home with its reads failing says couldn’t load',
      async run(ctx) {
        const off = await Promise.all(
          ['listHabits', 'listLogEntries', 'listFluxSets', 'getFinanceOverview'].map((m) =>
            ctx.intercept(m),
          ),
        );
        await ctx.ui.goto('/');
        await button(ctx, 'Night').click();
        await ctx.ui.expectText('Couldn’t load today’s review.', 15_000);
        await ctx.ui.expectText(LIST_ERROR, 15_000);
        await ctx.ui.expectText('Flux · couldn’t load today’s sets', 15_000);
        await ctx.ui.expectText('Finances · couldn’t load', 15_000);
        await absent(ctx, /No habits yet/);
        await absent(ctx, /Nothing logged yet/);
        await ctx.shot('night-failed');
        for (const i of off) await i.release();
      },
    },
    {
      id: 'recurring',
      entry: 'ui',
      proves: ['recurring-failed'],
      title: 'listSeries failing says so on the Recurring lens',
      async run(ctx) {
        const i = await ctx.intercept('listSeries');
        await ctx.ui.goto('/tasks?lens=recurring');
        await ctx.ui.expectText(LIST_ERROR, 15_000);
        await absent(ctx, 'No recurring tasks yet.');
        await i.release();
      },
    },
    {
      id: 'calibration',
      entry: 'ui',
      proves: ['calibration-failed'],
      title: 'getCalibration failing says so on the Calibration lens',
      async run(ctx) {
        const i = await ctx.intercept('getCalibration');
        await ctx.ui.goto('/tasks?lens=calibration');
        await ctx.ui.expectText(LIST_ERROR, 15_000);
        await absent(ctx, /No finished tasks with an estimate yet/);
        await i.release();
      },
    },
    {
      id: 'add-to-today',
      entry: 'ui',
      proves: ['add-to-today-failed'],
      title: 'Add to today with listTasks failing says so',
      async run(ctx) {
        const i = await ctx.intercept('listTasks');
        await ctx.ui.goto('/');
        await button(ctx, 'Morning').click();
        await button(ctx, 'Add to today').click();
        await ctx.ui.expectText('Couldn’t load your tasks.', 15_000);
        await absent(ctx, /Nothing waiting/);
        await ctx.shot('add-to-today-failed');
        await ctx.page.keyboard.press('Escape');
        await i.release();
      },
    },
    {
      id: 'bulk-add',
      entry: 'ui',
      proves: ['bulk-add-failed'],
      title: 'Bulk add with a #label and categories failing says so and stays blocked',
      async run(ctx) {
        const i = await ctx.intercept('listCategories');
        await ctx.ui.goto('/tasks');
        await button(ctx, /Bulk add/).click();
        await ctx.page.getByLabel('Tasks, one per line').fill('write memo | #Admin');
        await ctx.ui.expectText(/Couldn.t load categories — remove the #labels/, 15_000);
        const add = ctx.page
          .getByRole('dialog', { name: 'Bulk add tasks' })
          .getByRole('button', { name: /^Add \d+ task/ })
          .first();
        if (!(await add.isDisabled())) throw new Error('Add is enabled');
        await ctx.page.keyboard.press('Escape');
        await i.release();
      },
    },
    {
      id: 'adopt',
      entry: 'ui',
      proves: ['adopt-error'],
      title: 'listRunningSessions failing → “Couldn’t check for running timers”',
      async run(ctx) {
        await clearTimers(ctx);
        const i = await ctx.intercept('listRunningSessions');
        await ctx.ui.goto('/settings');
        await ctx.ui.expectText('Couldn’t check for running timers.', 15_000);
        await ctx.shot('adopt-failed');
        await i.release();
      },
    },
    {
      id: 'adopt-retry',
      entry: 'ui',
      proves: ['adopt-retry'],
      title: 'Retry on the timer row clears it',
      async run(ctx) {
        await button(ctx, 'Retry').click();
        await gone(ctx, 'Couldn’t check for running timers.');
      },
    },
    {
      id: 'start-fails',
      entry: 'ui',
      proves: ['start-fails'],
      title: 'A focus start that fails says so',
      async run(ctx) {
        const i = await ctx.intercept('startSession');
        await ctx.page.locator(FOCUS).first().click();
        await ctx.ui.expectText('Couldn’t start the timer — try again.', 15_000);
        await i.release();
      },
    },
    {
      id: 'start',
      entry: 'ui',
      title: 'Start a focus',
      async run(ctx) {
        await ctx.ui.goto('/tasks?lens=backlog');
        await ctx.page.locator(FOCUS).first().click();
        await button(ctx, 'Pause').waitFor({ timeout: 15_000 });
      },
    },
    {
      id: 'background',
      entry: 'ui',
      proves: ['keeps-data', 'heartbeat-fails'],
      title:
        'Heartbeats and a stale categories refetch fail for 32 s: “not syncing”, categories kept',
      async run(ctx) {
        const beats = await ctx.intercept('heartbeatSession');
        const cats = await ctx.intercept('listCategories');
        await wait(32_000); // two beats (15 s apart) and past the 30 s staleTime
        await ctx.page.getByRole('link', { name: 'Settings', exact: true }).first().click(); // in-app: refetch on mount
        await ctx.ui.expectText('not syncing', 5_000);
        await until('the failed categories refetch', () => cats.hits() >= 3, 10_000);
        await wait(SETTLE_MS);
        await absent(ctx, 'Couldn’t load categories.');
        await ctx.shot('not-syncing');
        // Each failed beat is 3 sends (the http client retries a 429 twice).
        if (beats.hits() < 6)
          throw new Error(`expected 2 failed heartbeats, saw ${beats.hits()} sends`);
        await beats.release();
        await cats.release();
        await gone(ctx, 'not syncing', 20_000);
      },
    },
    {
      id: 'resume',
      entry: 'ui',
      proves: ['resume-fails'],
      title: 'A failed resume stays paused and says so; Resume again works',
      async run(ctx) {
        await button(ctx, 'Pause').click();
        const i = await ctx.intercept('resumeSession');
        try {
          await button(ctx, 'Resume').click();
          await ctx.ui.expectText('Couldn’t resume — try again.', 15_000);
          await button(ctx, 'Resume').waitFor({ timeout: 2_000 });
        } finally {
          await i.release();
        }
        await button(ctx, 'Resume').click();
        await button(ctx, 'Pause').waitFor({ timeout: 15_000 });
      },
    },
    {
      id: 'stop',
      entry: 'ui',
      proves: ['stop-fails', 'paused-stop'],
      title: 'A failed stop keeps the timer and says so; then paused 20 s, Stop ends it',
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
      proves: ['stop-fails', 'paused-stop'],
      title: 'No timer left running, and the stopped one wasn’t credited its 20 s pause',
      async run(ctx) {
        const left = await ctx.api.reads.listRunningSessions();
        if (left.length) throw new Error(`${left.length} timer(s) still running on the test user`);
        const done = (await ctx.api.reads.listSessionsForDay(ctx.dates.today))
          .filter((x) => x.status === 'completed' && x.endedAt !== null)
          .sort((a, b) => b.endedAt! - a.endedAt!)[0];
        if (!done) throw new Error('the stopped timer is not in today’s sessions');
        const wallSec = (done.endedAt! - done.startedAt) / 1000;
        const creditedSec = done.activeMinutes * 60;
        // The run paused it twice (the resume step, then PAUSE_MS here): credit must fall short of the wall
        // clock by at least the last pause, less a heartbeat's worth of slack.
        if (creditedSec > wallSec - PAUSE_MS / 1000 + 5)
          throw new Error(
            `credited ${creditedSec.toFixed(1)} s of a ${wallSec.toFixed(1)} s timer`,
          );
      },
    },
    noConsoleErrors,
  ],
};
