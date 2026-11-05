// A task finished while its focus timer runs keeps the actual that was typed (01M4959BWYBF4KAAQ01ZZZEW4P):
// Mark done and a done split stop this task's timer first, and the server adds a closing session's minutes
// only to a task still open (accruesTime), so MCP's complete_task under a phone timer can't be double-counted
// either. Titles use `devcheck-tc <nonce>` — the parts scenarios sweep `devcheck <nonce>`. One timer runs at a
// time after the first step, so the bar's bare Stop is this run's. The capped-heartbeat task adds its rows here.
import type { DevSession } from '../api';
import { laDay, noConsoleErrors, type Ctx, type Scenario } from '../scenario';
import { clearTimers } from './failed-reads';

const name = (ctx: Ctx, what: string) => `devcheck-tc ${ctx.nonce} ${what}`;
const STOP_FAILED = 'Couldn’t mark it done — try again.';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dialogOf = (ctx: Ctx, title: string) =>
  ctx.page.getByRole('dialog', { name: `Task: ${title}` });

async function mine(ctx: Ctx, what: string) {
  const t = (await ctx.api.reads.listTasks()).find((x) => x.title === name(ctx, what));
  if (!t) throw new Error(`${what}: not on the server`);
  return t;
}

async function untilRunning(ctx: Ctx, n: number, what: string) {
  for (let i = 0; (await ctx.api.reads.listRunningSessions()).length !== n; i++) {
    if (i >= 40) throw new Error(`${what}: the server never listed ${n} running timer(s)`);
    await wait(250);
  }
}

// The task's row on the Backlog lens, searched down to it: the row stays where it is after Start.
async function rowOf(ctx: Ctx, title: string) {
  await ctx.ui.goto('/tasks?lens=backlog');
  await ctx.page.getByLabel('Search tasks').fill(title);
  const open = ctx.page.getByRole('button', { name: title, exact: true });
  await open.waitFor({ timeout: 15_000 });
  return open;
}

// Start from the row, then its Focus: the row's own, found from its title button (the idle dock's Focus
// has the same name while nothing runs). Resolves once the server lists one more running timer.
async function startAndFocus(ctx: Ctx, what: string) {
  const title = name(ctx, what);
  const before = (await ctx.api.reads.listRunningSessions()).length;
  await rowOf(ctx, title);
  const start = ctx.page.getByRole('button', { name: 'Start', exact: true });
  const starts = await start.count();
  if (starts !== 1) throw new Error(`search left ${starts} Start buttons, not this task’s one`);
  await start.click();
  const { id } = await mine(ctx, what);
  for (let i = 0; (await ctx.api.reads.getTask(id))?.status !== 'in_progress'; i++) {
    if (i >= 40) throw new Error(`${what}: Start never reached the server`);
    await wait(250);
  }
  const row = ctx.page
    .getByRole('button', { name: title, exact: true })
    .locator('xpath=ancestor::*[.//button[normalize-space()="Done"]][1]');
  await row.getByRole('button', { name: 'Focus', exact: true }).click();
  await untilRunning(ctx, before + 1, what);
  return id;
}

// The modal, from the row the search is already down to — it holds the Done form and Split.
async function openTask(ctx: Ctx, what: string) {
  const title = name(ctx, what);
  await ctx.page.getByRole('button', { name: title, exact: true }).click();
  const dialog = dialogOf(ctx, title);
  await dialog.getByLabel('Actual (min)').waitFor({ timeout: 10_000 });
  return dialog;
}

const stopButton = (ctx: Ctx) => ctx.page.getByRole('button', { name: 'Stop', exact: true });

// This run's completed sessions on the app's day (and the day before, for a run across the day start).
const isCompleted = (x: DevSession) => x.status === 'completed' && x.endedAt !== null;
async function completedAround(ctx: Ctx): Promise<DevSession[]> {
  const { dayStartHour } = await ctx.api.reads.getSettings();
  const now = Date.now() - dayStartHour * 3_600_000;
  const days = [laDay(new Date(now)), laDay(new Date(now - 86_400_000))];
  return (await Promise.all(days.map((d) => ctx.api.reads.listSessionsForDay(d))))
    .flat()
    .filter(isCompleted);
}
// The one session a Stop just completed: new since `before`, newest first.
async function justStopped(ctx: Ctx, before: Set<string>): Promise<DevSession> {
  const mine = (await completedAround(ctx))
    .filter((x) => !before.has(x.id))
    .sort((a, b) => b.endedAt! - a.endedAt!)[0];
  if (!mine) throw new Error('the stopped timer is not among the completed sessions');
  return mine;
}

