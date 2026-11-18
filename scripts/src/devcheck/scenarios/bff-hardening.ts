// The BFF's edge, hardened (bff-testmode-auth): testMode opens nothing over the Function URL, a malformed
// body is a 400 rather than a thrown handler, and updateSettings/updateStory refuse any key outside their
// patch type. Every refusal step sends a call the BFF must refuse before it writes; a probe that a regression
// would accept carries the row's current value, so even then it changes nothing. The legal story patch
// works on a ledgered story, deleted after. mcp-auth-closed: a wrong agent token is a 401 on /mcp while the
// test user's bearer is served; every "unset on a stage" case is off dev (authClosed.test.ts).
import { type Row, type Scenario } from '../scenario';

const INDEX = 'lambdas/src/index.test.ts';
const CLOSED = 'lambdas/src/authClosed.test.ts'; // fail closed on a stage (mcp-auth-closed)
const UNSET = 'needs a deployed env var unset, and dev’s config is never changed to prove it';

const offDev = (
  id: string,
  what: string,
  file: string,
  test: string,
  why: string,
  entry: Row['entry'] = 'api',
): Row => ({
  id,
  entry,
  kind: 'edge',
  what,
  offDev: { file, test, why },
});

const errorOf = (body: unknown): string =>
  body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
    ? (body as { error: string }).error
    : '';

function expectRefusal(
  label: string,
  got: { status: number; body: unknown },
  status: number,
  error?: RegExp,
): void {
  if (got.status !== status)
    throw new Error(
      `${label}: expected HTTP ${status}, got ${got.status} — ${JSON.stringify(got.body)}`,
    );
  if (error && !error.test(errorOf(got.body)))
    throw new Error(
      `${label}: expected an error matching ${error}, got ${JSON.stringify(got.body)}`,
    );
}

