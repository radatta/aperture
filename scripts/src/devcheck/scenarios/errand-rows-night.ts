// Errands stay out of the night review (docs/areas/tasks/places.md D3): an errand checked off on its store's
// list — with or without an estimate — never shows under Home → Today in review's "Done today · estimate vs
// actual", while a task finished today does. Titles use `devcheck-en <nonce>`, never `devcheck <nonce>` — the
// parts scenarios sweep that prefix; the place's name and slug carry an `N` so they never meet places'.
// Everything is ledgered at create (the place, both errands through the API, the timed task through MCP) and
// cleaned up by id.
import type { DevPlace } from '../api';
import { noConsoleErrors, type Ctx, type Scenario } from '../scenario';

const name = (ctx: Ctx, what: string) => `devcheck-en ${ctx.nonce} ${what}`;
const placeName = (ctx: Ctx) => `Devcheck ${ctx.nonce} N`;
const placeSlug = (ctx: Ctx) => `devcheck-${ctx.nonce.toLowerCase()}-n`;

// Steps share what earlier ones made; a failed step skips the rest, so these are set when read.
let place: DevPlace;
let errandIds: string[];

const checkOff = (ctx: Ctx, what: string) =>
  ctx.page
    .getByRole('region', { name: placeName(ctx), exact: true })
    .getByRole('button', { name: `Check off ${name(ctx, what)}`, exact: true });

export const errandRowsNight: Scenario = {
  id: 'errand-rows-night',
  title: 'A checked-off errand stays out of the night review’s Done today',
  tiers: ['full'],
  rows: [
    {
      id: 'errand-absent',
      entry: 'ui',
      kind: 'nominal',
      what: 'An errand checked off on its list isn’t in the night Done today; a task finished today is',
    },
    {
      id: 'estimated-errand-absent',
      entry: 'ui',
      kind: 'edge',
      what: 'An errand with a locked estimate is left out too — not shown as “no estimate”',
    },
    {
      id: 'errand-only-day',
      entry: 'ui',
      kind: 'edge',
      what: 'A day whose only finished tasks are errands shows no Done today heading',
      offDev: {
        file: 'app/src/pages/Home/Night.test.tsx',
        test: 'a day of only errands shows no Done today section',
        why: 'dev can’t produce it: the test user’s day holds other scenarios’ finished tasks until the run’s cleanup; only the filter feeding the heading is new, and errand-absent proves it on dev',
      },
    },
  ],
  steps: [
    {
      id: 'setup',
      entry: 'api',
      title: 'A place with two errands (one estimated); a task finished today through MCP',
      async run(ctx) {
        place = await ctx.api.writes.upsertPlace({ name: placeName(ctx), slug: placeSlug(ctx) });
        const plain = await ctx.api.writes.createTask({
          title: name(ctx, 'plain'),
          place: place.slug,
        });
        const est = await ctx.api.writes.createTask({
          title: name(ctx, 'est'),
          place: place.slug,
          estimateMin: 15,
        });
        errandIds = [plain.id, est.id];
        const timed = await ctx.mcp.writes.createTask({
          title: name(ctx, 'timed'),
          estimateMin: 10,
        });
        const { task } = await ctx.mcp.writes.completeTask(timed.id, 10);
        if (task.status !== 'done')
          throw new Error(`complete_task returned ${JSON.stringify(task)}`);
      },
    },
    {
      id: 'ui-check-off',
      entry: 'ui',
      title: 'Check both errands off on the store’s list, the way the user does',
      async run(ctx) {
        await ctx.ui.goto(`/tasks?lens=places&place=${place.slug}`);
        for (const what of ['plain', 'est']) {
          const check = checkOff(ctx, what);
          await check.click({ timeout: 15_000 });
          await ctx.ui.expectText(`Checked off “${name(ctx, what)}”.`, 15_000);
          await check.waitFor({ state: 'hidden', timeout: 10_000 });
        }
      },
    },
    {
      id: 'server-done',
      entry: 'api',
      title: 'Both errands are done on the server, still placed; the estimated one locked',
      async run(ctx) {
        // Keeps the night's absence from being vacuous: the errands really are done today.
        for (let i = 0; ; i++) {
          const got = await Promise.all(errandIds.map((id) => ctx.api.reads.getTask(id)));
          const ok =
            got.every((t) => t?.status === 'done' && t.place === place.slug) &&
            got[1]?.estimateLockedMin === 15;
          if (ok) break;
          if (i >= 30) throw new Error(`the server has ${JSON.stringify(got)}`);
          await new Promise((r) => setTimeout(r, 500));
        }
      },
    },
    {
      id: 'ui-night',
      entry: 'ui',
      proves: ['errand-absent', 'estimated-errand-absent'],
      title: 'Night → Today in review lists the finished task and neither errand',
      async run(ctx) {
        await ctx.ui.goto('/');
        await ctx.page.getByRole('button', { name: 'Night', exact: true }).click();
        await ctx.ui.expectText('Today in review', 15_000);
        // The errands come in the same tasks read as this row, so once it shows their absence is real.
        await ctx.ui.expectText(name(ctx, 'timed'), 15_000);
        for (const what of ['plain', 'est']) {
          const n = await ctx.page.getByText(name(ctx, what)).count();
          if (n > 0) throw new Error(`the errand “${what}” shows ${n}× on the night Home`);
        }
        await ctx.page.getByText(name(ctx, 'timed')).scrollIntoViewIfNeeded();
        await ctx.shot('night-review');
      },
    },
    noConsoleErrors,
  ],
};
