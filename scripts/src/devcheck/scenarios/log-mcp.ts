// The Log over MCP on dev (docs/areas/mcp → Tools, log): seed entries through the API and the capture bar,
// then prove search_log, list_log and get_day read them back as the test user. The tools only read; every
// seeded entry and task is ledgered by id and cleaned by the pipeline (a log entry is tombstoned by
// deleteLogEntry). Nothing is ever matched by text for cleanup — the nonce only finds rows on screen.
import { McpRpcError, PARAM_ERROR } from '../mcp';
import { laDay, noConsoleErrors, type Ctx, type Scenario } from '../scenario';

const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
// The app's day, not the calendar's: before the day start (4am) an entry belongs to yesterday.
const appDays = async (ctx: Ctx) => {
  const { dayStartHour } = await ctx.api.reads.getSettings();
  const today = laDay(new Date(Date.now() - dayStartHour * 3_600_000));
  return { today, yesterday: addDays(today, -1), tomorrow: addDays(today, 1) };
};

// What this run seeded, shared across steps (a scenario's steps run in order, one run at a time).
const seeded = { secret: '', lower: '', past: '', typed: '', done: '', planned: '', gone: '' };

const expectParamError = async (what: string, call: () => Promise<unknown>) => {
  try {
    await call();
  } catch (err) {
    if (err instanceof McpRpcError && err.code === PARAM_ERROR) return;
    throw err;
  }
  throw new Error(`${what}: expected a param error (-32602), got a result`);
};
const fail = (msg: string): never => {
  throw new Error(msg);
};