export const timerCredit: Scenario = {
  id: 'timer-credit',
  title: 'A task finished under a running timer keeps the actual that was typed',
  tiers: ['full'],
  rows: [
    {
      id: 'done-stops-timer',
      entry: 'ui',
      kind: 'nominal',
      what: 'Mark done with a timer running stops it; the typed actual stands, on reload too',
    },
    {
      id: 'neighbour-keeps',
      entry: 'ui',
      kind: 'edge',
      what: 'A second timer on another task keeps running and still accrues to its own task',
    },
    {
      id: 'split-done-stops-timer',
      entry: 'ui',
      kind: 'edge',
      what: 'A done split with a timer running stops it; this part keeps the typed actual, the follow-up starts at zero',
    },
    {
      id: 'stop-fails',
      entry: 'ui',
      kind: 'edge',
      what: 'A stop that fails keeps the form, the timer and the task in progress; Mark done again finishes it',
    },
    {
      id: 'mcp-complete-then-stop',
      entry: 'mcp',
      kind: 'edge',
      what: 'complete_task while a timer runs, then Stop in the app: the actual stays what complete_task set',
    },
    {
      id: 'stop-onto-cancelled',
      entry: 'api',
      kind: 'edge',
      what: 'A stop onto a cancelled task adds nothing to it',
      offDev: {
        file: 'lambdas/src/backend.test.ts',
        test: 'a stop onto a finished task completes with its minutes but adds none to the task',
        why: 'same path as mcp-complete-then-stop (proven on dev): the same stopSession call and guard (accruesTime); what differs is the finished status, a pure server decision the test drives over the real RPC in node. The shared contract suite runs the same case against the stub',
      },
    },
    {
      id: 'done-stop',
      entry: 'ui',
      kind: 'nominal',
      what: 'A block that reached Done and sat there credits exactly its length, not the wait before Stop',
    },
    {
      id: 'neighbour-full-credit',
      entry: 'ui',
      kind: 'edge',
      what: 'A second running timer keeps beating meanwhile and its stop credits its whole run',
    },
    {
      id: 'extend-on-done',
      entry: 'ui',
      kind: 'edge',
      what: 'Again on a block that reached Done: the wait before it is not credited, the new block counts',
      offDev: {
        file: 'app/src/modules/pomodoro/PomodoroProvider.test.tsx',
        test: 'Again on a done block resets its clock first, so the wait before it is never credited; the new block beats',
        why: 'the wait is the time between Done and Again, which on dev would be a second 1-minute block plus a held wait on top of done-stop (another ~80 s of the slow row); the fake-timer test drives the minutes and the beat loop directly, and done-stop already proves the capped credit on the wire',
      },
    },
    {
      id: 'bad-cap',
      entry: 'api',
      kind: 'edge',
      what: 'A negative capMin is refused and the session keeps running',
      offDev: {
        file: 'lambdas/src/backend.test.ts',
        test: 'a negative capMin is refused over RPC and the session keeps running',
        why: 'the app never sends a bad cap (stopCapMin is never negative), so only a hand-made call reaches this; the test drives it over the real RPC in node',
      },
    },
    {
      id: 'keep-stale-onto-cancelled',
      entry: 'api',
      kind: 'edge',
      what: 'Keeping a timer left running (found stale on the next open) onto a cancelled task adds nothing to it',
      offDev: {
        file: 'lambdas/src/backend.test.ts',
        test: 'keeping a stale timer onto a finished task completes it with its minutes but adds none',
        why: 'a stale timer needs 90 s of silence from the page (STALE_MS), which dev can’t produce on demand without a 90 s wait; the test drives resolveStaleSession over the real RPC in node',
      },
    },
  ],
  steps: [
    {
      id: 'setup',
      entry: 'api',
      title: 'Five backlog tasks — four for the app, one for MCP',
      async run(ctx) {
        for (const [what, estimateMin] of [
          ['done', 15],
          ['nb', 15],
          ['split', 45],
          ['fail', 15],
          ['cap', 15],
          ['nb2', 15],
        ] as const)
          await ctx.api.writes.createTask({ title: name(ctx, what), estimateMin });
        await ctx.mcp.writes.createTask({ title: name(ctx, 'mcp'), estimateMin: 10 });
      },
    },
    {
      id: 'done',
      entry: 'ui',
      proves: ['done-stops-timer', 'neighbour-keeps'],
      title: 'Two timers; Mark done on one with 30 typed — its timer goes, the other keeps accruing',
      async run(ctx) {
        await clearTimers(ctx);
        const nb = await startAndFocus(ctx, 'nb');
        const id = await startAndFocus(ctx, 'done');
        const dialog = await openTask(ctx, 'done');
        await ctx.shot('done-form-timer-running');
        await dialog.getByLabel('Actual (min)').fill('30');
        await dialog.getByRole('button', { name: 'Mark done' }).click();
        await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
        const t = await ctx.api.reads.getTask(id);
        if (t?.status !== 'done' || t.actualAccruedMin !== 30)
          throw new Error(`saved ${JSON.stringify(t)}`);
        await untilRunning(ctx, 1, 'after Mark done');
        // The bar: the neighbour's row only — the done task's title is nowhere (not in the bar, and the
        // lens no longer lists a done task).
        if ((await stopButton(ctx).count()) !== 1) throw new Error('the bar is not down to one timer');
        if (await ctx.page.getByText(name(ctx, 'done'), { exact: true }).count())
          throw new Error('the done task is still on screen (its timer row?)');
        await ctx.shot('after-done-neighbour-runs');
        await ctx.page.reload();
        await stopButton(ctx).waitFor({ timeout: 15_000 }); // the neighbour's timer, adopted again
        if ((await ctx.api.reads.getTask(id))?.actualAccruedMin !== 30)
          throw new Error('the actual changed across the reload');
        // The neighbour: still in progress, and its stop credits it its own seconds.
        await stopButton(ctx).click();
        await untilRunning(ctx, 0, 'stopping the neighbour');
        const other = await ctx.api.reads.getTask(nb);
        if (other?.status !== 'in_progress' || !((other.actualAccruedMin ?? 0) > 0))
          throw new Error(`the neighbour got ${JSON.stringify(other)}`);
        if ((await ctx.api.reads.getTask(id))?.actualAccruedMin !== 30)
          throw new Error('the neighbour’s stop changed the done task');
      },
    },
    {
      id: 'split',
      entry: 'ui',
      proves: ['split-done-stops-timer'],
      title: 'Timer running → Split… → Done with this part, 20 typed → the timer goes, Part 2 starts at 0',
      async run(ctx) {
        const id = await startAndFocus(ctx, 'split');
        const dialog = await openTask(ctx, 'split');
        await dialog.getByRole('button', { name: /^Split/ }).click();
        const actual = dialog.getByLabel("This part's actual (min)");
        await actual.waitFor({ timeout: 10_000 });
        await actual.scrollIntoViewIfNeeded(); // the reveal opens below the modal's fold
        await ctx.shot('split-form-timer-running');
        await actual.fill('20');
        await dialog.getByRole('button', { name: 'Split', exact: true }).click();
        await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
        const t = await ctx.api.reads.getTask(id);
        if (t?.status !== 'done' || t.actualAccruedMin !== 20 || !t.parentId)
          throw new Error(`this part saved ${JSON.stringify(t)}`);
        const followUp = (await ctx.api.reads.listTasks()).find(
          (x) => x.parentId === t.parentId && x.id !== id,
        );
        if (!followUp || followUp.actualAccruedMin !== 0)
          throw new Error(`the follow-up is ${JSON.stringify(followUp)}`);
        await untilRunning(ctx, 0, 'after the done split');
        await ctx.shot('after-split');
      },
    },
    {
      id: 'stop-fails',
      entry: 'ui',
      proves: ['stop-fails'],
      title: 'A failed stop keeps the form and the timer; Mark done again finishes it',
      async run(ctx) {
        const id = await startAndFocus(ctx, 'fail');
        const dialog = await openTask(ctx, 'fail');
        await dialog.getByLabel('Actual (min)').fill('10');
        const i = await ctx.intercept('stopSession');
        try {
          await dialog.getByRole('button', { name: 'Mark done' }).click();
          await ctx.ui.expectText(STOP_FAILED, 15_000);
          if (!(await dialog.isVisible())) throw new Error('the form closed on a failed stop');
          await ctx.shot('stop-failed');
        } finally {
          await i.release();
        }
        const t = await ctx.api.reads.getTask(id);
        if (t?.status !== 'in_progress' || t.actualAccruedMin !== 0)
          throw new Error(`a failed stop changed the task: ${JSON.stringify(t)}`);
        if ((await ctx.api.reads.listRunningSessions()).length !== 1)
          throw new Error('the timer did not survive the failed stop');
        await dialog.getByRole('button', { name: 'Mark done' }).click();
        await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
        await untilRunning(ctx, 0, 'after the second Mark done');
        const done = await ctx.api.reads.getTask(id);
        if (done?.status !== 'done' || done.actualAccruedMin !== 10)
          throw new Error(`saved ${JSON.stringify(done)}`);
      },
    },
    {
      id: 'mcp-start',
      entry: 'ui',
      title: 'Start and focus the MCP task in the app',
      async run(ctx) {
        await startAndFocus(ctx, 'mcp');
      },
    },
    {
      id: 'mcp-complete',
      entry: 'mcp',
      proves: ['mcp-complete-then-stop'],
      title: 'complete_task {actualMin: 20} while the timer runs',
      async run(ctx) {
        const { id } = await mine(ctx, 'mcp');
        const { task } = await ctx.mcp.writes.completeTask(id, 20);
        if (task.status !== 'done' || task.actualAccruedMin !== 20)
          throw new Error(`complete_task returned ${JSON.stringify(task)}`);
        if ((await ctx.api.reads.listRunningSessions()).length !== 1)
          throw new Error('complete_task touched the running timer');
      },
    },
    {
      id: 'mcp-stop',
      entry: 'ui',
      proves: ['mcp-complete-then-stop'],
      title: 'Stop the timer in the app: the actual stays 20',
      async run(ctx) {
        const { id } = await mine(ctx, 'mcp');
        await ctx.ui.goto('/tasks');
        await stopButton(ctx).waitFor({ timeout: 15_000 });
        await ctx.shot('mcp-done-timer-still-running');
        await stopButton(ctx).click();
        await untilRunning(ctx, 0, 'stopping onto the MCP-finished task');
        const t = await ctx.api.reads.getTask(id);
        if (t?.status !== 'done' || t.actualAccruedMin !== 20)
          throw new Error(`the stop changed it: ${JSON.stringify(t)}`);
      },
    },
    {
      id: 'done-stop',
      entry: 'ui',
      proves: ['done-stop', 'neighbour-full-credit'],
      title: '1-minute block → Done → a second timer starts → 15 s → Stop the done one (credit ≤ 1.05), then the other (credited in full)',
      async run(ctx) {
        const settings = await ctx.api.reads.getSettings();
        await ctx.api.writes.updateSettings({ pomodoroWorkMin: 1 });
        try {
          await startAndFocus(ctx, 'cap'); // a fresh page load, so the 1-minute target is in effect
          const again = ctx.page.getByRole('button', { name: 'Again', exact: true });
          await again.waitFor({ timeout: 90_000 }); // the block reached Done
          const doneAt = Date.now();
          await startAndFocus(ctx, 'nb2');
          const nbStartedAt = Date.now();
          await wait(Math.max(0, 15_000 - (Date.now() - doneAt))); // sit on Done 15 s in all
          await ctx.shot('done-held-and-neighbour');
          const before = new Set((await completedAround(ctx)).map((x) => x.id));
          // The done row's Stop, not the neighbour's: scoped to the row that holds Again.
          await ctx.page
            .getByRole('button', { name: 'Again', exact: true })
            .locator('xpath=ancestor::*[.//button[normalize-space()="Stop"]][1]')
            .getByRole('button', { name: 'Stop', exact: true })
            .click();
          await untilRunning(ctx, 1, 'stopping the done block');
          const capped = await justStopped(ctx, before);
          if (capped.activeMinutes > 1.05 || capped.activeMinutes < 0.9)
            throw new Error(`the done block credited ${capped.activeMinutes} min, not ~1`);
          // The neighbour ran on: its stop credits its whole run, no cap.
          const before2 = new Set((await completedAround(ctx)).map((x) => x.id));
          await stopButton(ctx).click();
          await untilRunning(ctx, 0, 'stopping the neighbour');
          const ran = (Date.now() - nbStartedAt) / 60_000;
          const nb = await justStopped(ctx, before2);
          if (nb.activeMinutes < ran - 0.1 || nb.activeMinutes > ran + 0.05)
            throw new Error(`the neighbour credited ${nb.activeMinutes} min for a ${ran.toFixed(2)} min run`);
        } finally {
          await ctx.api.writes.updateSettings({ pomodoroWorkMin: settings.pomodoroWorkMin });
        }
      },
    },
    {
      id: 'clear-search',
      entry: 'ui',
      title: 'Clear the /tasks search, so the scenarios after start unfiltered',
      async run(ctx) {
        await ctx.page.getByLabel('Search tasks').fill('');
      },
    },
    noConsoleErrors,
  ],
};
