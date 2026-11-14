// The BFF's argument shapes (bff-shape-validation): every call off the wire is checked against its method's
// argument spec (lambdas/src/rpc/argSpecs.ts) before anything is read or written, so a wrong shape is a 400
// naming the problem, never a 500, and a nested object is never stored as sent. Every refusal probe is
// either a create the BFF must refuse before it writes (its title carries the nonce, and the step checks it
// never landed) or an edit of a ledgered row, read back unchanged. The legal shapes save on ledgered rows,
// deleted after; the settings probes carry the current values, so even a regression changes nothing.
import { noConsoleErrors, type Row, type Scenario } from '../scenario';
import type { Ctx } from '../scenario';

// Mirror argSpecs.ts's TEXT_MAX (prose), CAPTURE_MAX (a log entry, an idea) and TASK_TITLE_MAX: drift fails
// this scenario's max rows loudly.
const TEXT_MAX = 20_000;
const CAPTURE_MAX = 100_000;
const TASK_TITLE_MAX = 40_000;
const BODY_MAX = 1024 * 1024; // RPC_BODY_MAX

const offDev = (id: string, what: string, file: string, test: string, why: string): Row => ({
  id,
  entry: 'api',
  kind: 'edge',
  what,
  offDev: { file, test, why },
});
const api = (id: string, kind: Row['kind'], what: string): Row => ({
  id,
  entry: 'api',
  kind,
  what,
});

const errorOf = (body: unknown): string =>
  body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
    ? (body as { error: string }).error
    : '';

// One raw call with the test user's JWT; a non-matching status or error text fails the step.
async function expectRpc(
  ctx: Ctx,
  method: string,
  args: unknown[],
  status: number,
  error?: RegExp,
): Promise<unknown> {
  const got = await ctx.api.writes.rpcRaw(method, JSON.stringify({ args }), 'jwt');
  const label = `${method}(${JSON.stringify(args).slice(0, 80)})`;
  if (got.status !== status)
    throw new Error(
      `${label}: expected HTTP ${status}, got ${got.status} — ${JSON.stringify(got.body)}`,
    );
  if (error && !error.test(errorOf(got.body)))
    throw new Error(
      `${label}: expected an error matching ${error}, got ${JSON.stringify(got.body)}`,
    );
  return got.body;
}

// Equal as JSON values, whatever the key order: DynamoDB hands a map's keys back in its own order.
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
        )
      : v;
const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

const titleOf = (ctx: Ctx, what: string) => `devcheck shapes ${what} ${ctx.nonce}`;
async function noTaskTitled(ctx: Ctx, title: string): Promise<void> {
  if ((await ctx.api.reads.listTasks()).some((t) => t.title === title))
    throw new Error(`a refused call left a task titled ${title}`);
}

const legalReview = {
  insight: null,
  help: 'none',
  mistakes: [],
  howItWent: null,
  tags: [],
  draftUsed: false,
};
const pushInput = (ctx: Ctx) => ({
  endpoint: `https://devcheck.invalid/push/${ctx.nonce}`,
  keys: { p256dh: 'devcheck-p256dh', auth: 'devcheck-auth' },
  label: 'devcheck shapes',
});

