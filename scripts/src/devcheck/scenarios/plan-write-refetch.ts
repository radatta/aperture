// One plan write, one refetch (lenses.md D5, 01M38GBZ6SYT21KV0GP2QXCW4M) and the night "Backlog" on a started
// task (D8, 01M38GBZ6SYT21KV0GP2QXCW4J). Dev proves the ceiling the deployed bundle holds — the /api calls a
// "+ Today" and an Unplan put on the wire, counted from the page's own requests — and the night row's order
// against the real server: the timer's stop lands first, and when the unplan then fails (removePlan 500,
// injected by the harness) the stopped minutes stay, a fresh timer runs, and the row is back. The exact refetch
// counts are the hook test's. Tasks come from the API (ledgered); the two timers are stopped by the rows
// themselves. The last step deletes the tasks so later scenarios find the Backlog as they left it (day-guards
// does the same); a failed step skips it, and a timer left running is then timer-credit's clearTimers to clear.
import type { DevSession, DevTask } from '../api';
import type { PwRequest, PwResponse } from '../pw-types';
import { datesFor, noConsoleErrors, type Ctx, type Scenario } from '../scenario';

const name = (ctx: Ctx, what: string) => `devcheck-pw ${ctx.nonce} ${what}`;
const SAVE_FAILED = 'Couldn’t save that — try again.';
const made: Record<string, DevTask> = {}; // scenario-scoped, set by setup
let firstTimer: DevSession | undefined; // S2's timer before the failed unplan

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => Promise<boolean> | boolean, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(250);
  }
}
async function days(ctx: Ctx) {
  const { dayStartHour } = await ctx.api.reads.getSettings();
  return datesFor(new Date(Date.now() - dayStartHour * 3_600_000));
}
const rowsOf = async (ctx: Ctx, day: string, task: DevTask) =>
  (await ctx.api.reads.listPlansForDay(day)).filter((p) => p.taskId === task.id);
const statusOf = async (ctx: Ctx, task: DevTask) => (await ctx.api.reads.getTask(task.id))?.status;
const runningOn = async (ctx: Ctx, task: DevTask) =>
  (await ctx.api.reads.listRunningSessions()).filter((s) => s.taskId === task.id);

// Served /api reads by method (200 responses, so a 429 the client retries counts once), from `arm()` until the
// wire has been quiet for `quietMs`. The page's load burst — useDay's cascade refetches tasks and plans after
// getDay lands — must be over before arming, so `quiet()` first, then `arm()`, then the tap.
function countApi(ctx: Ctx) {
  const counts: Record<string, number> = {};
  let last = Date.now();
  let armed = false;
  const methodOf = (url: string) => {
    const path = new URL(url).pathname;
    return path.startsWith('/api/') ? path.slice('/api/'.length) : null;
  };
  const requested = (r: PwRequest) => {
    if (methodOf(r.url())) last = Date.now();
  };
  const responded = (res: PwResponse) => {
    const method = methodOf(res.url());
    if (!method) return;
    last = Date.now();
    if (armed && res.status() === 200) counts[method] = (counts[method] ?? 0) + 1;
  };
  ctx.page.on('request', requested);
  ctx.page.on('response', responded);
  const quiet = (quietMs: number) =>
    until('the wire to go quiet', () => Date.now() - last > quietMs, 20_000);
  return {
    quiet: (quietMs = 1_500) => quiet(quietMs),
    arm() {
      armed = true;
    },
    async settle(quietMs = 1_500) {
      try {
        await quiet(quietMs);
      } finally {
        ctx.page.off('request', requested);
        ctx.page.off('response', responded);
      }
      ctx.log(`/api reads served: ${JSON.stringify(counts)}`);
      return (method: string) => counts[method] ?? 0;
    },
  };
}

