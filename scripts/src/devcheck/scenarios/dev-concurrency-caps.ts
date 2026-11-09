// Every dev function reserves its own concurrency (cdk/src/config/devAccount.ts), so dev's ceiling is their sum,
// not the account quota (CI-BOT.md → What's capped → Compute). Dev proves the reservations leave the app room: a
// burst of 12 at the BFF (more than the old quota of 10 allowed in flight) and one at /mcp get no throttle, and the
// one-tick poller still ticks.
// The values themselves, the kill's restore and the SCPs are template and kill-Lambda state the test user can't
// read; their tests pin them, and the live values and the drill are a hand read.
import { type Row, type Scenario } from '../scenario';

const STACKS = 'cdk/src/stacks.test.ts';
const KILL = 'lambdas/src/kill/kill.test.ts';
const ORG = 'cdk/src/org.test.ts';
const BFF_BURST = 12; // past the old account quota of 10, under the BFF's 18
const MCP_BURST = 6; // under /mcp's 10
const TICK_WINDOW_MS = 3 * 60_000; // the poller runs every minute: two missed ticks fail it

const offDev = (id: string, what: string, file: string, test: string, why: string): Row => ({
  id,
  entry: 'api',
  kind: 'edge',
  what,
  offDev: { file, test, why },
});

export const devConcurrencyCaps: Scenario = {
  id: 'dev-concurrency-caps',
  title: 'Each dev function reserves its share; the app still has room',
  tiers: ['full'],
  rows: [
    {
      id: 'bff-under-cap',
      entry: 'api',
      kind: 'nominal',
      what: `${BFF_BURST} /api reads sent at once all answer with no throttle`,
    },
    {
      id: 'mcp-under-cap',
      entry: 'mcp',
      kind: 'nominal',
      what: `${MCP_BURST} /mcp list_tasks at once all answer with no throttle`,
    },
    {
      id: 'poller-ticks',
      entry: 'api',
      kind: 'nominal',
      what: 'The reminder poller, reserved 1, has ticked within the last 3 minutes',
    },
    offDev(
      'reservation-values',
      'Each dev function reserves its own share (BFF 18, MCP 10, finance sync 1, poller 1), summing to 30; prod keeps only the poller’s 1',
      STACKS,
      "reserves each dev function's own share, summing to the slot's ceiling",
      'template state: the test user has no AWS credential to read a reservation, and dev shows only its effect (the rows above)',
    ),
    offDev(
      'new-fn-fails',
      'A new dev function with no reservation fails synth, so it can’t reach dev uncapped',
      STACKS,
      'fails synth for a dev function with no reservation on record',
      'a synth failure never reaches dev',
    ),
    offDev(
      'restore-puts-back',
      'After a kill, restore puts each function’s own reservation back, not the account quota',
      KILL,
      'puts each function’s own reservation back, unlocks the URLs and the distributions — never the SCP',
      'the harness never fires a kill: that kills dev for everyone (the live drill is a needs-you row)',
    ),
    offDev(
      'restore-unknown-fn',
      'A function with no reservation on record, other than a CDK provider, stays at 0 through a restore, named',
      KILL,
      'leaves it at 0 and names it, and still restores everything else',
      'needs an app function missing from the table, which only a template change ahead of an ApertureOrg redeploy makes',
    ),
    offDev(
      'absent-fn-skipped',
      'A function that doesn’t exist (a slot not yet deployed) is logged and skipped by a kill or restore, not a failure',
      KILL,
      'is logged and skipped by the kill and the restore, never a failure',
      'needs a URL function that isn’t deployed, which dev never has while the harness runs',
    ),
    offDev(
      'kill-without-table',
      'A malformed restore table can’t stop a kill: only the restore reads it',
      KILL,
      'kills on a trigger even when the restore’s table is unreadable',
      'needs a broken kill Lambda env, which only a hand ApertureOrg deploy makes',
    ),
    offDev(
      'restore-provider',
      'Restore hands a CDK provider function (never reserved) back unreserved, and succeeds',
      KILL,
      'gives a CDK provider function back its unreserved state, and succeeds',
      'the harness never fires a kill (the drill does, a needs-you row)',
    ),
    offDev(
      'bot-lane-denied',
      'A dispatch can’t change a reservation while the freeze is on; main’s lane can',
      ORG,
      "leave reservations to the freeze, so main's lane can deploy them",
      'an SCP denial needs a bad template deployed under the freeze, a hand step; the drill and the freeze reattach prove the SCPs are live',
    ),
    offDev(
      'over-cap-throttles',
      'A burst past a cap gets a 429, and the app’s client retries it',
      'app/src/data/httpClient.test.ts',
      'a 429 re-enters the queue while it waits to retry',
      'a 429 past the cap depends on how Lambda schedules a 20-wide burst, not reproducible on demand, and flooding dev is what the caps exist to bound',
    ),
    {
      id: 'live-values',
      entry: 'api',
      kind: 'nominal',
      what: 'Dev’s functions report 18 / 10 / 1 / 1 after the deploy',
      needsYou:
        'the container has no AWS credentials: the get-function-concurrency line in the PR body',
    },
    {
      id: 'kill-drill',
      entry: 'api',
      kind: 'edge',
      what: 'A live kill sets every function to 0; the unkill puts back 18 / 10 / 1 / 1',
      needsYou:
        'the drill kills dev for every lane and needs the management account (CI-BOT.md → Drill)',
    },
  ],
  steps: [
    {
      id: 'bff-burst',
      title: `${BFF_BURST} /api reads at once: no throttle`,
      entry: 'api',
      proves: ['bff-under-cap'],
      async run(ctx) {
        const before = ctx.api.throttles();
        await Promise.all(Array.from({ length: BFF_BURST }, () => ctx.api.reads.listCategories()));
        const throttled = ctx.api.throttles() - before;
        if (throttled)
          throw new Error(
            `${throttled} of ${BFF_BURST} /api reads were throttled (429) — the BFF's reservation isn't holding room`,
          );
      },
    },
    {
      id: 'mcp-burst',
      title: `${MCP_BURST} /mcp list_tasks at once: no throttle`,
      entry: 'mcp',
      proves: ['mcp-under-cap'],
      async run(ctx) {
        const before = ctx.mcp.throttles();
        await Promise.all(Array.from({ length: MCP_BURST }, () => ctx.mcp.reads.listTasks()));
        const throttled = ctx.mcp.throttles() - before;
        if (throttled)
          throw new Error(
            `${throttled} of ${MCP_BURST} /mcp calls were throttled (429) — /mcp's reservation isn't holding room`,
          );
      },
    },
    {
      id: 'poller-ticks',
      title: 'The reminder poller ticked within the last 3 minutes',
      entry: 'api',
      proves: ['poller-ticks'],
      async run(ctx) {
        const { lastRunAt } = (await ctx.api.reads.getPushStatus()).poller;
        if (lastRunAt === null) throw new Error('the reminder poller has never run on dev');
        const ago = Date.now() - lastRunAt;
        ctx.log(`reminder poller last ticked ${Math.round(ago / 1000)} s ago`);
        if (ago > TICK_WINDOW_MS)
          throw new Error(
            `the reminder poller last ticked ${Math.round(ago / 1000)} s ago — over 3 minutes`,
          );
      },
    },
  ],
};
