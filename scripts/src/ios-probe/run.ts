// The probe check — IOS-CHECK.md → Probe check. Every iOS plan the scenarios send, replayed against the stub app:
//   pnpm ios-probe [--scenario a,b] [--engine chromium|webkit] [--shots <dir>]
// Also a step of `pnpm devcheck:local` (runProbes). Exit 0 all pass, 1 a probe failed, 2 the check couldn't run.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { recordIosPlans, type RecordedJob } from '../devcheck/ios-plans';
import { SCENARIOS } from '../devcheck/scenarios/index';
import type { Scenario } from '../devcheck/scenario';
import { freePort, startVite, type Proc } from '../devcheck/local/server';
import { checkJob, formatJob, KEYBOARD_VIEWPORT_H, staleDevData, type JobResult } from './check';
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
  const stale = o.scenarios ? [] : staleDevData(jobs);
  const engine = await openEngine(o.engine ?? 'chromium');
  const results: JobResult[] = [];
  const blocks: string[] = [];
  try {
    for (const j of jobs) {
      const page = await engine.page(o.origin);
      try {
        const r = await checkJob(page, j, {
          shot: o.shotsDir ? (n) => join(o.shotsDir!, `${n}.png`) : undefined,
        });
        results.push(r);
        blocks.push(
          formatJob(r, `${engine.name}, 440×956, keyboard model 440×${KEYBOARD_VIEWPORT_H}`),
        );
        o.log?.(`${r.ok ? 'pass' : 'FAIL'} ${j.scenario}/${j.name}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await engine.close();
  }
  if (stale.length) blocks.push(`FAIL stale dev-data skips (no op matches): ${stale.join(', ')}`);
  const ok = !stale.length && results.every((r) => r.ok);
  const head = `iOS probe check: ${ok ? 'PASS' : 'FAIL'} — ${results.filter((r) => r.ok).length}/${results.length} jobs (a first filter: the Simulator stays the proof, IOS-CHECK.md → Probe check)`;
  return { ok, text: [head, '', ...blocks].join('\n\n'), results };
}

// A stub-mode Vite for the check, stopped by its PID.
export async function withStubApp<T>(
  worktree: string,
  logPath: string,
  f: (origin: string) => Promise<T>,
): Promise<T> {
  const procs: Proc[] = [];
  const port = await freePort();
  try {
    await startVite({ worktree, track: (p) => void procs.push(p), port, env: {}, logPath });
    return await f(`http://127.0.0.1:${port}`);
  } finally {
    for (const p of procs) await p.stop().catch(() => undefined);
  }
}

function parseArgs(argv: string[]) {
  const a = { scenarios: [] as string[], engine: 'chromium' as EngineName, shots: '' };
  for (let i = 0; i < argv.length; i += 2) {
    const [k, v = ''] = [argv[i], argv[i + 1]];
    if (k === '--scenario') a.scenarios = v.split(',').filter(Boolean);
    else if (k === '--shots') a.shots = v;
    else if (k === '--engine' && ENGINES.includes(v as EngineName)) a.engine = v as EngineName;
    else if (k === '--engine') throw new Error(`--engine is one of ${ENGINES.join(', ')}`);
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
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
  return run.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(2);
    },
  );