export const bffHardening: Scenario = {
  id: 'bff-hardening',
  title: 'The BFF refuses testMode over HTTP, malformed bodies and unknown patch keys',
  tiers: ['full'],
  rows: [
    {
      id: 'http-testmode-no-jwt',
      entry: 'api',
      kind: 'edge',
      what: 'An /api call with testMode and no JWT (a read and a write) is a 401; no task appears',
    },
    {
      id: 'http-testmode-jwt',
      entry: 'api',
      kind: 'edge',
      what: 'The same with the test user’s JWT is a 400 naming the direct invoke; nothing is written',
    },
    {
      id: 'bad-json',
      entry: 'api',
      kind: 'edge',
      what: 'A malformed body is a 400 “Invalid JSON”, not a thrown handler',
    },
    {
      id: 'args-not-array',
      entry: 'api',
      kind: 'edge',
      what: 'A body whose args is not an array is a 400',
    },
    {
      id: 'settings-mass-assign',
      entry: 'api',
      kind: 'edge',
      what: 'updateSettings with googleAccounts or createdAt is a 400 naming the key; settings unchanged',
    },
    {
      id: 'settings-patch-ok',
      entry: 'api',
      kind: 'nominal',
      what: 'A legal settings patch (the current pomodoroWorkMin) still lands',
    },
    offDev(
      'fault-500',
      'A fault in our code is a 500 with the fixed body “Internal error”, never its text',
      INDEX,
      'a fault inside dispatch is a 500 with a fixed body; a refusal keeps its message at 400',
      'no wire shape reaches a fault any more: the argument check refuses createTask(null) with a 400 (bff-shapes’ null-input row, on dev)',
    ),
    {
      id: 'story-patch-ok',
      entry: 'api',
      kind: 'nominal',
      what: 'A legal story patch still saves and reads back',
    },
    {
      id: 'story-mass-assign',
      entry: 'api',
      kind: 'edge',
      what: 'updateStory with userId is a 400 naming the key, before any lookup',
    },
    offDev(
      'direct-invoke-smoke',
      'A direct invoke with testMode still runs as smoke-test, write-free (the CI smoke)',
      INDEX,
      'a direct invoke with testMode runs as smoke-test and persists nothing (the CI smoke path)',
      'the harness has no AWS credential to invoke the function directly; deploy-stage.yml’s smoke step runs this event against dev and prod on every merge’s deploy',
    ),
    offDev(
      'presigner-inert',
      'testMode never mints a presigned URL, even with a live presigner',
      'lambdas/src/handler.test.ts',
      'testMode never mints a presigned URL, even with a live presigner injected',
      'only a direct invoke can carry testMode now, and the harness can’t invoke directly',
    ),
    offDev(
      'failure-logged',
      'Each failed call logs one rpc_failed line (method, status, name) and nothing sensitive',
      INDEX,
      'logs one rpc_failed line per failed call — method, status, name — never the body, the header or the message',
      'a scenario can’t read dev’s CloudWatch; the line’s shape and redaction are the test’s to prove',
    ),
    offDev(
      'refusal-400',
      'An AWS 5xx is a 500 too; a refusal subclass (ConflictError and kin) keeps its message at 400',
      INDEX,
      'a fault inside dispatch is a 500 with a fixed body; a refusal keeps its message at 400',
      'dev can’t make DynamoDB answer a 5xx or lose a conditional write on demand',
    ),
    offDev(
      'ingest-unchanged',
      'Device-token ingest still maps a lost race, a throttle and a fault to 409, 429 and 500',
      INDEX,
      'says which ingest failures are worth a retry: 409 a lost race, 429 a throttle, 500 a fault',
      'dev can’t make DynamoDB conflict or throttle on demand',
    ),
    {
      id: 'mcp-test-user-ok',
      entry: 'mcp',
      kind: 'nominal',
      what: '/mcp as the test user still lists its tools and reads the backlog (a configured stage isn’t refused)',
    },
    {
      id: 'mcp-wrong-agent-token',
      entry: 'mcp',
      kind: 'edge',
      what: 'A wrong agent token on /mcp (no bearer) is a 401 “invalid agent token” — a regression guard: the unset-token refusals are the off-dev rows',
    },
    offDev(
      'no-origin-secret',
      'A stage with no origin secret 403s every BFF HTTP call, health included (a preflight still 204s)',
      CLOSED,
      'no origin secret: every HTTP call is 403, health included',
      UNSET,
    ),
    offDev(
      'mcp-no-origin-secret',
      'A stage with no origin secret 403s every /mcp call',
      CLOSED,
      'no origin secret: 403',
      UNSET,
      'mcp',
    ),
    offDev(
      'bff-no-verifier',
      'A stage with no pool wired refuses a call instead of serving the local user',
      CLOSED,
      'no verifier wired: a call is 401, never the local user',
      UNSET,
    ),
    offDev(
      'bff-device-token-no-user',
      'The right device token with no user bound is refused on ingest (devb binds none)',
      CLOSED,
      'the right device token with no user bound: ingest is 401, never local',
      'dev binds a user; devb binds none but the dev check never holds the device token, and never reads it',
    ),
    offDev(
      'oauth-state-no-secret',
      'A Google callback state signed with the dev key is refused on a stage',
      CLOSED,
      'no origin secret: a state signed with the dev key is refused on the Google callback (direct invoke)',
      UNSET,
    ),
    offDev(
      'mcp-no-agent-token',
      'A stage with no agent token refuses the agent header instead of the local user',
      CLOSED,
      'no agent token configured: the agent header is 401, never local',
      UNSET,
      'mcp',
    ),
    offDev(
      'mcp-token-no-user',
      'The right agent token with no user bound is refused (devb binds none)',
      CLOSED,
      'the right agent token with no user bound is 401',
      'dev binds a user; devb binds none but the dev check never holds the agent token, and never reads it',
      'mcp',
    ),
    offDev(
      'oauth-connect-no-secret',
      'Google connect can’t sign a state on a stage with no origin secret',
      CLOSED,
      'no origin secret: Google connect can’t sign a state on a stage',
      UNSET,
    ),
    offDev(
      'ci-smoke-event',
      'The CI smoke’s event shape is unchanged (no http context)',
      'scripts/src/smoke.test.ts',
      'builds a testMode direct-invoke event (no http context → skips the origin gate)',
      'proven live by every merge’s deploy-stage.yml smoke step on dev, then prod — the deploy fails if it regresses',
    ),
  ],
  steps: [
    {
      id: 'mcp-auth',
      title: '/mcp: the test user is served, a wrong agent token is a 401',
      entry: 'mcp',
      proves: ['mcp-test-user-ok', 'mcp-wrong-agent-token'],
      async run(ctx) {
        if (!(await ctx.mcp.reads.toolsList()).includes('list_backlog'))
          throw new Error('/mcp as the test user listed no list_backlog tool');
        await ctx.mcp.reads.listBacklog();
        const got = await ctx.mcp.reads.agentTokenProbe();
        // The body tells a refused token from a header CloudFront dropped (that one is "requires a credential").
        if (got.status !== 401 || got.error !== 'Unauthorized: invalid agent token')
          throw new Error(
            `a wrong agent token on /mcp answered ${got.status} ${JSON.stringify(got.error)}`,
          );
      },
    },
    {
      id: 'story-ok',
      title: 'A legal story patch saves and reads back',
      entry: 'api',
      proves: ['story-patch-ok'],
      async run(ctx) {
        const story = await ctx.api.writes.createStory(`devcheck story ${ctx.nonce}`);
        const renamed = `devcheck story renamed ${ctx.nonce}`;
        const saved = await ctx.api.writes.updateStory(story.id, {
          title: renamed,
          situation: 'probe',
        });
        if (saved.title !== renamed || saved.situation !== 'probe')
          throw new Error(`updateStory answered ${JSON.stringify(saved)}`);
        const back = (await ctx.api.reads.listStories()).find((x) => x.id === story.id);
        if (back?.title !== renamed || back.situation !== 'probe')
          throw new Error(`the patched story read back as ${JSON.stringify(back)}`);
        await ctx.api.writes.deleteStory(story.id);
      },
    },
    {
      id: 'testmode-no-jwt',
      title: 'testMode with no JWT: 401, nothing written',
      entry: 'api',
      proves: ['http-testmode-no-jwt'],
      async run(ctx) {
        const title = `devcheck testMode probe ${ctx.nonce}`;
        const read = await ctx.api.writes.rpcRaw(
          'getSettings',
          JSON.stringify({ testMode: true, args: [] }),
          'none',
        );
        expectRefusal('getSettings testMode, no JWT', read, 401);
        const write = await ctx.api.writes.rpcRaw(
          'createTask',
          JSON.stringify({ testMode: true, args: [{ title }] }),
          'none',
        );
        expectRefusal('createTask testMode, no JWT', write, 401);
        if ((await ctx.api.reads.listTasks()).some((t) => t.title === title))
          throw new Error('a testMode createTask with no JWT left a task in the test user’s list');
      },
    },
    {
      id: 'testmode-jwt',
      title: 'testMode with the JWT: 400, nothing written',
      entry: 'api',
      proves: ['http-testmode-jwt'],
      async run(ctx) {
        const title = `devcheck testMode probe ${ctx.nonce}`;
        const got = await ctx.api.writes.rpcRaw(
          'createTask',
          JSON.stringify({ testMode: true, args: [{ title }] }),
          'jwt',
        );
        expectRefusal('createTask testMode with JWT', got, 400, /direct invoke/);
        if ((await ctx.api.reads.listTasks()).some((t) => t.title === title))
          throw new Error('a refused testMode createTask left a task in the test user’s list');
      },
    },
    {
      id: 'bad-body',
      title: 'A malformed body or non-array args: 400',
      entry: 'api',
      proves: ['bad-json', 'args-not-array'],
      async run(ctx) {
        expectRefusal(
          'malformed body',
          await ctx.api.writes.rpcRaw('getSettings', '{not json', 'jwt'),
          400,
          /^Invalid JSON$/,
        );
        expectRefusal(
          'args not an array',
          await ctx.api.writes.rpcRaw('getSettings', JSON.stringify({ args: 'x' }), 'jwt'),
          400,
          /args must be an array/,
        );
      },
    },
    {
      id: 'settings-reject',
      title: 'updateSettings refuses googleAccounts and userId; a legal patch lands',
      entry: 'api',
      proves: ['settings-mass-assign', 'settings-patch-ok'],
      async run(ctx) {
        const before = await ctx.api.reads.getSettings();
        // Each probe carries the current value, so a regressed allowlist that took it changes nothing.
        const current = before as unknown as { googleAccounts: unknown; createdAt: unknown };
        const probe = async (key: 'googleAccounts' | 'createdAt') =>
          expectRefusal(
            `updateSettings ${key}`,
            await ctx.api.writes.rpcRaw(
              'updateSettings',
              JSON.stringify({ args: [{ [key]: current[key] }] }),
              'jwt',
            ),
            400,
            new RegExp(`Unknown settings field: ${key}`),
          );
        await probe('googleAccounts');
        await probe('createdAt');
        // A refusal throws before any write, so updatedAt stays put; any write a regression let through moves it.
        const after = (await ctx.api.reads.getSettings()) as unknown as typeof current & {
          updatedAt: unknown;
        };
        const was = before as unknown as typeof after;
        for (const k of ['updatedAt', 'googleAccounts', 'createdAt'] as const)
          if (JSON.stringify(after[k]) !== JSON.stringify(was[k]))
            throw new Error(`a refused updateSettings changed the test user’s settings (${k})`);
        const ok = await ctx.api.writes.updateSettings({ pomodoroWorkMin: before.pomodoroWorkMin });
        if (ok.pomodoroWorkMin !== before.pomodoroWorkMin)
          throw new Error(
            `a legal patch answered pomodoroWorkMin ${ok.pomodoroWorkMin}, sent ${before.pomodoroWorkMin}`,
          );
      },
    },
    {
      id: 'story-reject',
      title: 'updateStory refuses userId before any lookup',
      entry: 'api',
      proves: ['story-mass-assign'],
      async run(ctx) {
        expectRefusal(
          'updateStory userId',
          await ctx.api.writes.rpcRaw(
            'updateStory',
            JSON.stringify({
              args: [`devcheck-no-such-story-${ctx.nonce}`, { userId: 'someone-else' }],
            }),
            'jwt',
          ),
          400,
          /Unknown story field: userId/,
        );
      },
    },
  ],
};