// The Backlog lens with this run's group open: COLLAPSE_AT (8) uncategorised tasks start it collapsed, and the
// header reads "NO CATEGORY · n" (CSS-uppercased; the accessible name follows).
async function openBacklog(ctx: Ctx) {
  await ctx.ui.goto('/tasks?lens=backlog');
  const header = ctx.page.getByRole('button', { name: /^no category · /i });
  await header.waitFor({ state: 'visible', timeout: 15_000 });
  if ((await header.getAttribute('aria-expanded')) === 'false') await header.click();
}
const addButton = (ctx: Ctx, task: DevTask) =>
  ctx.page.getByRole('button', { name: `Add ${task.title} to today` });
// A Today-lens row's Unplan: the card whose title button is this task's.
const unplanButton = (ctx: Ctx, task: DevTask) =>
  ctx.page
    .getByRole('button', { name: task.title, exact: true })
    .locator('xpath=ancestor::*[.//button[normalize-space()="Unplan"]][1]')
    .getByRole('button', { name: 'Unplan', exact: true });
const nightRow = (ctx: Ctx, task: DevTask) => ctx.page.getByRole('group', { name: task.title });
async function openNight(ctx: Ctx) {
  await ctx.ui.goto('/');
  await ctx.page.getByRole('button', { name: 'Night', exact: true }).click();
  await ctx.ui.expectText('Still open — when?', 15_000);
}
async function onceOnToday(ctx: Ctx, task: DevTask, when: string) {
  await ctx.ui.goto('/tasks');
  await ctx.ui.expectText(task.title, 15_000);
  const n = await ctx.page.getByText(task.title, { exact: true }).count();
  if (n !== 1) throw new Error(`${when}: Today shows ${task.title} ${n} times`);
}

