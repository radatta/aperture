// The dev check's two lanes (DEV-CHECK.md → Two users). On slot A the Simulator's scenarios (`user: 'iphone'`) run in
// the iPhone lane, signed in as the Simulator's own test user, side by side with every other scenario in the browser
// lane, signed in as the browser's: two users, so neither lane's tasks show in the other's lists and counts, and a
// full run takes about as long as its longer lane instead of both. Each lane is a whole pipeline run (pipeline.ts) —
// its own sign-in, sweep, ledger, cleanup and leak check, all per user — and the two results merge into one report.
// Pure: run.ts does the wiring.
import type { Slot } from './config';
import { DevcheckError } from './errors';
import { coverageOf } from './matrix';
import { deferral, type PipelineDeps } from './pipeline';
import type { CreatedRecord, RunResult, StepResult } from './report';
import type { Scenario, Step } from './scenario';

// one-user: everything in one lane as the original test user — devb (no Simulator), no browser-user env file yet, or
// DEVCHECK_LANES=one-user. serial: both lanes, the iPhone lane first — the timing baseline, and the fallback when the
// two side by side misbehave. parallel: both at once (the default with two users).
export type LaneMode = 'one-user' | 'serial' | 'parallel';
export const LANES_ENV = 'DEVCHECK_LANES';
const MODES: readonly string[] = ['one-user', 'serial', 'parallel'];

// An explicit serial or parallel that can't be honoured (no browser user, or devb) refuses: a timing run must never
// quietly measure one user. Unset falls back to one-user with the reason logged.
export function laneMode(o: { slot: Slot; webEnv: boolean; env?: string }): {
  mode: LaneMode;
  why: string;
} {
  const v = o.env?.trim() || undefined;
  if (v && !MODES.includes(v))
    throw new DevcheckError(
      'LANES_REFUSED',
      `${LANES_ENV}=${v} — one of ${MODES.join(', ')}, or unset`,
    );
  if (v === 'one-user') return { mode: 'one-user', why: `${LANES_ENV}=one-user` };
  const no =
    o.slot !== 'dev'
      ? `${o.slot} has no Simulator`
      : !o.webEnv
        ? 'no browser-user env file yet (DEV-CHECK.md → One-time setup, step 1b)'
        : null;
  if (no && v) throw new DevcheckError('LANES_REFUSED', `${LANES_ENV}=${v}, but ${no}`);
  if (no) return { mode: 'one-user', why: no };
  if (v === 'serial') return { mode: 'serial', why: `${LANES_ENV}=serial` };
  return { mode: 'parallel', why: 'two users, side by side' };
}

// Which scenarios go where. The iPhone lane takes the `user: 'iphone'` scenarios only when one of their steps will
// run (`runs`: not deferred, not skipped). When none will (a branch touching no iOS path), they stay in the browser
// lane, where their deferred rows are reported as ever and nothing is sent: no second sign-in for an idle lane.
export function splitLanes(
  scenarios: Scenario[],
  runs: (sc: Scenario, step: Step) => boolean,
): { browser: Scenario[]; iphone: Scenario[] } {
  const iphone = scenarios.filter((s) => s.user === 'iphone');
  if (!iphone.some((sc) => sc.steps.some((st) => runs(sc, st))))
    return { browser: scenarios, iphone: [] };
  return { browser: scenarios.filter((s) => s.user !== 'iphone'), iphone };
}

// A two-user run's plan (run.ts wires it): the split by the pipeline's own deferral rule; an idle iPhone lane still
// runs, steps-less, when its user's ledger holds an earlier run's leftovers (pending ids or orphan intents): its sweep
// is the only one with that user's token. The Simulator client rides with whichever lane has the iPhone scenarios.
export function planLanes(o: {
  scenarios: Scenario[];
  defer: Pick<PipelineDeps, 'skip' | 'slow'>;
  mainLeftovers: boolean;
}): {
  browser: Scenario[];
  iphone: Scenario[];
  iphoneRuns: boolean;
  sweepOnly: boolean;
  browserGetsIos: boolean;
} {
  const split = splitLanes(o.scenarios, (sc, st) => deferral(o.defer, sc.id, st) === null);
  const sweepOnly = !split.iphone.length && o.mainLeftovers;
  return {
    ...split,
    iphoneRuns: split.iphone.length > 0 || sweepOnly,
    sweepOnly,
    browserGetsIos: !split.iphone.length,
  };
}

