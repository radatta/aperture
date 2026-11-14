// The probe job (docs/ops/IOS-CHECK.md → Probe job): every iOS plan ios-standalone and category-suggest send, cut
// to their probes (probe-only.ts) and sent to the Mac's Simulator as ordinary sim jobs — no drafts, kills, relaunch
// or sign-in, ~4–5 min of Mac time against the full scenario's ~6+ (the one typed line is done-form's search filter). It
// proves the plans' points still land on the deployed build; the full scenario stays the proof of what typing, kills
// and relaunches do. Opt-in: it runs on `--feature ios-probe` / `--scenario ios-probe`, or a change to its own files,
// and is deferred whenever ios-standalone runs in full (scenarios/index.ts → probeSkip). `pnpm ios-probe` is the
// headless check before it.
import { IosAssert, type SimResult } from '../../mailroom/sim';
import { IOS_NOTE } from '../ios';
import { IOS_PROBE_PATHS } from './ios-paths';
import { recordIosPlans } from '../ios-plans';
import { probeJobs, type Plan } from '../probe-only';
import { needsYou, type Ctx, type Scenario } from '../scenario';
import { categorySuggest } from './category-suggest';
import { iosStandalone } from './ios-standalone';

// The scenarios whose plans are cut, in the order a full run sends them (index.test pins: every scenario that
// sends a sim job).
export const SOURCES = [iosStandalone, categorySuggest];
// A cut job is a few dozen point reads; the full jobs' 480 s is for typing and relaunches.
const TIMEOUT_SEC = 240;

export const SIGNED_OUT = `${IOS_NOTE}: SIGNED_OUT — the Simulator's app is on the sign-in card; the probe job never signs in. Run ios-standalone (its launch signs in from the Mac Keychain), then rerun`;

let taskId = '';
let drove = false;
let cut: { nonce: string; jobs: Plan[] } | null = null;
const jobsFor = async (nonce: string) =>
  cut?.nonce === nonce ? cut.jobs : (cut = { nonce, jobs: await cutPlans(nonce) }).jobs;

export async function cutPlans(nonce: string): Promise<Plan[]> {
  const recorded = [];
  for (const s of SOURCES) recorded.push(...(await recordIosPlans(s, { nonce })));
  return probeJobs(recorded);
}

// The app on the sign-in card: the probe job never signs in, so that's needs-you, not a failure. Anything else —
// a low dock included: ios-standalone's known one needs its padded long page, which this job doesn't build — fails.
export function signedOut(err: unknown): boolean {
  const r: SimResult | null =
    err instanceof Error && err.cause instanceof IosAssert ? err.cause.result : null;
  return r?.detail === 'LANDMARK' && r.signedIn === 'false';
}

async function probe(ctx: Ctx, name: string): Promise<void> {
  const job = (await jobsFor(ctx.nonce)).find((j) => j.name === name);
  if (!job) throw new Error(`no probe job ${name} — the recorded plans changed (ios-probe.test)`);
  try {
    await ctx.ios.run(name, job.steps, { timeoutSec: TIMEOUT_SEC });
  } catch (err) {
    if (signedOut(err)) needsYou(SIGNED_OUT); // the rest of the scenario reads needs-you too (pipeline)
    throw err;
  }
}

// The cut jobs, one step each; a recorded job it doesn't send is in probe-only.ts → NOT_PROBED, with why.
export const PROBE_STEPS = ['launch', 'capture', 'done-form', 'review-chip'];
const STEP_TITLES: Record<string, string> = {
  launch: 'Launch from the Home Screen on the deployed build (no sign-in)',
  capture: 'The capture bar and its mode row, keyboard up: found where the plan reads them',
  'done-form': 'Tasks search, the Done form and its Reflection box: found, tapped, cancelled',
  'review-chip': 'The capture bar switched to Task and back',
};

