// Finding a task over MCP on dev (docs/areas/mcp/index.md → Finding a task): seed tasks through the API as the
// test user, then prove search_tasks finds them by a title word and by a notes word, that each filter narrows,
// that the limit caps and says so, and that list_tasks' compact rows carry no notes. The tools only read; every
// seeded task and the category are ledgered by id and torn down here by id (the pipeline's cleanup is the
// backstop). Every title and the noted task's notes carry the run's nonce, and every query includes it, so the
// counts are exact whatever else the test user holds; the nonce never picks what gets deleted.
// Reads are eventually consistent: the first read after seeding and the one after teardown retry a few times.
import { McpRpcError, PARAM_ERROR, type DevCompactTask, type DevTaskSearch } from '../mcp';
import { noConsoleErrors, type Ctx, type Scenario } from '../scenario';

const OFF_FILE = 'lambdas/src/mcp/searchTools.test.ts';
const COMPACT_KEYS = [
  'categoryId',
  'dueDay',
  'dueTime',
  'estimateMin',
  'id',
  'parentId',
  'status',
  'title',
];
const NOTES_WORD = 'quokkafern'; // only in B's notes

// What this run seeded, shared across steps (a scenario's steps run in order, one run at a time).
const seeded = { cat: '', a: '', b: '', c: '', parent: '', part1: '', part2: '', bNotes: '' };