export type Lane = 'browser' | 'iphone';
export const IPHONE_SHOTS = 'iphone'; // the iPhone lane's screenshots: a folder of their own under shots/
export const IPHONE_TAG = 'iPhone user: ';

const STATUS_RANK: Record<RunResult['status'], number> = { PASS: 0, FAIL: 1, CRASH: 2 };

// One report from the lanes that ran, in scenario order. The iPhone lane's harness lines (failures, data, console)
// carry "iPhone user: ", its created records `lane: 'iphone'`, its screenshots their folder. A lane that never
// produced a result (it threw) arrives as a CRASH result (crashed()), so the other lane's report still stands.
export function mergeRuns(
  parts: { lane: Lane; r: RunResult }[],
  o: { order: string[]; mode: LaneMode; wallMs: number },
): RunResult {
  if (!parts.length) throw new Error('mergeRuns: no lane ran');
  const base = (parts.find((p) => p.lane === 'browser') ?? parts[0]!).r;
  const at = (id: string) => {
    const i = o.order.indexOf(id);
    return i < 0 ? o.order.length : i;
  };
  const byScenario = <T extends { scenario: string }>(xs: T[]) =>
    xs
      .map((x, i) => ({ x, i }))
      .sort((a, b) => at(a.x.scenario) - at(b.x.scenario) || a.i - b.i)
      .map(({ x }) => x);
  const all = <T>(pick: (r: RunResult) => T[] | undefined, tag: (lane: Lane, x: T) => T) =>
    parts.flatMap(({ lane, r }) => (pick(r) ?? []).map((x) => tag(lane, x)));
  const line = (lane: Lane, s: string) => (lane === 'iphone' ? `${IPHONE_TAG}${s}` : s);
  const shot = (lane: Lane, s: string) => (lane === 'iphone' ? `${IPHONE_SHOTS}/${s}` : s);
  const lines = (pick: (r: RunResult) => string[] | undefined) => all(pick, line);
  // bare ids, joined with ", " in the report: each says whose it is after it
  const ids = (pick: (r: RunResult) => string[] | undefined) =>
    all(pick, (lane, id) => (lane === 'iphone' ? `${id} (iPhone user)` : id));
  const worst = parts.reduce<RunResult['status']>(
    (w, { r }) => (STATUS_RANK[r.status] > STATUS_RANK[w] ? r.status : w),
    'PASS',
  );
  const iphone = parts.find((p) => p.lane === 'iphone')?.r;
  const crashes = parts.filter(({ r }) => r.crash).map(({ lane, r }) => line(lane, r.crash!));
  const merged: RunResult = {
    ...base,
    status: worst,
    codes: [...new Set(parts.flatMap(({ r }) => r.codes))],
    failures: all(
      (r) => r.failures,
      (lane, f) => ({ ...f, message: line(lane, f.message) }),
    ),
    coverage: byScenario(parts.flatMap(({ r }) => r.coverage)),
    steps: byScenario(
      all(
        (r) => r.steps,
        (lane, s): StepResult => (s.shot ? { ...s, shot: shot(lane, s.shot) } : s),
      ),
    ),
    created: all(
      (r) => r.created,
      (lane, c): CreatedRecord => (lane === 'iphone' ? { ...c, lane } : c),
    ),
    swept: ids((r) => r.swept),
    unrecorded: ids((r) => r.unrecorded),
    appeared: ids((r) => r.appeared),
    orphanIntents: lines((r) => r.orphanIntents),
    blockedDeletes: lines((r) => r.blockedDeletes),
    failedDeletes: lines((r) => r.failedDeletes),
    retried: lines((r) => r.retried),
    earlierOrphans: lines((r) => r.earlierOrphans),
    consoleErrors: lines((r) => r.consoleErrors),
    failedLoads: lines((r) => r.failedLoads),
    throttled: lines((r) => r.throttled),
    injected: lines((r) => r.injected),
    shots: all((r) => r.shots, shot),
    durationMs: o.wallMs,
    startSha: base.startSha ?? iphone?.startSha,
    endSha: base.endSha ?? iphone?.endSha,
    deployUrl: base.deployUrl ?? iphone?.deployUrl,
    ios: iphone?.ios ?? base.ios,
    // the browser lane's (base's) pipeline phases, under the wall they never exceed — but the deploy wait is the
    // lane that waited's: they share one (run.ts waitOnce), and in serial the iPhone lane, first, takes it all. The
    // iPhone lane's own time is lanes.iphoneMs (heavy-detail.ts reads both).
    ...(base.phases
      ? {
          phases: {
            ...base.phases,
            deployWaitMs: Math.max(base.phases.deployWaitMs, iphone?.phases?.deployWaitMs ?? 0),
          },
        }
      : {}),
    lanes: {
      mode: o.mode,
      ...(parts.some((p) => p.lane === 'browser') ? { browserMs: base.durationMs } : {}),
      ...(iphone ? { iphoneMs: iphone.durationMs } : {}),
    },
  };
  if (crashes.length) merged.crash = crashes.join('\n');
  else delete merged.crash;
  const unknown = parts
    .filter(({ r }) => r.leftoversUnknown)
    .map(({ lane, r }) => line(lane, r.leftoversUnknown!));
  if (unknown.length) merged.leftoversUnknown = unknown.join('; ');
  else delete merged.leftoversUnknown;
  return merged;
}