export const logMcp: Scenario = {
  id: 'log-mcp',
  title: 'The Log over MCP: search, a range, and one day as data',
  tiers: ['full'],
  rows: [
    {
      id: 'capture',
      entry: 'ui',
      kind: 'nominal',
      what: 'A line typed in the capture bar’s Log mode is saved and shows on /log',
    },
    {
      id: 'seed',
      entry: 'api',
      kind: 'nominal',
      what: 'createLogEntry on yesterday and today reads back under each day',
    },
    {
      id: 'delete',
      entry: 'api',
      kind: 'nominal',
      what: 'deleteLogEntry tombstones a seeded entry: gone from listLogRange and search_log; a second delete is a no-op',
    },
    {
      id: 'tools-listed',
      entry: 'mcp',
      kind: 'nominal',
      what: 'tools/list has search_log, list_log and get_day',
    },
    {
      id: 'search-hit',
      entry: 'mcp',
      kind: 'nominal',
      what: '"what was my disk password?" — search_log finds the entry with its day, id, text and time',
    },
    {
      id: 'search-ci',
      entry: 'mcp',
      kind: 'edge',
      what: 'A lowercase query matches upper-case text, and the reverse',
    },
    {
      id: 'search-empty',
      entry: 'mcp',
      kind: 'edge',
      what: 'A query nothing matches is an empty page, not an error',
    },
    {
      id: 'search-range',
      entry: 'mcp',
      kind: 'edge',
      what: 'from = to = yesterday finds yesterday’s entry and not today’s',
    },
    {
      id: 'search-paging',
      entry: 'mcp',
      kind: 'edge',
      what: 'limit 1 pages through every match once, newest first, nextCursor null at the end',
    },
    {
      id: 'list-range',
      entry: 'mcp',
      kind: 'nominal',
      what: 'list_log yesterday..today lists the seeded entries newest first',
    },
    {
      id: 'invalid',
      entry: 'mcp',
      kind: 'edge',
      what: 'from after to, a bad date, an empty query, a bad cursor and limit 0 are param errors',
    },
    {
      id: 'get-day',
      entry: 'mcp',
      kind: 'nominal',
      what: 'get_day today has the stored day row (peekDay), the day’s log, a task done with estimate vs actual, a planned task still open, the window from the day start',
    },
    {
      id: 'get-day-yesterday',
      entry: 'mcp',
      kind: 'edge',
      what: 'get_day yesterday has yesterday’s entry and none of today’s',
    },
    {
      id: 'get-day-future',
      entry: 'mcp',
      kind: 'edge',
      what: 'get_day tomorrow answers (no log, no error)',
    },
    {
      id: 'boundary-4am',
      entry: 'mcp',
      kind: 'edge',
      what: 'A task finished at 03:59 belongs to the previous day in get_day; at 04:00 to the day',
      offDev: {
        file: 'lambdas/src/mcp/logTools.test.ts',
        test: 'buckets a finish before the day start into the previous day',
        why: 'dev’s clock can’t be moved to 03:59; get-day proves the same bucketing path at the run’s own time',
      },
    },
    {
      id: 'ownership',
      entry: 'mcp',
      kind: 'edge',
      what: 'Another user’s entries never appear in a search',
      offDev: {
        file: 'lambdas/src/mcp/logTools.test.ts',
        test: "never returns another user's entries",
        why: 'dev has one test user, so there is no second user’s log to leak',
      },
    },
    {
      id: 'no-writes',
      entry: 'mcp',
      kind: 'edge',
      what: 'search_log, list_log and get_day write nothing (get_day never spawns a recurrence or sweeps a plan)',
      offDev: {
        file: 'lambdas/src/mcp/logTools.test.ts',
        test: 'search_log, list_log and get_day leave the table as it was',
        why: 'dev exposes no row-level write audit; the in-memory table can be snapshotted',
      },
    },
    {
      id: 'bounded-read',
      entry: 'mcp',
      kind: 'edge',
      what: 'A whole-history search is one range read of the user’s log, never a table scan',
      offDev: {
        file: 'lambdas/src/ddb/repo.test.ts',
        test: 'listLogRange bounds the sort key to log#<from>#..log#<to># (one range read)',
        why: 'the query shape is only visible on the DocClient',
      },
    },
    {
      id: 'voice',
      entry: 'mcp',
      kind: 'nominal',
      what: 'claude.ai (after Disconnect/Connect) answers "what did I log about X?" with search_log',
      needsYou: 'the claude.ai connector and the phone are the user’s',
    },
  ],
  steps: [
    {
      id: 'seed',
      title: 'Seed log entries on yesterday and today',
      entry: 'api',
      proves: ['seed'],
      async run(ctx) {
        const { today, yesterday } = await appDays(ctx);
        const w = ctx.api.writes;
        seeded.secret = (await w.createLogEntry(`Disk PASSWORD hunter2 ${ctx.nonce}`, today)).id;
        seeded.lower = (await w.createLogEntry(`lowercase disk note ${ctx.nonce}`, today)).id;
        seeded.past = (await w.createLogEntry(`yesterday ${ctx.nonce}`, yesterday)).id;
        const onToday = (await ctx.api.reads.listLogEntries(today)).map((e) => e.id);
        const onYesterday = (await ctx.api.reads.listLogEntries(yesterday)).map((e) => e.id);
        if (!onToday.includes(seeded.secret) || !onToday.includes(seeded.lower))
          fail(`today's entries don't read back under ${today}`);
        if (!onYesterday.includes(seeded.past) || onYesterday.includes(seeded.secret))
          fail(`yesterday's entry doesn't read back under ${yesterday} alone`);
      },
    },
    {
      id: 'capture',
      title: 'Type a line in the capture bar’s Log mode',
      entry: 'ui',
      proves: ['capture'],
      async run(ctx) {
        const line = `devcheck ${ctx.nonce} typed`;
        await ctx.ui.goto('/log');
        await ctx.page.getByRole('button', { name: 'Log', exact: true }).click();
        const field = ctx.page.getByLabel('Capture log', { exact: true });
        await field.fill(line);
        await field.press('Enter');
        await ctx.ui.expectText(/Logged/, 15_000);
        await ctx.ui.expectText(line, 15_000);
        await ctx.shot('log-captured');
        const { today } = await appDays(ctx);
        const mine = (await ctx.api.reads.listLogEntries(today)).find((e) => e.text === line);
        if (!mine) fail('the typed line never reached the server');
        if (!ctx.createdIds().includes(mine!.id))
          fail(`the capture's id ${mine!.id} wasn't ledgered from the response`);
        seeded.typed = mine!.id;
      },
    },
    {
      id: 'tools-listed',
      title: 'tools/list has the three log tools',
      entry: 'mcp',
      proves: ['tools-listed'],
      async run(ctx) {
        const names = await ctx.mcp.reads.toolsList();
        for (const n of ['search_log', 'list_log', 'get_day'])
          if (!names.includes(n)) fail(`tools/list has no ${n}`);
      },
    },
    {
      id: 'search',
      title: 'search_log: a hit, either case, nothing, a range',
      entry: 'mcp',
      proves: ['search-hit', 'search-ci', 'search-empty', 'search-range'],
      async run(ctx) {
        const { today, yesterday } = await appDays(ctx);
        const hit = await ctx.mcp.reads.searchLog({ query: `hunter2 ${ctx.nonce}` });
        const e = hit.entries.find((x) => x.id === seeded.secret);
        if (!e || hit.entries.length !== 1) fail(`search_log hunter2: ${JSON.stringify(hit)}`);
        if (e!.day !== today || !e!.text.includes('hunter2') || !e!.createdAt || !e!.localTime)
          fail(`search_log entry shape: ${JSON.stringify(e)}`);

        const upper = await ctx.mcp.reads.searchLog({ query: `DISK NOTE ${ctx.nonce}` });
        const lower = await ctx.mcp.reads.searchLog({
          query: `disk password hunter2 ${ctx.nonce}`,
        });
        if (!upper.entries.some((x) => x.id === seeded.lower))
          fail('an upper-case query missed lower-case text');
        if (!lower.entries.some((x) => x.id === seeded.secret))
          fail('a lower-case query missed upper-case text');

        const none = await ctx.mcp.reads.searchLog({ query: `${ctx.nonce}-nothing-matches` });
        if (none.entries.length !== 0 || none.more || none.nextCursor !== null)
          fail(`an empty search isn't an empty page: ${JSON.stringify(none)}`);

        const past = await ctx.mcp.reads.searchLog({
          query: ctx.nonce,
          from: yesterday,
          to: yesterday,
        });
        const ids = past.entries.map((x) => x.id);
        if (!ids.includes(seeded.past) || ids.includes(seeded.secret))
          fail(`from=to=${yesterday}: ${ids.join(', ')}`);
      },
    },
    {
      id: 'paging',
      title: 'search_log pages one at a time through every match',
      entry: 'mcp',
      proves: ['search-paging'],
      async run(ctx) {
        const mine = [seeded.secret, seeded.lower, seeded.past, seeded.typed];
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let i = 0; i < 10; i++) {
          const p = await ctx.mcp.reads.searchLog({
            query: ctx.nonce,
            limit: 1,
            ...(cursor ? { cursor } : {}),
          });
          if (p.entries.length !== 1) fail(`page ${i + 1} has ${p.entries.length} entries`);
          seen.push(p.entries[0]!.id);
          if (p.more !== (p.nextCursor !== null)) fail('more and nextCursor disagree');
          cursor = p.nextCursor;
          if (!cursor) break;
        }
        if (cursor) fail('paging never ended');
        if (new Set(seen).size !== seen.length) fail(`a page repeated: ${seen.join(', ')}`);
        if ([...seen].sort().join() !== [...mine].sort().join())
          fail(`pages ${seen.join(', ')} are not this run's ${mine.join(', ')}`);
        // Newest first: yesterday's entry comes last.
        if (seen.at(-1) !== seeded.past) fail(`not newest first: ${seen.join(', ')}`);
      },
    },
    {
      id: 'list',
      title: 'list_log yesterday..today',
      entry: 'mcp',
      proves: ['list-range'],
      async run(ctx) {
        const { today, yesterday } = await appDays(ctx);
        const out = await ctx.mcp.reads.listLog({ from: yesterday, to: today, limit: 200 });
        const ids = out.entries.map((x) => x.id);
        for (const id of [seeded.secret, seeded.lower, seeded.past, seeded.typed])
          if (!ids.includes(id)) fail(`list_log is missing ${id}`);
        if (ids.indexOf(seeded.past) < ids.indexOf(seeded.secret))
          fail('list_log is not newest first');
      },
    },
    {
      id: 'invalid',
      title: 'Bad arguments are param errors',
      entry: 'mcp',
      proves: ['invalid'],
      async run(ctx) {
        const { today, yesterday } = await appDays(ctx);
        const r = ctx.mcp.reads;
        await expectParamError('from after to', () =>
          r.searchLog({ query: 'x', from: today, to: yesterday }),
        );
        await expectParamError('a bad date', () => r.listLog({ from: '2026-13-01', to: today }));
        await expectParamError('an empty query', () => r.searchLog({ query: '  ' }));
        await expectParamError('a bad cursor', () => r.searchLog({ query: 'x', cursor: 'nope' }));
        await expectParamError('limit 0', () => r.searchLog({ query: 'x', limit: 0 }));
        await expectParamError('get_day without a day', () => r.getDay({}));
      },
    },
    {
      id: 'get-day',
      title: 'get_day today: log, a done task with numbers, a planned one still open',
      entry: 'mcp',
      proves: ['get-day'],
      async run(ctx) {
        const { today } = await appDays(ctx);
        const { dayStartHour } = await ctx.api.reads.getSettings();
        const done = await ctx.api.writes.createTask({
          title: `devcheck ${ctx.nonce} done`,
          estimateMin: 30,
        });
        seeded.done = done.id;
        await ctx.mcp.writes.completeTask(done.id, 40);
        const open = await ctx.api.writes.createTask({
          title: `devcheck ${ctx.nonce} planned`,
          estimateMin: 20,
        });
        seeded.planned = open.id;
        await ctx.api.writes.upsertPlan({
          taskId: open.id,
          day: today,
          plannedMinutes: 25,
          order: 9999,
        });

        await ctx.api.reads.getDay(today); // the app's open: the day row exists, as on any used day
        const d = await ctx.mcp.reads.getDay({ day: today });
        if (d.day !== today || d.today !== today) fail(`day/today: ${d.day}/${d.today}`);
        if (!d.dayPlan || !('intent' in d.dayPlan))
          fail(`dayPlan is ${JSON.stringify(d.dayPlan)} though the app opened today`);
        const startHour = new Date(d.window.start).toLocaleString('en-US', {
          timeZone: 'America/Los_Angeles',
          hour: 'numeric',
          hourCycle: 'h23',
        });
        if (Number(startHour) !== dayStartHour)
          fail(`window starts at ${startHour}h, not the day start ${dayStartHour}h`);
        const logIds = d.log.entries.map((e) => e.id);
        for (const id of [seeded.secret, seeded.lower, seeded.typed])
          if (!logIds.includes(id)) fail(`get_day log is missing ${id}`);
        if (logIds.includes(seeded.past)) fail("get_day today has yesterday's entry");
        const row = d.tasks.done.find((t) => t.id === done.id);
        if (!row || row.actualMin !== 40) fail(`done row: ${JSON.stringify(row)}`);
        if (row!.isCalibrationPoint && row!.deltaMin !== 40 - (row!.estimateLockedMin ?? NaN))
          fail(`deltaMin isn't actual − locked: ${JSON.stringify(row)}`);
        const planned = d.tasks.planned.find((t) => t.id === open.id);
        if (!planned || planned.plannedMinutes !== 25 || planned.byTime)
          fail(`planned row: ${JSON.stringify(planned)}`);
        if (!d.tasks.stillOpen.some((t) => t.id === open.id))
          fail('the planned task is not still open');
        if (!Array.isArray(d.flux.sets) || !Array.isArray(d.leetcode))
          fail('flux/leetcode sections missing');
        if (!d.calendar.reason && !d.calendar.window)
          fail('calendar has neither a window nor a reason');
      },
    },
    {
      id: 'get-day-other',
      title: 'get_day yesterday and tomorrow',
      entry: 'mcp',
      proves: ['get-day-yesterday', 'get-day-future'],
      async run(ctx) {
        const { yesterday, tomorrow } = await appDays(ctx);
        const y = await ctx.mcp.reads.getDay({ day: yesterday });
        const ids = y.log.entries.map((e) => e.id);
        if (!ids.includes(seeded.past) || ids.includes(seeded.secret))
          fail(`get_day ${yesterday} log: ${ids.join(', ')}`);
        const t = await ctx.mcp.reads.getDay({ day: tomorrow });
        if (t.day !== tomorrow || t.log.count !== 0)
          fail(`get_day ${tomorrow}: ${JSON.stringify(t.log)}`);
      },
    },
    {
      id: 'delete',
      title: 'deleteLogEntry tombstones a seeded entry by id',
      entry: 'api',
      proves: ['delete'],
      async run(ctx) {
        const { today } = await appDays(ctx);
        const e = await ctx.api.writes.createLogEntry(`devcheck ${ctx.nonce} to delete`, today);
        seeded.gone = e.id;
        await ctx.api.writes.deleteLogEntry(e.id);
        if (
          (await ctx.api.reads.listLogRange({ from: today, to: today })).some((x) => x.id === e.id)
        )
          fail('a deleted entry still lists');
        const hit = await ctx.mcp.reads.searchLog({ query: `${ctx.nonce} to delete` });
        if (hit.entries.length !== 0) fail('search_log still finds a deleted entry');
        await ctx.api.writes.deleteLogEntry(e.id); // again: a no-op, not an error
      },
    },
    noConsoleErrors,
  ],
};
