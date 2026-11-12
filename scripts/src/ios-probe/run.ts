// The probe check — IOS-CHECK.md → Probe check. Every iOS plan the scenarios send, replayed against the stub app:
//   pnpm ios-probe [--scenario a,b] [--engine chromium|webkit] [--shots <dir>] [--calibrate [--results <dir>]]
// Also a step of `pnpm devcheck:local` (runProbes). Exit 0 all pass, 1 a probe failed, 2 the check couldn't run.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { recordIosPlans, type RecordedJob } from '../devcheck/ios-plans';
import { SCENARIOS } from '../devcheck/scenarios/index';
import type { Scenario } from '../devcheck/scenario';
import { freePort, startVite, type Proc } from '../devcheck/local/server';
import { checkJob, formatJob, KEYBOARD_VIEWPORT_H, staleDevData, type JobResult } from './check';
import { compareJob, formatCalibration, newestGreen, type SimResultFile } from './calibrate';
import { ENGINES, openEngine, type EngineName } from './engine';

// The nonce the plans are recorded with: ios-standalone's search marker becomes "rewrit", which finds the stub seed's
// in-progress task ("Rewrite the onboarding section", app/src/data/seed.ts) as dev's seeded task is found there.
export const PROBE_NONCE = 'rewrite';

export async function recordAll(scenarios: Scenario[] = SCENARIOS): Promise<RecordedJob[]> {
  const jobs: RecordedJob[] = [];
  for (const s of scenarios) jobs.push(...(await recordIosPlans(s, { nonce: PROBE_NONCE })));
  return jobs;
}

export interface ProbeRun {
  ok: boolean;
  text: string;
  results: JobResult[];
}

export async function runProbes(o: {
  origin: string;
  engine?: EngineName;
  scenarios?: Scenario[];
  shotsDir?: string;
  log?: (m: string) => void;
}): Promise<ProbeRun> {
  const jobs = await recordAll(o.scenarios);
  if (o.scenarios && !jobs.length)
    throw new Error(`no iOS plans in ${o.scenarios.map((x) => x.id).join(', ')}`);
  const stale = o.scenarios ? [] : staleDevData(jobs);
  const engine = await openEngine(o.engine ?? 'chromium');
  const results: JobResult[] = [];
  const blocks: string[] = [];
  try {
    for (const j of jobs) {
      // One job's crash (Home's landmark gone, a page that won't load) is that job's FAIL, not the run's end.
      const r = await checkJobSafely(engine, o.origin, j, o.shotsDir).catch(
        (err: unknown): JobResult => ({
          scenario: j.scenario,
          name: j.name,
          ok: false,
          ops: [
            {
              i: -1,
              op: 'job',
              status: 'fail',
              note: `CRASH: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        }),
      );
      results.push(r);
      blocks.push(
        formatJob(r, `${engine.name}, 440×956, keyboard model 440×${KEYBOARD_VIEWPORT_H}`),
      );
      o.log?.(`${r.ok ? 'pass' : 'FAIL'} ${j.scenario}/${j.name}`);
    }
  } finally {
    await engine.close();
  }
  if (!jobs.length) blocks.push('FAIL no iOS plans recorded: nothing was checked');
  const fragile = results.flatMap((r) => r.ops).filter((x) => x.note.includes('FRAGILE')).length;
  if (stale.length) blocks.push(`FAIL stale dev-data skips (no op matches): ${stale.join(', ')}`);
  const ok = jobs.length > 0 && !stale.length && results.every((r) => r.ok);
  const head = `iOS probe check: ${ok ? 'PASS' : 'FAIL'} — ${results.filter((r) => r.ok).length}/${results.length} jobs${fragile ? `, ${fragile} FRAGILE` : ''} (a first filter: the Simulator stays the proof, IOS-CHECK.md → Probe check)`;
  return { ok, text: [head, '', ...blocks].join('\n\n'), results };
}

async function checkJobSafely(
  engine: Awaited<ReturnType<typeof openEngine>>,
  origin: string,
  j: RecordedJob,
  shotsDir?: string,
): Promise<JobResult> {
  const page = await engine.page(origin);
  try {
    return await checkJob(page, j, {
      shot: shotsDir ? (n) => join(shotsDir, `${n}.png`) : undefined,
    });
  } finally {
    await page.close();
  }
}

// A stub-mode Vite for the check, stopped by its PID — on a signal or a crash too (the container is shared).
export async function withStubApp<T>(
  worktree: string,
  logPath: string,
  f: (origin: string) => Promise<T>,
): Promise<T> {
  const procs: Proc[] = [];
  const stopAll = async () => {
    for (const p of procs) await p.stop().catch(() => undefined);
  };
  for (const [sig, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)
    process.once(sig, () => void stopAll().then(() => process.exit(code)));
  process.once('exit', () => procs.forEach((p) => p.killNow()));
  const port = await freePort();
  try {
    await startVite({ worktree, track: (p) => void procs.push(p), port, env: {}, logPath });
    return await f(`http://127.0.0.1:${port}`);
  } finally {
    await stopAll();
  }
}

function parseArgs(argv: string[]) {
  const a = {
    scenarios: [] as string[],
    engine: 'chromium' as EngineName,
    shots: '',
    calibrate: false,
    results: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const [k, v = ''] = [argv[i], argv[i + 1]];
    if (k === '--calibrate') {
      a.calibrate = true;
      continue;
    }
    i++;
    if (k === '--scenario') a.scenarios = v.split(',').filter(Boolean);
    else if (k === '--shots') a.shots = v;
    else if (k === '--results') a.results = v;
    else if (k === '--engine' && ENGINES.includes(v as EngineName)) a.engine = v as EngineName;
    else if (k === '--engine') throw new Error(`--engine is one of ${ENGINES.join(', ')}`);
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

// The Simulator's results live in the main checkout's .hostjobs (the mailroom's shared folder), not a worktree's.
function resultsRoot(worktree: string): string {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: worktree,
  })
    .toString()
    .trim();
  return join(dirname(common), '.hostjobs', 'results');
}

function calibrate(run: ProbeRun, root: string): { ok: boolean; text: string } {
  const ids = existsSync(root) ? readdirSync(root) : [];
  const read = (id: string): SimResultFile | null => {
    try {
      return JSON.parse(readFileSync(join(root, id, 'result.json'), 'utf8')) as SimResultFile;
    } catch {
      return null;
    }
  };
  const sources: string[] = [];
  const rows = run.results.flatMap((r) => {
    const id = newestGreen(ids, r.scenario, r.name, read);
    if (!id) return [];
    sources.push(id);
    return compareJob(r, read(id)!);
  });
  return formatCalibration(rows, sources);
}

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2));
  const worktree = new URL('../../../', import.meta.url).pathname;
  const scenarios = a.scenarios.length
    ? a.scenarios.map((id) => {
        const s = SCENARIOS.find((x) => x.id === id);
        if (!s) throw new Error(`no scenario ${id}`);
        return s;
      })
    : undefined;
  const shots = a.shots || join(worktree, 'localNotes', 'ios-probe');
  mkdirSync(shots, { recursive: true });
  const run = await withStubApp(worktree, join(shots, 'vite.log'), (origin) =>
    runProbes({
      origin,
      engine: a.engine,
      scenarios,
      shotsDir: shots,
      log: (m) => console.log(`[ios-probe] ${m}`),
    }),
  );
  console.log(`\n${run.text}`);
  if (!a.calibrate) return run.ok ? 0 : 1;
  const cal = calibrate(run, a.results || resultsRoot(worktree));
  console.log(`\n${cal.text}`);
  return cal.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(2);
    },
  );
