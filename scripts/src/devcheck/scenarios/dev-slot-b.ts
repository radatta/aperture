// Slot B (INFRA §2, docs/ops/CI-BOT.md → Dev slots): a second dev stack, devb, in the same account. Its dev rows are
// slot-relative — each passes on either slot — so the scenario stays as a standing guard that the harness is where the
// lock says it is: the BFF names the slot it runs as, the app and its /mcp answer at the run's origin, and the slot's
// reminders are set up and ticking. What only the deploy path or AWS can show (which lock a branch gets, the kill
// reaching devb, main's devb lane) is proven off dev by its own tests or by the user.
import { assertDevOrigin, currentSlot, targetOrigin } from '../config';
import { parseMarker } from '../deploy';
import { noConsoleErrors, type Row, type RowKind, type Scenario } from '../scenario';

const off = (
  id: string,
  what: string,
  file: string,
  test: string,
  why: string,
  kind: RowKind = 'edge',
  entry: Row['entry'] = 'api',
): Row => ({ id, entry, kind, what, offDev: { file, test, why } });
const DEPLOY_PATH =
  'which lock a branch gets is the bot’s choice before any deploy; a devcheck run holds one slot, so it can’t make the other choice happen';
const TEMPLATE =
  'the template and the role policies are the proof, before any deploy; the round’s synth diff shows the same';
const OTHER_SLOT =
  'a run sees only the slot its lock is on, so the other slot’s addresses and records never reach it';
const POLLER_FRESH_MS = 10 * 60_000; // the poller ticks every minute

async function fetchSlot(path: string): Promise<Response> {
  const url = `${targetOrigin()}${path}`;
  assertDevOrigin(url);
  const r = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
  if (r.status !== 200) throw new Error(`${path}: expected 200, got ${r.status}`);
  return r;
}

