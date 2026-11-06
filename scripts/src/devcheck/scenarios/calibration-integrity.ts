// Calibration integrity (docs/areas/calibration/integrity.md): no done task without an estimate and an actual.
// Start on an unscoped task nudges with chips; Done and a done split ask for what's missing, marked retro; MCP
// says so before writing anything; the Calibration page footnotes retro and labels a rescoped row. An errand's
// exemption is the `places` scenario's check-off. Titles use `devcheck-cal <nonce>` — the parts scenarios sweep
// `devcheck <nonce>` — and no task's word sits inside another's, since the search matches substrings.
import { noConsoleErrors, type Ctx, type Scenario } from '../scenario';

const name = (ctx: Ctx, what: string) => `devcheck-cal ${ctx.nonce} ${what}`;
const GATE = 'Needs an estimate and an actual';

async function mine(ctx: Ctx, what: string) {
  const t = (await ctx.api.reads.listTasks()).find((x) => x.title === name(ctx, what));
  if (!t) throw new Error(`${what}: not on the server`);
  return t;
}
// Any range: the app's day boundary can put today's point on yesterday.
async function pointOf(ctx: Ctx, id: string) {
  const all = await ctx.api.reads.getCalibration({ from: '2000-01-01', to: '2100-01-01' });
  const p = all.find((x) => x.taskId === id);
  if (!p) throw new Error(`${id}: no calibration point`);
  return p;
}
const dialogOf = (ctx: Ctx, title: string) =>
  ctx.page.getByRole('dialog', { name: `Task: ${title}` });
