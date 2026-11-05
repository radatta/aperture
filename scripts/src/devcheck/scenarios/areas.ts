// Life areas (docs/areas/tasks/areas.md): an area on every category, set in Settings or over MCP; the Backlog
// folds the Aperture area away behind "Aperture · N", Home's "+ Add" picker lists the life backlog, Week never
// filters. The run creates its own categories (ledgered, api.ts CATEGORY_VIA — never the test user's) and
// its tasks on them; cleanup deletes the tasks, then the categories, by id. Titles use `devcheck-areas
// <nonce>`, never `devcheck <nonce>` — the parts scenarios sweep that prefix. The /tasks search text persists
// across lenses (sessionStorage), so each lens step clears what it typed. The rows are the plan's dev-test
// matrix (localNotes/plan.md) plus dispatch's Settings-at-390 row for phone-nits.
import { PHONE } from '../browser';
import type { DevCategory, DevTask } from '../api';
import { noConsoleErrors, type Ctx, type Scenario } from '../scenario';

const title = (ctx: Ctx, what: string) => `devcheck-areas ${ctx.nonce} ${what}`;
const catLabel = (ctx: Ctx, which: 'A' | 'B') => `Devcheck areas ${ctx.nonce} ${which}`;
// 390×844 is the narrowest phone the UI pass covers (browser.ts); the Settings rows must keep their arrows there.
const NARROW = { width: 390, height: 844 } as const;

let catA: DevCategory; // gets the Aperture area in Settings, then School over MCP
let catB: DevCategory; // never given an area: reads as Personal
// Its tasks, found on screen by title: `dev` on A, undated — folds away on Backlog; `fri` on A, due
// tomorrow — Week shows it whatever the fold; `hw` on B — the life backlog.

async function serverCategory(ctx: Ctx, id: string): Promise<DevCategory> {
  const c = (await ctx.api.reads.listCategories()).find((x) => x.id === id);
  if (!c) throw new Error(`category ${id} is not on the server`);
  return c;
}

