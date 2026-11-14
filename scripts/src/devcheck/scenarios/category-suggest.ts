// The editor's category suggestion (docs/areas/tasks/task-editor.md → Category suggestion): seed two
// run categories and 27 categorised tasks with their own vocabulary (synthetic — never a real title), then
// open uncategorised tasks whose titles do and don't match. Categories go in first: cleanup runs
// newest-first, so the tasks go before the categories they sit on. Titles use `devcheck-cat <nonce> …`,
// never `devcheck <nonce>` — the parts scenarios sweep that prefix. The /tasks search text persists
// across lenses, so every open searches for its own task and the last step clears it.
// The Review preview's chip (docs/areas/tasks/quick-add.md) has no grammar path: Review always asks the
// model. Four rows go end to end through the real parse (the `real-*` steps and the Simulator's, a fraction of a cent a run):
// they assert what holds whatever the model says (a preview, no error, the slot agrees with what lands) and
// nothing of its wording. Rows that need an exact reply (the scorer's cases need a parse with no category,
// which the model won't reliably give) get a canned one from ctx.intercept; each row's text says why.
import type { IosOp } from '../../mailroom/sim.ts';
import type { PwLocator } from '../pw-types';
import { laDay, noConsoleErrors, type Ctx, type Scenario } from '../scenario';
import { DOCK, MODE_ROW } from '../ios';
import { CATEGORY_SUGGEST_PATHS } from './ios-paths';

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
  // Words that say nothing of gardens: the real parse has no reason to file a line of them under Garden,
  // so its Review reaches the chip, and only this history can place it. Review titles use them because
  // three examples clear the margin on two words; "tomato beds", on one example each, doesn't (2 nats).
  'oil the flux gasket',
  'check the flux gasket',
  'swap the flux gasket',
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
const R_ACCEPT = 'hoe the flux gasket';
const R_DECLINE = 'feed the flux gasket';
const R_EDIT = 'dig the flux gasket';
const R_NAMED = 'edge the flux gasket';
const R_STRANGER = 'annual filing';
const R_PROBE = 'till the flux gasket';
const R_AUTO = 'rake the flux gasket';
const R_GRAMMAR = 'lime the flux gasket';
const R_FAILED = 'net the flux gasket';
const R_RETRY = 'tie the flux gasket';
const R_ROLLOVER = 'hill the flux gasket';
const R_TODAY = 'thin the flux gasket';
const R_MODE = 'seed the flux gasket';
const R_REAL_CHIP = 'torque the flux gasket';
// The Simulator's own line: a verb no other step saves. A full run's real-review can file its line under
// another category (the model matches the run nonce to another scenario's category), and the same words
// then outvote Garden; measured, this one still clears the margin after every earlier save (2.8 nats).
const R_SIM_CHIP = 'shim the flux gasket';
const R_REAL_NAMED = 'kitchen, polish the flux gasket';
const R_REAL_AUTO = 'grease the flux gasket';
const R_LONG =
  'hoe the flux gasket and then walk the long way back past the shed to fetch the other tool';

// The slice of @aperture/shared's ParseTaskResult the canned replies carry (scripts doesn't depend on shared).
type ParseReply =
  | {
      ok: true;
      source: 'haiku';
      input: { title: string; categoryId?: string };
      categoryLabel: string | null;
      placeName: null;
      dropped: string[];
      today: string;
    }
  | { ok: false; reason: 'unavailable' };

// Why a row's parse is canned, in the row's own words on the report.
const NO_CATEGORY =
  'Canned parse: needs a reply with no category, which the model won’t reliably give.';

const name = (ctx: Ctx, what: string) => `devcheck-cat ${ctx.nonce} ${what}`;
const chipName = (label: string) => `Use suggested category ${label}`;
// By role, never getByLabel: that also matches the chip's aria-label, as a substring. The <label> wraps
// the <select>, so its accessible name carries the options too; hence the prefix.
const categorySelect = (dialog: PwLocator) => dialog.getByRole('combobox', { name: /^Category/ });
const placeSelect = (dialog: PwLocator) => dialog.getByRole('combobox', { name: /^Place\b/ });

