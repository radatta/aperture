// The reflection line (docs/areas/tasks/reflection.md): written on the Done form with the actual, edited in
// the task modal, read back under the delta at night, and through MCP's complete_task / update_task.
// Titles use `devcheck-refl <nonce>`, never `devcheck <nonce>` — the parts scenarios sweep that prefix.
// The /tasks search text persists across lenses (sessionStorage), so every open searches for its own task
// and the last step clears it for the scenarios after.
import { noConsoleErrors, type Ctx, type Scenario } from '../scenario';

const name = (ctx: Ctx, what: string) => `devcheck-refl ${ctx.nonce} ${what}`;
const FIRST = 'Went fine, should have outlined first';
const SEEDED = 'Set before Mark done — devcheck';
const EDITED = 'Outline first next time — devcheck';
const VIA_MCP = 'Read the brief twice — devcheck';
const KEPT = 'Set before the actual — devcheck';
const NEWER = 'Saved over MCP while the form was open — devcheck';

// The reflection textarea. Its <label> wraps it, so its accessible name grows with what's typed.
const reflectionBox = (scope: Pick<Ctx['page'], 'getByRole'>) =>
  scope.getByRole('textbox', { name: /^Reflection/ });

const dialogOf = (ctx: Ctx, title: string) =>
  ctx.page.getByRole('dialog', { name: `Task: ${title}` });

// Opens a task's modal by its title button on a lens of /tasks, searched down to that task.
async function openTask(ctx: Ctx, lens: string, title: string) {
  await ctx.ui.goto(`/tasks?lens=${lens}`);
  await ctx.page.getByLabel('Search tasks').fill(title);
  const open = ctx.page.getByRole('button', { name: title, exact: true });
  await open.waitFor({ timeout: 15_000 }); // the row, not "Nothing matches “…”"
  await open.click();
  return dialogOf(ctx, title);
}

async function mine(ctx: Ctx, what: string) {
  const t = (await ctx.api.reads.listTasks()).find((x) => x.title === name(ctx, what));
  if (!t) throw new Error(`${what}: not on the server`);
  return t;
}

// Start from Backlog (searched down to the task, so its Start is the only one), wait for the server to
// have it in progress, then open it where it stands — the modal holds the Done form.
async function startAndOpen(ctx: Ctx, what: string) {
  const title = name(ctx, what);
  await ctx.ui.goto('/tasks?lens=backlog');
  await ctx.page.getByLabel('Search tasks').fill(title);
  await ctx.page.getByRole('button', { name: title, exact: true }).waitFor({ timeout: 15_000 });
  const start = ctx.page.getByRole('button', { name: 'Start', exact: true });
  const starts = await start.count();
  if (starts !== 1) throw new Error(`search left ${starts} Start buttons, not this task’s one`);
  await start.click();
  const { id } = await mine(ctx, what);
  for (let i = 0; (await ctx.api.reads.getTask(id))?.status !== 'in_progress'; i++) {
    if (i >= 40) throw new Error(`${what}: Start never reached the server`);
    await new Promise((r) => setTimeout(r, 250));
  }
  await ctx.page.getByRole('button', { name: title, exact: true }).click();
  const dialog = dialogOf(ctx, title);
  await dialog.getByLabel('Actual (min)').waitFor({ timeout: 10_000 });
  return { id, dialog };
}

// The reflection box shows whole: at least its two rows (a 16px line is ~24px, so two rows plus padding
// clear 48px) and its placeholder isn't clipped. A collapsed box was ~18px — just its padding.
async function expectFullBox(scope: ReturnType<typeof dialogOf>, where: string) {
  const box = await reflectionBox(scope).boundingBox();
  if (!box || box.height < 48)
    throw new Error(`${where}: the Reflection box is ${box ? Math.round(box.height) : 0}px tall`);
}

