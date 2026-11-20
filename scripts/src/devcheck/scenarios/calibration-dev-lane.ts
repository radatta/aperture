// The Aperture calibration lane and the backfill (docs/areas/calibration/dev-lane.md): an Aperture-area point
// shows in its own lane, apart from Life; `backfill_tasks` closes old tickets on their day, marked, as points
// that never move a gap. The gap rows compare the page with an aggregate the harness computes from the API's
// points over the page's window, so other scenarios' points can't break them. Titles use `devcheck-lane
// <nonce>`; every task and the category are this run's, and the tasks go at the end (the 60-row batch would
// otherwise sit in every later scenario's lists).
import type { DevCalibrationPoint, DevTask } from '../api';
import { UNKNOWN_TASK_ID } from '../mcp/tasks';
import { laDay, noConsoleErrors, type Ctx, type Scenario } from '../scenario';

const name = (ctx: Ctx, what: string) => `devcheck-lane ${ctx.nonce} ${what}`;
const MAX = 100; // calibration.ts BACKFILL_MAX
const BATCH = 60; // the shipped-ticket table's size

const addDays = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// The page's window: its today is the app day (the day-start offset) in the user's zone, back 30 days.
async function window(ctx: Ctx) {
  const start = (await ctx.api.reads.getSettings()).dayStartHour;
  const to = laDay(new Date(Date.now() - start * 3_600_000));
  return { from: addDays(to, -30), to };
}

const ids = new Map<string, string>(); // what → task id, this run's
const id = (what: string) => {
  const v = ids.get(what);
  if (!v) throw new Error(`${what}: not set up`);
  return v;
};
let categoryId = '';
let bulk: string[] = [];