const fail = (msg: string): never => {
  throw new Error(msg);
};
const expect = (ok: boolean, what: string, got: unknown) => {
  if (!ok) fail(`${what}: ${JSON.stringify(got)}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> => {
  for (let i = 0; ; i++) {
    const v = await read();
    if (ok(v) || i === 4) return v;
    await sleep(1000);
  }
};
const expectParamError = async (what: string, call: () => Promise<unknown>) => {
  try {
    await call();
  } catch (err) {
    if (err instanceof McpRpcError && err.code === PARAM_ERROR) return;
    throw err;
  }
  fail(`${what}: expected a param error (-32602), got a result`);
};
const title = (ctx: Ctx, what: string) => `devcheck find ${ctx.nonce} ${what}`;
const search = (ctx: Ctx, args: Record<string, unknown>) => ctx.mcp.reads.searchTasks(args);
const ids = (r: DevTaskSearch) => r.tasks.map((t) => t.id);
const same = (got: string[], want: string[]) =>
  got.length === want.length && want.every((id) => got.includes(id));
// Key-order-free JSON, to compare two reads of one row.
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );
const keysOf = (row: DevCompactTask) =>
  Object.keys(row)
    .filter((k) => k !== 'parts' && k !== 'notesSnippet')
    .sort();

export const taskSearchMcp: Scenario = {
  id: 'task-search-mcp',
  title: 'Finding a task over MCP: search_tasks and compact list_tasks',
  order: 377,
  tiers: ['full'],
  rows: [
    {
      id: 'seed',
      entry: 'api',
      kind: 'nominal',
      what: 'A category and six tasks (one started, one with notes due today, one categorised and timed tomorrow, a parent with two parts) read back',
    },
    {
      id: 'tools-listed',
      entry: 'mcp',
      kind: 'nominal',
      what: 'tools/list has search_tasks (query required, status as one or a list, limit) and list_tasks has compact',
    },
    {
      id: 'find-title',
      entry: 'mcp',
      kind: 'nominal',
      what: 'A title word finds that one task, as a row of exactly the eight compact keys',
    },
    {
      id: 'find-notes',
      entry: 'mcp',
      kind: 'nominal',
      what: 'A word only in the notes, typed in upper case, finds the task with a one-line notesSnippet holding the word',
    },
    {
      id: 'all-words',
      entry: 'mcp',
      kind: 'edge',
      what: 'A title word plus a notes word finds the task; adding a word no task has is an empty answer, not an error',
    },
    {
      id: 'status',
      entry: 'mcp',
      kind: 'edge',
      what: 'status in_progress, a status list, and backlog each narrow to the right tasks',
    },
    {
      id: 'category-due',
      entry: 'mcp',
      kind: 'edge',
      what: 'categoryId, and dueFrom/dueTo (both inclusive, open on either side) narrow; an undated task never passes a due filter',
    },
    {
      id: 'limit',
      entry: 'mcp',
      kind: 'edge',
      what: 'The nonce alone finds all six with more false; limit 2 gives the newest two, totalMatches 6 and more true',
    },
    {
      id: 'invalid',
      entry: 'mcp',
      kind: 'edge',
      what: 'A blank or over-long query, limit 0/51/2.5, an unknown or empty status, a bad day, dueFrom after dueTo, an unknown argument, and compact "yes" are param errors',
    },
    {
      id: 'compact',
      entry: 'mcp',
      kind: 'nominal',
      what: 'list_tasks compact: rows have only the compact keys and no notes (the noted task included); the parent keeps parts; status still applies',
    },
    {
      id: 'neighbour',
      entry: 'mcp',
      kind: 'edge',
      what: 'After a compact call, the default list_tasks still has notes and timestamps; the same search twice answers the same',
    },
    {
      id: 'cleanup',
      entry: 'mcp',
      kind: 'nominal',
      what: 'After teardown by id, a search for the nonce finds nothing',
    },
    {
      id: 'default-unchanged',
      entry: 'mcp',
      kind: 'edge',
      what: 'list_tasks with no argument or compact false returns each seeded task exactly as the BFF lists it, plus parts on the parent',
    },
    {
      id: 'backlog-parts',
      entry: 'mcp',
      kind: 'edge',
      what: 'list_backlog still carries parts on a parent (its helper moved)',
    },
    {
      id: 'ownership',
      entry: 'mcp',
      kind: 'edge',
      what: 'Another user’s task with the same words never matches',
      offDev: {
        file: OFF_FILE,
        test: "search_tasks never returns another user's task",
        why: 'slot B signs in one test user, so there is no second user’s task to leak',
      },
    },
    {
      id: 'max-limit',
      entry: 'mcp',
      kind: 'edge',
      what: '51 matches with limit 50 give 50 rows and more true; exactly 50 give more false',
      offDev: {
        file: OFF_FILE,
        test: 'limit 50 returns 50 and says more matched',
        why: 'same path as limit (proven on dev): count, then cut, at another number; 51 seeded tasks would spend dev’s capped reads for nothing new',
      },
    },
    {
      id: 'snippet-edges',
      entry: 'mcp',
      kind: 'edge',
      what: 'A snippet cut inside a run of emoji starts with … and keeps every emoji whole; blank lines and runs of spaces collapse',
    },
    {
      id: 'old-row',
      entry: 'mcp',
      kind: 'edge',
      what: 'A row stored before dueTime and parentId still answers with every key, as null',
      offDev: {
        file: OFF_FILE,
        test: 'a row from before dueTime and parentId still has every key',
        why: 'dev cannot write a row without those fields',
      },
    },
    {
      id: 'read-only',
      entry: 'mcp',
      kind: 'edge',
      what: 'search_tasks and both list_tasks forms dispatch listTasks once and nothing else; a refused argument reads nothing',
      offDev: {
        file: OFF_FILE,
        test: 'each dispatches listTasks once and nothing else',
        why: 'dev exposes no per-call dispatch audit',
      },
    },
    {
      id: 'live-client',
      entry: 'mcp',
      kind: 'nominal',
      what: 'A reconnected claude.ai or Claude Code session finds a real task by a word from its notes, with no saved file',
      needsYou:
        'the live connectors and the real account are the user’s; reconnect after the prod deploy',
    },
  ],
  steps: [
    {
      id: 'seed',
      title: 'Seed a category and six tasks through the API',
      entry: 'api',
      proves: ['seed'],
      async run(ctx) {
        const w = ctx.api.writes;
        const { today, tomorrow } = ctx.dates;
        seeded.cat = (
          await w.upsertCategory({ label: `devcheck find ${ctx.nonce}`, isWork: false })
        ).id;
        seeded.a = (await w.createTask({ title: title(ctx, 'alpha started'), estimateMin: 15 })).id;
        // The word sits past 45 emoji (90 UTF-16 units), so the snippet's front cut lands inside the run, on the
        // second half of a pair (the word at 2n+25, the cut 60 before it: odd). No nonce here: the queries match
        // it in the title, and the earliest word in the notes must be NOTES_WORD.
        seeded.bNotes = `${'🌿'.repeat(45)} ask the clerk\n\n  about the ${NOTES_WORD} form, then file it`;
        seeded.b = (
          await w.createTask({
            title: title(ctx, 'beta noted'),
            notes: seeded.bNotes,
            dueDay: today,
          })
        ).id;
        seeded.c = (
          await w.createTask({
            title: title(ctx, 'gamma timed'),
            categoryId: seeded.cat,
            dueDay: tomorrow,
            dueTime: '16:30',
          })
        ).id;
        seeded.parent = (await w.createTask({ title: title(ctx, 'delta parent') })).id;
        seeded.part1 = (
          await w.createTask({
            title: title(ctx, 'delta part one'),
            parentId: seeded.parent,
            estimateMin: 10,
          })
        ).id;
        seeded.part2 = (
          await w.createTask({
            title: title(ctx, 'delta part two'),
            parentId: seeded.parent,
            estimateMin: 20,
          })
        ).id;
        await ctx.mcp.writes.updateTask(seeded.a, { status: 'in_progress' });
        // Reads are eventually consistent: wait until one search sees the whole seeded state.
        const missing = (r: DevTaskSearch) => {
          const row = (id: string) => r.tasks.find((t) => t.id === id);
          return [
            r.totalMatches !== 6 && `${r.totalMatches} of 6 rows`,
            row(seeded.a)?.status !== 'in_progress' && 'A in_progress',
            row(seeded.c)?.categoryId !== seeded.cat && 'C’s category',
            row(seeded.parent)?.parts?.total !== 2 && 'the parent’s parts',
          ].filter(Boolean);
        };
        const settled = await until(
          () => search(ctx, { query: ctx.nonce }),
          (r) => !missing(r).length,
        );
        expect(!missing(settled).length, 'the seeded state never read back', missing(settled));
      },
    },
    {
      id: 'tools-listed',
      title: 'tools/list has search_tasks and list_tasks compact',
      entry: 'mcp',
      proves: ['tools-listed'],
      async run(ctx) {
        const tools = await ctx.mcp.reads.toolSchemas();
        const schema = (n: string) =>
          (tools.find((t) => t.name === n)?.inputSchema ?? fail(`tools/list has no ${n}`)) as {
            properties: Record<string, { anyOf?: unknown[] }>;
            required?: string[];
          };
        const s = schema('search_tasks');
        expect(!!s.required?.includes('query'), 'search_tasks query is not required', s);
        expect(
          s.properties.status?.anyOf?.length === 2,
          'search_tasks status is not one-or-a-list',
          s,
        );
        expect(!!s.properties.limit, 'search_tasks has no limit', s);
        expect(
          !!schema('list_tasks').properties.compact,
          'list_tasks has no compact',
          schema('list_tasks'),
        );
      },
    },
    {
      id: 'find',
      title: 'search_tasks by a title word and by a notes word',
      entry: 'mcp',
      proves: ['find-title', 'find-notes', 'snippet-edges'],
      async run(ctx) {
        const byTitle = await search(ctx, { query: `${ctx.nonce} alpha` });
        expect(same(ids(byTitle), [seeded.a]), 'a title word', byTitle);
        expect(
          keysOf(byTitle.tasks[0]!).join() === COMPACT_KEYS.join(),
          'compact keys',
          byTitle.tasks[0],
        );
        expect(
          byTitle.tasks[0]!.notesSnippet === undefined,
          'a title-only match has a snippet',
          byTitle,
        );

        const byNotes = await search(ctx, { query: `${NOTES_WORD.toUpperCase()} ${ctx.nonce}` });
        expect(same(ids(byNotes), [seeded.b]), 'a notes word, upper case', ids(byNotes));
        const snip = byNotes.tasks[0]!.notesSnippet ?? '';
        expect(snip.includes(NOTES_WORD), 'the snippet holds the word', snip.length);
        expect(!/\n| {2}/.test(snip), 'the snippet collapses whitespace', JSON.stringify(snip));
        expect(snip.startsWith('…🌿'), 'the snippet cut in the emoji run', snip.slice(0, 3));
        expect(
          !/\\ud[89a-f]/i.test(JSON.stringify(snip)),
          'the snippet halves an emoji',
          snip.length,
        );
      },
    },
    {
      id: 'all-words',
      title: 'every word, any order, across title and notes',
      entry: 'mcp',
      proves: ['all-words'],
      async run(ctx) {
        const both = await search(ctx, { query: `${NOTES_WORD} beta ${ctx.nonce}` });
        expect(same(ids(both), [seeded.b]), 'a title word plus a notes word', ids(both));
        const none = await search(ctx, { query: `${ctx.nonce} beta nowordlikethis` });
        expect(
          none.totalMatches === 0 && none.tasks.length === 0 && none.more === false,
          'a word no task has',
          none,
        );
      },
    },
    {
      id: 'status',
      title: 'status: one, a list, backlog',
      entry: 'mcp',
      proves: ['status'],
      async run(ctx) {
        const q = ctx.nonce;
        expect(
          same(ids(await search(ctx, { query: q, status: 'in_progress' })), [seeded.a]),
          'in_progress',
          q,
        );
        const list = await search(ctx, { query: q, status: ['done', 'in_progress'] });
        expect(same(ids(list), [seeded.a]), 'a status list', ids(list));
        const backlog = await search(ctx, { query: q, status: 'backlog' });
        const backlogIds = [seeded.b, seeded.c, seeded.parent, seeded.part1, seeded.part2];
        expect(
          same(ids(backlog), backlogIds),
          'backlog',
          backlog.tasks.map((t) => t.status),
        );
      },
    },
    {
      id: 'category-due',
      title: 'categoryId and the due range',
      entry: 'mcp',
      proves: ['category-due'],
      async run(ctx) {
        const q = ctx.nonce;
        const { today, tomorrow } = ctx.dates;
        const got = async (args: Record<string, unknown>) =>
          ids(await search(ctx, { query: q, ...args }));
        const check = async (args: Record<string, unknown>, want: string[]) => {
          const g = await got(args);
          expect(same(g, want), JSON.stringify(args), g);
        };
        await check({ categoryId: seeded.cat }, [seeded.c]);
        await check({ dueFrom: today, dueTo: today }, [seeded.b]);
        await check({ dueFrom: tomorrow }, [seeded.c]);
        await check({ dueTo: today }, [seeded.b]);
        await check({ dueFrom: today, dueTo: tomorrow }, [seeded.b, seeded.c]);
        const [c] = (await search(ctx, { query: `${q} gamma` })).tasks;
        expect(
          c?.dueDay === tomorrow && c.dueTime === '16:30' && c.categoryId === seeded.cat,
          'the timed row',
          c,
        );
      },
    },
    {
      id: 'limit',
      title: 'the limit caps and says so',
      entry: 'mcp',
      proves: ['limit'],
      async run(ctx) {
        const all = await search(ctx, { query: ctx.nonce });
        const mine = [seeded.a, seeded.b, seeded.c, seeded.parent, seeded.part1, seeded.part2];
        expect(
          same(ids(all), mine) && all.totalMatches === 6 && !all.more,
          'the nonce alone',
          ids(all),
        );
        const two = await search(ctx, { query: ctx.nonce, limit: 2 });
        expect(two.tasks.length === 2 && two.totalMatches === 6 && two.more, 'limit 2', {
          n: two.tasks.length,
          totalMatches: two.totalMatches,
          more: two.more,
        });
        expect(
          ids(two).join() === [seeded.part2, seeded.part1].join(),
          'limit 2 keeps the newest',
          ids(two),
        );
      },
    },
    {
      id: 'invalid',
      title: 'bad arguments are param errors',
      entry: 'mcp',
      proves: ['invalid'],
      async run(ctx) {
        const bad: Record<string, unknown>[] = [
          { query: '   ' },
          { query: 'x'.repeat(201) },
          { query: 'a', limit: 0 },
          { query: 'a', limit: 51 },
          { query: 'a', limit: 2.5 },
          { query: 'a', status: 'open' },
          { query: 'a', status: [] },
          { query: 'a', dueFrom: '2026-13-40' },
          { query: 'a', dueFrom: ctx.dates.tomorrow, dueTo: ctx.dates.today },
          { query: 'a', due: ctx.dates.today },
        ];
        for (const args of bad)
          await expectParamError(`search_tasks ${Object.keys(args).join('+')}`, () =>
            search(ctx, args),
          );
        await expectParamError('list_tasks compact "yes"', () =>
          ctx.mcp.reads.listTasksCompact({ compact: 'yes' }),
        );
      },
    },
    {
      id: 'default',
      title: 'list_tasks without compact, and list_backlog, as before',
      entry: 'mcp',
      proves: ['default-unchanged', 'backlog-parts'],
      async run(ctx) {
        const mine = new Set([
          seeded.a,
          seeded.b,
          seeded.c,
          seeded.parent,
          seeded.part1,
          seeded.part2,
        ]);
        const parts = { total: 2, done: 0, estimateMin: 30 };
        const stored = new Map(
          (await ctx.api.reads.listTasks())
            .filter((t) => mine.has(t.id))
            .map((t) => [t.id, canon(t.id === seeded.parent ? { ...t, parts } : t)]),
        );
        expect(stored.size === 6, 'the BFF lists the seeded tasks', [...stored.keys()]);
        const reads: [string, () => Promise<{ id: string }[]>][] = [
          ['no argument', () => ctx.mcp.reads.listTasks()],
          ['compact false', () => ctx.mcp.reads.listTasksCompact({ compact: false })],
        ];
        for (const [what, read] of reads) {
          // Two eventually consistent reads: retry until they agree, then judge the last.
          const offOf = (rows: { id: string }[]) => {
            const listed = rows.filter((t) => mine.has(t.id));
            return listed.length !== 6
              ? [`${listed.length} of 6`]
              : listed.filter((t) => canon(t) !== stored.get(t.id)).map((t) => t.id);
          };
          const off = offOf(await until(read, (rows) => !offOf(rows).length));
          expect(!off.length, `list_tasks with ${what} differs`, off);
        }
        const parent = (await ctx.mcp.reads.listBacklog()).find((t) => t.id === seeded.parent) as
          { parts?: unknown } | undefined;
        expect(canon(parent?.parts) === canon(parts), 'list_backlog’s parent parts', parent?.parts);
      },
    },
    {
      id: 'compact',
      title: 'list_tasks compact: no notes, parts kept, status applies',
      entry: 'mcp',
      proves: ['compact', 'neighbour'],
      async run(ctx) {
        const rows = await ctx.mcp.reads.listTasksCompact();
        const bad = rows.find(
          (r) => keysOf(r).join() !== COMPACT_KEYS.join() || 'notesSnippet' in r,
        );
        expect(!bad, 'a compact row with other keys', bad && Object.keys(bad));
        const b = rows.find((r) => r.id === seeded.b);
        expect(!!b && !('notes' in b), 'B in the compact list', b && Object.keys(b));
        const parent = rows.find((r) => r.id === seeded.parent);
        expect(
          parent?.parts?.total === 2 && parent.parts.estimateMin === 30,
          'the parent’s parts',
          parent?.parts,
        );
        const started = await ctx.mcp.reads.listTasksCompact({ status: 'in_progress' });
        expect(
          started.some((r) => r.id === seeded.a) &&
            started.every((r) => r.status === 'in_progress'),
          'compact with status',
          started.map((r) => r.status),
        );
        // neighbour: the default list is untouched by the compact call
        const full = (await ctx.mcp.reads.listTasks()).find((t) => t.id === seeded.b) as
          Record<string, unknown> | undefined;
        expect(
          typeof full?.notes === 'string' &&
            full.notes.includes(NOTES_WORD) &&
            !!full.createdAt &&
            !!full.updatedAt,
          'the default list after compact',
          full && Object.keys(full),
        );
        const once = await search(ctx, { query: ctx.nonce });
        const twice = await search(ctx, { query: ctx.nonce });
        expect(JSON.stringify(once) === JSON.stringify(twice), 'the same search twice', ids(twice));
      },
    },
    {
      id: 'teardown',
      title: 'tear down by id; the nonce then finds nothing',
      entry: 'mcp',
      proves: ['cleanup'],
      async run(ctx) {
        const w = ctx.api.writes;
        for (const id of [seeded.part1, seeded.part2, seeded.parent, seeded.c, seeded.b, seeded.a])
          if (id) await w.deleteTask(id);
        if (seeded.cat) await w.deleteCategory(seeded.cat, null);
        const after = await until(
          () => search(ctx, { query: ctx.nonce }),
          (r) => r.totalMatches === 0,
        );
        expect(after.totalMatches === 0, 'the nonce after teardown', ids(after));
        const cats = await until(
          () => ctx.api.reads.listCategories(),
          (list) => !list.some((c) => c.id === seeded.cat),
        );
        expect(!cats.some((c) => c.id === seeded.cat), 'the category after teardown', seeded.cat);
      },
    },
    noConsoleErrors,
  ],
};
