// Consistent read-then-write on the deployed BFF: a second write straight after a first — a reorder, a
// day-row field, a category edit — keeps what the first one wrote (PR 77 made task reads consistent; this
// covers plans, the day row, categories; settings, stories and habits ride the same repo change, unit-
// tested). Plus PR 77's Right-now nit: a timed part's second line at phone width. Tasks and the category
// come from the API (ledger-recorded).
//
// A category is a ledger kind (DEV-CHECK.md → What it guarantees): recorded from the create's id
// (`via: api:upsertCategory`), deleted with deleteCategory(id, null). Cleanup runs newest-first and the category
// is made after the run's tasks, so it goes before them — a run task on a run category would make the delete
// refuse, so no scenario puts one there. The day row (capacity, intent) is the test user's own, set through the
// UI and put back as found in the step's finally — a singleton, nothing to ledger (an intent that was never set
// comes back as ''; the API has no null intent).
import type { DevCategory } from '../api';
import { datesFor, noConsoleErrors, type Ctx, type Scenario } from '../scenario';

const name = (ctx: Ctx, what: string) => `devcheck ${ctx.nonce} ${what}`;
const PLANNED = ['pA', 'pB', 'pC', 'pD'] as const; // four planned rows: Big 3 + one "Also today"
let cat: DevCategory | undefined; // the run's category, from the API create (never a UI create, so not in createdIds)

// The app's today (its day starts at the test user's dayStartHour, not midnight).
async function appToday(ctx: Ctx): Promise<string> {
  const { dayStartHour } = await ctx.api.reads.getSettings();
  return datesFor(new Date(Date.now() - dayStartHour * 3_600_000)).today;
}

// The nearest row around a title: the first ancestor div that holds a button (Start / Focus this).
const rowOf = (ctx: Ctx, title: string) =>
  ctx.page.getByText(title, { exact: true }).locator('xpath=ancestor::div[.//button][1]');

// The CSS "·" a second-line piece carries (RightNowCard RowText) — `::before` content, or "none".
const beforeContent = (ctx: Ctx, text: string) =>
  ctx.page.evaluate<string>(
    `(() => { const el = [...document.querySelectorAll('span')].find((s) => s.textContent?.trim().startsWith(${JSON.stringify(text)})); return el ? getComputedStyle(el, '::before').content : 'missing'; })()`,
  );

async function inView(ctx: Ctx, text: string | RegExp, row: ReturnType<typeof rowOf>) {
  const piece = row.getByText(text).first();
  await piece.waitFor({ state: 'visible', timeout: 15_000 });
  const box = await piece.boundingBox();
  const width = await ctx.page.evaluate<number>('window.innerWidth');
  if (!box || box.width < 8 || box.x < 0 || box.x + box.width > width + 0.5)
    throw new Error(`${String(text)} is not fully in view: ${JSON.stringify(box)} of ${width}`);
  return box;
}