export interface LaneRun {
  scenarios: Scenario[];
  run: () => Promise<RunResult>;
}

// Runs the lanes and merges them: side by side in parallel, the iPhone lane first in serial; `iphone` absent, the
// browser lane alone. A lane that throws becomes a CRASH result (crashed()); the other still finishes and cleans up.
export async function runLanes(o: {
  mode: Exclude<LaneMode, 'one-user'>;
  browser: LaneRun;
  iphone?: LaneRun;
  base: Parameters<typeof crashed>[0];
  order: string[];
  now: () => number;
}): Promise<RunResult> {
  const t0 = o.now();
  const settle = async (lane: Lane, l: LaneRun) => ({
    lane,
    r: await l.run().catch((err: unknown) => crashed(o.base, l.scenarios, err)),
  });
  const parts = !o.iphone
    ? [await settle('browser', o.browser)]
    : o.mode === 'parallel'
      ? await Promise.all([settle('browser', o.browser), settle('iphone', o.iphone)])
      : [await settle('iphone', o.iphone), await settle('browser', o.browser)];
  return mergeRuns(parts, { order: o.order, mode: o.mode, wallMs: o.now() - t0 });
}

// A lane whose pipeline threw instead of returning (it catches its own failures, so this is a harness bug): a CRASH
// result naming it, its scenarios' rows unproven (none of its steps is recorded), so the merge still reports the
// lane that finished and never drops the other's rows.
export function crashed(
  base: Pick<RunResult, 'runId' | 'tier' | 'feature' | 'expectedSha' | 'scenarioSha' | 'target'>,
  scenarios: Scenario[],
  err: unknown,
): RunResult {
  return {
    ...base,
    status: 'CRASH',
    crash: err instanceof Error ? (err.stack ?? err.message) : String(err),
    codes: [],
    failures: [],
    coverage: scenarios.flatMap((sc) => coverageOf(sc, [], false)),
    steps: [],
    created: [],
    swept: [],
    unrecorded: [],
    orphanIntents: [],
    blockedDeletes: [],
    failedDeletes: [],
    consoleErrors: [],
    failedLoads: [],
    throttled: [],
    injected: [],
    shots: [],
    durationMs: 0,
    leftoversUnknown:
      "the lane threw, so its cleanup may not have finished — its ledger keeps its ids for that user's lane's next run",
  };
}