export const devSlotB: Scenario = {
  id: 'dev-slot-b',
  title: 'Each dev slot answers as itself, at its own origin',
  tiers: ['full'],
  rows: [
    {
      id: 'health-stage',
      entry: 'api',
      kind: 'nominal',
      what: 'The BFF behind the run’s origin runs as that slot’s stage',
    },
    {
      id: 'shell-origin',
      entry: 'ui',
      kind: 'nominal',
      what: 'The signed-in app runs at the slot’s own origin and serves a build marker',
    },
    {
      id: 'mcp-slot',
      entry: 'mcp',
      kind: 'nominal',
      what: 'The slot’s /mcp accepts its own claude client (aperture-claude-<slot>)',
    },
    {
      id: 'push-keys',
      entry: 'api',
      kind: 'nominal',
      what: 'Reminders work on the slot: VAPID keys set in its SSM path (copied from dev’s) and its own poller ticking',
    },
    // The template
    off(
      'born-capped',
      'devb is created with dev’s on-demand ceiling and TTL',
      'cdk/src/stacks.test.ts',
      'creates devb with the on-demand ceiling and TTL a dev slot needs',
      'the freeze keeps a ceiling only if the table was created with one, and that create happens once; the template is the proof',
      'nominal',
    ),
    off(
      'ttl-stamp',
      'Rows deleted on devb get their expiry stamp, as on dev',
      'lambdas/src/ddb/writes.test.ts',
      'every dev slot stamps put, putIf and batchPut',
      'the stamp is one isDevSlot check in liveWrites; dead-rows proves the dev path through it on whichever slot the run is on',
    ),
    off(
      'roles-both-slots',
      'The dev deploy roles publish, smoke and read outputs on devb, never prod',
      'cdk/src/cicd.test.ts',
      'lets both dev deploy roles publish, smoke and read outputs on both dev slots, never prod',
      TEMPLATE,
    ),
    off(
      'logs-both-slots',
      '`pnpm bot logs` reads both slots’ groups and nothing else',
      'cdk/src/cicd.test.ts',
      "lets the logs role read only the dev slots' Lambda groups, and nothing else",
      TEMPLATE,
    ),
    // The bot's lock
    off(
      'takes-b',
      'deploy-dev takes devb when another branch holds dev, leaving dev’s lock alone',
      'scripts/src/bot/deploy-dev.test.ts',
      'takes slot B when another branch holds A, dispatches devb, and leaves A alone',
      DEPLOY_PATH,
      'nominal',
    ),
    off(
      'stays-on-slot',
      'A branch that holds a slot keeps it on its next deploy',
      'scripts/src/bot/lock.test.ts',
      'keeps a branch on the slot it holds, even when A has freed',
      DEPLOY_PATH,
    ),
    off(
      'both-held',
      'Both slots held: refused, naming both holders and `lock wait --any`',
      'scripts/src/bot/lock.test.ts',
      'refuses with every holder named when both are held',
      DEPLOY_PATH,
    ),
    off(
      'wait-any',
      '`lock wait --any` wakes on whichever slot frees first',
      'scripts/src/bot/lock.test.ts',
      'wait --any wakes on whichever slot frees first',
      'a wait needs two other branches holding both slots; the fake clock drives it',
    ),
    off(
      'wait-any-gives-up',
      '`lock wait --any` still held at the cap: exit 75, naming the soonest holder',
      'scripts/src/bot/lock.test.ts',
      'wait --any gives up naming the soonest holder',
      'a 45-minute wait behind two live holders; the fake clock drives it',
    ),
    off(
      'own-slot-only',
      'renew and release act on the slot this branch holds, never the other',
      'scripts/src/bot/lock.test.ts',
      'finds, renews and releases only the slot the branch holds',
      DEPLOY_PATH,
    ),
    // Main's lane
    off(
      'main-shape',
      'A main merge redeploys devb only when its shape changed (cdk/, the lockfile, or shared’s stage.ts)',
      'scripts/src/deploy-base.test.ts',
      "deploys only a shape change: cdk/, the lockfile or shared's stage.ts",
      'main’s lane runs only on a merge to main, after this PR',
      'nominal',
    ),
    off(
      'bases-apart',
      'Each slot’s main deploys are judged by its own records, never the other’s',
      'scripts/src/deploy-base.test.ts',
      "walks past the other slot's records, failed ones included",
      'main’s lane runs only on a merge to main, after this PR',
    ),
    {
      id: 'first-main-devb',
      entry: 'api',
      kind: 'nominal',
      what: 'The first merge to main after this PR runs `deploy-devb` green (or skips it, with mode_devb none)',
      needsYou:
        'main’s Deploy run after the merge: read its `changes` log line (`devb=`) and the `deploy-devb / deploy` job',
    },
    {
      id: 'bad-slot',
      entry: 'api',
      kind: 'edge',
      what: 'deploy-dev.yml refuses a slot other than dev or devb before the role is assumed',
      needsYou:
        'the bot never sends one; a hand dispatch with `-f slot=devc` shows the `verify` refusal (optional)',
    },
    // The devcheck
    off(
      'lock-picks-target',
      'A devcheck targets the slot its branch’s lock is on, and never another branch’s',
      'scripts/src/devcheck/slot.test.ts',
      "never follows another branch's lock: no lock of its own → slot A, as before slot B",
      OTHER_SLOT,
    ),
    off(
      'no-lock-a-held',
      'No lock of its own while another branch holds dev: refused, never run into that branch’s test',
      'scripts/src/devcheck/slot.test.ts',
      'refuses to run on dev while another branch holds it live',
      OTHER_SLOT,
    ),
    off(
      'guards-follow-slot',
      'Every guard — origin, Files bucket, Hosted UI host, MCP scope — follows the slot',
      'scripts/src/devcheck/config.slots.test.ts',
      "on devb, every guard moves to devb's addresses and refuses slot A's",
      OTHER_SLOT,
    ),
    off(
      'ios-slot-a',
      'iOS rows on devb read “needs you”, never a failure',
      'scripts/src/devcheck/ios.test.ts',
      "on devb every iOS step is needs you, and nothing goes to the Mac (the sim is slot A's)",
      'the sim is slot A’s by design (deferred), so a devb run never queues a sim job to fail',
      'edge',
      'ios',
    ),
    // AWS, by hand
    {
      id: 'kill-devb',
      entry: 'api',
      kind: 'edge',
      what: 'A kill locks devb’s URLs, zeroes its functions and disables its distribution; unkill restores them',
      needsYou:
        'the kill drill (plan D15–D16): it kills both slots, so it runs once, by hand, when no lane is on dev',
    },
    {
      id: 'finance-devb',
      entry: 'ui',
      kind: 'nominal',
      what: 'The finance scenario has its fixture bank on devb',
      needsYou:
        'one Plaid Link in Safari as devb’s test user (plan D11); until then the finance scenario reads needs-you on devb',
    },
  ],
  steps: [
    {
      id: 'health',
      entry: 'api',
      title: 'GET /api/health names this slot as its stage',
      proves: ['health-stage'],
      async run(ctx) {
        const body = (await (await fetchSlot('/api/health')).json()) as { stage?: unknown };
        if (body.stage !== currentSlot())
          throw new Error(
            `/api/health says stage ${String(body.stage)}, this run is on ${currentSlot()}`,
          );
        ctx.log(`health: stage ${String(body.stage)} at ${targetOrigin()}`);
      },
    },
    {
      id: 'shell',
      entry: 'ui',
      title: 'The app runs at the run’s origin, with a build marker',
      proves: ['shell-origin'],
      async run(ctx) {
        await ctx.ui.goto('/settings');
        await ctx.ui.expectText(/^Build [0-9a-f]{7}$/);
        const at = new URL(ctx.page.url()).origin;
        if (at !== targetOrigin()) throw new Error(`the app is at ${at}, not ${targetOrigin()}`);
        const marker = parseMarker(await (await fetchSlot('/')).text());
        if (!marker || !/^[0-9a-f]{40}$/.test(marker))
          throw new Error(`${targetOrigin()}/ serves no build marker (${String(marker)})`);
        await ctx.shot('settings');
      },
    },
    {
      id: 'mcp',
      entry: 'mcp',
      title: 'The slot’s /mcp answers as the test user',
      proves: ['mcp-slot'],
      async run(ctx) {
        const tools = await ctx.mcp.reads.toolsList();
        if (!tools.includes('create_task')) throw new Error('tools/list has no create_task');
        ctx.log(`mcp at ${targetOrigin()}/mcp: ${tools.length} tools`);
      },
    },
    {
      id: 'push',
      entry: 'api',
      title: 'Reminders are set up on this slot, and its poller is ticking',
      proves: ['push-keys'],
      async run(ctx) {
        const s = await ctx.api.reads.getPushStatus();
        if (!s.configured || !s.vapidPublicKey)
          throw new Error(
            `reminders aren't configured on ${currentSlot()} — copy the VAPID keys to its SSM path (plan D10)`,
          );
        const last = s.poller.lastRunAt;
        if (!last || Date.now() - last > POLLER_FRESH_MS)
          throw new Error(
            `${currentSlot()}'s reminder poller last ran ${last ? new Date(last).toISOString() : 'never'}`,
          );
        ctx.log(`push: configured, poller last ran ${new Date(last).toISOString()}`);
      },
    },
    noConsoleErrors,
  ],
};
