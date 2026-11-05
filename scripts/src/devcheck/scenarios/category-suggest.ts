// The editor's category suggestion (docs/areas/tasks/task-editor.md → Category suggestion): seed two
// run categories and 24 categorised tasks with their own vocabulary (synthetic — never a real title), then
// open uncategorised tasks whose titles do and don't match. Categories go in first: cleanup runs
// newest-first, so the tasks go before the categories they sit on. Titles use `devcheck-cat <nonce> …`,
// never `devcheck <nonce>` — the parts scenarios sweep that prefix. The /tasks search text persists
// across lenses, so every open searches for its own task and the last step clears it.
import { noConsoleErrors, type Ctx, type Scenario } from '../scenario';

const GARDEN = [
  'water the tomato beds',
  'prune the rose hedge',
  'spread mulch on the border',
  'sow carrot seeds',
  'stake the bean poles',
  'weed the herb patch',
  'repot the fern',
  'trim the lawn edge',
  'turn the compost heap',
  'plant tulip bulbs',
  'net the berry bushes',
  'rake the fallen leaves',
];
const KITCHEN = [
  'descale the kettle',
  'sharpen the chef knife',
  'clean the oven racks',
  'restock the pantry shelf',
  'season the cast skillet',
  'defrost the freezer drawer',
  'wipe the range hood',
  'sort the spice rack',
  'replace the sink filter',
  'scrub the cutting board',
  'organise the baking tins',
  'degrease the stove top',
];
const MATCH = 'mulch the tomato beds';
const CANCEL = 'prune the tomato hedge';
const STRANGER = 'quarterly filing';

const name = (ctx: Ctx, what: string) => `devcheck-cat ${ctx.nonce} ${what}`;
const chipName = (label: string) => `Use suggested category ${label}`;

// Opens a task's editor from the Backlog, searched down to that task.
async function openTask(ctx: Ctx, title: string) {
  await ctx.ui.goto('/tasks?lens=backlog');
  await ctx.page.getByLabel('Search tasks').fill(title);
  const open = ctx.page.getByRole('button', { name: title, exact: true });
  await open.waitFor({ timeout: 15_000 });
  await open.click();
  const dialog = ctx.page.getByRole('dialog', { name: `Task: ${title}` });
  await dialog.getByLabel('Category').waitFor({ timeout: 10_000 });
  return dialog;
}

async function mine(ctx: Ctx, what: string) {
  const t = (await ctx.api.reads.listTasks()).find((x) => x.title === name(ctx, what));
  if (!t) throw new Error(`${what}: not on the server`);
  return t;
}