export const partsV2bReads: Scenario = {
  id: 'parts-v2b-reads',
  title: 'A write straight after another keeps both',
  tiers: ['full'],
  rows: [
    {
      id: 'reorder',
      entry: 'ui',
      kind: 'nominal',
      what: '“Focus this” on two rows straight after each other → each task once after a reload, one live plan row each',
    },
    {
      id: 'aborted-write',
      entry: 'ui',
      kind: 'edge',
      what: 'One write of a “Focus this” never reaches the server (a real dropped request), then a reload → each row once, two share an order; the next tap heals it',
    },
    {
      id: 'reload-mid-write',
      entry: 'api',
      kind: 'edge',
      what: 'A read landing inside a plan move sees the row once, never none',
      offDev: {
        file: 'lambdas/src/backend.test.ts',
        test: 'a reader during a plan move sees the row once, at every step',
        why: 'only a read between the move’s two writes shows it; the in-memory doc reads at each write',
      },
    },
    {
      id: 'move-put-fails',
      entry: 'api',
      kind: 'edge',
      what: 'A plan move whose put fails → the row stays where it was',
      offDev: {
        file: 'lambdas/src/backend.test.ts',
        test: 'a plan move whose put fails keeps the row where it was',
        why: 'dev’s table has no way to fail one write of a move',
      },
    },
    {
      id: 'move-delete-fails',
      entry: 'api',
      kind: 'edge',
      what: 'A plan move whose delete fails → one row, at the new spot, in reads and the next write',
      offDev: {
        file: 'lambdas/src/backend.test.ts',
        test: 'a plan move whose delete fails leaves one row: the new spot wins every read and the next write',
        why: 'dev’s table has no way to fail one write of a move',
      },
    },
    {
      id: 'second-tap',
      entry: 'ui',
      kind: 'edge',
      what: 'A second “Focus this” while the first’s writes are out → it waits; orders stay distinct',
      offDev: {
        file: 'app/src/pages/Home/RightNow.test.tsx',
        test: 'a second “Focus this” waits for the first; the server’s orders stay distinct',
        why: 'the tie needs one response held back and plan ids out of order; only the stub holds a write open',
      },
    },
    {
      id: 'day-row',
      entry: 'ui',
      kind: 'edge',
      what: 'Hours available today, then the Day intent straight after → both survive a reload',
    },
    {
      id: 'category',
      entry: 'ui',
      kind: 'edge',
      what: 'Rename a category, then Make it work straight after → the new name is kept (Settings)',
    },
    // The lag itself is never producible on dev (its DynamoDB is consistent within a request's time on
    // demand); these rows are the in-memory doc's lagging-reads cases, one per written-back row kind.
    {
      id: 'habit',
      entry: 'api',
      kind: 'edge',
      what: 'A habit checked then unchecked at once → no check left',
      offDev: {
        file: 'lambdas/src/backend.test.ts',
        test: 'a habit unchecked straight after a check leaves no check, and the reverse re-checks it',
        why: 'dev’s DynamoDB rarely lags on demand; the lag is modelled on the in-memory doc',
      },
    },
    {
      id: 'unplan',
      entry: 'api',
      kind: 'edge',
      what: 'A plan removed straight after a reorder is gone, not left at its new spot',
      offDev: {
        file: 'lambdas/src/backend.test.ts',
        test: 'a plan removed straight after a reorder is gone, not left at its new spot',
        why: 'dev’s DynamoDB rarely lags on demand; the lag is modelled on the in-memory doc',
      },
    },
    {
      id: 'reflection',
      entry: 'api',
      kind: 'edge',
      what: 'A reflection straight after an intent keeps the intent',
      offDev: {
        file: 'lambdas/src/backend.test.ts',
        test: 'a reflection straight after an intent keeps the intent',
        why: 'dev’s DynamoDB rarely lags on demand; the lag is modelled on the in-memory doc',
      },
    },
    {
      id: 'delete-category',
      entry: 'api',
      kind: 'edge',
      what: 'Deleting a category straight after a rename tombstones the renamed row',
      offDev: {
        file: 'lambdas/src/backend.test.ts',
        test: 'deleting a category straight after a rename tombstones the renamed row',
        why: 'dev’s DynamoDB rarely lags on demand; the lag is modelled on the in-memory doc',
      },
    },
    {
      id: 'settings',
      entry: 'api',
      kind: 'edge',
      what: 'A settings patch straight after another keeps both',
      offDev: {
        file: 'lambdas/src/backend.test.ts',
        test: 'a settings patch straight after another keeps both',
        why: 'dev’s DynamoDB rarely lags on demand; the lag is modelled on the in-memory doc',
      },
    },
    {
      id: 'story',
      entry: 'api',
      kind: 'edge',
      what: 'A story patch straight after a rename keeps the title; a delete tombstones the renamed row',
      offDev: {
        file: 'lambdas/src/backend.test.ts',
        test: 'a story patch straight after a rename keeps the title; a delete tombstones the renamed row',
        why: 'dev’s DynamoDB rarely lags on demand; the lag is modelled on the in-memory doc',
      },
    },
    {
      id: 'series',
      entry: 'api',
      kind: 'edge',
      what: 'A series deactivated straight after a rename keeps the name',
      offDev: {
        file: 'lambdas/src/backend.test.ts',
        test: 'a series deactivated straight after a rename keeps the name',
        why: 'dev’s DynamoDB rarely lags on demand; the lag is modelled on the in-memory doc',
      },
    },
    {
      id: 'part-row',
      entry: 'ui',
      kind: 'nominal',
      what: 'A timed part on Right now at phone width reads “of <parent> · ends … · due …”, every piece in view',
    },
    {
      id: 'plain-row',
      entry: 'ui',
      kind: 'edge',
      what: 'A plain timed task’s row beside it is unchanged: “by <time>”, no “of”, no “·”',
    },
  ],
  steps: [
    {
      id: 'setup',
      entry: 'api',
      title: 'Four planned tasks, a timed parent + part and a plain timed task due today (API)',
      async run(ctx) {
        const today = await appToday(ctx);
        for (const [order, what] of PLANNED.entries()) {
          const t = await ctx.api.writes.createTask({ title: name(ctx, what), estimateMin: 15 });
          await ctx.api.writes.upsertPlan({ taskId: t.id, day: today, plannedMinutes: 15, order });
        }
        const p = await ctx.api.writes.createTask({
          title: name(ctx, 'Essay final draft'),
          dueDay: today,
          dueTime: '23:59',
        });
        await ctx.api.writes.createTask({
          title: name(ctx, 'intro'),
          parentId: p.id,
          dueDay: today,
          dueTime: '23:57',
        });
        await ctx.api.writes.createTask({
          title: name(ctx, 'OA2'),
          dueDay: today,
          dueTime: '23:58',
        });
      },
    },
    {
      id: 'reorder',
      entry: 'ui',
      proves: ['reorder'],
      title: 'Home › Right now: “Focus this” on the fourth row, then on the one it displaced',
      async run(ctx) {
        await ctx.ui.goto('/');
        await ctx.page.getByRole('button', { name: 'Daytime' }).click();
        await ctx.ui.expectText(name(ctx, 'pD'), 15_000);
        await rowOf(ctx, name(ctx, 'pD')).getByRole('button', { name: 'Focus this' }).click();
        // pC takes pD's "Also today" spot once the plan refetches; its button appears then, enabled once
        // the first tap's writes are done (the click waits for that).
        await rowOf(ctx, name(ctx, 'pC')).getByRole('button', { name: 'Focus this' }).click();
        // pD's button back and enabled: the second tap's writes are answered, so the reload and the server
        // read below judge the final order. A read inside a move is reload-mid-write's row.
        const pD = rowOf(ctx, name(ctx, 'pD')).getByRole('button', { name: 'Focus this' });
        await pD.waitFor({ state: 'visible', timeout: 15_000 });
        for (let i = 0; await pD.isDisabled(); i++) {
          if (i > 150)
            throw new Error('“Focus this” stayed disabled for 15 s after the second tap');
          await new Promise((r) => setTimeout(r, 100));
        }
        await ctx.page.reload();
        await ctx.page.getByRole('button', { name: 'Daytime' }).click();
        await ctx.ui.expectText(name(ctx, 'pD'), 15_000);
        for (const what of PLANNED) {
          const n = await ctx.page.getByText(name(ctx, what), { exact: true }).count();
          if (n !== 1) throw new Error(`${what} shows ${n} times after the reload`);
        }
        await ctx.shot('reorder');
      },
    },
    {
      id: 'server-plans',
      entry: 'api',
      proves: ['reorder'],
      title: 'One live plan row per task, distinct orders',
      async run(ctx) {
        const today = await appToday(ctx);
        const mine = new Set(
          (await ctx.api.reads.listTasks())
            .filter((t) => PLANNED.some((w) => t.title === name(ctx, w)))
            .map((t) => t.id),
        );
        const rows = (await ctx.api.reads.listPlansForDay(today)).filter((p) => mine.has(p.taskId));
        const tasks = new Set(rows.map((r) => r.taskId));
        const orders = new Set(rows.map((r) => r.order));
        if (rows.length !== 4 || tasks.size !== 4 || orders.size !== 4)
          throw new Error(`plan rows: ${JSON.stringify(rows.map((r) => [r.taskId, r.order]))}`);
      },
    },
    {
      id: 'aborted-write',
      entry: 'ui',
      proves: ['aborted-write'],
      title:
        'A dropped write of a “Focus this”, then a reload: each row once, a tie on the server; the next tap heals it',
      async run(ctx) {
        const today = await appToday(ctx);
        const mine = new Set(
          (await ctx.api.reads.listTasks())
            .filter((t) => PLANNED.some((w) => t.title === name(ctx, w)))
            .map((t) => t.id),
        );
        const orders = async () =>
          (await ctx.api.reads.listPlansForDay(today))
            .filter((p) => mine.has(p.taskId))
            .map((p) => p.order);
        const until = async (what: string, ok: (o: number[]) => boolean) => {
          let last: number[] = [];
          for (let i = 0; i < 75; i++) {
            last = await orders();
            if (ok(last)) return;
            await new Promise((r) => setTimeout(r, 200));
          }
          throw new Error(`${what}: orders ${JSON.stringify(last)}`);
        };
        const distinct = (o: number[]) => new Set(o).size;
        const dropped = await ctx.intercept('upsertPlan', { abort: true, times: 1 });
        try {
          await rowOf(ctx, name(ctx, 'pD')).getByRole('button', { name: 'Focus this' }).click();
          await ctx.ui.expectText("Couldn't save that — try again.", 15_000);
          if (dropped.hits() !== 1 || dropped.passed() !== 1)
            throw new Error(`upsertPlan: ${dropped.hits()} dropped, ${dropped.passed()} sent`);
        } finally {
          await dropped.release();
        }
        await until('the sent write to leave a tie', (o) => o.length === 4 && distinct(o) === 3);
        await ctx.page.reload();
        await ctx.page.getByRole('button', { name: 'Daytime' }).click();
        await ctx.ui.expectText(name(ctx, 'pD'), 15_000);
        for (const what of PLANNED) {
          const n = await ctx.page.getByText(name(ctx, what), { exact: true }).count();
          if (n !== 1) throw new Error(`${what} shows ${n} times with a tie`);
        }
        await ctx.shot('tie');
        const offers = [];
        for (const what of PLANNED) {
          const b = rowOf(ctx, name(ctx, what)).getByRole('button', { name: 'Focus this' });
          if (await b.count()) offers.push(b);
        }
        if (offers.length !== 1) throw new Error(`${offers.length} rows offer “Focus this”`);
        await offers[0]!.click();
        await until('the next tap to heal the tie', (o) => o.length === 4 && distinct(o) === 4);
      },
    },
    {
      id: 'day-row',
      entry: 'ui',
      proves: ['day-row'],
      title: 'Today lens: Hours available, then Home › Morning: the Day intent; reload shows both',
      async run(ctx) {
        const today = await appToday(ctx);
        const prior = await ctx.api.reads.getDay(today);
        const hours = prior.capacityHours === 5 ? 6 : 5;
        const intent = name(ctx, 'intent');
        try {
          await ctx.ui.goto('/tasks');
          const field = ctx.page.getByLabel('Hours available today', { exact: true });
          await field.fill(String(hours));
          await field.press('Enter');
          // The write is in flight; a page navigation would drop it — wait for the server to hold it,
          // then type the intent straight after.
          for (let i = 0; (await ctx.api.reads.getDay(today)).capacityHours !== hours; i++) {
            if (i > 40) throw new Error('capacity never reached the server');
            await new Promise((r) => setTimeout(r, 250));
          }
          await ctx.ui.goto('/');
          await ctx.page.getByRole('button', { name: 'Morning' }).click();
          const box = ctx.page.getByLabel('Day intent', { exact: true });
          await box.fill(intent);
          await box.press('Enter');
          for (let i = 0; (await ctx.api.reads.getDay(today)).intent !== intent; i++) {
            if (i > 40) throw new Error('the intent never reached the server');
            await new Promise((r) => setTimeout(r, 250));
          }
          await ctx.page.reload();
          await ctx.page.getByRole('button', { name: 'Morning' }).click();
          const shown = ctx.page.getByLabel('Day intent', { exact: true });
          await shown.waitFor({ state: 'visible', timeout: 15_000 });
          for (let i = 0; (await shown.inputValue()) !== intent; i++) {
            if (i > 40) throw new Error(`intent after reload: “${await shown.inputValue()}”`);
            await new Promise((r) => setTimeout(r, 250));
          }
          await ctx.shot('day-intent');
          await ctx.ui.goto('/tasks');
          const after = ctx.page.getByLabel('Hours available today', { exact: true });
          await after.waitFor({ state: 'visible', timeout: 15_000 });
          for (let i = 0; (await after.inputValue()) !== String(hours); i++) {
            if (i > 40) throw new Error(`capacity after reload: “${await after.inputValue()}”`);
            await new Promise((r) => setTimeout(r, 250));
          }
          const day = await ctx.api.reads.getDay(today);
          if (day.capacityHours !== hours || day.intent !== intent)
            throw new Error(`server has ${JSON.stringify(day)}`);
        } finally {
          // The test user's own row: put back what was there.
          await ctx.api.writes.setDayCapacity(today, prior.capacityHours);
          await ctx.api.writes.setDayIntent(today, prior.intent ?? '');
        }
      },
    },
    {
      id: 'category-setup',
      entry: 'api',
      title: 'A non-work category (API, ledgered)',
      async run(ctx) {
        cat = await ctx.api.writes.upsertCategory({ label: name(ctx, 'cat'), isWork: false });
      },
    },
    {
      id: 'category',
      entry: 'ui',
      proves: ['category'],
      title:
        'Settings: rename it, then Make work › Just going forward straight after; reload keeps the name',
      async run(ctx) {
        const label = name(ctx, 'cat');
        const renamed = `${label} renamed`;
        await ctx.ui.goto('/settings');
        const field = ctx.page.getByRole('textbox', { name: `Rename ${label}`, exact: true });
        await field.fill(renamed);
        await field.press('Tab'); // blur commits the rename
        // The menu's name follows the label once the list refetches — match either.
        await ctx.page
          .getByRole('button', { name: new RegExp(`^More actions for ${label}`) })
          .click();
        await ctx.page.getByRole('menuitem', { name: 'Make work…' }).click();
        // Armed before the tap and awaited before the reload below, which otherwise can drop the write: on
        // 2026-11-05 the flip never reached a Lambda when the rename's refetch had already renamed the field.
        const flipped = ctx.page.waitForResponse((r) => r.url().endsWith('/api/setCategoryWork'), {
          timeout: 15_000,
        });
        await ctx.page.getByRole('button', { name: 'Just going forward', exact: true }).click();
        const res = await flipped;
        if (res.status() !== 200) throw new Error(`setCategoryWork answered ${res.status()}`);
        await ctx.page
          .getByRole('textbox', { name: `Rename ${renamed}`, exact: true })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await ctx.page.reload();
        await ctx.page
          .getByRole('textbox', { name: `Rename ${renamed}`, exact: true })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await ctx.shot('category');
      },
    },
    {
      id: 'server-category',
      entry: 'api',
      proves: ['category'],
      title: 'The server has the new name and the work flag',
      async run(ctx) {
        const renamed = `${name(ctx, 'cat')} renamed`;
        const found = (await ctx.api.reads.listCategories()).find((c) => c.id === cat?.id);
        if (!found) throw new Error('the server has no such category');
        if (found.label !== renamed || found.isWork !== true)
          throw new Error(`server has ${JSON.stringify(found)}`);
      },
    },
    {
      id: 'part-row',
      entry: 'ui',
      proves: ['part-row', 'plain-row'],
      title: 'Home › Right now › By time: the part’s second line, and the plain row beside it',
      async run(ctx) {
        await ctx.ui.goto('/');
        await ctx.page.getByRole('button', { name: 'Daytime' }).click();
        await ctx.ui.expectText(name(ctx, 'intro'), 15_000);
        const row = rowOf(ctx, name(ctx, 'intro'));
        const of = await inView(ctx, new RegExp(`^of ${name(ctx, 'Essay')}`), row);
        const ends = await inView(ctx, 'ends 11:57pm', row);
        const due = await inView(ctx, /^due 11:59pm/, row);
        if (!(of.x + of.width <= ends.x + 0.5 && ends.x + ends.width <= due.x + 0.5))
          throw new Error('the second line is not “of … · ends … · due …” left to right');
        const dots = [
          await beforeContent(ctx, 'ends 11:57pm'),
          await beforeContent(ctx, 'due 11:59pm'),
        ];
        if (!dots.every((d) => d.includes('·')))
          throw new Error(`no “·” before: ${dots.join(' | ')}`);
        const plain = rowOf(ctx, name(ctx, 'OA2'));
        await inView(ctx, 'by 11:58pm', plain);
        const text = (await plain.textContent()) ?? '';
        if (/\bof /.test(text) || text.includes('·')) throw new Error(`plain row reads “${text}”`);
        const plainDot = await beforeContent(ctx, 'by 11:58pm');
        if (plainDot.includes('·')) throw new Error('the plain row grew a “·”');
        await ctx.shot('part-row');
      },
    },
    noConsoleErrors,
  ],
};
