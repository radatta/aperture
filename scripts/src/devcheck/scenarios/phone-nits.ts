// Four phone layout fixes (docs/areas/tasks/task-editor.md → Build record, 2026-11-05): the editor's Due and
// Due time share a line; a card title clamps to two lines, with the Scope button folded into the meta line's
// "not scoped"; a Settings category row keeps its reorder arrows at 390 (that one is the user's: rows, below). The run renders at 440 (browser.ts);
// the steps that need the 390 floor or the desktop set the viewport and put 440 back in `finally`, so a
// failure here never changes what the scenarios after see. Layout is measured through roles and labels (the
// boxes of the controls the user sees), never a class. Titles use `devcheck-nits <nonce>`.
import { PHONE } from '../browser';
import { noConsoleErrors, type Ctx, type Scenario } from '../scenario';

const FLOOR = { width: 390, height: 844 } as const; // iPhone 12–14 class — the narrowest layout kept working
const DESKTOP = { width: 1512, height: 860 } as const; // the 14" MacBook Pro's Safari content area
const LONG =
  'needs a full second line on the phone, with words long enough to wrap and keep wrapping past the row';
const name = (ctx: Ctx) => `devcheck-nits ${ctx.nonce} ${LONG}`; // ~120 characters

type Box = { x: number; y: number; width: number; height: number };
async function boxOf(l: { boundingBox(): Promise<Box | null> }, what: string): Promise<Box> {
  const b = await l.boundingBox();
  if (!b) throw new Error(`${what}: not rendered`);
  return b;
}
const sameLine = (a: Box, b: Box) => Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)) <= 4;
const r = (n: number) => Math.round(n);

async function at<T>(ctx: Ctx, size: { width: number; height: number }, fn: () => Promise<T>) {
  await ctx.page.setViewportSize(size);
  try {
    return await fn();
  } finally {
    await ctx.page.setViewportSize(PHONE);
  }
}

// The row, on a lens of /tasks searched down to this run's task (its Start is then the only one).
async function findRow(ctx: Ctx, lens: string) {
  const title = name(ctx);
  await ctx.ui.goto(`/tasks?lens=${lens}`);
  await ctx.page.getByLabel('Search tasks').fill(title);
  const button = ctx.page.getByRole('button', { name: title, exact: true });
  await button.waitFor({ timeout: 15_000 });
  return button;
}

const dialogOf = (ctx: Ctx) => ctx.page.getByRole('dialog', { name: `Task: ${name(ctx)}` });

// Due and Due time sit on one line of the open editor.
async function expectDuePair(ctx: Ctx, where: string) {
  const dialog = dialogOf(ctx);
  const due = await boxOf(dialog.getByLabel('Due', { exact: true }), `${where}: Due`);
  const time = await boxOf(dialog.getByLabel('Due time', { exact: true }), `${where}: Due time`);
  if (!sameLine(due, time))
    throw new Error(`${where}: Due at y ${r(due.y)}, Due time at y ${r(time.y)} — not one line`);
  return { due, time };
}

// The title button shows two lines: a 16px line is 24px, so two are 48px; one is under 30, three over 66.
async function expectTwoLines(button: { boundingBox(): Promise<Box | null> }, where: string) {
  const box = await boxOf(button, `${where}: title`);
  if (box.height < 40 || box.height > 60)
    throw new Error(`${where}: the title is ${r(box.height)}px tall — not two lines`);
  return box;
}

async function closeEditor(ctx: Ctx) {
  await ctx.page.keyboard.press('Escape');
  await dialogOf(ctx).waitFor({ state: 'hidden', timeout: 10_000 });
}