export const iosProbe: Scenario = {
  id: 'ios-probe',
  title: 'iOS probe job: every sim plan’s probe points, on the Simulator, without drafts',
  tiers: ['full'],
  slowPaths: IOS_PROBE_PATHS,
  rows: [
    {
      id: 'probe-launch',
      entry: 'ios',
      kind: 'nominal',
      what: 'The Home Screen app launches signed in on the deployed build',
    },
    {
      id: 'probe-points',
      entry: 'ios',
      kind: 'nominal',
      what: 'Every find, tap and absent of ios-standalone’s and category-suggest’s plans lands on the deployed build (the reads outside drafts)',
    },
    {
      id: 'probe-closes',
      entry: 'ios',
      kind: 'edge',
      what: 'The Done form’s Cancel closes it: Tasks’ search is found again where the first tap found it',
    },
    {
      id: 'probe-never-writes',
      entry: 'api',
      kind: 'edge',
      what: 'After the probe jobs the task is untouched: in progress, no reflection, no time logged',
    },
    {
      id: 'probe-miss-fails',
      entry: 'ios',
      kind: 'edge',
      what: 'A probe that misses fails its step, with the runner’s reason',
      offDev: {
        file: 'scripts/src/devcheck/scenarios/ios-probe.test.ts',
        test: 'a miss stays a failure',
        why: 'a green dev run has no miss to show',
      },
    },
    {
      id: 'probe-signed-out',
      entry: 'ios',
      kind: 'edge',
      what: 'A signed-out Simulator is needs-you (SIGNED_OUT) for the rest of the scenario, never a sign-in',
      offDev: {
        file: 'scripts/src/devcheck/scenarios/ios-probe.test.ts',
        test: 'a signed-out sim is needs-you for the rest of the scenario',
        why: 'signing the dev sim out would need the Keychain sign-in to undo',
      },
    },
    {
      id: 'probe-covered',
      entry: 'ios',
      kind: 'edge',
      what: 'With ios-standalone running in full, the probe job is deferred, never sent as well',
      offDev: {
        file: 'scripts/src/devcheck/scenarios/index.test.ts',
        test: 'probeSkip defers the probe job only when ios-standalone runs in full',
        why: 'the dev run for this feature runs the probe job alone',
      },
    },
  ],
  steps: [
    {
      id: 'setup',
      title: 'An in-progress task for the Done form, titled to match its search (MCP)',
      entry: 'mcp',
      cost: 'slow',
      async run(ctx) {
        drove = false;
        // The Done form's job searches Tasks for ios-standalone's marker: the task carries what it types.
        const search = (await jobsFor(ctx.nonce))
          .find((j) => j.name === 'done-form')
          ?.steps.find((s) => s.op === 'keys');
        if (search?.op !== 'keys') throw new Error('done-form types no search — the plan changed');
        const t = await ctx.mcp.writes.createTask({
          title: `devcheck-ios-probe ${search.text}`,
          estimateMin: 15,
        });
        taskId = t.id;
        await ctx.mcp.writes.updateTask(t.id, { status: 'in_progress' });
      },
    },
    ...PROBE_STEPS.map((name) => ({
      id: name,
      title: STEP_TITLES[name] ?? name,
      entry: 'ios' as const,
      cost: 'slow' as const,
      proves:
        name === 'launch'
          ? ['probe-launch']
          : name === 'done-form'
            ? ['probe-points', 'probe-closes']
            : ['probe-points'],
      async run(ctx: Ctx) {
        await probe(ctx, name);
        if (name === 'done-form') drove = true;
      },
    })),
    {
      id: 'verify',
      title: 'The probe jobs wrote nothing: the task is as set up',
      entry: 'api',
      cost: 'slow',
      proves: ['probe-never-writes'],
      async run(ctx) {
        const t = await ctx.api.reads.getTask(taskId);
        if (!t) throw new Error('the task is gone');
        if (t.status !== 'in_progress') throw new Error(`status ${t.status}, want in_progress`);
        if (t.reflection) throw new Error('a reflection was saved');
        if (t.actualAccruedMin) throw new Error(`${t.actualAccruedMin} min logged`);
        if (!drove)
          needsYou('the Done form job never completed, so an untouched task proves nothing');
      },
    },
  ],
};