export const bffShapes: Scenario = {
  id: 'bff-shapes',
  title: 'The BFF refuses wrongly shaped arguments with a 400 and stores no nested object as sent',
  tiers: ['full'],
  rows: [
    api(
      'null-input',
      'edge',
      'createTask(null) and createTask("x") are a 400 naming the task, not a 500',
    ),
    api(
      'missing-required',
      'edge',
      'createTask({}) and setTaskTitle(id) are a 400 naming the missing field',
    ),
    api(
      'unknown-key',
      'edge',
      'createTask with userId, sent twice, is the same 400 naming userId; no task lands',
    ),
    api(
      'extra-arg',
      'edge',
      'getDay(today, {consistent: true}) is a 400: the backend-only option is not the wire’s',
    ),
    api(
      'scalar-slot-object',
      'edge',
      'An object where text goes (a log entry, a task title) is a 400; both read back unchanged',
    ),
    api(
      'series-rule-bad',
      'edge',
      'A series rule as a string, an unknown kind, bad days or an extra key is a 400; the series reads back unchanged',
    ),
    api(
      'series-rule-ok',
      'nominal',
      'A legal weekly series saves and listSeries reads its rule back',
    ),
    api(
      'settings-nested-bad',
      'edge',
      'Calendar refs of the wrong shape, a bad write default or theme are a 400; settings unchanged',
    ),
    api(
      'settings-nested-ok',
      'nominal',
      'A patch carrying the current calendar refs and write default lands',
    ),
    api(
      'story-values-bad',
      'edge',
      'Story tags as an object, a title as an object, or a field over the cap are a 400; the story is unchanged',
    ),
    api('story-max-ok', 'nominal', 'Two tags and a field at the cap save and read back'),
    api(
      'review-unknown-key',
      'edge',
      'A sitting review with an extra key is a 400 naming it, before any lookup',
    ),
    api(
      'review-legal-passes',
      'nominal',
      'A legal review passes the check (a missing sitting answers Not found)',
    ),
    api('push-unknown-key', 'edge', 'A push subscription with an extra key is a 400 naming it'),
    api(
      'push-legal-passes',
      'nominal',
      'A legal subscription passes the check (an off-list endpoint is refused by the push rule)',
    ),
    api(
      'capture-max-ok',
      'nominal',
      'A task title at its cap (40 000) and a log entry at the capture cap (100 000) save and read back',
    ),
    api(
      'optional-args',
      'nominal',
      'listIdeas(), listSittings() and createTasks([]) still answer 200',
    ),
    api('body-cap', 'edge', 'A body over 1 MiB is a 413'),
    api(
      'ingest-shape',
      'edge',
      'lcSittingStart(null) and with two args, with the JWT, are a 400 with a reason',
    ),
    {
      id: 'mcp-refusal',
      entry: 'mcp',
      kind: 'edge',
      what: 'create_task with a title over the cap is an MCP error naming the cap; no task lands',
    },
    {
      id: 'mcp-ok',
      entry: 'mcp',
      kind: 'nominal',
      what: 'create_task still saves through the check',
    },
    { id: 'ui-ok', entry: 'ui', kind: 'nominal', what: 'Capturing a task in the app still saves' },
    offDev(
      'ingest-device-token',
      'The same ingest refusal with the device token',
      'lambdas/src/index.test.ts',
      'a wrongly shaped ingest call is a 400 on the device-token path, not a 500',
      'same path as ingest-shape (proven on dev): only the credential differs, and the harness holds no device token',
    ),
    offDev(
      'throttle-500',
      'A DynamoDB throttle is a 500 with a fixed body on rpc, still a 429 on ingest',
      'lambdas/src/rpc/failure.test.ts',
      'maps a throttle to 429 on ingest and a fixed 500 on rpc',
      'dev can’t make DynamoDB throttle on demand',
    ),
    offDev(
      'aws-4xx-hidden',
      'An AWS 4xx never shows its text on either path',
      'lambdas/src/rpc/failure.test.ts',
      'never shows the text of an AWS error',
      'dev can’t make DynamoDB refuse a request on demand',
    ),
    offDev(
      'smoke-calls',
      'Every CI smoke call passes the check',
      'scripts/src/smoke.test.ts',
      "every call passes the BFF's argument check, so the deploy smoke can't go red on a shape",
      'the harness can’t invoke the function directly; every merge’s deploy-stage.yml smoke step proves it live',
    ),
  ],
  steps: [
    {
      id: 'null-and-missing',
      title: 'Null, a string or a missing field where an object goes: 400 with a reason',
      entry: 'api',
      proves: ['null-input', 'missing-required'],
      async run(ctx) {
        // Ledgered: a regression's create would land untitled, so only its id could clean it.
        const label = titleOf(ctx, 'untitled probe');
        for (const [args, error] of [
          [[null], 'task must be an object'],
          [['x'], 'task must be an object'],
          [[{}], 'title is required'],
        ] as const) {
          const got = await ctx.api.writes.createTaskExpectingRefusal([...args], label);
          if (got.status !== 400 || errorOf(got.body) !== error)
            throw new Error(
              `createTask(${JSON.stringify(args)}) answered ${got.status} ${JSON.stringify(got.body)}`,
            );
        }
        await expectRpc(
          ctx,
          'setTaskTitle',
          [`devcheck-no-such-task-${ctx.nonce}`],
          400,
          /setTaskTitle: title is required/,
        );
      },
    },
    {
      id: 'unknown-key',
      title: 'createTask with userId, twice: the same 400, nothing lands',
      entry: 'api',
      proves: ['unknown-key'],
      async run(ctx) {
        const title = titleOf(ctx, 'mass-assign');
        for (let i = 0; i < 2; i++) {
          const got = await ctx.api.writes.createTaskExpectingRefusal(
            [{ title, userId: 'someone-else' }],
            title,
          );
          if (got.status !== 400 || errorOf(got.body) !== 'Unknown task field: userId')
            throw new Error(
              `createTask with userId answered ${got.status} ${JSON.stringify(got.body)}`,
            );
        }
        await noTaskTitled(ctx, title);
      },
    },
    {
      id: 'extra-arg',
      title: 'getDay with a second argument: 400',
      entry: 'api',
      proves: ['extra-arg'],
      async run(ctx) {
        await expectRpc(
          ctx,
          'getDay',
          [ctx.dates.today, { consistent: true }],
          400,
          /getDay takes at most 1 argument/,
        );
      },
    },
    {
      id: 'scalar-object',
      title: 'An object where text goes: 400, rows unchanged',
      entry: 'api',
      proves: ['scalar-slot-object'],
      async run(ctx) {
        const text = titleOf(ctx, 'log');
        const entry = await ctx.api.writes.createLogEntry(text, ctx.dates.today);
        const task = await ctx.api.writes.createTask({ title: titleOf(ctx, 'scalar') });
        try {
          await expectRpc(
            ctx,
            'updateLogEntry',
            [entry.id, { text: 'x' }],
            400,
            /^text must be text$/,
          );
          await expectRpc(
            ctx,
            'setTaskTitle',
            [task.id, { title: 'x' }],
            400,
            /^title must be text$/,
          );
          const back = (await ctx.api.reads.listLogEntries(ctx.dates.today)).find(
            (e) => e.id === entry.id,
          );
          if (back?.text !== text)
            throw new Error(`the log entry read back as ${JSON.stringify(back)}`);
          if ((await ctx.api.reads.getTask(task.id))?.title !== titleOf(ctx, 'scalar'))
            throw new Error('a refused setTaskTitle changed the task');
        } finally {
          await ctx.api.writes.deleteLogEntry(entry.id);
          await ctx.api.writes.deleteTask(task.id);
        }
      },
    },
    {
      id: 'series',
      title: 'A legal weekly series saves; bad rules on it are refused',
      entry: 'api',
      proves: ['series-rule-ok', 'series-rule-bad'],
      async run(ctx) {
        const title = titleOf(ctx, 'series');
        const series = await ctx.api.writes.createSeries(
          { title, rule: { kind: 'weekly', daysOfWeek: [1, 3] } },
          ctx.dates.today,
        );
        try {
          const read = async () =>
            (await ctx.api.reads.listSeries()).find((s) => s.id === series.id);
          const saved = await read();
          if (!same(saved?.rule, { kind: 'weekly', daysOfWeek: [1, 3] }))
            throw new Error(`the series rule read back as ${JSON.stringify(saved?.rule)}`);
          const edit = (rule: unknown) => [
            {
              id: series.id,
              title,
              categoryId: null,
              defaultEstimateMin: null,
              rule,
              anchorDate: ctx.dates.today,
            },
          ];
          await expectRpc(ctx, 'upsertSeries', edit('weekly'), 400, /^rule must be an object$/);
          await expectRpc(
            ctx,
            'upsertSeries',
            edit({ kind: 'monthly' }),
            400,
            /^rule\.kind must be one of/,
          );
          await expectRpc(
            ctx,
            'upsertSeries',
            edit({ kind: 'weekly', daysOfWeek: 'mon' }),
            400,
            /daysOfWeek must be a list/,
          );
          await expectRpc(
            ctx,
            'upsertSeries',
            edit({ kind: 'weekly', daysOfWeek: [9] }),
            400,
            /must be 0 to 6/,
          );
          await expectRpc(
            ctx,
            'upsertSeries',
            edit({ kind: 'daily', extra: 1 }),
            400,
            /^Unknown rule field: extra$/,
          );
          if (!same((await read())?.rule, saved?.rule))
            throw new Error('a refused upsertSeries changed the series rule');
        } finally {
          await ctx.api.writes.deleteSeries(series.id);
        }
      },
    },
    {
      id: 'settings',
      title: 'Wrongly shaped calendar refs, default or theme are refused; the current ones land',
      entry: 'api',
      proves: ['settings-nested-bad', 'settings-nested-ok'],
      async run(ctx) {
        const before = (await ctx.api.reads.getSettings()) as unknown as Record<string, unknown>;
        // The legal patch is also the restore: it puts back the current values in `finally`, so a regression
        // that stored a refused probe leaves the test user's settings as they were.
        const current = {
          calendarShapeRefs: before.calendarShapeRefs,
          calendarWriteDefault: before.calendarWriteDefault,
          theme: before.theme,
        };
        let ok: Record<string, unknown>;
        try {
          await expectRpc(
            ctx,
            'updateSettings',
            [{ calendarShapeRefs: [{ accountSub: 1 }] }],
            400,
            /accountSub must be text/,
          );
          await expectRpc(
            ctx,
            'updateSettings',
            [{ calendarShapeRefs: [{ accountSub: 'a', calendarId: 'b', x: 1 }] }],
            400,
            /^Unknown calendar field: x$/,
          );
          await expectRpc(
            ctx,
            'updateSettings',
            [{ calendarWriteDefault: 'x' }],
            400,
            /calendarWriteDefault must be an object/,
          );
          await expectRpc(
            ctx,
            'updateSettings',
            [{ theme: { dark: true } }],
            400,
            /theme must be one of/,
          );
          const after = (await ctx.api.reads.getSettings()) as unknown as Record<string, unknown>;
          for (const k of ['updatedAt', 'calendarShapeRefs', 'calendarWriteDefault', 'theme'])
            if (!same(after[k], before[k]))
              throw new Error(`a refused updateSettings changed the test user’s settings (${k})`);
        } finally {
          ok = (await ctx.api.writes.updateSettings(current as never)) as unknown as Record<
            string,
            unknown
          >;
        }
        for (const [k, v] of Object.entries(current))
          if (!same(ok[k], v))
            throw new Error(`a legal patch answered ${k} ${JSON.stringify(ok[k])}`);
      },
    },
    {
      id: 'story',
      title: 'Story values: bad ones refused, tags and a field at the cap saved',
      entry: 'api',
      proves: ['story-values-bad', 'story-max-ok'],
      async run(ctx) {
        const story = await ctx.api.writes.createStory(titleOf(ctx, 'story'));
        const neighbour = await ctx.api.writes.createStory(titleOf(ctx, 'story neighbour'));
        try {
          const before = await ctx.api.reads.listStories();
          await expectRpc(
            ctx,
            'updateStory',
            [story.id, { competencyTags: { leadership: true } }],
            400,
            /competencyTags must be a list/,
          );
          await expectRpc(
            ctx,
            'updateStory',
            [story.id, { title: { text: 'x' } }],
            400,
            /^title must be text$/,
          );
          await expectRpc(
            ctx,
            'updateStory',
            [story.id, { situation: 'x'.repeat(TEXT_MAX + 1) }],
            400,
            /situation is limited to 20000 characters/,
          );
          if (!same(await ctx.api.reads.listStories(), before))
            throw new Error('a refused updateStory changed the story list');
          const full = 's'.repeat(TEXT_MAX);
          const saved = await ctx.api.writes.updateStory(story.id, {
            competencyTags: ['ownership', 'impact'],
            situation: full,
          });
          const back = (await ctx.api.reads.listStories()).find((s) => s.id === story.id);
          for (const got of [saved, back])
            if (got?.situation !== full || !same(got.competencyTags, ['ownership', 'impact']))
              throw new Error(
                `the story at the cap read back as ${JSON.stringify(got).slice(0, 200)}`,
              );
          const other = (await ctx.api.reads.listStories()).find((s) => s.id === neighbour.id);
          if (other?.title !== titleOf(ctx, 'story neighbour') || other.situation !== '')
            throw new Error('the neighbour story changed');
        } finally {
          await ctx.api.writes.deleteStory(story.id);
          await ctx.api.writes.deleteStory(neighbour.id);
        }
      },
    },
    {
      id: 'review-and-push',
      title: 'Owned inputs: an extra key is refused by name; a legal shape reaches its own rule',
      entry: 'api',
      proves: [
        'review-unknown-key',
        'review-legal-passes',
        'push-unknown-key',
        'push-legal-passes',
      ],
      async run(ctx) {
        const noSitting = `devcheck-no-such-sitting-${ctx.nonce}`;
        await expectRpc(
          ctx,
          'setSittingReview',
          [noSitting, { ...legalReview, extra: 1 }],
          400,
          /^Unknown review field: extra$/,
        );
        await expectRpc(ctx, 'setSittingReview', [noSitting, legalReview], 400, /Not found/);
        // An endpoint no push service issues: even a regression that skipped the check stores nothing.
        await expectRpc(
          ctx,
          'subscribePush',
          [{ ...pushInput(ctx), extra: 1 }],
          400,
          /^Unknown push subscription field: extra$/,
        );
        await expectRpc(
          ctx,
          'subscribePush',
          [pushInput(ctx)],
          400,
          /push endpoint isn't a known push service|aren't set up/,
        );
      },
    },
    {
      id: 'capture-max',
      title: 'A task title and a log entry at their caps save and read back',
      entry: 'api',
      proves: ['capture-max-ok'],
      async run(ctx) {
        const head = titleOf(ctx, 'max');
        const title = `${head} ${'t'.repeat(TASK_TITLE_MAX - head.length - 1)}`;
        const text = `${head} ${'l'.repeat(CAPTURE_MAX - head.length - 1)}`;
        const task = await ctx.api.writes.createTask({ title });
        const entry = await ctx.api.writes.createLogEntry(text, ctx.dates.today);
        try {
          if ((await ctx.api.reads.getTask(task.id))?.title !== title)
            throw new Error('the task at the title cap read back changed');
          const back = (await ctx.api.reads.listLogEntries(ctx.dates.today)).find(
            (e) => e.id === entry.id,
          );
          if (back?.text !== text)
            throw new Error('the log entry at the capture cap read back changed');
        } finally {
          await ctx.api.writes.deleteTask(task.id);
          await ctx.api.writes.deleteLogEntry(entry.id);
        }
      },
    },
    {
      id: 'optional-args',
      title: 'Optional arguments left out or null still answer',
      entry: 'api',
      proves: ['optional-args'],
      async run(ctx) {
        await expectRpc(ctx, 'listIdeas', [], 200);
        await expectRpc(ctx, 'listSittings', [], 200);
        const made = await expectRpc(ctx, 'createTasks', [[]], 200);
        if (!Array.isArray(made) || made.length !== 0)
          throw new Error(`createTasks([]) answered ${JSON.stringify(made)}`);
      },
    },
    {
      id: 'body-cap',
      title: 'A body over 1 MiB: 413',
      entry: 'api',
      proves: ['body-cap'],
      async run(ctx) {
        const raw = JSON.stringify({ args: [], pad: 'x'.repeat(BODY_MAX + 1) });
        const got = await ctx.api.writes.rpcRaw('getSettings', raw, 'jwt');
        if (got.status !== 413) throw new Error(`a ${raw.length}-char body answered ${got.status}`);
      },
    },
    {
      id: 'ingest',
      title: 'An ingest call of the wrong shape: 400 with a reason',
      entry: 'api',
      proves: ['ingest-shape'],
      async run(ctx) {
        await expectRpc(ctx, 'lcSittingStart', [null], 400, /A sitting start is required/);
        await expectRpc(
          ctx,
          'lcSittingStart',
          [{}, {}],
          400,
          /lcSittingStart takes at most 1 argument/,
        );
      },
    },
    {
      id: 'mcp',
      title: 'MCP: a title over the cap is refused through the check; a legal create saves',
      entry: 'mcp',
      proves: ['mcp-refusal', 'mcp-ok'],
      async run(ctx) {
        const long = `${titleOf(ctx, 'mcp long')} ${'x'.repeat(TASK_TITLE_MAX)}`;
        const refused = await ctx.mcp.writes.createTaskExpectingRefusal({ title: long });
        if (!refused.isError || refused.text !== 'title is limited to 40000 characters')
          throw new Error(
            `create_task with a title over the cap answered ${refused.text.slice(0, 120)}`,
          );
        await noTaskTitled(ctx, long);
        const task = await ctx.mcp.writes.createTask({
          title: titleOf(ctx, 'mcp'),
          estimateMin: 15,
        });
        if (task.title !== titleOf(ctx, 'mcp'))
          throw new Error(`MCP saved ${JSON.stringify(task)}`);
        await ctx.mcp.writes.deleteTask(task.id);
      },
    },
    {
      id: 'ui',
      title: 'The app’s capture still saves through the check',
      entry: 'ui',
      proves: ['ui-ok'],
      async run(ctx) {
        await ctx.ui.goto('/tasks');
        await ctx.ui.captureTask(`${titleOf(ctx, 'ui')} | ~15`);
        await ctx.shot('captured');
        const id = ctx.createdIds().at(-1);
        if (!id) throw new Error('the create response never reached the ledger');
        const task = await ctx.api.reads.getTask(id);
        if (task?.title !== titleOf(ctx, 'ui') || task.estimateMin !== 15)
          throw new Error(`server has ${JSON.stringify(task)}`);
      },
    },
    noConsoleErrors,
  ],
};