async function untilInProgress(ctx: Ctx, id: string) {
  for (let i = 0; (await ctx.api.reads.getTask(id))?.status !== 'in_progress'; i++) {
    if (i >= 40) throw new Error(`${id}: the start never reached the server`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Start on the task's Backlog row, searched down to it, opens its chips.
async function openChips(ctx: Ctx, what: string) {
  const title = name(ctx, what);
  await ctx.ui.goto('/tasks?lens=backlog');
  await ctx.page.getByLabel('Search tasks').fill(title);
  await ctx.page.getByRole('button', { name: title, exact: true }).waitFor({ timeout: 15_000 });
  const start = ctx.page.getByRole('button', { name: 'Start', exact: true });
  const starts = await start.count();
  if (starts !== 1) throw new Error(`search left ${starts} Start buttons, not this task’s one`);
  await start.click();
  const chips = ctx.page.getByRole('group', { name: `Estimate for ${title}` });
  await chips.waitFor({ timeout: 10_000 });
  return chips;
}
// The started task's modal, opened where the row stands: it holds the Done form.
async function openDoneForm(ctx: Ctx, what: string) {
  const title = name(ctx, what);
  await ctx.page.getByRole('button', { name: title, exact: true }).click();
  const dialog = dialogOf(ctx, title);
  await dialog.getByLabel('Actual (min)').waitFor({ timeout: 10_000 });
  return dialog;
}
async function markDone(dialog: ReturnType<typeof dialogOf>) {
  await dialog.getByRole('button', { name: 'Mark done' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
}
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );

export const calibrationIntegrity: Scenario = {
  id: 'calibration-integrity',
  title: 'Every done task has an estimate and an actual; hindsight is marked and footnoted',
  tiers: ['full'],
  rows: [
    {
      id: 'chips-start',
      entry: 'ui',
      kind: 'nominal',
      what: 'Start on an unscoped task → chip 30 → Done 40 → the point is 30 vs 40, planned, and survives a reload',
    },
    {
      id: 'chips-custom',
      entry: 'ui',
      kind: 'edge',
      what: 'Custom estimate: 0 is refused with a message, 25 starts with a lock of 25',
    },
    {
      id: 'chips-cancel',
      entry: 'ui',
      kind: 'edge',
      what: 'Cancel on the chips leaves the task unstarted, with nothing written',
    },
    {
      id: 'chips-home',
      entry: 'ui',
      kind: 'nominal',
      what: 'Start on a Home “Right now” row opens the same chips',
      offDev: {
        file: 'app/src/pages/Home/RightNow.test.tsx',
        test: 'Start on an unscoped row asks for an estimate, and a chip starts it',
        why: 'same path as chips-start (proven on dev): the same EstimateChips and BFF calls; which row opens them runs in the named test, and Home’s mode depends on the clock',
      },
    },
    {
      id: 'without-one',
      entry: 'ui',
      kind: 'edge',
      what: '“Start without one” leaves no lock; Done asks for the estimate and stays blocked until it is typed; the point is retro',
    },
    {
      id: 'actual-zero',
      entry: 'ui',
      kind: 'edge',
      what: 'A typed actual of 0 blocks Mark done and says why',
    },
    {
      id: 'split-unscoped',
      entry: 'ui',
      kind: 'edge',
      what: 'A done split of an unscoped task asks for its estimate; the point is retro, the next part stays unscoped and unlocked',
    },
    {
      id: 'footnote',
      entry: 'ui',
      kind: 'nominal',
      what: 'The Calibration page footnotes “N of M estimated after the fact”',
    },
    {
      id: 'drift-label',
      entry: 'ui',
      kind: 'nominal',
      what: 'A task rescoped after start reads “est 30m → 1h · actual 1h 15m” on the Calibration page, bar still against the lock; revised',
    },
    {
      id: 'parent-unchanged',
      entry: 'ui',
      kind: 'edge',
      what: 'A parent’s Mark done still takes one tap, with no estimate of its own, its actual the sum of its parts',
    },
    {
      id: 'mcp-scoped',
      entry: 'mcp',
      kind: 'nominal',
      what: 'complete_task {actualMin} on a scoped backlog task: lock = estimate, planned',
    },
    {
      id: 'mcp-unscoped-refused',
      entry: 'mcp',
      kind: 'edge',
      what: 'complete_task on an unscoped task without estimateMin: the error names it and the task is untouched',
    },
    {
      id: 'mcp-unscoped-retro',
      entry: 'mcp',
      kind: 'edge',
      what: 'complete_task {actualMin, estimateMin} on an unscoped task: retro, the lock is that estimate',
    },
    {
      id: 'mcp-revision',
      entry: 'mcp',
      kind: 'edge',
      what: 'complete_task with estimateMin on a scoped task: a revision, the lock stays at start’s number',
    },
    {
      id: 'mcp-status-done',
      entry: 'mcp',
      kind: 'edge',
      what: 'update_task {status: done} on an unscoped started task: the gate’s message, still in progress',
    },
    {
      id: 'api-actual-zero-done',
      entry: 'api',
      kind: 'edge',
      what: 'setTaskActual 0 on a done task is refused, the actual unchanged',
    },
    {
      id: 'mcp-backfill-once',
      entry: 'mcp',
      kind: 'edge',
      what: 'A done task with no lock takes one retro estimate; a second is refused',
      offDev: {
        file: 'lambdas/src/mcp/tools.test.ts',
        test: 'update_task backfills a done task with no lock once; a second is refused',
        why: 'dev can no longer produce a done task with no lock: only a row from before the gate has that shape, and the test writes it directly',
      },
    },
    {
      id: 'prod-backfill',
      entry: 'mcp',
      kind: 'edge',
      what: 'The one prod row without an estimate takes its backfill over update_task',
      needsYou:
        'a write on your real data: update_task {id: 01M5DWWVC950YPWHX52SVXQE4Z, estimateMin: N} on aperture, with the N you choose',
    },
  ],
  steps: [
    {
      id: 'setup',
      entry: 'api',
      title: 'Tasks for each case: unscoped and scoped, a parent with two parts (API, MCP)',
      async run(ctx) {
        for (const what of ['chips', 'custom', 'nudged', 'without', 'splitme'])
          await ctx.api.writes.createTask({ title: name(ctx, what) });
        for (const what of ['zeroed', 'drifted'])
          await ctx.api.writes.createTask({ title: name(ctx, what), estimateMin: 30 });
        await ctx.mcp.writes.createTask({ title: name(ctx, 'mscoped'), estimateMin: 10 });
        await ctx.mcp.writes.createTask({ title: name(ctx, 'mnone') });
        await ctx.mcp.writes.createTask({ title: name(ctx, 'mrevise'), estimateMin: 20 });
        await ctx.mcp.writes.createTask({ title: name(ctx, 'mstatus') });
        const parent = await ctx.api.writes.createTask({ title: name(ctx, 'rollup') });
        for (const what of ['pone', 'ptwo'])
          await ctx.api.writes.createTask({
            title: name(ctx, what),
            parentId: parent.id,
            estimateMin: 5,
          });
      },
    },
    {
      id: 'chips-start',
      entry: 'ui',
      proves: ['chips-start'],
      title: 'Start → chip 30 → Done 40 → reload the Calibration page',
      async run(ctx) {
        const chips = await openChips(ctx, 'chips');
        await ctx.shot('chips-open');
        await chips.getByRole('button', { name: '30', exact: true }).click();
        const { id } = await mine(ctx, 'chips');
        await untilInProgress(ctx, id);
        const t = await ctx.api.reads.getTask(id);
        if (t?.estimateLockedMin !== 30) throw new Error(`locked ${JSON.stringify(t)}`);
        const dialog = await openDoneForm(ctx, 'chips');
        await dialog.getByLabel('Actual (min)').fill('40');
        if (await dialog.getByLabel('Estimate (min)').count())
          throw new Error('a scoped task’s Done form asked for an estimate');
        await markDone(dialog);
        const p = await pointOf(ctx, id);
        if (
          p.estimateLockedMin !== 30 ||
          p.actualAccruedMin !== 40 ||
          p.estimateSource !== 'planned'
        )
          throw new Error(`point ${JSON.stringify(p)}`);
        await ctx.ui.goto('/tasks?lens=calibration');
        await ctx.page.reload();
        await ctx.ui.expectText(name(ctx, 'chips'), 15_000);
        await ctx.shot('calibration-after-reload');
      },
    },
    {
      id: 'chips-custom',
      entry: 'ui',
      proves: ['chips-custom'],
      title: 'Custom: 0 says at least 1, 25 starts locked at 25',
      async run(ctx) {
        const chips = await openChips(ctx, 'custom');
        await chips.getByRole('button', { name: 'Custom', exact: true }).click();
        const field = chips.getByLabel('Estimate (min)');
        await field.fill('0');
        await ctx.ui.expectText('Minutes need to be at least 1.');
        if (!(await chips.getByRole('button', { name: 'Start with this' }).isDisabled()))
          throw new Error('0 left “Start with this” enabled');
        await ctx.shot('custom-zero');
        await field.fill('25');
        await chips.getByRole('button', { name: 'Start with this' }).click();
        const { id } = await mine(ctx, 'custom');
        await untilInProgress(ctx, id);
        const t = await ctx.api.reads.getTask(id);
        if (t?.estimateLockedMin !== 25) throw new Error(`locked ${JSON.stringify(t)}`);
      },
    },
    {
      id: 'chips-cancel',
      entry: 'ui',
      proves: ['chips-cancel'],
      title: 'Cancel closes the chips; the task is untouched on the server',
      async run(ctx) {
        const chips = await openChips(ctx, 'nudged');
        await chips.getByRole('button', { name: 'Cancel', exact: true }).click();
        await chips.waitFor({ state: 'hidden', timeout: 5_000 });
        const t = await mine(ctx, 'nudged');
        if (t.status !== 'backlog' || t.estimateMin != null || t.estimateLockedMin != null)
          throw new Error(`after Cancel ${JSON.stringify(t)}`);
      },
    },
    {
      id: 'without-one',
      entry: 'ui',
      proves: ['without-one'],
      title: 'Start without one → Done asks for it, blocked until typed → retro',
      async run(ctx) {
        const chips = await openChips(ctx, 'without');
        await chips.getByRole('button', { name: 'Start without one' }).click();
        const { id } = await mine(ctx, 'without');
        await untilInProgress(ctx, id);
        const started = await ctx.api.reads.getTask(id);
        if (started?.estimateLockedMin != null) throw new Error('a lock with no estimate');
        const dialog = await openDoneForm(ctx, 'without');
        const estimate = dialog.getByLabel('Estimate (min)');
        await estimate.scrollIntoViewIfNeeded();
        await ctx.shot('done-asks-estimate');
        await dialog.getByLabel('Actual (min)').fill('50');
        if (!(await dialog.getByRole('button', { name: 'Mark done' }).isDisabled()))
          throw new Error('Mark done is enabled with no estimate');
        await estimate.fill('45');
        await markDone(dialog);
        const p = await pointOf(ctx, id);
        if (p.estimateLockedMin !== 45 || p.estimateSource !== 'retro')
          throw new Error(`point ${JSON.stringify(p)}`);
      },
    },
    {
      id: 'actual-zero',
      entry: 'ui',
      proves: ['actual-zero'],
      title: 'A scoped started task: actual 0 blocks Mark done and says why',
      async run(ctx) {
        const title = name(ctx, 'zeroed');
        await ctx.ui.goto('/tasks?lens=backlog');
        await ctx.page.getByLabel('Search tasks').fill(title);
        await ctx.page.getByRole('button', { name: 'Start', exact: true }).click();
        await untilInProgress(ctx, (await mine(ctx, 'zeroed')).id);
        const dialog = await openDoneForm(ctx, 'zeroed');
        await dialog.getByLabel('Actual (min)').fill('0');
        await dialog.getByText('Minutes need to be at least 1.').waitFor({ timeout: 5_000 });
        if (!(await dialog.getByRole('button', { name: 'Mark done' }).isDisabled()))
          throw new Error('Mark done is enabled at 0');
        await ctx.shot('actual-zero');
      },
    },
    {
      id: 'split-unscoped',
      entry: 'ui',
      proves: ['split-unscoped'],
      title: 'Start without one → Split… → Done with this part asks for its estimate',
      async run(ctx) {
        const chips = await openChips(ctx, 'splitme');
        await chips.getByRole('button', { name: 'Start without one' }).click();
        const { id } = await mine(ctx, 'splitme');
        await untilInProgress(ctx, id);
        const dialog = await openDoneForm(ctx, 'splitme');
        await dialog.getByRole('button', { name: /^Split/ }).click();
        const actual = dialog.getByLabel("This part's actual (min)");
        await actual.waitFor({ timeout: 10_000 });
        await actual.scrollIntoViewIfNeeded();
        await actual.fill('20');
        const split = dialog.getByRole('button', { name: 'Split', exact: true });
        if (!(await split.isDisabled())) throw new Error('Split is enabled with no estimate');
        await dialog.getByLabel("This part's estimate (min)").fill('15');
        await ctx.shot('split-asks-estimate');
        await split.click();
        await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
        const p = await pointOf(ctx, id);
        if (p.estimateLockedMin !== 15 || p.estimateSource !== 'retro')
          throw new Error(`point ${JSON.stringify(p)}`);
        const t = await ctx.api.reads.getTask(id);
        const next = (await ctx.api.reads.listTasks()).find(
          (x) => x.parentId === t?.parentId && x.id !== id,
        );
        if (!next || next.estimateMin != null || next.estimateLockedMin != null)
          throw new Error(`the next part is ${JSON.stringify(next)}`);
      },
    },
    {
      id: 'footnote',
      entry: 'ui',
      proves: ['footnote'],
      title: 'The Calibration page counts the retro points',
      async run(ctx) {
        await ctx.ui.goto('/tasks?lens=calibration');
        const note = ctx.page.getByText(/^\d+ of \d+ estimated after the fact$/);
        await note.waitFor({ timeout: 15_000 });
        await note.scrollIntoViewIfNeeded();
        await ctx.shot('footnote');
      },
    },
    {
      id: 'drift-label',
      entry: 'ui',
      proves: ['drift-label'],
      title: 'Locked at 30, rescoped to 60 over MCP, Done 75 → the row’s label and revised',
      async run(ctx) {
        const { id } = await mine(ctx, 'drifted');
        await ctx.mcp.writes.updateTask(id, { status: 'in_progress' });
        await ctx.mcp.writes.updateTask(id, { estimateMin: 60 });
        await ctx.mcp.writes.completeTask(id, 75);
        const p = await pointOf(ctx, id);
        if (p.estimateLockedMin !== 30 || p.estimateMin !== 60 || p.estimateSource !== 'revised')
          throw new Error(`point ${JSON.stringify(p)}`);
        await ctx.ui.goto('/tasks?lens=calibration');
        const label = ctx.page.getByText('est 30m → 1h · actual 1h 15m').first();
        await label.waitFor({ timeout: 15_000 });
        await label.scrollIntoViewIfNeeded();
        await ctx.ui.expectText(name(ctx, 'drifted'));
        await ctx.shot('drift-label');
      },
    },
    {
      id: 'parent-unchanged',
      entry: 'ui',
      proves: ['parent-unchanged'],
      title: 'Parts finished over MCP → the parent’s one-tap Mark done → Σ parts',
      async run(ctx) {
        const parent = await mine(ctx, 'rollup');
        await ctx.mcp.writes.completeTask((await mine(ctx, 'pone')).id, 6);
        await ctx.mcp.writes.completeTask((await mine(ctx, 'ptwo')).id, 9);
        await ctx.ui.goto('/tasks?lens=backlog');
        await ctx.page.getByLabel('Search tasks').fill(name(ctx, 'rollup'));
        await ctx.page.getByRole('button', { name: 'Mark done', exact: true }).click();
        for (let i = 0; (await ctx.api.reads.getTask(parent.id))?.status !== 'done'; i++) {
          if (i >= 40) throw new Error('the parent’s Mark done never reached the server');
          await new Promise((r) => setTimeout(r, 250));
        }
        const done = await ctx.api.reads.getTask(parent.id);
        if (done?.actualAccruedMin !== 15 || done.estimateMin != null)
          throw new Error(`the parent saved ${JSON.stringify(done)}`);
      },
    },
    {
      id: 'mcp',
      entry: 'mcp',
      proves: [
        'mcp-scoped',
        'mcp-unscoped-refused',
        'mcp-unscoped-retro',
        'mcp-revision',
        'mcp-status-done',
      ],
      title: 'complete_task and update_task, scoped and unscoped',
      async run(ctx) {
        const scoped = await mine(ctx, 'mscoped');
        await ctx.mcp.writes.completeTask(scoped.id, 12);
        const a = await pointOf(ctx, scoped.id);
        if (a.estimateLockedMin !== 10 || a.estimateSource !== 'planned')
          throw new Error(`scoped: ${JSON.stringify(a)}`);

        const none = await mine(ctx, 'mnone');
        const why = await refusal(ctx.mcp.writes.completeTask(none.id, 12));
        if (!why?.includes('estimateMin')) throw new Error(`unscoped said: ${why}`);
        const untouched = await ctx.api.reads.getTask(none.id);
        if (untouched?.status !== 'backlog' || untouched.actualAccruedMin !== 0)
          throw new Error(`the refusal wrote: ${JSON.stringify(untouched)}`);
        await ctx.mcp.writes.completeTask(none.id, 12, undefined, 8);
        const b = await pointOf(ctx, none.id);
        if (b.estimateLockedMin !== 8 || b.estimateSource !== 'retro')
          throw new Error(`retro: ${JSON.stringify(b)}`);

        const revise = await mine(ctx, 'mrevise');
        await ctx.mcp.writes.completeTask(revise.id, 25, undefined, 40);
        const c = await pointOf(ctx, revise.id);
        if (c.estimateLockedMin !== 20 || c.estimateMin !== 40 || c.estimateSource !== 'revised')
          throw new Error(`revision: ${JSON.stringify(c)}`);

        const status = await mine(ctx, 'mstatus');
        await ctx.mcp.writes.updateTask(status.id, { status: 'in_progress' });
        const said = await refusal(ctx.mcp.writes.updateTask(status.id, { status: 'done' }));
        if (!said?.includes(GATE)) throw new Error(`update_task said: ${said}`);
        if ((await ctx.api.reads.getTask(status.id))?.status !== 'in_progress')
          throw new Error('the gate’s refusal moved the task');
      },
    },
    {
      id: 'api-actual-zero',
      entry: 'api',
      proves: ['api-actual-zero-done'],
      title: 'setTaskActual 0 on a finished task is refused',
      async run(ctx) {
        const { id } = await mine(ctx, 'mscoped');
        const said = await refusal(ctx.api.writes.setTaskActual(id, 0));
        if (!said?.includes(GATE)) throw new Error(`setTaskActual said: ${said}`);
        if ((await ctx.api.reads.getTask(id))?.actualAccruedMin !== 12)
          throw new Error('the refused actual landed');
      },
    },
    {
      id: 'clear-open',
      entry: 'api',
      title: 'Delete what this scenario left open, so later scenarios’ lists stay short',
      async run(ctx) {
        const tasks = await ctx.api.reads.listTasks();
        const parentId = tasks.find((t) => t.title === name(ctx, 'splitme'))?.parentId;
        for (const what of ['custom', 'nudged', 'zeroed', 'mstatus'])
          await ctx.api.writes.deleteTask((await mine(ctx, what)).id);
        if (parentId) await ctx.api.writes.deleteTask(parentId);
      },
    },
    {
      id: 'clear-search',
      entry: 'ui',
      title: 'Clear the /tasks search, so the scenarios after start unfiltered',
      async run(ctx) {
        await ctx.ui.goto('/tasks?lens=backlog');
        await ctx.page.getByLabel('Search tasks').fill('');
      },
    },
    noConsoleErrors,
  ],
};