export const planWriteRefetch: Scenario = {
  id: 'plan-write-refetch',
  title: 'One plan write, one refetch; night Backlog stops the timer first',
  tiers: ['full'],
  rows: [
    {
      id: 'add-once',
      entry: 'ui',
      kind: 'nominal',
      what: 'Backlog “+ Today” → on Today once, reload once; on the wire ≤1 listTasks, ≤3 listPlansForDay, 0 getDay',
    },
    {
      id: 'add-already',
      entry: 'ui',
      kind: 'edge',
      what: '“+ Today” on a task the API planned a moment earlier → Today shows it once, status planned, one row',
    },
    {
      id: 'unplan-row',
      entry: 'ui',
      kind: 'edge',
      what: 'Unplan → back in the Backlog after exactly one getDay; reload same; no row, status backlog',
    },
    {
      id: 'due-heals',
      entry: 'ui',
      kind: 'edge',
      what: 'The editor gives a planned task a time → it stays on Today by its time and the day refetch sweeps its status to backlog; reload same',
    },
    {
      id: 'night-lists',
      entry: 'ui',
      kind: 'nominal',
      what: 'Night: Tomorrow on one row, Backlog on another → both leave, no stale row; tomorrow has the first, the second is backlog',
    },
    {
      id: 'neighbour',
      entry: 'api',
      kind: 'edge',
      what: 'A second planned row keeps its order, minutes and status through the add and the unplan',
    },
    {
      id: 'promote-focus',
      entry: 'ui',
      kind: 'edge',
      what: 'Focus on an “Also today” row promotes it: several plan rows written at once, each replaced in place in today’s list',
      offDev: {
        file: 'app/src/data/hooks/usePlans.test.tsx',
        test: 'an upsert by id replaces the row in place; a remove drops it; each refetches once',
        why: 'same path as add-once (proven on dev): the same upsertPlan write-through and plans refetch; what differs — several rows at once, each replaced by id — runs entirely in the named test',
      },
    },
    {
      id: 'counts-exact',
      entry: 'ui',
      kind: 'edge',
      what: 'The exact reads per add (1 listTasks, 3 listPlansForDay, 0 getDay) and per unplan (1, 2, 1)',
      offDev: {
        file: 'app/src/data/hooks/useAddToDay.test.tsx',
        test: 'one add refetches tasks once and the day never',
        why: 'dev proves the ceiling from the wire (add-once, unplan-row); the number is the hook’s own, counted with the Tasks page’s queries mounted over the stub',
      },
    },
    {
      id: 'stop-then-unplan',
      entry: 'ui',
      kind: 'nominal',
      what: 'Night Backlog on a started task with a running timer → the timer is gone, the session completed with its minutes on the task, the task backlog; reload: row gone',
    },
    {
      id: 'no-timer',
      entry: 'ui',
      kind: 'edge',
      what: 'Night Backlog on a started task with no timer → backlog, row gone',
    },
    {
      id: 'unplan-fails',
      entry: 'ui',
      kind: 'edge',
      what: 'removePlan fails once → the stopped minutes stay, a fresh timer runs on the task, status in progress, the row stays and says so; tap again → backlog, no timer',
    },
    {
      id: 'neighbour-timer',
      entry: 'ui',
      kind: 'edge',
      what: 'Another row’s running timer keeps running through the first row’s Backlog',
    },
    {
      id: 'restart-refused',
      entry: 'ui',
      kind: 'edge',
      what: 'The restart after a failed unplan is refused too → the row’s error line shows and the dock reports its own',
      offDev: {
        file: 'app/src/modules/pomodoro/PomodoroProvider.test.tsx',
        test: 'startFocus resolves false and sets startError when the server refuses',
        why: 'two injected failures on one tap: dev’s intercept fails a method, not the second call of a chain; the restart’s own answer is the provider’s contract and its test drives it',
      },
    },
    {
      id: 'busy-disabled',
      entry: 'ui',
      kind: 'edge',
      what: 'The row’s buttons are disabled while its unplan is out',
      offDev: {
        file: 'app/src/pages/Home/Night.test.tsx',
        test: 'Backlog on a started task with a running timer stops it, then unplans; a failed unplan restarts the timer and says so',
        why: 'the window is the write’s round trip; only the stub can hold it open long enough to assert — dev’s is milliseconds',
      },
    },
  ],
  steps: [
    {
      id: 'setup',
      entry: 'api',
      title:
        'Tasks (API): A to add, U to add after the API plans it, N the neighbour, P for a time, T for Tomorrow, S1–S3 started (timers on S1, S2)',
      async run(ctx) {
        const { today } = await days(ctx);
        for (const what of ['A', 'U', 'N', 'P', 'T', 'S1', 'S2', 'S3'])
          made[what] = await ctx.api.writes.createTask({ title: name(ctx, what), estimateMin: 15 });
        let order = 0;
        for (const what of ['N', 'P', 'T', 'S1', 'S2', 'S3'])
          await ctx.api.writes.upsertPlan({
            taskId: made[what]!.id,
            day: today,
            plannedMinutes: 15,
            order: order++,
          });
        for (const what of ['N', 'P', 'T'])
          await ctx.api.writes.transitionTask(made[what]!.id, 'planned');
        for (const what of ['S1', 'S2', 'S3'])
          await ctx.api.writes.transitionTask(made[what]!.id, 'in_progress');
        await ctx.api.writes.startSession(made.S1!.id, today);
        firstTimer = await ctx.api.writes.startSession(made.S2!.id, today);
      },
    },
    {
      id: 'add-once',
      entry: 'ui',
      proves: ['add-once'],
      title:
        'Backlog “+ Today” on A: ≤1 listTasks, ≤3 listPlansForDay, 0 getDay on the wire; Today shows A once, and after a reload',
      async run(ctx) {
        await openBacklog(ctx);
        const add = addButton(ctx, made.A!);
        await add.waitFor({ state: 'visible', timeout: 15_000 });
        const counter = countApi(ctx);
        await counter.quiet();
        counter.arm();
        await add.click();
        const got = await counter.settle();
        const over = [
          ['listTasks', 1],
          ['listPlansForDay', 3],
          ['getDay', 0],
        ].filter(([m, cap]) => got(m as string) > (cap as number));
        if (over.length)
          throw new Error(
            `over the ceiling: ${over.map(([m, cap]) => `${m} ${got(m as string)} > ${cap}`).join(', ')}`,
          );
        await onceOnToday(ctx, made.A!, 'after the add');
        await ctx.page.reload();
        await onceOnToday(ctx, made.A!, 'after a reload');
        await ctx.shot('added-today');
      },
    },
    {
      id: 'add-once-server',
      entry: 'api',
      proves: ['add-once', 'neighbour'],
      title: 'A is planned with one row; N still planned, order 0, 15 min',
      async run(ctx) {
        const { today } = await days(ctx);
        if ((await statusOf(ctx, made.A!)) !== 'planned') throw new Error('A is not planned');
        const a = await rowsOf(ctx, today, made.A!);
        if (a.length !== 1) throw new Error(`A rows: ${JSON.stringify(a)}`);
        const n = await rowsOf(ctx, today, made.N!);
        if (n.length !== 1 || n[0]!.order !== 0 || n[0]!.plannedMinutes !== 15)
          throw new Error(`N moved: ${JSON.stringify(n)}`);
        if ((await statusOf(ctx, made.N!)) !== 'planned') throw new Error('N changed status');
      },
    },
    {
      id: 'add-already',
      entry: 'ui',
      proves: ['add-already'],
      title:
        'The Backlog shows U; the API plans it; “+ Today” → Today shows U once, planned, one row',
      async run(ctx) {
        const { today } = await days(ctx);
        await openBacklog(ctx);
        const add = addButton(ctx, made.U!);
        await add.waitFor({ state: 'visible', timeout: 15_000 });
        // Another device plans it while this page's Backlog still lists it.
        await ctx.api.writes.upsertPlan({
          taskId: made.U!.id,
          day: today,
          plannedMinutes: 15,
          order: 9,
        });
        await add.click();
        await onceOnToday(ctx, made.U!, 'after the add');
        await until('U to be planned', async () => (await statusOf(ctx, made.U!)) === 'planned');
        const rows = await rowsOf(ctx, today, made.U!);
        if (rows.length !== 1) throw new Error(`U rows: ${JSON.stringify(rows)}`);
      },
    },
    {
      id: 'unplan-row',
      entry: 'ui',
      proves: ['unplan-row'],
      title:
        'Unplan A on Today: exactly one getDay on the wire; A back in the Backlog, and after a reload',
      async run(ctx) {
        await ctx.ui.goto('/tasks');
        const unplan = unplanButton(ctx, made.A!);
        await unplan.waitFor({ state: 'visible', timeout: 15_000 });
        const counter = countApi(ctx);
        await counter.quiet();
        counter.arm();
        await unplan.click();
        const got = await counter.settle();
        if (got('getDay') !== 1) throw new Error(`getDay ${got('getDay')} times, not once`);
        if (got('listTasks') > 1 || got('listPlansForDay') > 2)
          throw new Error(
            `over the ceiling: listTasks ${got('listTasks')}, listPlansForDay ${got('listPlansForDay')}`,
          );
        await openBacklog(ctx);
        await addButton(ctx, made.A!).waitFor({ state: 'visible', timeout: 15_000 });
        await ctx.page.reload();
        await openBacklog(ctx);
        await addButton(ctx, made.A!).waitFor({ state: 'visible', timeout: 15_000 });
      },
    },
    {
      id: 'unplan-row-server',
      entry: 'api',
      proves: ['unplan-row', 'neighbour'],
      title: 'A is backlog with no row; N untouched',
      async run(ctx) {
        const { today } = await days(ctx);
        if ((await statusOf(ctx, made.A!)) !== 'backlog') throw new Error('A is not backlog');
        if ((await rowsOf(ctx, today, made.A!)).length) throw new Error('A still has a row');
        const n = await rowsOf(ctx, today, made.N!);
        if (n.length !== 1 || n[0]!.order !== 0 || n[0]!.plannedMinutes !== 15)
          throw new Error(`N moved: ${JSON.stringify(n)}`);
      },
    },
    {
      id: 'due-heals',
      entry: 'ui',
      proves: ['due-heals'],
      title:
        'P gets a time in the editor: the day refetch sweeps it to backlog; it stays on Today by its time, and after a reload',
      async run(ctx) {
        const { today } = await days(ctx);
        await ctx.ui.goto('/tasks');
        await ctx.page.getByRole('button', { name: made.P!.title, exact: true }).click();
        const dialog = ctx.page.getByRole('dialog', { name: `Task: ${made.P!.title}` });
        await dialog.getByLabel('Due', { exact: true }).waitFor({ timeout: 10_000 });
        await dialog.getByLabel('Due', { exact: true }).fill(today);
        await dialog.getByLabel('Due time', { exact: true }).fill('23:58');
        await until('the sweep to settle P', async () => {
          const t = await ctx.api.reads.getTask(made.P!.id);
          return t?.status === 'backlog' && t.dueTime === '23:58';
        });
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await ctx.ui.expectText(made.P!.title, 15_000);
        await ctx.page.reload();
        await ctx.ui.expectText(made.P!.title, 15_000);
        if ((await rowsOf(ctx, today, made.P!)).length !== 1)
          throw new Error('P’s plan row did not stay as history');
        await ctx.shot('timed-stays-today');
      },
    },
    {
      id: 'night-lists',
      entry: 'ui',
      proves: ['night-lists'],
      title: 'Night: Tomorrow on T, Backlog on N → both rows leave',
      async run(ctx) {
        await openNight(ctx);
        await nightRow(ctx, made.T!).getByRole('button', { name: 'Tomorrow', exact: true }).click();
        await nightRow(ctx, made.T!).waitFor({ state: 'hidden', timeout: 15_000 });
        await nightRow(ctx, made.N!).getByRole('button', { name: 'Backlog', exact: true }).click();
        await nightRow(ctx, made.N!).waitFor({ state: 'hidden', timeout: 15_000 });
        await ctx.shot('night-answered');
      },
    },
    {
      id: 'night-lists-server',
      entry: 'api',
      proves: ['night-lists'],
      title: 'T has a row tomorrow (today’s kept, still planned); N is backlog with no row today',
      async run(ctx) {
        const { today, tomorrow } = await days(ctx);
        if ((await rowsOf(ctx, tomorrow, made.T!)).length !== 1)
          throw new Error('T not on tomorrow');
        if ((await rowsOf(ctx, today, made.T!)).length !== 1) throw new Error('T lost today’s row');
        if ((await statusOf(ctx, made.T!)) !== 'planned') throw new Error('T changed status');
        await until('N to be backlog', async () => (await statusOf(ctx, made.N!)) === 'backlog');
        if ((await rowsOf(ctx, today, made.N!)).length) throw new Error('N still has a row');
      },
    },
    {
      id: 'stop-then-unplan',
      entry: 'ui',
      proves: ['stop-then-unplan', 'no-timer', 'neighbour-timer'],
      title:
        'Night Backlog on S1 (timer) → timer stopped, minutes credited, backlog; S2’s timer still runs; Backlog on S3 (no timer) → backlog; reload: both rows gone',
      async run(ctx) {
        const { today } = await days(ctx);
        await openNight(ctx);
        const before = await runningOn(ctx, made.S1!);
        if (before.length !== 1) throw new Error(`S1 timers before: ${before.length}`);
        await nightRow(ctx, made.S1!).getByRole('button', { name: 'Backlog', exact: true }).click();
        await nightRow(ctx, made.S1!).waitFor({ state: 'hidden', timeout: 15_000 });
        await until('S1 to be backlog', async () => (await statusOf(ctx, made.S1!)) === 'backlog');
        if ((await runningOn(ctx, made.S1!)).length) throw new Error('S1’s timer still runs');
        const done = (await ctx.api.reads.listSessionsForDay(today)).find(
          (s) => s.id === before[0]!.id,
        );
        if (done?.status !== 'completed' || done.endedAt === null)
          throw new Error(`S1’s session: ${JSON.stringify(done)}`);
        const s1 = await ctx.api.reads.getTask(made.S1!.id);
        if ((s1?.actualAccruedMin ?? -1) < Math.floor(done.activeMinutes))
          throw new Error(`S1 accrued ${s1?.actualAccruedMin}, session had ${done.activeMinutes}`);
        if ((await rowsOf(ctx, today, made.S1!)).length) throw new Error('S1 still has a row');
        if ((await runningOn(ctx, made.S2!)).length !== 1)
          throw new Error('S2’s timer stopped too');
        await nightRow(ctx, made.S3!).getByRole('button', { name: 'Backlog', exact: true }).click();
        await nightRow(ctx, made.S3!).waitFor({ state: 'hidden', timeout: 15_000 });
        await until('S3 to be backlog', async () => (await statusOf(ctx, made.S3!)) === 'backlog');
        await ctx.page.reload();
        await openNight(ctx);
        await nightRow(ctx, made.S2!).waitFor({ state: 'visible', timeout: 15_000 });
        if (await nightRow(ctx, made.S1!).isVisible()) throw new Error('S1 is back after a reload');
        if (await nightRow(ctx, made.S3!).isVisible()) throw new Error('S3 is back after a reload');
        await ctx.shot('started-to-backlog');
      },
    },
    {
      id: 'unplan-fails',
      entry: 'ui',
      proves: ['unplan-fails'],
      title:
        'removePlan fails once on S2: minutes credited, a fresh timer, in progress, the row says so; again → backlog, no timer',
      async run(ctx) {
        const { today } = await days(ctx);
        const i = await ctx.intercept('removePlan', { status: 500, times: 1 });
        try {
          await nightRow(ctx, made.S2!)
            .getByRole('button', { name: 'Backlog', exact: true })
            .click();
          await ctx.ui.expectText(SAVE_FAILED, 15_000);
          if (i.hits() !== 1) throw new Error(`removePlan failed ${i.hits()} times`);
          await ctx.shot('unplan-failed');
        } finally {
          await i.release();
        }
        await until('a fresh timer on S2', async () => {
          const running = await runningOn(ctx, made.S2!);
          return running.length === 1 && running[0]!.id !== firstTimer!.id;
        });
        if ((await statusOf(ctx, made.S2!)) !== 'in_progress')
          throw new Error('S2 left in progress');
        const done = (await ctx.api.reads.listSessionsForDay(today)).find(
          (s) => s.id === firstTimer!.id,
        );
        if (done?.status !== 'completed')
          throw new Error(`S2’s first session: ${JSON.stringify(done)}`);
        if ((await rowsOf(ctx, today, made.S2!)).length !== 1) throw new Error('S2 lost its row');
        const row = nightRow(ctx, made.S2!);
        await row.waitFor({ state: 'visible', timeout: 5_000 });
        await row.getByRole('button', { name: 'Backlog', exact: true }).click();
        await row.waitFor({ state: 'hidden', timeout: 15_000 });
        await until('S2 to be backlog', async () => (await statusOf(ctx, made.S2!)) === 'backlog');
        if ((await runningOn(ctx, made.S2!)).length) throw new Error('S2’s timer still runs');
        if ((await rowsOf(ctx, today, made.S2!)).length) throw new Error('S2 still has a row');
      },
    },
    {
      id: 'teardown',
      entry: 'api',
      title:
        'The run’s tasks go now (ledgered deletes), so the Backlog is as later scenarios expect',
      async run(ctx) {
        for (const task of Object.values(made)) await ctx.api.writes.deleteTask(task.id);
      },
    },
    noConsoleErrors,
  ],
};