export const phoneNits: Scenario = {
  id: 'phone-nits',
  title: 'Phone layout: Due pair on one line, two-line titles, Settings arrows at 390',
  tiers: ['full'],
  rows: [
    {
      id: 'due-pair-440',
      entry: 'ui',
      kind: 'nominal',
      what: 'Open a backlog task at 440: Due and Due time share a line',
    },
    {
      id: 'due-pair-390',
      entry: 'ui',
      kind: 'nominal',
      what: 'The same editor at 390: Due and Due time still share a line',
    },
    {
      id: 'title-two-lines-390',
      entry: 'ui',
      kind: 'nominal',
      what: 'An unscoped Backlog card at 390 shows its title on two lines beside Start',
    },
    {
      id: 'title-clamp-390',
      entry: 'ui',
      kind: 'edge',
      what: 'A 120-character title clamps at two lines (not three) and Start stays right-aligned inside the viewport',
    },
    {
      id: 'not-scoped-opens-390',
      entry: 'ui',
      kind: 'nominal',
      what: 'Tapping “not scoped” on the card opens the editor on the Estimate field (there is no Scope button)',
    },
    {
      id: 'today-in-progress-390',
      entry: 'ui',
      kind: 'edge',
      what: 'Started, the Today card (Focus / Done) wraps its title to two lines too',
    },
    // The dev test user has no categories, and the harness has no category write or cleanup — so the
    // Settings rows are the user's glance for now (the headless stub pass covered both at 390: PR
    // screenshots); life-areas adds the `category` ledger kind and a row proving these arrows at 390.
    {
      id: 'settings-arrows-390',
      entry: 'ui',
      kind: 'nominal',
      what: 'Settings → Categories at 390 keeps both reorder arrows on the row, nothing scrolling sideways',
      needsYou:
        'the dev test user has no categories and the harness has no category create/cleanup yet; the stub pass covered it at 390, and life-areas’ areas scenario proves it on dev once both land',
    },
    {
      id: 'settings-long-name-390',
      entry: 'ui',
      kind: 'edge',
      what: 'A 40-character category name shrinks the rename input instead of wrapping the arrows',
      needsYou:
        'the dev test user has no categories and the harness has no category create/cleanup yet; the stub pass covered it at 390, and life-areas’ areas scenario proves it on dev once both land',
    },
    {
      id: 'desktop-unchanged-1512',
      entry: 'ui',
      kind: 'nominal',
      what: 'At 1512 the editor keeps Category, Due and Due time on one line, as before',
    },
  ],
  steps: [
    {
      id: 'setup',
      entry: 'api',
      title: 'One unscoped backlog task with a ~120-character title',
      async run(ctx) {
        await ctx.api.writes.createTask({ title: name(ctx) });
      },
    },
    {
      id: 'editor-440',
      entry: 'ui',
      proves: ['due-pair-440'],
      title: 'Backlog → open the task at 440 → Due and Due time on one line',
      async run(ctx) {
        await (await findRow(ctx, 'backlog')).click();
        await expectDuePair(ctx, 'at 440');
        await ctx.shot('editor-440');
        await closeEditor(ctx);
      },
    },
    {
      id: 'card-390',
      entry: 'ui',
      proves: ['title-two-lines-390', 'title-clamp-390', 'not-scoped-opens-390', 'due-pair-390'],
      title:
        'At 390: two-line title, Start inside the viewport, “not scoped” → Estimate, Due pair on one line',
      async run(ctx) {
        await at(ctx, FLOOR, async () => {
          const title = await findRow(ctx, 'backlog');
          await expectTwoLines(title, 'Backlog at 390');
          const start = await boxOf(
            ctx.page.getByRole('button', { name: 'Start', exact: true }),
            'Start',
          );
          if (start.x + start.width > FLOOR.width)
            throw new Error(`Start ends at x ${r(start.x + start.width)} — past the 390 viewport`);
          const scope = ctx.page.getByRole('button', { name: 'Scope', exact: true });
          if ((await scope.count()) !== 0) throw new Error('a Scope button is still on the card');
          await ctx.shot('card-390');
          await ctx.page.getByRole('button', { name: 'not scoped', exact: true }).click();
          const dialog = dialogOf(ctx);
          await dialog.getByLabel('Estimate (min)').waitFor({ timeout: 10_000 });
          const focused = await ctx.page.evaluate<string>(
            `(document.activeElement && document.activeElement.closest('label') || {}).textContent || ''`,
          );
          if (!focused.startsWith('Estimate'))
            throw new Error(`“not scoped” opened on ${JSON.stringify(focused)}, not Estimate`);
          await expectDuePair(ctx, 'at 390');
          await ctx.shot('editor-390');
          await closeEditor(ctx);
        });
      },
    },
    {
      id: 'today-390',
      entry: 'ui',
      proves: ['today-in-progress-390'],
      title: 'Start it → Today lens at 390 → the in-progress card’s title wraps too',
      async run(ctx) {
        await at(ctx, FLOOR, async () => {
          await findRow(ctx, 'backlog');
          await ctx.page.getByRole('button', { name: 'Start', exact: true }).click();
          await ctx.page
            .getByRole('button', { name: 'Done', exact: true })
            .waitFor({ timeout: 15_000 });
          const title = await findRow(ctx, 'today');
          await ctx.page
            .getByRole('button', { name: 'Done', exact: true })
            .waitFor({ timeout: 15_000 });
          await expectTwoLines(title, 'Today at 390');
          await ctx.shot('today-390');
        });
      },
    },
    {
      id: 'desktop-1512',
      entry: 'ui',
      proves: ['desktop-unchanged-1512'],
      title: 'At 1512 the editor is as before: Estimate + Buffer + Category, then the Due pair',
      // Measured on main (2026-11-05): the Due pair already sat on its own line under Category at 1512.
      async run(ctx) {
        await at(ctx, DESKTOP, async () => {
          await (await findRow(ctx, 'today')).click();
          const dialog = dialogOf(ctx);
          await expectDuePair(ctx, 'at 1512');
          const estimate = await boxOf(dialog.getByLabel('Estimate (min)'), 'Estimate');
          // The <label> wraps the <select>, so its accessible name carries the chosen option too.
          const category = await boxOf(
            dialog.getByRole('combobox', { name: /^Category/ }),
            'Category',
          );
          if (!sameLine(category, estimate))
            throw new Error(
              `Category at y ${r(category.y)}, Estimate at y ${r(estimate.y)} — not one line`,
            );
          await ctx.shot('editor-1512');
          await closeEditor(ctx);
        });
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