// The server's copy of a category's area, polled: a Settings tap writes through the page.
async function waitForArea(ctx: Ctx, id: string, area: DevCategory['area'], what: string) {
  for (let i = 0; (await serverCategory(ctx, id)).area !== area; i++) {
    if (i >= 40) throw new Error(`${what}: the server never read area ${String(area)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// The chip's accessible name ("Aperture area · N"); the group header reads "Aperture · N".
const apertureChip = (ctx: Ctx) => ctx.page.getByRole('button', { name: /^Aperture area · \d+$/ });
const taskButton = (ctx: Ctx, what: string) =>
  ctx.page.getByRole('button', { name: title(ctx, what), exact: true });

async function clearSearch(ctx: Ctx) {
  await ctx.page.getByLabel('Search tasks').fill('');
}

export const areas: Scenario = {
  id: 'areas',
  title:
    'Life areas: set in Settings and over MCP, the Backlog folds Aperture away, Week never filters',
  tiers: ['full'],
  rows: [
    {
      id: 'settings-area',
      entry: 'ui',
      kind: 'nominal',
      what: 'Settings › Area… › Aperture on a category: one write, the row reads "Work · Aperture"',
    },
    {
      id: 'settings-arrows-390',
      entry: 'ui',
      kind: 'edge',
      what: 'Settings › Categories at 390 px: a row’s Move up / Move down arrows are on screen (before any typing)',
    },
    {
      id: 'backlog-hides',
      entry: 'ui',
      kind: 'nominal',
      what: 'Backlog hides the Aperture-area task; the chip reads "Aperture · N"; a search still finds it',
    },
    {
      id: 'chip-shows',
      entry: 'ui',
      kind: 'nominal',
      what: 'Tapping the chip shows the task; it stays shown across a reload (the session); tapping again folds it',
    },
    {
      id: 'chip-day-reset',
      entry: 'ui',
      kind: 'edge',
      what: 'The chip’s state resets on a new day',
      offDev: {
        file: 'app/src/modules/tasks/useTaskQuery.test.ts',
        test: 'yesterday’s shown-Aperture query is gone today',
        why: 'the day can’t turn during a dev run; same stored-query path as chip-shows (proven on dev)',
      },
    },
    {
      id: 'no-area-personal',
      entry: 'ui',
      kind: 'edge',
      what: 'A category with no area reads Personal in Settings and its task shows on Backlog',
    },
    {
      id: 'retired-keeps-area',
      entry: 'api',
      kind: 'edge',
      what: 'Retiring a category keeps its area; restoring it keeps it too',
    },
    {
      id: 'aperture-in-week',
      entry: 'ui',
      kind: 'edge',
      what: 'An Aperture-area task due this week sits in Week — the fold is Backlog’s only',
    },
    {
      id: 'home-picker',
      entry: 'ui',
      kind: 'nominal',
      what: 'Home "+ Add" lists the life backlog without the Aperture-area task; typing finds it',
    },
    {
      id: 'home-count',
      entry: 'ui',
      kind: 'nominal',
      what: 'Home’s "N waiting in the backlog" leaves Aperture-area tasks out',
      offDev: {
        file: 'app/src/data/hooks/useTasks.test.tsx',
        test: 'leaves an Aperture-area task out; no area and a retired category read by their area',
        why: 'the count line shows only while no capacity is set for the day, which the test user may have; home-picker (proven on dev) runs the same life-backlog rule',
      },
    },
    {
      id: 'stored-query-reset',
      entry: 'ui',
      kind: 'edge',
      what: 'A session query stored before the field → Backlog loads on its preset, never crashes',
      offDev: {
        file: 'app/src/modules/tasks/useTaskQuery.test.ts',
        test: 'a stored query without areas → Backlog loads on its preset (Aperture folded away)',
        why: 'dev’s build already writes the field; only a hand-made sessionStorage value lacks it',
      },
    },
    {
      id: 'mcp-area',
      entry: 'mcp',
      kind: 'nominal',
      what: 'update_category {area: "school"} → list_categories returns it; the Backlog shows the task on reload',
    },
    {
      id: 'api-invalid-area',
      entry: 'api',
      kind: 'edge',
      what: 'setCategoryArea with a value off the set is refused and the category is unchanged',
    },
    {
      id: 'api-foreign-id',
      entry: 'api',
      kind: 'edge',
      what: 'Another user’s category id is not found; nothing is written',
      offDev: {
        file: 'lambdas/src/backend.test.ts',
        test: 'another user’s id is not found — through the real RPC dispatch — and nothing is written',
        why: 'the harness has one user; the Lambda test drives two partitions through handleRpc',
      },
    },
  ],
  steps: [
    {
      id: 'seed',
      entry: 'api',
      title: 'Two categories without an area, and three tasks on them',
      async run(ctx) {
        catA = await ctx.api.writes.upsertCategory({ label: catLabel(ctx, 'A'), isWork: true });
        catB = await ctx.api.writes.upsertCategory({ label: catLabel(ctx, 'B'), isWork: true });
        if (catA.area !== null || catB.area !== null)
          throw new Error(`a new category has an area: ${catA.area}, ${catB.area}`);
        const made: DevTask[] = [
          await ctx.api.writes.createTask({ title: title(ctx, 'dev'), categoryId: catA.id }),
          await ctx.api.writes.createTask({
            title: title(ctx, 'fri'),
            categoryId: catA.id,
            dueDay: ctx.dates.tomorrow,
          }),
          await ctx.api.writes.createTask({ title: title(ctx, 'hw'), categoryId: catB.id }),
        ];
        const ids = ctx.createdIds();
        for (const id of [catA.id, catB.id, ...made.map((t) => t.id)])
          if (!ids.includes(id)) throw new Error(`${id} never reached the ledger`);
      },
    },
    {
      id: 'settings-390',
      entry: 'ui',
      proves: ['settings-arrows-390'],
      title: 'Settings at 390 px: the run’s category rows keep their arrows on screen',
      async run(ctx) {
        await ctx.page.setViewportSize(NARROW);
        try {
          await ctx.ui.goto('/settings');
          await ctx.page
            .getByRole('textbox', { name: `Rename ${catLabel(ctx, 'A')}`, exact: true })
            .waitFor({ state: 'visible', timeout: 15_000 });
          await ctx.ui.settle();
          await ctx.shot('settings-390');
          for (const which of ['A', 'B'] as const) {
            for (const dir of ['up', 'down'] as const) {
              const arrow = ctx.page.getByRole('button', {
                name: `Move ${catLabel(ctx, which)} ${dir}`,
                exact: true,
              });
              await arrow.scrollIntoViewIfNeeded();
              const box = await arrow.boundingBox();
              if (!box || box.width < 24 || box.height < 24)
                throw new Error(
                  `Move ${which} ${dir}: ${box ? `${box.width}×${box.height}` : 'no box'}`,
                );
              if (box.x < 0 || box.x + box.width > NARROW.width)
                throw new Error(
                  `Move ${which} ${dir} is off screen at 390: x ${box.x}, w ${box.width}`,
                );
            }
          }
        } finally {
          await ctx.page.setViewportSize(PHONE);
        }
      },
    },
    {
      id: 'settings-area',
      entry: 'ui',
      proves: ['settings-area', 'no-area-personal'],
      title: 'Settings › Area… › Aperture: the row reads it, the server has it after one write',
      async run(ctx) {
        await ctx.ui.goto('/settings');
        const rowA = ctx.page
          .getByRole('textbox', { name: `Rename ${catLabel(ctx, 'A')}`, exact: true })
          .locator('xpath=ancestor::div[contains(@class,"flex-wrap")][1]');
        await rowA.waitFor({ state: 'visible', timeout: 15_000 });
        // No area yet: both rows read Personal.
        for (const which of ['A', 'B'] as const) {
          const row = ctx.page
            .getByRole('textbox', { name: `Rename ${catLabel(ctx, which)}`, exact: true })
            .locator('xpath=ancestor::div[contains(@class,"flex-wrap")][1]');
          if ((await row.getByText('Work · Personal', { exact: true }).count()) !== 1)
            throw new Error(`row ${which} doesn't read "Work · Personal" before an area is set`);
        }
        await ctx.page
          .getByRole('button', { name: `More actions for ${catLabel(ctx, 'A')}`, exact: true })
          .click();
        await ctx.page.getByRole('menuitem', { name: 'Area…', exact: true }).click();
        const panel = ctx.page.getByRole('group', { name: `Area for ${catLabel(ctx, 'A')}` });
        await panel.waitFor({ state: 'visible', timeout: 10_000 });
        const personal = panel.getByRole('button', { name: 'Personal', exact: true });
        if ((await personal.getAttribute('aria-pressed')) !== 'true')
          throw new Error('the panel opened without Personal pressed');
        await ctx.ui.settle();
        await ctx.shot('area-panel'); // untouched: Personal pressed, four chips, Close
        await panel.getByRole('button', { name: 'Aperture', exact: true }).click();
        await panel.waitFor({ state: 'hidden', timeout: 10_000 });
        await rowA
          .getByText('Work · Aperture', { exact: true })
          .waitFor({ state: 'visible', timeout: 10_000 });
        await waitForArea(ctx, catA.id, 'aperture', 'settings-area');
        if ((await serverCategory(ctx, catB.id)).area !== null)
          throw new Error('the neighbour row’s category gained an area');
        await ctx.shot('area-set');
      },
    },
    {
      id: 'backlog-folded',
      entry: 'ui',
      proves: ['backlog-hides', 'no-area-personal'],
      title: 'Backlog: the B task shows, the A task waits behind "Aperture · N", a search finds it',
      async run(ctx) {
        await ctx.ui.goto('/tasks?lens=backlog');
        await taskButton(ctx, 'hw').waitFor({ state: 'visible', timeout: 15_000 });
        const chip = apertureChip(ctx);
        await chip.waitFor({ state: 'visible', timeout: 10_000 });
        if ((await chip.getAttribute('aria-pressed')) !== 'false')
          throw new Error('the Aperture chip opened pressed — the fold is off');
        const n = Number((await chip.textContent())?.match(/\d+/)?.[0] ?? 0);
        if (n < 1)
          throw new Error(`the chip counts ${n} Aperture cards; at least the dev task is one`);
        if ((await taskButton(ctx, 'dev').count()) !== 0)
          throw new Error('the Aperture-area task is on Backlog while folded');
        if ((await taskButton(ctx, 'fri').count()) !== 0)
          throw new Error('the task due tomorrow is on Backlog, not Week');
        await ctx.shot('backlog-folded');
        await ctx.page.getByLabel('Search tasks').fill(title(ctx, 'dev'));
        await taskButton(ctx, 'dev').waitFor({ state: 'visible', timeout: 15_000 });
        await clearSearch(ctx);
        await taskButton(ctx, 'dev').waitFor({ state: 'hidden', timeout: 15_000 });
      },
    },
    {
      id: 'chip',
      entry: 'ui',
      proves: ['chip-shows'],
      title: 'The chip shows the A task, survives a reload, and folds it back',
      async run(ctx) {
        const chip = apertureChip(ctx);
        await chip.click();
        await taskButton(ctx, 'dev').waitFor({ state: 'visible', timeout: 15_000 });
        if ((await chip.getAttribute('aria-pressed')) !== 'true')
          throw new Error('the chip is not pressed while Aperture shows');
        // Still no filter: the fold widens, it never narrows.
        if ((await ctx.page.getByRole('button', { name: 'Filter', exact: true }).count()) !== 1)
          throw new Error('showing Aperture counted as a filter');
        await ctx.ui.settle();
        await ctx.shot('backlog-shown');
        await ctx.page.reload({ waitUntil: 'domcontentloaded' });
        await taskButton(ctx, 'dev').waitFor({ state: 'visible', timeout: 15_000 });
        if ((await apertureChip(ctx).getAttribute('aria-pressed')) !== 'true')
          throw new Error('the reload forgot the chip');
        await apertureChip(ctx).click();
        await taskButton(ctx, 'dev').waitFor({ state: 'hidden', timeout: 15_000 });
        await taskButton(ctx, 'hw').waitFor({ state: 'visible', timeout: 15_000 });
      },
    },
    {
      id: 'week',
      entry: 'ui',
      proves: ['aperture-in-week'],
      title: 'Week lists the Aperture-area task due tomorrow, and offers no chip',
      async run(ctx) {
        await ctx.ui.goto('/tasks?lens=week');
        await ctx.page.getByLabel('Search tasks').waitFor({ state: 'visible', timeout: 15_000 });
        if ((await apertureChip(ctx).count()) !== 0) throw new Error('Week drew an Aperture chip');
        // Searched down to the one task so the test user's own week stays out of the assert; a search
        // groups by place, so "This week · 1" is where it lives.
        await ctx.page.getByLabel('Search tasks').fill(title(ctx, 'fri'));
        await taskButton(ctx, 'fri').waitFor({ state: 'visible', timeout: 15_000 });
        await ctx.ui.expectText(/^This week · 1$/);
        await ctx.shot('week-aperture');
        await clearSearch(ctx);
        await taskButton(ctx, 'fri').waitFor({ state: 'visible', timeout: 15_000 }); // unsearched too
      },
    },
    {
      id: 'home-picker',
      entry: 'ui',
      proves: ['home-picker'],
      title: 'Home › + Add lists the B task, not the A task; typing the A task’s title finds it',
      async run(ctx) {
        await ctx.ui.goto('/');
        await ctx.page.getByRole('button', { name: 'Morning', exact: true }).click();
        await ctx.page.getByRole('button', { name: 'Add to today', exact: true }).click();
        const dialog = ctx.page.getByRole('dialog', { name: 'Add to today' });
        await dialog
          .getByText(title(ctx, 'hw'), { exact: true })
          .waitFor({ state: 'visible', timeout: 15_000 });
        if ((await dialog.getByText(title(ctx, 'dev'), { exact: true }).count()) !== 0)
          throw new Error('the Aperture-area task is in the unsearched picker');
        await ctx.shot('home-picker');
        await dialog.getByLabel('Find a task').fill(title(ctx, 'dev'));
        await dialog
          .getByRole('button', { name: `Add ${title(ctx, 'dev')} to today`, exact: true })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await dialog.getByLabel('Find a task').fill('');
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
      },
    },
    {
      id: 'mcp-area',
      entry: 'mcp',
      proves: ['mcp-area'],
      title: 'update_category area: school → list_categories (MCP and API) return it',
      async run(ctx) {
        const moved = await ctx.mcp.writes.updateCategory(catA.id, { area: 'school' });
        if (moved.area !== 'school' || moved.label !== catLabel(ctx, 'A'))
          throw new Error(`update_category answered ${JSON.stringify(moved)}`);
        const listed = (await ctx.mcp.reads.listCategories()).find((c) => c.id === catA.id);
        if (listed?.area !== 'school') throw new Error(`list_categories has ${listed?.area}`);
        if ((await serverCategory(ctx, catA.id)).area !== 'school')
          throw new Error('the API lists a different area than MCP');
      },
    },
    {
      id: 'regroup',
      entry: 'ui',
      proves: ['mcp-area'],
      title: 'Backlog on reload shows the A task under its category, no chip pressed',
      async run(ctx) {
        await ctx.ui.goto('/tasks?lens=backlog');
        await taskButton(ctx, 'dev').waitFor({ state: 'visible', timeout: 15_000 });
        await taskButton(ctx, 'hw').waitFor({ state: 'visible', timeout: 15_000 });
        const chip = apertureChip(ctx);
        if ((await chip.count()) === 1 && (await chip.getAttribute('aria-pressed')) === 'true')
          throw new Error('the task shows only because the chip is pressed');
        await ctx.shot('backlog-regrouped');
      },
    },
    {
      id: 'api-invalid',
      entry: 'api',
      proves: ['api-invalid-area'],
      title: 'setCategoryArea(id, "other") is refused; the category still reads school',
      async run(ctx) {
        const refused = await ctx.api.writes.setCategoryArea(catA.id, 'other').then(
          () => null,
          (err: unknown) => (err instanceof Error ? err.message : String(err)),
        );
        if (refused === null) throw new Error('an area off the set was accepted');
        if (!/area must be one of/.test(refused)) throw new Error(`refused with: ${refused}`);
        const after = await serverCategory(ctx, catA.id);
        if (after.area !== 'school' || after.label !== catLabel(ctx, 'A'))
          throw new Error(`the refusal changed the category: ${JSON.stringify(after)}`);
      },
    },
    {
      id: 'retired',
      entry: 'api',
      proves: ['retired-keeps-area'],
      title: 'Retire, then restore: the area rides along',
      async run(ctx) {
        const base = { id: catA.id, label: catLabel(ctx, 'A'), isWork: true };
        const retired = await ctx.api.writes.upsertCategory({ ...base, active: false });
        if (retired.active || retired.area !== 'school')
          throw new Error(`retired reads ${JSON.stringify(retired)}`);
        const restored = await ctx.api.writes.upsertCategory({ ...base, active: true });
        if (!restored.active || restored.area !== 'school')
          throw new Error(`restored reads ${JSON.stringify(restored)}`);
      },
    },
    noConsoleErrors,
  ],
};
