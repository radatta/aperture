// Slot B (INFRA §2, docs/ops/CI-BOT.md → Dev slots): a second dev stack, devb, in the same account. Its rows are
// slot-relative — each passes on either slot — so the scenario stays as a standing guard that the harness is where the
// lock says it is: the BFF names the slot it runs as, the app and its /mcp answer at the slot's origin, and the slot
// has its own push keys. What only the deploy path or AWS can show (which lock a branch gets, the kill reaching devb)
// is proven off dev by its own tests or by the user's drill.
import { assertDevOrigin, currentSlot, slotOrigin, targetOrigin } from '../config';
import { parseMarker } from '../deploy';
import { noConsoleErrors, type Row, type Scenario } from '../scenario';

const off = (
  id: string,
  what: string,
  file: string,
  test: string,
  why: string,
  entry: Row['entry'] = 'api',
): Row => ({ id, entry, kind: 'edge', what, offDev: { file, test, why } });
const DEPLOY_PATH =
  'which lock a branch gets is the bot’s choice before any deploy; a devcheck run holds one slot, so it can’t make the other choice happen';

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
      what: 'The BFF behind the slot’s origin runs as that slot’s stage',
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
      what: 'Reminders are configured on the slot: its own VAPID keys, its own poller',
    },
    off(
      'born-capped',
      'devb is created with dev’s on-demand ceiling and TTL',
      'cdk/src/stacks.test.ts',
      'creates devb with the on-demand ceiling and TTL a dev slot needs',
      'the freeze keeps a ceiling only if the table was created with one, and that create happens once; the template is the proof, before any deploy',
    ),
    off(
      'takes-b',
      'deploy-dev takes devb when another branch holds dev, leaving dev’s lock alone',
      'scripts/src/bot/deploy-dev.test.ts',
      'takes slot B when another branch holds A, dispatches devb, and leaves A alone',
      DEPLOY_PATH,
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
      'lock-picks-target',
      'A devcheck targets the slot its branch’s lock is on, and never another branch’s',
      'scripts/src/devcheck/slot.test.ts',
      "never follows another branch's lock: no lock of its own → slot A, as before slot B",
      'a run sees only the slot it holds; the lock it doesn’t hold is the other branch’s',
    ),
    off(
      'main-shape',
      'A main merge redeploys devb only when its shape changed (cdk/ or the lockfile), never gating prod',
      'scripts/src/deploy-base.test.ts',
      'deploys only a shape change: cdk/ or the lockfile',
      'main’s lane runs only on a merge to main, after this PR; its first run is checked by hand',
    ),
    off(
      'ios-slot-a',
      'iOS rows on devb read “needs you”, never a failure',
      'scripts/src/devcheck/ios.test.ts',
      "on devb every iOS step is needs you, and nothing goes to the Mac (the sim is slot A's)",
      'the sim is slot A’s by design (deferred), so a devb run never queues a sim job to fail',
      'ios',
    ),
    {
      id: 'kill-devb',
      entry: 'api',
      kind: 'edge',
      what: 'A kill locks devb’s URLs, zeroes its functions and disables its distribution; unkill puts its reservations back',
      needsYou:
        'the kill drill (plan D15–D16): it kills both slots, so it runs once, by hand, when no lane is on dev',
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
        ctx.log(`health: stage ${String(body.stage)} at ${slotOrigin()}`);
      },
    },
    {
      id: 'shell',
      entry: 'ui',
      title: 'The app runs at the slot’s origin',
      proves: ['shell-origin'],
      async run(ctx) {
        await ctx.ui.goto('/settings');
        await ctx.ui.expectText(/^Build [0-9a-f]{7}$/);
        const at = new URL(ctx.page.url()).origin;
        if (at !== slotOrigin()) throw new Error(`the app is at ${at}, not ${slotOrigin()}`);
        const marker = parseMarker(await (await fetchSlot('/')).text());
        if (!marker || !/^[0-9a-f]{40}$/.test(marker))
          throw new Error(`${slotOrigin()}/ serves no build marker (${String(marker)})`);
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
        ctx.log(`mcp at ${slotOrigin()}/mcp: ${tools.length} tools`);
      },
    },
    {
      id: 'push',
      entry: 'api',
      title: 'Reminders are configured on this slot',
      proves: ['push-keys'],
      async run(ctx) {
        const s = await ctx.api.reads.getPushStatus();
        if (!s.configured || !s.vapidPublicKey)
          throw new Error(
            `reminders aren't configured on ${currentSlot()} — copy the slot's VAPID keys (plan D10)`,
          );
        ctx.log(
          `push: configured, poller last ran ${s.poller.lastRunAt ? new Date(s.poller.lastRunAt).toISOString() : 'never'}`,
        );
      },
    },
    noConsoleErrors,
  ],
};