async function waitForCategory(ctx: Ctx, id: string, categoryId: string | null) {
  for (let i = 0; (await ctx.api.reads.getTask(id))?.categoryId !== categoryId; i++) {
    if (i >= 40) throw new Error(`task ${id} never reached category ${JSON.stringify(categoryId)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export const categorySuggest: Scenario = {
  id: 'category-suggest',
  title: 'Editor: tap-only category suggestion',
  tiers: ['full'],
  rows: [
    {
      id: 'accept',
      entry: 'ui',
      kind: 'nominal',
      what: 'An uncategorised task whose title matches the history shows "Garden?"; tap, Save, reload — the category is set',
    },
    {
      id: 'cancel',
      entry: 'ui',
      kind: 'edge',
      what: 'Tap the chip, then Close → "Discard unsaved changes?" → Discard: nothing written',
    },
    {
      id: 'no-match',
      entry: 'ui',
      kind: 'edge',
      what: 'A title matching nothing shows no chip; the Category select still lists every category',
    },
    {
      id: 'categorised',
      entry: 'ui',
      kind: 'edge',
      what: 'A task that already has a category shows no chip',
    },
    {
      id: 'server-copy',
      entry: 'api',
      kind: 'edge',
      what: 'After Save the server holds the accepted id; the seeded tasks are unchanged',
    },
    {
      id: 'one-category',
      entry: 'ui',
      kind: 'edge',
      what: 'A one-category history never suggests',
      offDev: {
        file: 'packages/shared/src/categorySuggest.test.ts',
        test: 'no suggestion from a one-category history',
        why: 'same path as no-match (proven on dev): only the scorer’s pure decision differs, run entirely in the named test',
      },
    },
    {
      id: 'threshold',
      entry: 'ui',
      kind: 'edge',
      what: 'Under 20 categorised tasks, no chip',
      offDev: {
        file: 'packages/shared/src/categorySuggest.test.ts',
        test: 'needs 20 categorised tasks',
        why: 'same path as no-match (proven on dev): only the scorer’s pure decision differs, run entirely in the named test',
      },
    },
    {
      id: 'retired',
      entry: 'ui',
      kind: 'edge',
      what: 'A retired category is never suggested',
      offDev: {
        file: 'packages/shared/src/categorySuggest.test.ts',
        test: 'never a retired category — its tasks leave the evidence too',
        why: 'same path as no-match (proven on dev): only the scorer’s pure decision differs, run entirely in the named test',
      },
    },
    {
      id: 'self',
      entry: 'ui',
      kind: 'edge',
      what: 'The task’s own row is never its evidence',
      offDev: {
        file: 'packages/shared/src/categorySuggest.test.ts',
        test: 'excludes the task itself from its own evidence',
        why: 'same path as no-match (proven on dev): only the scorer’s pure decision differs, run entirely in the named test',
      },
    },
    {
      id: 'week',
      entry: 'ui',
      kind: 'nominal',
      what: 'A week of real scoping: is the chip right when it speaks, and quiet enough? Decides whether the parse prompt gets examples next',
      needsYou: 'only your own backlog and a week of use can say',
    },
  ],
  steps: [
    {
      id: 'seed',
      entry: 'api',
      title: 'Two run categories, 24 categorised tasks, three uncategorised ones (API)',
      async run(ctx) {
        const garden = await ctx.api.writes.upsertCategory({ label: 'Garden', isWork: false });
        const kitchen = await ctx.api.writes.upsertCategory({ label: 'Kitchen', isWork: false });
        for (const t of GARDEN)
          await ctx.api.writes.createTask({ title: name(ctx, t), categoryId: garden.id });
        for (const t of KITCHEN)
          await ctx.api.writes.createTask({ title: name(ctx, t), categoryId: kitchen.id });
        for (const t of [MATCH, CANCEL, STRANGER])
          await ctx.api.writes.createTask({ title: name(ctx, t) });
      },
    },
    {
      id: 'chip',
      entry: 'ui',
      proves: ['accept'],
      title: 'The matching task opens with "Garden?" beside an empty Category select',
      async run(ctx) {
        const dialog = await openTask(ctx, name(ctx, MATCH));
        const chip = dialog.getByRole('button', { name: chipName('Garden') });
        await chip.waitFor({ timeout: 10_000 });
        if ((await dialog.getByLabel('Category').inputValue()) !== '')
          throw new Error('the select was pre-filled — the chip must be tap-only');
        await ctx.shot('chip');
      },
    },
    {
      id: 'accept',
      entry: 'ui',
      proves: ['accept'],
      title: 'Tap fills the select; Save persists; a reload shows the category set',
      async run(ctx) {
        const title = name(ctx, MATCH);
        const dialog = ctx.page.getByRole('dialog', { name: `Task: ${title}` });
        await dialog.getByRole('button', { name: chipName('Garden') }).click();
        const garden = (await ctx.api.reads.listCategories()).find((c) => c.label === 'Garden');
        if (!garden) throw new Error('the Garden category is not on the server');
        if ((await dialog.getByLabel('Category').inputValue()) !== garden.id)
          throw new Error('the tap did not fill the select');
        if ((await dialog.getByRole('button', { name: chipName('Garden') }).count()) !== 0)
          throw new Error('the chip stayed after the field was filled');
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        const { id } = await mine(ctx, MATCH);
        await waitForCategory(ctx, id, garden.id);
        const again = await openTask(ctx, title);
        if ((await again.getByLabel('Category').inputValue()) !== garden.id)
          throw new Error('after a reload the select does not show the saved category');
        if ((await again.getByRole('button', { name: /^Use suggested category/ }).count()) !== 0)
          throw new Error('a chip shows on a categorised task');
        await ctx.shot('accepted');
      },
    },
    {
      id: 'cancel',
      entry: 'ui',
      proves: ['cancel'],
      title: 'Tap, then Close → Discard: the server still has no category',
      async run(ctx) {
        const title = name(ctx, CANCEL);
        const dialog = await openTask(ctx, title);
        await dialog.getByRole('button', { name: chipName('Garden') }).click();
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        const confirm = ctx.page.getByRole('dialog', { name: 'Discard unsaved changes?' });
        await confirm.waitFor({ timeout: 10_000 });
        await confirm.getByRole('button', { name: 'Discard' }).click();
        await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
        const { id, categoryId } = await mine(ctx, CANCEL);
        if (categoryId != null) throw new Error(`task ${id} was written: ${categoryId}`);
      },
    },
    {
      id: 'no-match',
      entry: 'ui',
      proves: ['no-match'],
      title: 'A stranger title: no chip, every category still offered',
      async run(ctx) {
        const dialog = await openTask(ctx, name(ctx, STRANGER));
        if ((await dialog.getByRole('button', { name: /^Use suggested category/ }).count()) !== 0)
          throw new Error('a chip shows on a title nothing matches');
        const options = dialog.getByLabel('Category').locator('option');
        const labels: string[] = [];
        for (let i = 0, n = await options.count(); i < n; i++)
          labels.push((await options.nth(i).textContent()) ?? '');
        for (const l of ['Garden', 'Kitchen'])
          if (!labels.includes(l)) throw new Error(`the select lost ${l}: ${labels.join(', ')}`);
        await ctx.shot('no-chip');
      },
    },
    {
      id: 'categorised',
      entry: 'ui',
      proves: ['categorised'],
      title: 'A seeded (categorised) task: no chip',
      async run(ctx) {
        const dialog = await openTask(ctx, name(ctx, KITCHEN[0]!));
        if ((await dialog.getByRole('button', { name: /^Use suggested category/ }).count()) !== 0)
          throw new Error('a chip shows on a categorised task');
        await ctx.page.getByLabel('Search tasks').fill(''); // leave /tasks clean for the next scenario
      },
    },
    {
      id: 'server-copy',
      entry: 'api',
      proves: ['server-copy'],
      title: 'The server: the accepted task holds Garden; two seeded tasks are as seeded',
      async run(ctx) {
        const cats = await ctx.api.reads.listCategories();
        const id = (label: string) => cats.find((c) => c.label === label)?.id;
        const accepted = await ctx.api.reads.getTask((await mine(ctx, MATCH)).id);
        if (accepted?.categoryId !== id('Garden'))
          throw new Error(`accepted task holds ${JSON.stringify(accepted?.categoryId)}`);
        for (const [what, label] of [
          [GARDEN[0]!, 'Garden'],
          [KITCHEN[0]!, 'Kitchen'],
        ] as const) {
          const t = await ctx.api.reads.getTask((await mine(ctx, what)).id);
          if (t?.categoryId !== id(label)) throw new Error(`${what} moved to ${t?.categoryId}`);
        }
      },
    },
    noConsoleErrors,
  ],
};