// The page's lanes as the harness expects them: scored points only (no rollup, not backfilled), per lane.
function expected(points: DevCalibrationPoint[], lane: 'life' | 'aperture') {
  const inLane = points.filter((p) => (p.area === 'aperture') === (lane === 'aperture'));
  const scored = inLane.filter((p) => !p.parts && !p.backfilled);
  const est = scored.reduce((s, p) => s + p.estimateLockedMin, 0);
  const act = scored.reduce((s, p) => s + p.actualAccruedMin, 0);
  const pct = (e: number, a: number) => {
    const n = Math.round((a / e - 1) * 100);
    return `${n > 0 ? '+' : ''}${n}%`;
  };
  const back = inLane.filter((p) => !p.parts && p.backfilled);
  const backEst = back.reduce((s, p) => s + p.estimateLockedMin, 0);
  const backAct = back.reduce((s, p) => s + p.actualAccruedMin, 0);
  return {
    headline: est > 0 ? pct(est, act) : null,
    withBackfill: est + backEst > 0 ? pct(est + backEst, act + backAct) : null,
    backfilled: back.length,
  };
}
// Every one of `want` on the server's points (the list read lags a write), over the page's window.
async function pointsWith(
  ctx: Ctx,
  want: string[],
  check: (p: DevCalibrationPoint) => boolean = () => true,
) {
  const range = await window(ctx);
  for (let i = 0; ; i++) {
    const all = await ctx.api.reads.getCalibration(range);
    if (want.every((w) => all.some((p) => p.taskId === w && check(p)))) return all;
    if (i >= 40) throw new Error(`points never showed: ${want.join(', ')}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
const lane = (ctx: Ctx, which: 'life' | 'aperture') => ctx.page.locator(`[data-lane="${which}"]`);
const headline = (ctx: Ctx, which: 'life' | 'aperture') =>
  lane(ctx, which)
    .getByText(/^[+-]?\d+%$/)
    .first();
// The page's headline for `which` once it reads `want` — a reload or two covers a read that lagged.
async function untilHeadline(ctx: Ctx, which: 'life' | 'aperture', want: string) {
  for (let i = 0; ; i++) {
    await lane(ctx, which).waitFor({ timeout: 15_000 });
    const got = (await headline(ctx, which).textContent())?.trim();
    if (got === want) return;
    if (i >= 3) throw new Error(`${which} headline reads ${got}, the API's points say ${want}`);
    await ctx.page.reload({ waitUntil: 'domcontentloaded' });
  }
}
const refused = (r: { refused: string } | { rows: unknown }) => ('refused' in r ? r.refused : null);

export const calibrationDevLane: Scenario = {
  id: 'calibration-dev-lane',
  title:
    'Aperture is its own calibration lane; backfilled tickets land on their day and never move a gap',
  tiers: ['full'],
  order: 262, // after areas and category-suggest: its done tasks never reach their lists or pickers
  rows: [
    {
      id: 'lane-shown',
      entry: 'ui',
      kind: 'nominal',
      what: 'A scored Aperture-area point (est 30, actual 60) shows an Aperture card apart from Life',
    },
    {
      id: 'lane-absent',
      entry: 'ui',
      kind: 'edge',
      what: 'With no Aperture point in the window the page is one headline, as before',
      offDev: {
        file: 'app/src/modules/calibration/CalibrationSection.test.tsx',
        test: 'with no Aperture point, one headline as it always was',
        why: 'the dev test user always has other scenarios’ points, and Deep Work-like categories may sit in the Aperture area, so dev can’t be guaranteed to have none',
      },
    },
    {
      id: 'backfill-nominal',
      entry: 'mcp',
      kind: 'nominal',
      what: 'backfill_tasks with two rows (one scoped, one given its estimate): both done, backfilled, on their completedDay',
    },
    {
      id: 'gap-unmoved',
      entry: 'ui',
      kind: 'nominal',
      what: 'The Aperture headline is the gap without the backfilled points (and differs from the gap with them); its footnote counts them',
    },
    {
      id: 'recent-hidden',
      entry: 'ui',
      kind: 'edge',
      what: 'Backfilled tickets stay out of Recent; the scored one is there',
    },
    {
      id: 'reload',
      entry: 'ui',
      kind: 'edge',
      what: 'The lane, its number and the footnote survive a reload',
    },
    {
      id: 'get-calibration',
      entry: 'mcp',
      kind: 'nominal',
      what: 'get_calibration: the backfilled point carries area aperture, backfilled true, its completedDay',
    },
    {
      id: 'get-day',
      entry: 'mcp',
      kind: 'edge',
      what: 'get_day on the completedDay: the row reads backfilled, deltaMin null, not a calibration point',
    },
    {
      id: 'invalid',
      entry: 'mcp',
      kind: 'edge',
      what: 'actual 0, a future day, an unknown id, a parent, a part, an id twice: each refused naming the row, nothing written',
    },
    {
      id: 'invalid-shapes',
      entry: 'mcp',
      kind: 'edge',
      what: 'An errand, a Roll rep, a recurring occurrence, a calendar-linked or a cancelled task is refused toward complete_task',
      offDev: {
        file: 'packages/shared/src/calibration.test.ts',
        test: 'refuses every shape with side effects, naming the row and the way round it',
        why: 'the same refusal path `invalid` proves on dev (planBackfill notPlain); making a Roll rep, a series or a calendar link on dev only to be refused costs a Google event and a series for no new path',
      },
    },
    {
      id: 'empty-max',
      entry: 'mcp',
      kind: 'edge',
      what: 'An empty batch and 101 rows are refused; a 60-row batch lands in one call (its time logged)',
    },
    {
      id: 'repeat',
      entry: 'mcp',
      kind: 'edge',
      what: 'The same batch again: every row skipped, nothing changed',
    },
    {
      id: 'mark-clear',
      entry: 'mcp',
      kind: 'edge',
      what: 'update_task backfilled: true on a done task marks its point, false clears it; true on an open task is refused',
    },
    {
      id: 'neighbour',
      entry: 'ui',
      kind: 'edge',
      what: 'A Life point finished in the same run: the Life headline is the API’s Life gap, untouched by the backfill',
    },
    {
      id: 'area-live',
      entry: 'api',
      kind: 'edge',
      what: 'Moving the category to School moves its points out of the Aperture lane on the next read',
    },
    {
      id: 'api-direct',
      entry: 'api',
      kind: 'edge',
      what: 'backfillTasks over the BFF refuses a completedDay that isn’t a date, writing nothing',
    },
    {
      id: 'ownership',
      entry: 'api',
      kind: 'edge',
      what: 'Another user’s task id reads as not found; nothing of theirs moves',
      offDev: {
        file: 'lambdas/src/backend.backfill.test.ts',
        test: 'another user’s task reads as not found, and nothing of theirs moves',
        why: 'one run signs in as one test user, so dev has no second partition to aim at',
      },
    },
    {
      id: 'legacy-row',
      entry: 'api',
      kind: 'edge',
      what: 'A stored task from before the field reads as scored',
      offDev: {
        file: 'lambdas/src/backend.backfill.test.ts',
        test: 'a stored row from before the field reads as scored',
        why: 'every task dev makes now is written by the new code; neighbour proves an unmarked point scores',
      },
    },
    {
      id: 'partial',
      entry: 'api',
      kind: 'edge',
      what: 'A batch put that dies part-way leaves what landed done; a rerun skips it and finishes the rest',
      offDev: {
        file: 'lambdas/src/backend.backfill.test.ts',
        test: 'a batch put that dies part-way leaves what landed done; a rerun skips it and finishes the rest',
        why: 'dev can’t make DynamoDB fail one batch write part-way; repeat proves the skip on dev',
      },
    },
    {
      id: 'prod-backfill',
      entry: 'mcp',
      kind: 'nominal',
      what: 'The real table of shipped dev tickets lands on prod',
      needsYou:
        'a prod write: the hub drafts the table, and backfill_tasks runs on aperture only on your explicit yes',
    },
  ],
  steps: [
    {
      id: 'setup',
      entry: 'api',
      title: 'An Aperture-area category; tasks for each case (API)',
      async run(ctx) {
        ids.clear();
        bulk = [];
        const cat = await ctx.api.writes.upsertCategory({
          label: `devcheck-lane ${ctx.nonce}`,
          isWork: true,
          area: 'aperture',
        });
        categoryId = cat.id;
        const make = async (what: string, estimateMin?: number, inCat = true) => {
          const t = await ctx.api.writes.createTask({
            title: name(ctx, what),
            ...(estimateMin ? { estimateMin } : {}),
            categoryId: inCat ? categoryId : null,
          });
          ids.set(what, t.id);
          return t;
        };
        await make('scored', 30);
        await make('livework', 30, false);
        await make('bfone', 10);
        await make('bftwo');
        await make('marked', 20);
        await make('stays', 30);
        const parent = await make('parent');
        const part = await ctx.api.writes.createTask({
          title: name(ctx, 'part'),
          estimateMin: 5,
          parentId: parent.id,
        });
        ids.set('part', part.id);
      },
    },
    {
      id: 'lane-shown',
      entry: 'ui',
      proves: ['lane-shown'],
      title:
        'Finish an Aperture task 30 → 60 and a Life one 30 → 45 (MCP); the page shows both lanes',
      async run(ctx) {
        await ctx.mcp.writes.completeTask(id('scored'), 60);
        await ctx.mcp.writes.completeTask(id('livework'), 45);
        const points = await pointsWith(ctx, [id('scored'), id('livework')]);
        const scored = points.find((p) => p.taskId === id('scored'))!;
        if (scored.area !== 'aperture' || scored.backfilled !== false)
          throw new Error(`the scored point reads ${JSON.stringify(scored)}`);
        await ctx.ui.goto('/tasks?lens=calibration');
        await untilHeadline(ctx, 'aperture', expected(points, 'aperture').headline!);
        await lane(ctx, 'life').waitFor({ timeout: 10_000 });
        await ctx.shot('lanes');
      },
    },
    {
      id: 'backfill',
      entry: 'mcp',
      proves: ['backfill-nominal', 'get-calibration'],
      title: 'backfill_tasks: two old tickets, one given its estimate, on two past days',
      async run(ctx) {
        const { to } = await window(ctx);
        const r = await ctx.mcp.writes.backfillTasks([
          { id: id('bfone'), actualMin: 300, completedDay: addDays(to, -1) },
          { id: id('bftwo'), actualMin: 45, estimateMin: 15, completedDay: addDays(to, -2) },
        ]);
        if ('refused' in r) throw new Error(`refused: ${r.refused}`);
        const want = [
          [id('bfone'), addDays(to, -1), 10],
          [id('bftwo'), addDays(to, -2), 15],
        ] as const;
        for (const [tid, day, lock] of want) {
          const row = r.rows.find((x) => x.id === tid);
          const t = row?.task;
          if (row?.outcome !== 'done' || t?.status !== 'done' || t.backfilled !== true)
            throw new Error(`${tid} came back ${JSON.stringify(row)}`);
          if (t.estimateLockedMin !== lock) throw new Error(`${tid}: lock ${t.estimateLockedMin}`);
          if (laDay(new Date(t.completedAt!)) !== day)
            throw new Error(
              `${tid}: completed ${new Date(t.completedAt!).toISOString()}, not ${day}`,
            );
        }
        const mcpPoints = await ctx.mcp.reads.getCalibration(await window(ctx));
        const p = mcpPoints.find((x) => x.taskId === id('bfone'));
        if (p?.area !== 'aperture' || p.backfilled !== true || p.day !== addDays(to, -1))
          throw new Error(`get_calibration reads ${JSON.stringify(p)}`);
      },
    },
    {
      id: 'get-day',
      entry: 'mcp',
      proves: ['get-day'],
      title: 'get_day on the completedDay: backfilled, no delta',
      async run(ctx) {
        const { to } = await window(ctx);
        const day = await ctx.mcp.reads.getDay({ day: addDays(to, -1) });
        const row = day.tasks.done.find((t) => t.id === id('bfone'));
        if (!row || row.backfilled !== true || row.deltaMin !== null || row.isCalibrationPoint)
          throw new Error(`get_day reads ${JSON.stringify(row)}`);
      },
    },
    {
      id: 'gap-unmoved',
      entry: 'ui',
      proves: ['gap-unmoved', 'recent-hidden', 'neighbour'],
      title:
        'The page: Aperture’s number leaves the backfill out and footnotes it; Life is the API’s; Recent skips it',
      async run(ctx) {
        const points = await pointsWith(
          ctx,
          [id('bfone'), id('bftwo'), id('scored'), id('livework')],
          (p) => p.taskId !== id('bfone') || p.backfilled === true,
        );
        const ap = expected(points, 'aperture');
        if (ap.headline === ap.withBackfill)
          throw new Error(
            `the backfill would not move the gap (${ap.headline}): the case proves nothing`,
          );
        await ctx.ui.goto('/tasks?lens=calibration');
        await untilHeadline(ctx, 'aperture', ap.headline!);
        await untilHeadline(ctx, 'life', expected(points, 'life').headline!);
        const note = lane(ctx, 'aperture').getByText(/^\d+ backfilled · .+, not scored$/);
        await note.waitFor({ timeout: 10_000 });
        const n = Number((await note.textContent())!.split(' ')[0]);
        if (n !== ap.backfilled)
          throw new Error(`the footnote counts ${n}, the API ${ap.backfilled}`);
        await note.scrollIntoViewIfNeeded();
        await ctx.shot('backfill-footnote');
        await ctx.page.getByText(name(ctx, 'scored'), { exact: true }).waitFor({ timeout: 10_000 });
        for (const what of ['bfone', 'bftwo'])
          if (await ctx.page.getByText(name(ctx, what), { exact: true }).count())
            throw new Error(`${what} is in Recent`);
      },
    },
    {
      id: 'reload',
      entry: 'ui',
      proves: ['reload'],
      title: 'Reload: the lane, its number and the footnote are still there',
      async run(ctx) {
        const before = (await headline(ctx, 'aperture').textContent())?.trim();
        await ctx.page.reload({ waitUntil: 'domcontentloaded' });
        await lane(ctx, 'aperture').waitFor({ timeout: 15_000 });
        const after = (await headline(ctx, 'aperture').textContent())?.trim();
        if (after !== before)
          throw new Error(`after a reload the headline reads ${after}, not ${before}`);
        await lane(ctx, 'aperture')
          .getByText(/backfilled · .+, not scored$/)
          .waitFor({ timeout: 10_000 });
      },
    },
    {
      id: 'repeat',
      entry: 'mcp',
      proves: ['repeat'],
      title: 'The same batch again: all skipped, unchanged',
      async run(ctx) {
        const before = await ctx.api.reads.getTask(id('bfone'));
        const { to } = await window(ctx);
        const r = await ctx.mcp.writes.backfillTasks([
          { id: id('bfone'), actualMin: 999, completedDay: addDays(to, -1) },
          { id: id('bftwo'), actualMin: 999, estimateMin: 15, completedDay: addDays(to, -2) },
        ]);
        if ('refused' in r) throw new Error(`refused: ${r.refused}`);
        if (r.rows.some((x) => x.outcome !== 'skipped'))
          throw new Error(`a rerun wrote: ${JSON.stringify(r.rows.map((x) => x.outcome))}`);
        const after = await ctx.api.reads.getTask(id('bfone'));
        if (after?.updatedAt !== before?.updatedAt || after?.actualAccruedMin !== 300)
          throw new Error(`a skipped row changed: ${JSON.stringify(after)}`);
      },
    },
    {
      id: 'invalid',
      entry: 'mcp',
      proves: ['invalid'],
      title: 'Bad rows: each refused naming the row; the good row beside it is not written',
      async run(ctx) {
        const { to } = await window(ctx);
        const ok = { id: id('stays'), actualMin: 10, completedDay: addDays(to, -1) };
        const row = (what: string, over: Record<string, unknown> = {}) => ({
          ...ok,
          id: id(what),
          ...over,
        });
        const cases: [string, Record<string, unknown>[], RegExp][] = [
          ['actual 0', [ok, row('bftwo', { actualMin: 0 })], /actualMin/],
          ['future day', [row('stays', { completedDay: addDays(to, 2) })], /after today/],
          ['unknown id', [ok, { ...ok, id: `${UNKNOWN_TASK_ID}1` }], /Row 2 .*not found/],
          ['parent', [ok, row('parent')], /Row 2 .*has parts/],
          ['part', [row('part')], /is a part/],
          ['twice', [ok, ok], /listed twice/],
        ];
        for (const [what, rows, msg] of cases) {
          const why = refused(await ctx.mcp.writes.backfillTasks(rows));
          if (!why || !msg.test(why)) throw new Error(`${what}: ${why ?? 'it landed'}`);
        }
        const stays = await ctx.api.reads.getTask(id('stays'));
        if (stays?.status !== 'backlog' || stays.backfilled)
          throw new Error(`a refused batch wrote: ${JSON.stringify(stays)}`);
      },
    },
    {
      id: 'empty-max',
      entry: 'mcp',
      proves: ['empty-max'],
      title: `Empty and ${MAX + 1} rows refused; ${BATCH} rows land in one call`,
      async run(ctx) {
        const { to } = await window(ctx);
        const empty = refused(await ctx.mcp.writes.backfillTasks([]));
        if (!empty || !/non-empty/.test(empty)) throw new Error(`[]: ${empty ?? 'it landed'}`);
        const over = Array.from({ length: MAX + 1 }, () => ({
          id: id('stays'),
          actualMin: 10,
          completedDay: to,
        }));
        const big = refused(await ctx.mcp.writes.backfillTasks(over));
        if (!big || !/at most 100/.test(big)) throw new Error(`101 rows: ${big ?? 'it landed'}`);
        for (let i = 0; i < BATCH; i++) {
          const t: DevTask = await ctx.api.writes.createTask({
            title: name(ctx, `bulk${i}`),
            estimateMin: 15,
            categoryId,
          });
          bulk.push(t.id);
        }
        const started = Date.now();
        const r = await ctx.mcp.writes.backfillTasks(
          bulk.map((b, i) => ({ id: b, actualMin: 5 + i, completedDay: addDays(to, -(i % 20)) })),
        );
        const ms = Date.now() - started;
        if ('refused' in r) throw new Error(`${BATCH} rows refused: ${r.refused}`);
        if (r.rows.length !== BATCH || r.rows.some((x) => x.outcome !== 'done'))
          throw new Error(`${BATCH} rows came back ${r.rows.length}, not all done`);
        ctx.log(`backfill_tasks: ${BATCH} rows in ${ms} ms (the MCP Lambda's timeout is 15 s)`);
      },
    },
    {
      id: 'mark-clear',
      entry: 'mcp',
      proves: ['mark-clear'],
      title:
        'update_task backfilled on a done task sets and clears its point’s mark; on an open one it is refused',
      async run(ctx) {
        const tid = id('marked');
        await ctx.mcp.writes.completeTask(tid, 25);
        await ctx.mcp.writes.updateTask(tid, { backfilled: true });
        await pointsWith(ctx, [tid], (p) => p.backfilled === true);
        await ctx.mcp.writes.updateTask(tid, { backfilled: false });
        await pointsWith(ctx, [tid], (p) => p.backfilled === false);
        const open = await ctx.mcp.writes.updateTask(id('stays'), { backfilled: true }).then(
          () => null,
          (e: unknown) => String(e),
        );
        if (!open || !/done task/.test(open))
          throw new Error(`open task: ${open ?? 'it was marked'}`);
      },
    },
    {
      id: 'api-direct',
      entry: 'api',
      proves: ['api-direct'],
      title:
        'backfillTasks over the BFF: a completedDay that isn’t a date is refused, nothing written',
      async run(ctx) {
        const why = await ctx.api.writes
          .backfillTasks([{ id: id('stays'), actualMin: 10, completedDay: 'Nov 10' }])
          .then(
            () => null,
            (e: unknown) => String(e),
          );
        if (!why || !/completedDay/.test(why)) throw new Error(`bad day: ${why ?? 'it landed'}`);
        if ((await ctx.api.reads.getTask(id('stays')))?.status !== 'backlog')
          throw new Error('a refused call wrote');
      },
    },
    {
      id: 'area-live',
      entry: 'api',
      proves: ['area-live'],
      title: 'The category moves to School: its points leave the Aperture lane on the next read',
      async run(ctx) {
        await ctx.api.writes.setCategoryArea(categoryId, 'school');
        await pointsWith(ctx, [id('scored')], (p) => p.area === 'school');
        await ctx.api.writes.setCategoryArea(categoryId, 'aperture');
      },
    },
    {
      id: 'teardown',
      entry: 'api',
      title: 'Delete this run’s tasks now, so the later scenarios never list them',
      async run(ctx) {
        for (const tid of [...bulk, ...ids.values()]) {
          if (tid === id('part')) continue; // its parent takes it
          await ctx.api.writes.deleteTask(tid);
        }
      },
    },
    noConsoleErrors,
  ],
};
