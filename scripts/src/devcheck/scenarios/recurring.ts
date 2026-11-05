// Recurring cadences (docs/areas/tasks/recurring.md): a series says when each occurrence is due and when it
// ends, an unplanned occurrence is never respawned, and series are made and stopped over MCP. The series are
// made the way the user does it (the Recurring tab's form, create_series by voice) and read back on Today;
// each is ledgered from its create response (recorder.ts for the browser's upsertSeries, mcp.ts for
// create_series) and the last step deletes them with the occurrences they spawned, by those ids — cleanup
// by ledger id is the backstop. Titles use `devcheck-recur <nonce>`: the parts scenarios sweep `devcheck <nonce>`.
// The /tasks search text persists across lenses (sessionStorage), so the last UI step clears it.
import type { DevSeries } from '../api';
import { laDay, noConsoleErrors, type Ctx, type Scenario } from '../scenario';

const name = (ctx: Ctx, what: string) => `devcheck-recur ${ctx.nonce} ${what}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// packages/shared/src/dates.ts fmtMonthShortDay for a day key: "Dec 5" (scripts doesn't depend on shared).
const monthDay = (key: string) =>
  `${MONTHS[Number(key.slice(5, 7)) - 1]} ${Number(key.slice(8, 10))}`;
const shiftDays = (key: string, n: number) => {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Steps share what earlier ones made; a failed step skips the rest, so these are set when read.
let appToday: string; // the app's day — todayKey(dayStartHour), not the calendar's (lenses.md D13)
let prelab: DevSeries; // the form's series: due next day, until +30 d
let ended: DevSeries; // the form's series whose until is already past
let plain: DevSeries; // the form's series with no cadence
let viaMcp: DevSeries; // create_series's

const lastCreated = (ctx: Ctx, what: string): string => {
  const id = ctx.createdIds().at(-1);
  if (!id) throw new Error(`${what}: the create response never reached the ledger`);
  return id;
};
async function seriesOnServer(ctx: Ctx, id: string): Promise<DevSeries> {
  const s = (await ctx.api.reads.listSeries()).find((x) => x.id === id);
  if (!s) throw new Error(`series ${id} is not on the server`);
  return s;
}
const occurrencesOf = async (ctx: Ctx, seriesId: string) =>
  (await ctx.api.reads.listTasks()).filter((t) => t.seriesId === seriesId);

// Today's list, searched down to one title (the Today lens shows the search's list, with Unplan / + Today).
async function todaySearched(ctx: Ctx, title: string) {
  await ctx.ui.goto('/tasks');
  await ctx.page.getByLabel('Search tasks').fill(title);
  await ctx.ui.settle();
}
const rowOf = (ctx: Ctx, title: string) =>
  ctx.page.getByRole('button', { name: title, exact: true });

// The Recurring tab's form, filled as the user would and submitted; the ledger gets the id from the
// upsertSeries response. Selects are picked by their visible labels, as the user does.
async function addSeries(
  ctx: Ctx,
  title: string,
  opts: {
    repeats: 'Every day' | 'Weekdays';
    estimate?: string;
    due?: 'Same day' | 'Next day';
    until?: string;
  },
): Promise<DevSeries> {
  await ctx.ui.goto('/tasks?lens=recurring');
  await ctx.page.getByRole('button', { name: 'New recurring task' }).click();
  await ctx.page.getByLabel('Title').fill(title);
  await ctx.page.getByLabel('Repeats').selectOption({ label: opts.repeats });
  if (opts.estimate) await ctx.page.getByLabel('Estimate (min)').fill(opts.estimate);
  if (opts.due) await ctx.page.getByLabel('Due').selectOption({ label: opts.due });
  if (opts.until) await ctx.page.getByLabel('Until').fill(opts.until);
  await ctx.page.getByRole('button', { name: 'Add series' }).click();
  await ctx.page.getByText(title, { exact: true }).waitFor({ timeout: 15_000 });
  return seriesOnServer(ctx, lastCreated(ctx, title));
}

export const recurring: Scenario = {
  id: 'recurring',
  title: 'Recurring cadences: due offset, until, no respawn after unplan, series over MCP',
  tiers: ['full'],
  rows: [
    {
      id: 'create-ui',
      entry: 'ui',
      kind: 'nominal',
      what: 'New recurring task with Due “Next day” and an Until → the row reads the rule, the offset and the end',
    },
    {
      id: 'today-due',
      entry: 'ui',
      kind: 'nominal',
      what: 'Today shows its occurrence as “due tomorrow”; the server has one, untimed, stamped with its day',
    },
    {
      id: 'reload-one',
      entry: 'ui',
      kind: 'edge',
      what: 'Reloading Today keeps one occurrence (getDay again spawns nothing)',
    },
    {
      id: 'unplan',
      entry: 'ui',
      kind: 'edge',
      what: 'Unplan sends the occurrence to Backlog; Today shows no copy, and reloading spawns none',
    },
    {
      id: 'replan',
      entry: 'ui',
      kind: 'edge',
      what: '“+ Today” from Backlog brings the same occurrence back — still one',
    },
    {
      id: 'ended',
      entry: 'ui',
      kind: 'edge',
      what: 'An Until already past: the row reads “ended …” with Stop still offered, and nothing spawns',
    },
    {
      id: 'undated',
      entry: 'ui',
      kind: 'edge',
      what: 'A series with no Due spawns an undated occurrence (as before the cadence existed)',
    },
    {
      id: 'neighbour',
      entry: 'ui',
      kind: 'edge',
      what: 'The first series’ occurrence is unaffected by the others',
    },
    {
      id: 'api-respawn',
      entry: 'api',
      kind: 'edge',
      what: 'getDay(today) twice after removePlan → one occurrence',
      offDev: {
        file: 'lambdas/src/backend.test.ts',
        test: 'getDay twice after removePlan spawns no second occurrence',
        why: 'same path as unplan (proven on dev): the browser’s Unplan is removePlan then getDay, and every reload is another getDay; the test runs the Lambda’s own path a third time',
      },
    },
    {
      id: 'mcp-create',
      entry: 'mcp',
      kind: 'nominal',
      what: 'create_series {daily, dueOffsetDays:1} → list_series lists it; Today shows its occurrence “due tomorrow”',
    },
    {
      id: 'mcp-until-past',
      entry: 'mcp',
      kind: 'edge',
      what: 'create_series with until before today is refused as a param error; nothing is written',
    },
    {
      id: 'mcp-stop',
      entry: 'mcp',
      kind: 'nominal',
      what: 'stop_series → inactive; list_series omits it unless includeStopped; its occurrence stays',
    },
    {
      id: 'mcp-stop-unknown',
      entry: 'mcp',
      kind: 'edge',
      what: 'stop_series on an id the user has no series for → Not found',
    },
    {
      id: 'mcp-other-user',
      entry: 'mcp',
      kind: 'edge',
      what: 'stop_series on another user’s series id → Not found, nothing changes',
      offDev: {
        file: 'lambdas/src/mcp/seriesTools.test.ts',
        test: 'an unknown id, or another user’s, is not found; nothing changes',
        why: 'dev has one test user; the partition key makes another user’s id unreadable, which the test proves with two users on one table',
      },
    },
  ],
  steps: [
    {
      id: 'setup',
      entry: 'api',
      title: 'Read the app’s day boundary — the day a series counts from',
      async run(ctx) {
        const { dayStartHour } = await ctx.api.reads.getSettings();
        appToday = laDay(new Date(Date.now() - dayStartHour * 3_600_000));
        ctx.log(
          `app today ${appToday} (calendar ${ctx.dates.today}, day starts ${dayStartHour}:00)`,
        );
      },
    },
    {
      id: 'create-form',
      entry: 'ui',
      proves: ['create-ui'],
      title: 'Recurring → New recurring task: every day, 60 min, Due “Next day”, Until +30 days',
      async run(ctx) {
        const until = shiftDays(appToday, 30);
        prelab = await addSeries(ctx, name(ctx, 'prelab'), {
          repeats: 'Every day',
          estimate: '60',
          due: 'Next day',
          until,
        });
        if (prelab.dueOffsetDays !== 1 || prelab.until !== until || prelab.anchorDate !== appToday)
          throw new Error(`the server has ${JSON.stringify(prelab)}`);
        await ctx.ui.expectText(`Every day · due next day · until ${monthDay(until)}`);
        await ctx.shot('recurring-row');
      },
    },
    {
      id: 'today',
      entry: 'ui',
      proves: ['today-due', 'reload-one'],
      title: 'Today shows it “due tomorrow”; a reload keeps one occurrence',
      async run(ctx) {
        const title = name(ctx, 'prelab');
        await todaySearched(ctx, title);
        await rowOf(ctx, title).waitFor({ timeout: 15_000 });
        await ctx.ui.expectText('due tomorrow');
        await ctx.shot('today-due-tomorrow');
        const first = await occurrencesOf(ctx, prelab.id);
        if (first.length !== 1) throw new Error(`${first.length} occurrences after the first load`);
        const t = first[0]!;
        if (
          t.seriesDay !== appToday ||
          t.dueDay !== shiftDays(appToday, 1) ||
          t.status !== 'planned'
        )
          throw new Error(`the occurrence is ${JSON.stringify(t)}`);
        await todaySearched(ctx, title); // the reload: getDay again
        await rowOf(ctx, title).waitFor({ timeout: 15_000 });
        if ((await rowOf(ctx, title).count()) !== 1)
          throw new Error('more than one row after a reload');
        const again = await occurrencesOf(ctx, prelab.id);
        if (again.length !== 1) throw new Error(`${again.length} occurrences after a reload`);
      },
    },
    {
      id: 'unplan',
      entry: 'ui',
      proves: ['unplan'],
      title: 'Unplan → Backlog; Today shows no copy after two reloads',
      async run(ctx) {
        const title = name(ctx, 'prelab');
        await todaySearched(ctx, title);
        const unplan = ctx.page.getByRole('button', { name: 'Unplan', exact: true });
        await unplan.waitFor({ timeout: 15_000 });
        if ((await unplan.count()) !== 1)
          throw new Error(`search left ${await unplan.count()} Unplan buttons`);
        await unplan.click();
        const [t] = await occurrencesOf(ctx, prelab.id);
        for (let i = 0; (await ctx.api.reads.getTask(t!.id))?.status !== 'backlog'; i++) {
          if (i >= 40) throw new Error('Unplan never reached the server');
          await new Promise((r) => setTimeout(r, 250));
        }
        for (const pass of [1, 2]) {
          await todaySearched(ctx, title);
          await ctx.ui.expectText(/Nothing matches/);
          const rows = await occurrencesOf(ctx, prelab.id);
          if (rows.length !== 1 || rows[0]!.status !== 'backlog')
            throw new Error(
              `reload ${pass}: ${rows.length} occurrences, ${rows.map((r) => r.status).join(',')}`,
            );
        }
        await ctx.shot('today-after-unplan');
        await ctx.ui.goto('/tasks?lens=backlog');
        await ctx.page.getByLabel('Search tasks').fill(title);
        await rowOf(ctx, title).waitFor({ timeout: 15_000 });
      },
    },
    {
      id: 'replan',
      entry: 'ui',
      proves: ['replan'],
      title: '“+ Today” from Backlog → the same occurrence is back on Today, still one',
      async run(ctx) {
        const title = name(ctx, 'prelab');
        await ctx.ui.goto('/tasks?lens=backlog');
        await ctx.page.getByLabel('Search tasks').fill(title);
        const add = ctx.page.getByRole('button', { name: `Add ${title} to today` });
        await add.waitFor({ timeout: 15_000 });
        await add.click();
        const [before] = await occurrencesOf(ctx, prelab.id);
        for (let i = 0; (await ctx.api.reads.getTask(before!.id))?.status !== 'planned'; i++) {
          if (i >= 40) throw new Error('“+ Today” never reached the server');
          await new Promise((r) => setTimeout(r, 250));
        }
        await todaySearched(ctx, title);
        await rowOf(ctx, title).waitFor({ timeout: 15_000 });
        const rows = await occurrencesOf(ctx, prelab.id);
        if (rows.length !== 1 || rows[0]!.id !== before!.id)
          throw new Error(
            `${rows.length} occurrences after “+ Today” (same task: ${rows[0]?.id === before!.id})`,
          );
        await ctx.shot('today-replanned');
      },
    },
    {
      id: 'ended-undated',
      entry: 'ui',
      proves: ['ended', 'undated', 'neighbour'],
      title:
        'An Until of yesterday reads “ended …” and spawns nothing; no Due spawns undated; the first is untouched',
      async run(ctx) {
        const yesterday = shiftDays(appToday, -1);
        ended = await addSeries(ctx, name(ctx, 'ended'), {
          repeats: 'Weekdays',
          due: 'Same day',
          until: yesterday,
        });
        await ctx.ui.expectText(`Weekdays · due same day · ended ${monthDay(yesterday)}`);
        if ((await ctx.page.getByRole('button', { name: 'Stop', exact: true }).count()) < 2)
          throw new Error('an ended series lost its Stop');
        plain = await addSeries(ctx, name(ctx, 'plain'), { repeats: 'Every day' });
        await ctx.page.getByText('Every day', { exact: true }).first().waitFor({ timeout: 10_000 });
        await ctx.shot('recurring-three-rows');
        await ctx.ui.goto('/tasks'); // Today: getDay spawns what's due
        await ctx.page.getByLabel('Search tasks').fill(name(ctx, 'plain'));
        await rowOf(ctx, name(ctx, 'plain')).waitFor({ timeout: 15_000 });
        if ((await ctx.page.getByText(/^due /).count()) !== 0)
          throw new Error('an undated occurrence shows a due phrase');
        const [plainRow] = await occurrencesOf(ctx, plain.id);
        if (!plainRow || plainRow.dueDay != null || plainRow.seriesDay !== appToday)
          throw new Error(`the undated occurrence is ${JSON.stringify(plainRow)}`);
        if ((await occurrencesOf(ctx, ended.id)).length !== 0)
          throw new Error('an ended series spawned');
        const first = await occurrencesOf(ctx, prelab.id);
        if (
          first.length !== 1 ||
          first[0]!.status !== 'planned' ||
          first[0]!.dueDay !== shiftDays(appToday, 1)
        )
          throw new Error(`the neighbour moved: ${JSON.stringify(first)}`);
      },
    },
    {
      id: 'mcp-create',
      entry: 'mcp',
      proves: ['mcp-create'],
      title: 'create_series {daily, dueOffsetDays: 1} → list_series; Today shows it “due tomorrow”',
      async run(ctx) {
        const title = name(ctx, 'mcp');
        viaMcp = await ctx.mcp.writes.createSeries({
          title,
          rule: { kind: 'daily' },
          dueOffsetDays: 1,
        });
        if (viaMcp.anchorDate !== appToday || viaMcp.dueOffsetDays !== 1 || viaMcp.until != null)
          throw new Error(`create_series returned ${JSON.stringify(viaMcp)}`);
        if (!(await ctx.mcp.reads.listSeries()).some((s) => s.id === viaMcp.id))
          throw new Error('list_series does not list it');
        await todaySearched(ctx, title);
        await rowOf(ctx, title).waitFor({ timeout: 15_000 });
        await ctx.ui.expectText('due tomorrow');
        await ctx.shot('today-mcp-series');
        const rows = await occurrencesOf(ctx, viaMcp.id);
        if (rows.length !== 1 || rows[0]!.dueDay !== shiftDays(appToday, 1))
          throw new Error(`${rows.length} occurrences: ${JSON.stringify(rows)}`);
      },
    },
    {
      id: 'mcp-refused',
      entry: 'mcp',
      proves: ['mcp-until-past', 'mcp-stop-unknown'],
      title:
        'create_series with until yesterday → param error, nothing written; stop_series on no such id → Not found',
      async run(ctx) {
        const before = await ctx.api.reads.listSeries();
        const err = await ctx.mcp.writes
          .createSeries({
            title: name(ctx, 'past'),
            rule: { kind: 'daily' },
            until: shiftDays(appToday, -1),
          })
          .then(
            () => null,
            (e: unknown) => (e instanceof Error ? e.message : String(e)),
          );
        if (!err || !/-32602/.test(err) || !/before today/.test(err))
          throw new Error(`expected a param error naming today, got ${err ?? 'a series'}`);
        const after = await ctx.api.reads.listSeries();
        if (after.length !== before.length)
          throw new Error('the refused create_series wrote a series');
        const stop = await ctx.mcp.writes.stopSeriesUnknown(`nx-${ctx.nonce}`);
        if (!stop.isError || !/^Not found/.test(stop.text))
          throw new Error(`stop_series on an unknown id answered ${JSON.stringify(stop)}`);
      },
    },
    {
      id: 'mcp-stop',
      entry: 'mcp',
      proves: ['mcp-stop'],
      title:
        'stop_series → inactive, out of list_series, in with includeStopped; the occurrence stays',
      async run(ctx) {
        const stopped = await ctx.mcp.writes.stopSeries(viaMcp.id);
        if (stopped.active) throw new Error('stop_series left it active');
        if ((await ctx.mcp.reads.listSeries()).some((s) => s.id === viaMcp.id))
          throw new Error('list_series still lists a stopped series');
        if (!(await ctx.mcp.reads.listSeries(true)).some((s) => s.id === viaMcp.id && !s.active))
          throw new Error('list_series {includeStopped} does not list it');
        if ((await occurrencesOf(ctx, viaMcp.id)).length !== 1)
          throw new Error('stopping the series touched its occurrence');
      },
    },
    {
      id: 'teardown',
      entry: 'api',
      title: 'Delete this run’s series with their occurrences (by recorded id); clear the search',
      async run(ctx) {
        for (const s of [prelab, ended, plain, viaMcp]) await ctx.api.writes.deleteSeries(s.id);
        const left = (await ctx.api.reads.listTasks()).filter((t) =>
          [prelab, ended, plain, viaMcp].some((s) => s.id === t.seriesId),
        );
        if (left.length) throw new Error(`${left.length} occurrences left after deleteSeries`);
        await ctx.ui.goto('/tasks');
        await ctx.page.getByLabel('Search tasks').fill('');
      },
    },
    noConsoleErrors,
  ],
};
