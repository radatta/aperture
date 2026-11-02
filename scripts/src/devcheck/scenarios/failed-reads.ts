// A failed read never fails silently (docs/product/CONVENTIONS.md → Failed reads). The harness fails dev's
// /api/<method> itself (ctx.intercept, a Playwright route — nothing in the app switches) and checks the screen
// says so instead of an empty list or a default, that Retry recovers, and that a 429 is retried away.
import { noConsoleErrors, type Ctx, type Scenario } from '../scenario';

const CATEGORIES_LINE = /Couldn.t load categories — labels and category filters are off/;
const FOCUS = '[title="Start a 25-minute focus block"]';
const title = (nonce: string) => `devcheck-fr ${nonce}`;

const button = (ctx: Ctx, name: string) =>
  ctx.page.getByRole('button', { name, exact: true }).first();
const gone = (ctx: Ctx, text: string | RegExp, timeout = 10_000) =>
  ctx.page.getByText(text).first().waitFor({ state: 'hidden', timeout });
async function absent(ctx: Ctx, text: string | RegExp) {
  if (await ctx.page.getByText(text).count()) throw new Error(`"${String(text)}" is on screen`);
}
async function until(what: string, ok: () => boolean, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A run that died mid-timer leaves one running (or stale) on the test user; clear it through the dock first,
// so this run's Pause/Stop are its own. Timers live only in the test user's partition.
async function clearTimers(ctx: Ctx) {
  await ctx.ui.goto('/settings');
  for (let i = 0; i < 6; i++) {
    if (await ctx.page.locator(FOCUS).count()) return;
    const discard = button(ctx, 'Discard');
    const stop = button(ctx, 'Stop');
    if (await discard.isVisible()) await discard.click();
    else if (await stop.isVisible()) await stop.click();
    await wait(1_000);
  }
  throw new Error('a timer left running on the test user would not clear');
}

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
      what: 'Categories keep failing → Tasks says “Couldn’t load categories” with Retry, never an empty roster',
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
      what: 'A dropped connection on the read shows the same line',
    },
    {
      id: 'write-429-retried',
      entry: 'ui',
      kind: 'nominal',
      what: 'A capture whose createTask gets one 429 still lands (“Task added”)',
    },
    {
      id: 'settings-fails',
      entry: 'ui',
      kind: 'edge',
      what: 'Settings failing says “running on defaults”, survives a reload, and Retry clears it',
    },
    {
      id: 'home-no-lies',
      entry: 'ui',
      kind: 'nominal',
      what: 'Night Home with habits and the log failing says couldn’t load, not “No habits yet” / “Nothing logged yet”',
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
      id: 'stop-fails',
      entry: 'ui',
      kind: 'edge',
      what: 'A stop that fails keeps the timer and says “Couldn’t stop”; Stop again ends it on the server',
    },
    {
      id: 'write-5xx-not-retried',
      entry: 'ui',
      kind: 'edge',
      what: 'A write that gets a 500 or a dropped connection is never sent twice',
      offDev: {
        file: 'app/src/data/httpClient.test.ts',
        test: 'never retries a write on a 500 or a dropped connection — it may have landed',
        why: 'proving it on dev means counting requests the server may have run — a duplicate task is the failure',
      },
    },
    {
      id: 'refusal-not-retried',
      entry: 'ui',
      kind: 'edge',
      what: 'A 400 refusal or a 401 shows at once, without retrying',
      offDev: {
        file: 'app/src/data/retry.test.ts',
        test: 'does not retry a 400 refusal, a 401, a 404 or a plain Error at the query layer',
        why: 'dev’s refusals are task-state 400s on writes, not reads; the policy is a pure function',
      },
    },
    {
      id: 'mutation-not-retried',
      entry: 'ui',
      kind: 'edge',
      what: 'The query layer never retries a write',
      offDev: {
        file: 'app/src/data/retry.test.ts',
        test: 'the app QueryClient wires the policy and leaves mutations un-retried',
        why: 'a config fact of the client, not a behaviour dev can show',
      },
    },
    {
      id: 'ios-offline',
      entry: 'ios',
      kind: 'edge',
      what: 'Airplane mode on the iPhone PWA shows inline errors, not blank cards',
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
        await ctx.ui.goto('/tasks?lens=backlog');
        await until('the retried categories read', () => i.passed() >= 1);
        await wait(1_000);
        await absent(ctx, CATEGORIES_LINE);
        if (i.hits() !== 1) throw new Error(`expected 1 injected 429, got ${i.hits()}`);
        await i.release();
      },
    },
    {
      id: 'shown',
      entry: 'ui',
      proves: ['error-shown'],
      title: 'listCategories keeps failing → the line, with Retry',
      async run(ctx) {
        const i = await ctx.intercept('listCategories');
        await ctx.ui.goto('/tasks?lens=backlog');
        await ctx.ui.expectText(CATEGORIES_LINE, 15_000);
        if (i.hits() < 3) throw new Error(`expected 3 tries (1 + 2 retries), saw ${i.hits()}`);
        await ctx.shot('categories-failed');
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
        await gone(ctx, CATEGORIES_LINE);
      },
    },
    {
      id: 'aborted',
      entry: 'ui',
      proves: ['network-error'],
      title: 'A dropped connection shows the same line',
      async run(ctx) {
        const i = await ctx.intercept('listCategories', { abort: true });
        await ctx.ui.goto('/tasks?lens=backlog');
        await ctx.ui.expectText(CATEGORIES_LINE, 15_000);
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
      id: 'settings',
      entry: 'ui',
      proves: ['settings-fails'],
      title: 'getSettings failing → “running on defaults”, after a reload too, then Retry',
      async run(ctx) {
        const i = await ctx.intercept('getSettings');
        await ctx.ui.goto('/settings');
        await ctx.ui.expectText(/running on defaults/, 15_000);
        await ctx.ui.expectText(/Couldn.t load your settings — calendar, preferences/);
        await ctx.page.reload({ waitUntil: 'domcontentloaded' });
        await ctx.ui.expectText(/running on defaults/, 15_000);
        await ctx.shot('settings-failed');
        await i.release();
        await button(ctx, 'Retry').click();
        await gone(ctx, /running on defaults/);
      },
    },
    {
      id: 'home',
      entry: 'ui',
      proves: ['home-no-lies'],
      title: 'Night Home with habits and the log failing says couldn’t load',
      async run(ctx) {
        const habits = await ctx.intercept('listHabits');
        const log = await ctx.intercept('listLogEntries');
        await ctx.ui.goto('/');
        await button(ctx, 'Night').click();
        await ctx.ui.expectText('Couldn’t load today’s review.', 15_000);
        await ctx.ui.expectText(/Couldn.t load this\. Check your connection/, 15_000);
        await absent(ctx, /No habits yet/);
        await absent(ctx, /Nothing logged yet/);
        await ctx.shot('night-failed');
        await habits.release();
        await log.release();
      },
    },
    {
      id: 'adopt',
      entry: 'ui',
      proves: ['adopt-error'],
      title: 'listRunningSessions failing → “Couldn’t check for running timers”',
      async run(ctx) {
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
      id: 'start',
      entry: 'ui',
      title: 'Start a focus (leftover timers cleared first)',
      async run(ctx) {
        await clearTimers(ctx);
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
        await absent(ctx, 'Couldn’t load categories.');
        await ctx.shot('not-syncing');
        if (beats.hits() < 2) throw new Error(`expected 2 failed heartbeats, saw ${beats.hits()}`);
        await beats.release();
        await cats.release();
        await gone(ctx, 'not syncing', 20_000);
      },
    },
    {
      id: 'stop',
      entry: 'ui',
      proves: ['stop-fails'],
      title: 'A failed stop keeps the timer and says so; Stop again ends it',
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
        await button(ctx, 'Stop').click();
        await ctx.page.locator(FOCUS).first().waitFor({ timeout: 15_000 });
      },
    },
    {
      id: 'no-timer-left',
      entry: 'api',
      proves: ['stop-fails'],
      title: 'The server has no running timer left',
      async run(ctx) {
        const left = await ctx.api.reads.listRunningSessions();
        if (left.length) throw new Error(`${left.length} timer(s) still running on the test user`);
      },
    },
    noConsoleErrors,
  ],
};