// Mark done, then wait for the modal to close — it closes only once the actual and the finish landed.
async function markDone(dialog: ReturnType<typeof dialogOf>) {
  await dialog.getByRole('button', { name: 'Mark done' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
}

export const reflectionLine: Scenario = {
  id: 'reflection-line',
  title: 'A reflection rides Mark done, edits later, and reads back at night and over MCP',
  tiers: ['full'],
  rows: [
    {
      id: 'done-form',
      entry: 'ui',
      kind: 'nominal',
      what: 'Mark done with a reflection saves it with the actual (the box shows whole before typing)',
    },
    {
      id: 'done-untouched-keeps',
      entry: 'ui',
      kind: 'edge',
      what: 'Mark done with the reflection left as it was keeps the one already saved',
    },
    {
      id: 'esc-asks',
      entry: 'ui',
      kind: 'edge',
      what: 'A typed reflection makes Esc ask before the modal closes',
    },
    {
      id: 'edit-later',
      entry: 'ui',
      kind: 'nominal',
      what: 'Editing the reflection in the task modal saves, stays open, and survives a reload',
    },
    {
      id: 'clear',
      entry: 'ui',
      kind: 'edge',
      what: 'Clearing the reflection in the modal saves it empty',
    },
    {
      id: 'over-cap-ui',
      entry: 'ui',
      kind: 'edge',
      what: 'A reflection over 1,000 characters disables Mark done and says so',
      offDev: {
        file: 'app/src/modules/tasks/DoneForm.test.tsx',
        test: 'a reflection over the cap disables Mark done and says so',
        why: 'same path as done-form (proven on dev): a pure client check, nothing is sent',
      },
    },
    {
      id: 'over-cap-bff',
      entry: 'api',
      kind: 'edge',
      what: 'The server refuses an over-cap reflection on setTaskActual and lands nothing, the actual included',
    },
    {
      id: 'other-done-forms',
      entry: 'ui',
      kind: 'nominal',
      what: 'Home’s Right now and Flux’s rep tie Done forms carry the reflection too',
      offDev: {
        file: 'app/src/modules/tasks/DoneForm.test.tsx',
        test: 'Mark done sends the reflection with the actual; left alone, it sends none',
        why: 'same path as done-form (proven on dev): the same DoneForm and setTaskActual, in a plain onDone host',
      },
    },
    {
      id: 'night-review',
      entry: 'ui',
      kind: 'nominal',
      what: 'The night review shows the reflection under the task’s delta',
    },
    {
      id: 'mcp-complete',
      entry: 'mcp',
      kind: 'nominal',
      what: 'MCP complete_task with a reflection saves it; list_tasks, get_calibration and the app read it back',
    },
    {
      id: 'mcp-over-cap',
      entry: 'mcp',
      kind: 'edge',
      what: 'MCP complete_task with a reflection over the cap is refused and changes nothing',
    },
    {
      id: 'keeps-on-two-args',
      entry: 'mcp',
      kind: 'edge',
      what: 'complete_task without a reflection keeps the one already there (list_backlog shows it first)',
    },
  ],
  steps: [
    {
      id: 'setup',
      entry: 'api',
      title: 'Four backlog tasks — two for the app (one with a reflection already), two for MCP',
      async run(ctx) {
        await ctx.api.writes.createTask({ title: name(ctx, 'ui'), estimateMin: 15 });
        const keep = await ctx.api.writes.createTask({ title: name(ctx, 'keep'), estimateMin: 15 });
        await ctx.mcp.writes.updateTask(keep.id, { reflection: SEEDED });
        await ctx.mcp.writes.createTask({ title: name(ctx, 'mcp'), estimateMin: 10 });
        await ctx.mcp.writes.createTask({ title: name(ctx, 'cap'), estimateMin: 10 });
      },
    },
    {
      id: 'done-form',
      entry: 'ui',
      proves: ['done-form'],
      title: 'Start → open → Actual 20 + a reflection → Mark done',
      async run(ctx) {
        const { id, dialog } = await startAndOpen(ctx, 'ui');
        // Untouched, as it first shows: typing re-measures the box, so only this catches one that
        // opened collapsed (its height measured inside the not-yet-open dialog — 2026-11-04).
        await expectFullBox(dialog, 'the Done form, untouched');
        await reflectionBox(dialog).scrollIntoViewIfNeeded(); // the Done form sits below the fold
        await ctx.shot('done-form-untouched');
        await dialog.getByLabel('Actual (min)').fill('20');
        await reflectionBox(dialog).fill(FIRST);
        await ctx.shot('done-form');
        await markDone(dialog);
        const t = await ctx.api.reads.getTask(id);
        if (t?.status !== 'done' || t.actualAccruedMin !== 20 || t.reflection !== FIRST)
          throw new Error(`saved ${JSON.stringify(t)}`);
      },
    },
    {
      id: 'done-untouched',
      entry: 'ui',
      proves: ['done-untouched-keeps', 'esc-asks'],
      title:
        'A seeded reflection: typing then Esc asks; put back, Mark done keeps one saved meanwhile',
      async run(ctx) {
        const { id, dialog } = await startAndOpen(ctx, 'keep');
        const box = reflectionBox(dialog);
        if ((await box.inputValue()) !== SEEDED) throw new Error('the Done form didn’t seed it');
        await expectFullBox(dialog, 'the Done form, seeded');
        await box.fill(`${SEEDED} more`);
        await ctx.page.keyboard.press('Escape');
        const confirm = ctx.page.getByRole('dialog', { name: 'Discard unsaved changes?' });
        await confirm.waitFor({ timeout: 10_000 });
        await ctx.shot('esc-asks');
        await confirm.getByRole('button', { name: 'Keep editing' }).click();
        await box.fill(SEEDED); // back as it was: Mark done sends no reflection at all
        // Saved elsewhere while the form is open: only a Mark done that sends none keeps it.
        await ctx.mcp.writes.updateTask(id, { reflection: NEWER });
        await dialog.getByLabel('Actual (min)').fill('12');
        await markDone(dialog);
        const t = await ctx.api.reads.getTask(id);
        if (t?.status !== 'done' || t.actualAccruedMin !== 12 || t.reflection !== NEWER)
          throw new Error(`saved ${JSON.stringify(t)}`);
      },
    },
    {
      id: 'over-cap-bff',
      entry: 'api',
      proves: ['over-cap-bff'],
      title: 'setTaskActual with 1,001 characters is refused; the actual and reflection stay',
      async run(ctx) {
        const { id } = await mine(ctx, 'keep');
        const refused = await ctx.api.writes.setTaskActual(id, 99, 'x'.repeat(1001)).then(
          () => null,
          (e: unknown) => (e instanceof Error ? e.message : String(e)),
        );
        if (!refused || !/1,000/.test(refused))
          throw new Error(`not refused by the cap: ${refused}`);
        const t = await ctx.api.reads.getTask(id);
        if (t?.actualAccruedMin !== 12 || t.reflection !== NEWER)
          throw new Error(`changed: ${JSON.stringify(t)}`);
      },
    },
    {
      id: 'edit-later',
      entry: 'ui',
      proves: ['edit-later', 'clear'],
      title: 'Done lens → open → clear → Save; add again → Save stays open → reload keeps it',
      async run(ctx) {
        const { id } = await mine(ctx, 'ui');
        let dialog = await openTask(ctx, 'done', name(ctx, 'ui'));
        await dialog.getByRole('button', { name: 'Edit reflection' }).click();
        await reflectionBox(dialog).fill('');
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        const add = dialog.getByRole('button', { name: 'Add a reflection…' });
        await add.waitFor({ timeout: 10_000 });
        const cleared = await ctx.api.reads.getTask(id);
        if (cleared?.reflection !== null)
          throw new Error(`clear saved ${JSON.stringify(cleared?.reflection)}`);

        await add.click();
        await expectFullBox(dialog, 'the details form’s editor, untouched');
        await reflectionBox(dialog).fill(EDITED);
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await dialog.getByText('Saved', { exact: true }).waitFor({ timeout: 10_000 });
        if (!(await dialog.isVisible())) throw new Error('Save closed the modal');
        await ctx.page.reload();
        dialog = await openTask(ctx, 'done', name(ctx, 'ui'));
        await dialog.getByText(EDITED).waitFor({ timeout: 10_000 });
        await ctx.shot('edit-later');
        const t = await ctx.api.reads.getTask(id);
        if (t?.reflection !== EDITED)
          throw new Error(`server has ${JSON.stringify(t?.reflection)}`);
      },
    },
    {
      id: 'night-review',
      entry: 'ui',
      proves: ['night-review'],
      title: 'Night → Today in review shows it under the delta',
      async run(ctx) {
        await ctx.ui.goto('/');
        await ctx.page.getByRole('button', { name: 'Night', exact: true }).click();
        await ctx.ui.expectText('Today in review', 15_000);
        await ctx.ui.expectText(EDITED);
        await ctx.shot('night-review');
      },
    },
    {
      id: 'mcp-complete',
      entry: 'mcp',
      proves: ['mcp-complete'],
      title: 'complete_task with a reflection; list_tasks and the Done lens read it',
      async run(ctx) {
        const id = (await mine(ctx, 'mcp')).id;
        const { task } = await ctx.mcp.writes.completeTask(id, 10, VIA_MCP);
        if (task.status !== 'done' || task.reflection !== VIA_MCP)
          throw new Error(`complete_task returned ${JSON.stringify(task)}`);
        const listed = (await ctx.mcp.reads.listTasks()).find((t) => t.id === id);
        if (listed?.reflection !== VIA_MCP) throw new Error('list_tasks lacks the reflection');
        // Any range: the app's day boundary can put today's point on yesterday.
        const points = await ctx.mcp.reads.getCalibration({ from: '2000-01-01', to: '2100-01-01' });
        if (points.find((p) => p.taskId === id)?.reflection !== VIA_MCP)
          throw new Error('get_calibration lacks the reflection');
        const dialog = await openTask(ctx, 'done', name(ctx, 'mcp'));
        await dialog.getByText(VIA_MCP).waitFor({ timeout: 10_000 });
        await ctx.shot('mcp-complete');
      },
    },
    {
      id: 'mcp-over-cap',
      entry: 'mcp',
      proves: ['mcp-over-cap'],
      title: 'complete_task with 1,001 characters is refused; the task stays in the backlog',
      async run(ctx) {
        const id = (await mine(ctx, 'cap')).id;
        const refused = await ctx.mcp.writes.completeTask(id, 10, 'x'.repeat(1001)).then(
          () => null,
          (e: unknown) => (e instanceof Error ? e.message : String(e)),
        );
        if (!refused || !/1,000/.test(refused))
          throw new Error(`not refused by the cap: ${refused}`);
        const t = (await ctx.mcp.reads.listTasks()).find((x) => x.id === id);
        if (t?.status !== 'backlog' || t.reflection)
          throw new Error(`changed: ${JSON.stringify(t)}`);
      },
    },
    {
      id: 'mcp-keeps',
      entry: 'mcp',
      proves: ['keeps-on-two-args'],
      title: 'update_task sets a reflection; complete_task without one keeps it',
      async run(ctx) {
        const id = (await mine(ctx, 'cap')).id;
        await ctx.mcp.writes.updateTask(id, { reflection: KEPT });
        const backlog = (await ctx.mcp.reads.listBacklog()).find((t) => t.id === id);
        if (backlog?.reflection !== KEPT) throw new Error('list_backlog lacks the reflection');
        const { task } = await ctx.mcp.writes.completeTask(id, 10);
        if (task.status !== 'done' || task.reflection !== KEPT)
          throw new Error(`complete_task returned ${JSON.stringify(task)}`);
      },
    },
    {
      id: 'clear-search',
      entry: 'ui',
      title: 'Clear the /tasks search, so the scenarios after start unfiltered',
      async run(ctx) {
        await ctx.ui.goto('/tasks');
        await ctx.page.getByLabel('Search tasks').fill('');
      },
    },
    noConsoleErrors,
  ],
};