// Opens a task's editor from the Backlog, searched down to that task.
async function openTask(ctx: Ctx, title: string) {
  await ctx.ui.goto('/tasks?lens=backlog');
  await ctx.page.getByLabel('Search tasks').fill(title);
  const open = ctx.page.getByRole('button', { name: title, exact: true });
  await open.waitFor({ timeout: 15_000 });
  await open.click();
  const dialog = ctx.page.getByRole('dialog', { name: `Task: ${title}` });
  await categorySelect(dialog).waitFor({ timeout: 10_000 });
  // The page load refetches categories, and until they land the select holds only Uncategorized and no
  // chip can show; the row above already waited on the task list. Both loaded, a "no chip" means something.
  await categorySelect(dialog)
    .locator('option:text-is("Garden")')
    .waitFor({ state: 'attached', timeout: 10_000 });
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

// The app's day (todayKey(dayStartHour)): the bar drops a preview parsed against any other day.
async function appToday(ctx: Ctx, daysAgo = 0) {
  const { dayStartHour } = await ctx.api.reads.getSettings();
  return laDay(new Date(Date.now() - dayStartHour * 3_600_000 - daysAgo * 86_400_000));
}

const captureField = (ctx: Ctx) => ctx.page.locator('textarea[aria-label="Capture task"]');

async function openTaskBar(ctx: Ctx) {
  await ctx.ui.goto('/tasks');
  await ctx.page.getByRole('button', { name: 'Task', exact: true }).click();
}

// The parse's reply for a title; the harness serves it, so no Review reaches the model.
async function parsed(ctx: Ctx, title: string, category?: { id: string; label: string }) {
  return {
    ok: true,
    source: 'haiku',
    input: category ? { title, categoryId: category.id } : { title },
    categoryLabel: category?.label ?? null,
    placeName: null,
    dropped: [],
    today: await appToday(ctx),
  } satisfies ParseReply;
}

// One Review of this title, its parse answered by the harness. Waits on the button a shown preview turns
// Review into, never the title's text: the field holds that too, and releasing the route before the
// request lands would send it to the real model.
async function review(ctx: Ctx, title: string, category?: { id: string; label: string }) {
  const parse = await ctx.intercept('parseTask', {
    status: 200,
    times: 1,
    body: await parsed(ctx, title, category),
  });
  await captureField(ctx).fill(title);
  await ctx.page.getByRole('button', { name: 'Review before saving' }).click();
  await ctx.page.getByRole('button', { name: 'Save reviewed task' }).waitFor({ timeout: 10_000 });
  await parse.release();
  if (parse.hits() !== 1) throw new Error(`parseTask answered ${parse.hits()} times, not once`);
}

// A Review through the real model. A failed parse gets one press of its own Retry: an outage isn't this
// feature's bug, though a second failure is the row's.
async function realReview(ctx: Ctx, line: string) {
  const save = ctx.page.getByRole('button', { name: 'Save reviewed task' });
  const retry = ctx.page.getByRole('button', { name: 'Retry parse' });
  await captureField(ctx).fill(line);
  await ctx.page.getByRole('button', { name: 'Review before saving' }).click();
  await save.or(retry).first().waitFor({ timeout: 15_000 });
  if (await retry.isVisible()) {
    ctx.log('the real parse failed once; pressing Retry parse');
    await retry.click();
    await save.waitFor({ timeout: 15_000 });
  }
}

// The newest create in the ledger after `before`: the model may reword a title, so never found by title.
async function newestTask(ctx: Ctx, before: string | undefined) {
  for (let i = 0; i < 40; i++) {
    const id = ctx.createdIds().at(-1);
    if (id && id !== before) {
      const t = await ctx.api.reads.getTask(id);
      if (t) return t;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('the create response never reached the ledger');
}

// What holds whatever the model said: the preview's slot (chip, a category, or "no category") agrees with what
// lands, and the title the preview showed is the title saved. Returns which slot it was, for the log.
async function saveRealReview(ctx: Ctx) {
  const shown = await ctx.page.locator('div[aria-live="polite"]:not([role])').first().textContent();
  const cats = await ctx.api.reads.listCategories();
  const chip = anyChip(ctx);
  const suggested = (await chip.count())
    ? (await chip.first().getAttribute('aria-label'))?.replace('Use suggested category ', '')
    : undefined;
  const none = (await ctx.page.getByText('no category', { exact: true }).count()) !== 0;
  if (suggested) await chip.first().click();
  const before = ctx.createdIds().at(-1);
  await captureField(ctx).press('Enter');
  await ctx.ui.expectText(/Task added/, 15_000);
  const t = await newestTask(ctx, before);
  if (!t.title || !shown?.includes(t.title))
    throw new Error(`the preview showed “${shown}”, the server saved “${t.title}”`);
  if (suggested) {
    if (t.categoryId !== cats.find((c) => c.label === suggested)?.id)
      throw new Error(`took ${suggested}, saved under ${t.categoryId}`);
  } else if (none ? t.categoryId != null : t.categoryId == null)
    throw new Error(`preview said ${none ? 'no category' : 'a category'}, saved ${t.categoryId}`);
  return suggested ? `chip ${suggested}` : none ? 'no category' : 'the model’s category';
}

const anyChip = (ctx: Ctx) => ctx.page.getByRole('button', { name: /^Use suggested category/ });

// The bar's task list loads when a chip first mounts, and "no chip" means nothing until it has: a matching
// Review shows the chip, so the absence after it is the scorer's answer, not a list still on its way.
async function barWithHistory(ctx: Ctx) {
  await openTaskBar(ctx);
  await review(ctx, name(ctx, R_PROBE));
  await ctx.page.getByRole('button', { name: chipName('Garden') }).waitFor({ timeout: 15_000 });
}

// The sim types through its own keyboard, so the line is the fixed words of R_REAL_CHIP, no nonce. Nothing is
// saved. The field and the chip are found by scanning: the preview lifts the bar by its own height.
// Opens with its own launch: run last, it can't count on ios-standalone leaving the sim up.
// A filled field reads as its value, and only over its text, with no textarea role (as ios-standalone
// finds 'zzqx'). Scanned down from the top, so the field wins over the preview's copy of the title below
// it, wherever the dock sits.
const REVIEW_KEYBOARD: IosOp[] = [
  { op: 'launch' },
  { op: 'signIn' },
  // A warm app holds the task list it loaded earlier in the run, before this scenario seeded its history.
  { op: 'kill', method: 'terminate' },
  { op: 'launch' },
  { op: 'nav', tab: 'Home' },
  { op: 'tap', label: 'Capture', near: { x: 220, y: 895 }, radius: 10 },
  // 4 s, not 2: since the mode-row scan starts at MODE_ROW (315) it can read the Task toggle mid-settle (y 374/402 on
  // 2026-11-12, against 464 settled), and a tap there misses the moving dock and blurs the field (jobs …011648Z…-8c62,
  // …010744Z…-6102). ios-standalone's CAPTURE waits 4 for the same settle.
  { op: 'wait', s: 4 },
  { op: 'tap', label: 'Task', scan: DOCK(110, MODE_ROW), role: 'AXCheckBox' },
  { op: 'keys', text: R_SIM_CHIP },
  { op: 'tap', label: 'Review before saving', scan: DOCK(355) },
  { op: 'wait', s: 6 },
  { op: 'shot', name: 'review-chip' },
  {
    op: 'find',
    label: R_SIM_CHIP,
    scan: { x: 60, from: 300, to: 600 },
    as: 'bar0',
  },
  { op: 'expect', as: 'bar0', aboveKeyboard: true },
  {
    op: 'find',
    label: 'Use suggested category',
    scan: { x: 195, from: 300, to: 600 },
    role: 'AXButton',
    as: 'chip',
  },
  { op: 'expect', as: 'chip', aboveKeyboard: true },
  {
    op: 'tap',
    label: 'Use suggested category',
    scan: { x: 195, from: 300, to: 600 },
    role: 'AXButton',
  },
  { op: 'wait', s: 1 },
  { op: 'shot', name: 'review-chip-tapped' },
  {
    op: 'find',
    label: R_SIM_CHIP,
    scan: { x: 60, from: 300, to: 600 },
    as: 'bar',
  },
  { op: 'expect', as: 'bar', aboveKeyboard: true },
  { op: 'absent', label: 'Use suggested category', scan: { x: 195, from: 300, to: 600 } },
  { op: 'shot', name: 'review-chip-taken' },
  { op: 'erase', n: R_SIM_CHIP.length },
  { op: 'tap', label: 'Log', scan: DOCK(49, MODE_ROW), role: 'AXCheckBox' },
  { op: 'blur' },
];

export const categorySuggest: Scenario = {
  id: 'category-suggest',
  title: 'Editor and Review preview: tap-only category suggestion',
  tiers: ['full'],
  slowPaths: CATEGORY_SUGGEST_PATHS,
  rows: [
    {
      id: 'accept',
      entry: 'ui',
      kind: 'nominal',
      what: 'An uncategorised task whose title matches the history shows "Garden?"; tap, Save, reload — the category is set',
    },
    {
      id: 'steady',
      entry: 'ui',
      kind: 'edge',
      what: 'At phone width the tap removes the chip and moves nothing else: Category, Place and the Due field stay where they were',
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
      what: 'A title with nothing distinctive in it shows no chip; the Category select still lists every category',
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
      id: 'review-accept',
      entry: 'ui',
      kind: 'nominal',
      what: `Review of a line the parse left uncategorised shows "Garden?" for "no category"; the tap writes nothing; the next press saves it under Garden. ${NO_CATEGORY}`,
    },
    {
      id: 'review-steady',
      entry: 'ui',
      kind: 'edge',
      what: `At phone width the tap moves nothing: the capture field stays where it was. ${NO_CATEGORY}`,
    },
    {
      id: 'review-decline',
      entry: 'ui',
      kind: 'edge',
      what: `Saving a Review without the tap stays uncategorised (never pre-selected). ${NO_CATEGORY}`,
    },
    {
      id: 'review-edit',
      entry: 'ui',
      kind: 'edge',
      what: `Tap, then edit the text: the preview and the taken category go, nothing is written; the next Review offers the chip again. ${NO_CATEGORY}`,
    },
    {
      id: 'review-stranger',
      entry: 'ui',
      kind: 'edge',
      what: `A title matching nothing keeps "no category" and shows no chip. ${NO_CATEGORY}`,
    },
    {
      id: 'review-named',
      entry: 'ui',
      kind: 'edge',
      what: 'A parse that found a category shows it and no chip, even when the history says otherwise. Canned parse: needs Kitchen on a Garden-worded title, a disagreement the model won’t stage on request.',
    },
    {
      id: 'review-long',
      entry: 'ui',
      kind: 'edge',
      what: `With a title that wraps at phone width, the tap still moves nothing. ${NO_CATEGORY}`,
    },
    {
      id: 'review-retry',
      entry: 'ui',
      kind: 'edge',
      what: `Tap, then the create fails: the text comes back with the taken category, and the retry saves under it. ${NO_CATEGORY}`,
    },
    {
      id: 'review-auto',
      entry: 'ui',
      kind: 'edge',
      what: `Enter with no Review saves uncategorised: it never takes a suggestion. ${NO_CATEGORY}`,
    },
    {
      id: 'review-grammar',
      entry: 'ui',
      kind: 'edge',
      what: 'A grammar line shows no chip',
    },
    {
      id: 'review-failed',
      entry: 'ui',
      kind: 'edge',
      what: 'A failed parse shows no chip. Canned parse: a failure the model won’t produce on demand.',
    },
    {
      id: 'real-review',
      entry: 'ui',
      kind: 'nominal',
      what: 'Real parse into Review, words only the history can place: a preview, no error; the slot (chip, a category, or "no category") agrees with what lands',
    },
    {
      id: 'real-named',
      entry: 'ui',
      kind: 'edge',
      what: 'Real parse into Review of a line naming a category: the same agreement, and a chip only if the model left the category empty',
    },
    {
      id: 'real-auto',
      entry: 'ui',
      kind: 'nominal',
      what: 'Real parse behind Enter with no Review: the task lands with a title, and no chip ever shows',
    },
    {
      id: 'review-rollover',
      entry: 'ui',
      kind: 'edge',
      what: 'A parse from before the 4am rollover is never saved: no preview shows, and the next press parses again. Canned parse: needs yesterday’s day in the reply.',
    },
    {
      id: 'review-today',
      entry: 'ui',
      kind: 'edge',
      what: `Tap, then "→ today": planned today under the taken category. ${NO_CATEGORY}`,
    },
    {
      id: 'review-mode',
      entry: 'ui',
      kind: 'edge',
      what: `Tap, then switch to Log and back: the taken category is gone. ${NO_CATEGORY}`,
    },
    {
      id: 'review-keyboard',
      entry: 'ios',
      kind: 'nominal',
      what: 'iPhone PWA, real parse: Review a line, tap the chip: the keyboard stays up, the field stays above it, the chip goes',
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
      title: 'Two run categories, a place, 27 categorised tasks, three uncategorised ones (API)',
      async run(ctx) {
        const garden = await ctx.api.writes.upsertCategory({ label: 'Garden', isWork: false });
        const kitchen = await ctx.api.writes.upsertCategory({ label: 'Kitchen', isWork: false });
        // The Place select only renders with a place on the roster, and it's what the old layout moved.
        await ctx.api.writes.upsertPlace({ name: `Devcheck ${ctx.nonce} Shed` });
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
      title: 'The matching task opens with "Garden?" above an empty Category select',
      async run(ctx) {
        const dialog = await openTask(ctx, name(ctx, MATCH));
        const chip = dialog.getByRole('button', { name: chipName('Garden') });
        await chip.waitFor({ timeout: 10_000 });
        await placeSelect(dialog).waitFor({ timeout: 10_000 });
        if ((await categorySelect(dialog).inputValue()) !== '')
          throw new Error('the select was pre-filled — the chip must be tap-only');
        await ctx.shot('chip');
      },
    },
    {
      id: 'accept',
      entry: 'ui',
      proves: ['accept', 'steady'],
      title:
        'Tap fills the select and moves nothing else; Save persists; a reload shows the category set',
      async run(ctx) {
        const title = name(ctx, MATCH);
        const dialog = ctx.page.getByRole('dialog', { name: `Task: ${title}` });
        const tops = async () => [
          (await categorySelect(dialog).boundingBox())?.y,
          (await placeSelect(dialog).boundingBox())?.y,
          (await dialog.getByLabel('Due', { exact: true }).boundingBox())?.y,
        ];
        const before = await tops();
        await dialog.getByRole('button', { name: chipName('Garden') }).click();
        const after = await tops();
        if (before.includes(undefined) || before.join() !== after.join())
          throw new Error(`the tap moved the form: ${before.join()} → ${after.join()}`);
        const garden = (await ctx.api.reads.listCategories()).find((c) => c.label === 'Garden');
        if (!garden) throw new Error('the Garden category is not on the server');
        if ((await categorySelect(dialog).inputValue()) !== garden.id)
          throw new Error('the tap did not fill the select');
        if ((await dialog.getByRole('button', { name: chipName('Garden') }).count()) !== 0)
          throw new Error('the chip stayed after the field was filled');
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        const { id } = await mine(ctx, MATCH);
        await waitForCategory(ctx, id, garden.id);
        const again = await openTask(ctx, title);
        if ((await categorySelect(again).inputValue()) !== garden.id)
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
        const options = categorySelect(dialog).locator('option');
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
    {
      id: 'review-chip',
      entry: 'ui',
      proves: ['review-accept', 'review-steady'],
      title:
        'Review → "Garden?"; the tap moves nothing and writes nothing; the next press saves it',
      async run(ctx) {
        const title = name(ctx, R_ACCEPT);
        await openTaskBar(ctx);
        await review(ctx, title);
        const chip = ctx.page.getByRole('button', { name: chipName('Garden') });
        await chip.waitFor({ timeout: 15_000 });
        if ((await ctx.page.getByText('no category', { exact: true }).count()) !== 0)
          throw new Error('"no category" still shows beside the chip');
        await ctx.shot('review-chip');
        const before = (await captureField(ctx).boundingBox())?.y;
        await chip.click();
        const label = ctx.page.getByText('#Garden', { exact: true });
        await label.waitFor({ timeout: 5_000 });
        const after = (await captureField(ctx).boundingBox())?.y;
        if (before === undefined || before !== after)
          throw new Error(`the tap moved the capture field: ${before} → ${after}`);
        if ((await anyChip(ctx).count()) !== 0) throw new Error('the chip stayed after the tap');
        if ((await ctx.api.reads.listTasks()).some((t) => t.title === title))
          throw new Error('the tap saved the task');
        await ctx.shot('review-taken');
        await ctx.page.getByRole('button', { name: 'Save reviewed task' }).click();
        await ctx.ui.expectText(/Task added/, 15_000);
        const garden = (await ctx.api.reads.listCategories()).find((c) => c.label === 'Garden');
        const { id } = await mine(ctx, R_ACCEPT);
        await waitForCategory(ctx, id, garden!.id);
      },
    },
    {
      id: 'review-decline',
      entry: 'ui',
      proves: ['review-decline'],
      title: 'Review, no tap, Enter: saved with no category',
      async run(ctx) {
        await openTaskBar(ctx);
        await review(ctx, name(ctx, R_DECLINE));
        await ctx.page
          .getByRole('button', { name: chipName('Garden') })
          .waitFor({ timeout: 15_000 });
        await captureField(ctx).press('Enter');
        await ctx.ui.expectText(/Task added/, 15_000);
        const t = await mine(ctx, R_DECLINE);
        if (t.categoryId != null) throw new Error(`saved under ${t.categoryId}`);
      },
    },
    {
      id: 'review-edit',
      entry: 'ui',
      proves: ['review-edit'],
      title:
        'Tap, then edit: the taken category goes, nothing written; the next Review offers it again',
      async run(ctx) {
        const title = name(ctx, R_EDIT);
        await openTaskBar(ctx);
        await review(ctx, title);
        await ctx.page.getByRole('button', { name: chipName('Garden') }).click();
        const label = ctx.page.getByText('#Garden', { exact: true });
        await label.waitFor({ timeout: 5_000 });
        await captureField(ctx).fill(`${title} x`);
        await label.waitFor({ state: 'hidden', timeout: 5_000 });
        await review(ctx, `${title} y`);
        await ctx.page
          .getByRole('button', { name: chipName('Garden') })
          .waitFor({ timeout: 10_000 });
        if ((await label.count()) !== 0) throw new Error('the taken category came back by itself');
        await captureField(ctx).fill('');
        if ((await ctx.api.reads.listTasks()).some((t) => t.title.startsWith(title)))
          throw new Error('an unsaved Review reached the server');
      },
    },
    {
      id: 'review-stranger',
      entry: 'ui',
      proves: ['review-stranger'],
      title: 'A stranger title: "no category", no chip',
      async run(ctx) {
        await barWithHistory(ctx);
        await review(ctx, name(ctx, R_STRANGER));
        await ctx.page.getByText('no category', { exact: true }).waitFor({ timeout: 10_000 });
        if ((await anyChip(ctx).count()) !== 0) throw new Error('a chip shows on a stranger title');
        await captureField(ctx).fill('');
      },
    },
    {
      id: 'review-named',
      entry: 'ui',
      proves: ['review-named'],
      title: 'A parse that found Kitchen on a Garden-worded title: #Kitchen, no chip',
      async run(ctx) {
        const kitchen = (await ctx.api.reads.listCategories()).find((c) => c.label === 'Kitchen');
        if (!kitchen) throw new Error('the Kitchen category is not on the server');
        await barWithHistory(ctx);
        await review(ctx, name(ctx, R_NAMED), kitchen);
        await ctx.page.getByText('#Kitchen', { exact: true }).waitFor({ timeout: 10_000 });
        if ((await anyChip(ctx).count()) !== 0) throw new Error('a chip shows beside a category');
        await captureField(ctx).fill('');
      },
    },
    {
      id: 'review-long',
      entry: 'ui',
      proves: ['review-long'],
      title: 'A title that wraps: the tap leaves the field where it was',
      async run(ctx) {
        await openTaskBar(ctx);
        await review(ctx, name(ctx, R_LONG));
        const chip = ctx.page.getByRole('button', { name: chipName('Garden') });
        await chip.waitFor({ timeout: 15_000 });
        const before = (await captureField(ctx).boundingBox())?.y;
        await chip.click();
        await ctx.page.getByText('#Garden', { exact: true }).waitFor({ timeout: 5_000 });
        const after = (await captureField(ctx).boundingBox())?.y;
        if (before === undefined || before !== after)
          throw new Error(`the tap moved the capture field: ${before} → ${after}`);
        await ctx.shot('review-long-taken');
        await captureField(ctx).fill('');
      },
    },
    {
      id: 'review-retry',
      entry: 'ui',
      proves: ['review-retry'],
      title:
        'Tap, the create fails once: the text and #Garden are back; the retry saves under Garden',
      async run(ctx) {
        const title = name(ctx, R_RETRY);
        await openTaskBar(ctx);
        await review(ctx, title);
        await ctx.page.getByRole('button', { name: chipName('Garden') }).click({ timeout: 15_000 });
        const create = await ctx.intercept('createTask', { status: 500, times: 1 });
        await ctx.page.getByRole('button', { name: 'Save reviewed task' }).click();
        const label = ctx.page.getByText('#Garden', { exact: true });
        await label.waitFor({ timeout: 15_000 });
        await create.release();
        if ((await captureField(ctx).inputValue()) !== title)
          throw new Error('the failed create did not put the text back');
        await captureField(ctx).press('Enter');
        await ctx.ui.expectText(/Task added/, 15_000);
        const garden = (await ctx.api.reads.listCategories()).find((c) => c.label === 'Garden');
        const { id } = await mine(ctx, R_RETRY);
        await waitForCategory(ctx, id, garden!.id);
      },
    },
    {
      id: 'review-auto',
      entry: 'ui',
      proves: ['review-auto'],
      title: 'Enter with no Review: saved with no category',
      async run(ctx) {
        const title = name(ctx, R_AUTO);
        await openTaskBar(ctx);
        const parse = await ctx.intercept('parseTask', {
          status: 200,
          times: 1,
          body: await parsed(ctx, title),
        });
        await captureField(ctx).fill(title);
        await captureField(ctx).press('Enter');
        await ctx.ui.expectText(/Task added/, 15_000);
        await parse.release();
        if (parse.hits() !== 1) throw new Error('the Auto save never asked for its parse');
        const t = await mine(ctx, R_AUTO);
        if (t.categoryId != null) throw new Error(`saved under ${t.categoryId}`);
      },
    },
    {
      id: 'review-grammar',
      entry: 'ui',
      proves: ['review-grammar'],
      title: 'A grammar line on a matching title: no chip',
      async run(ctx) {
        await barWithHistory(ctx);
        await captureField(ctx).fill(`${name(ctx, R_GRAMMAR)} | ~30`);
        await ctx.page.getByRole('button', { name: 'Save reviewed task' }).waitFor({
          state: 'hidden',
          timeout: 5_000,
        });
        if ((await anyChip(ctx).count()) !== 0) throw new Error('a chip shows on a grammar line');
        await captureField(ctx).fill('');
      },
    },
    {
      id: 'review-failed',
      entry: 'ui',
      proves: ['review-failed'],
      title: 'A failed parse of a matching title: its error, no chip',
      async run(ctx) {
        await barWithHistory(ctx);
        const parse = await ctx.intercept('parseTask', {
          status: 200,
          times: 1,
          body: { ok: false, reason: 'unavailable' } satisfies ParseReply,
        });
        await captureField(ctx).fill(name(ctx, R_FAILED));
        await ctx.page.getByRole('button', { name: 'Review before saving' }).click();
        await ctx.page.getByText(/Couldn’t parse/).waitFor({ timeout: 10_000 });
        await parse.release();
        if ((await anyChip(ctx).count()) !== 0) throw new Error('a chip shows on a failed parse');
        await captureField(ctx).fill('');
      },
    },
    {
      id: 'review-rollover',
      entry: 'ui',
      proves: ['review-rollover'],
      title: 'A reply from yesterday: no preview; Enter parses again and saves that reply',
      async run(ctx) {
        const title = name(ctx, R_ROLLOVER);
        await openTaskBar(ctx);
        const reply = await parsed(ctx, title);
        const stale = await ctx.intercept('parseTask', {
          status: 200,
          times: 1,
          body: { ...reply, input: { title: `${title} stale` }, today: await appToday(ctx, 1) },
        });
        await captureField(ctx).fill(title);
        await ctx.page.getByRole('button', { name: 'Review before saving' }).click();
        for (let i = 0; stale.hits() === 0; i++) {
          if (i >= 40) throw new Error('the Review never asked for its parse');
          await new Promise((r) => setTimeout(r, 250));
        }
        await stale.release();
        await new Promise((r) => setTimeout(r, 500)); // the reply reaches the bar
        if ((await ctx.page.getByRole('button', { name: 'Save reviewed task' }).count()) !== 0)
          throw new Error('yesterday’s parse shows as a preview');
        const fresh = await ctx.intercept('parseTask', { status: 200, times: 1, body: reply });
        await captureField(ctx).press('Enter');
        await ctx.ui.expectText(/Task added/, 15_000);
        await fresh.release();
        if (fresh.hits() !== 1) throw new Error('Enter saved without parsing again');
        await mine(ctx, R_ROLLOVER); // the fresh reply's title, not the stale one's
      },
    },
    {
      id: 'review-today',
      entry: 'ui',
      proves: ['review-today'],
      title: 'Tap, "→ today", save: on today’s plan under Garden',
      async run(ctx) {
        const title = name(ctx, R_TODAY);
        await openTaskBar(ctx);
        await review(ctx, title);
        await ctx.page.getByRole('button', { name: chipName('Garden') }).click({ timeout: 15_000 });
        // By its title: the Tasks page's own "Today" filter also matches a name of /today/i.
        const toToday = ctx.page.locator('button[title="Put this task on today\'s plan"]');
        await toToday.click();
        if ((await toToday.getAttribute('aria-pressed')) !== 'true')
          throw new Error('"→ today" did not turn on');
        await captureField(ctx).press('Enter');
        await ctx.ui.expectText(/Task added/, 15_000);
        const garden = (await ctx.api.reads.listCategories()).find((c) => c.label === 'Garden');
        const { id } = await mine(ctx, R_TODAY);
        await waitForCategory(ctx, id, garden!.id);
        const plans = await ctx.api.reads.listPlansForDay(await appToday(ctx));
        if (!plans.some((p) => p.taskId === id)) throw new Error('the task is not on today’s plan');
      },
    },
    {
      id: 'review-mode',
      entry: 'ui',
      proves: ['review-mode'],
      title: 'Tap, Log, back to Task: no #Garden, and the bar asks for a new Review',
      async run(ctx) {
        const title = name(ctx, R_MODE);
        await openTaskBar(ctx);
        await review(ctx, title);
        await ctx.page.getByRole('button', { name: chipName('Garden') }).click({ timeout: 15_000 });
        const label = ctx.page.getByText('#Garden', { exact: true });
        await label.waitFor({ timeout: 5_000 });
        await ctx.page.getByRole('button', { name: 'Log', exact: true }).click();
        await ctx.page.getByRole('button', { name: 'Task', exact: true }).click();
        await ctx.page
          .getByRole('button', { name: 'Review before saving' })
          .waitFor({ timeout: 5_000 });
        if ((await label.count()) !== 0) throw new Error('the taken category survived the switch');
        await captureField(ctx).fill('');
      },
    },
    {
      id: 'real-review',
      entry: 'ui',
      proves: ['real-review'],
      title: 'The real parse into Review; what the slot says is what lands',
      async run(ctx) {
        await barWithHistory(ctx);
        await realReview(ctx, name(ctx, R_REAL_CHIP));
        await ctx.shot('real-review');
        ctx.log(`real Review: ${await saveRealReview(ctx)}`);
      },
    },
    {
      id: 'real-named',
      entry: 'ui',
      proves: ['real-named'],
      title: 'The real parse into Review of a line naming a category; same agreement',
      async run(ctx) {
        await barWithHistory(ctx);
        await realReview(ctx, `${R_REAL_NAMED} ${ctx.nonce}`);
        ctx.log(`real Review, named: ${await saveRealReview(ctx)}`);
      },
    },
    {
      id: 'real-auto',
      entry: 'ui',
      proves: ['real-auto'],
      title: 'The real parse behind Enter: a task lands, no chip',
      async run(ctx) {
        await openTaskBar(ctx);
        const before = ctx.createdIds().at(-1);
        await captureField(ctx).fill(name(ctx, R_REAL_AUTO));
        await captureField(ctx).press('Enter');
        await ctx.ui.expectText(/Task added/, 20_000);
        const t = await newestTask(ctx, before);
        if (!t.title) throw new Error('the task landed with no title');
        if ((await anyChip(ctx).count()) !== 0) throw new Error('a chip shows after an Auto save');
      },
    },
    // Last: a Simulator miss fails only its own row, never the browser steps after it.
    {
      id: 'review-keyboard',
      entry: 'ios',
      cost: 'slow',
      proves: ['review-keyboard'],
      title: 'On the Simulator: Review, tap the chip; the keyboard stays up over a real parse',
      async run(ctx) {
        await ctx.ios.run('review-chip', REVIEW_KEYBOARD);
      },
    },
    noConsoleErrors,
  ],
};
