// The dev check CLI — docs/ops/DEV-CHECK.md. From a worktree whose branch is (being) deployed to dev:
//   pnpm --filter @aperture/scripts devcheck --tier smoke|delta|full [--scenario a,b] [--feature a,b] [--sha <40-hex>]
//     [--no-deploy-wait]
// Never alongside tests or a dev server (CLAUDE.md → COI ceilings). One run at a time per container: the
// sweep of earlier runs' leftovers would otherwise race a live run.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createApiClient } from './api';
import { launch, loadPlaywright } from './browser';
import {
  DEV_ORIGIN,
  devcheckHome,
  envPath,
  loadEnv,
  mainCheckout,
  runDir,
  statePath,
  worktreeRoot,
} from './config';
import { RUN_FIELDS, waitForDeploy, type DeployRun } from './deploy';
import { DevcheckError } from './errors';
import { openLedger } from './ledger';
import { matrixProblems } from './matrix';
import { createMcpClient } from './mcp';
import { blockClaude, ensureMcpSignedIn } from './mcp-login';
import { ensureSignedIn, readCheckedSession, validateCachedState } from './login';
import { exitCode, runPipeline } from './pipeline';
import { renderReport, statusLine } from './report';
import { SCENARIOS, selectFeature, selectScenarios, type RunTier } from './scenarios/index';

const exec = promisify(execFile);

export interface Args {
  tier: RunTier;
  scenarios: string[];
  feature: string[];
  sha?: string;
  deployWait: boolean;
}

const ids = (v: string) => [...new Set(v.split(',').filter(Boolean))];

export function parseArgs(argv: string[]): Args {
  const args: Args = { tier: 'smoke', scenarios: [], feature: [], deployWait: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--tier') {
      const t = val();
      if (t !== 'smoke' && t !== 'delta' && t !== 'full')
        throw new Error(`--tier smoke|delta|full, got ${t}`);
      args.tier = t;
    } else if (a === '--scenario') args.scenarios = ids(val());
    else if (a === '--feature') args.feature = ids(val());
    else if (a === '--sha') {
      const s = val();
      if (!/^[0-9a-f]{40}$/.test(s)) throw new Error(`--sha needs a full 40-hex SHA, got ${s}`);
      args.sha = s;
    } else if (a === '--no-deploy-wait') args.deployWait = false;
    else if (a !== '--') throw new Error(`unknown argument ${a}`);
  }
  // In delta the feature is what was asked for; smoke always rides along and is never a feature.
  if (!args.feature.length && args.tier === 'delta')
    args.feature = args.scenarios.filter((id) => id !== 'smoke');
  return args;
}

// One live run per container: a pid file in the shared devcheck home, created exclusively (O_EXCL) so two
// runs starting together can't both take it. A stale file (its pid is dead) is removed and retried once.
export function takeLock(path: string): () => void {
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx' });
      // Two runs that both found the same stale lock can each unlink and write; settle, then confirm it's ours.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      if (readFileSync(path, 'utf8') !== String(process.pid))
        throw new Error(`lost the race for ${path} to another dev check — wait for it`);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw err;
      const held = readFileSync(path, 'utf8');
      const pid = /^[1-9][0-9]*$/.test(held.trim()) ? Number(held) : 0; // garbage or empty → stale
      let alive = pid > 0;
      if (alive)
        try {
          process.kill(pid, 0);
        } catch (e) {
          alive = (e as NodeJS.ErrnoException).code !== 'ESRCH'; // EPERM: alive, just not ours
        }
      if (alive)
        throw new Error(`another dev check (pid ${pid}) holds ${path} — wait for it`, {
          cause: err,
        });
      // Re-read before removing: another run may have taken over the stale lock in between.
      if (readFileSync(path, 'utf8') === held) unlinkSync(path);
    }
  }
  return () => {
    if (existsSync(path) && readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path);
  };
}

async function listRuns(): Promise<DeployRun[]> {
  try {
    const { stdout } = await exec('gh', [
      'run',
      'list',
      '--workflow',
      'deploy-dev.yml',
      '--limit',
      '10',
      '--json',
      RUN_FIELDS,
    ]);
    const runs = JSON.parse(stdout) as DeployRun[];
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '');
    throw new Error(`gh run list failed: ${stderr.trim() || String(err)}`, { cause: err });
  }
}

const fetchShell = async (): Promise<string> =>
  (
    await fetch(`${DEV_ORIGIN}/`, {
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(15_000),
    })
  ).text();

// The build under test is HEAD unless --sha names one; the scenarios are always HEAD's, marked -dirty when
// scripts/src/devcheck has uncommitted edits — never in `sha`, which must name a real deployed commit.
export const shasFor = (head: string, dirty: boolean, argSha?: string) => ({
  sha: argSha ?? head,
  scenarioSha: dirty ? `${head}-dirty` : head,
});

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const main = mainCheckout();
  const worktree = worktreeRoot();
  const git = async (a: string[]) => (await exec('git', a, { cwd: worktree })).stdout.trim();
  const { sha, scenarioSha } = shasFor(
    await git(['rev-parse', 'HEAD']),
    !!(await git(['--no-optional-locks', 'status', '--porcelain', '--', ':/scripts/src/devcheck'])),
    args.sha,
  );
  const scenarios = selectScenarios(args.tier, args.scenarios, SCENARIOS);
  const feature = selectFeature(args.feature, scenarios);
  // Every scenario, whatever the tier: a broken matrix is a bug before anything waits on dev.
  const gaps = matrixProblems(SCENARIOS, worktree, {
    exists: existsSync,
    read: (p) => readFileSync(p, 'utf8'),
  });
  if (gaps.length) throw new DevcheckError('MATRIX_GAP', gaps.join('\n  '));
  const env = loadEnv(envPath(main));
  const pw = loadPlaywright();

  const home = devcheckHome(main);
  mkdirSync(home, { recursive: true });
  const release = takeLock(join(home, 'run.lock'));
  // A kill (Ctrl-C, a background job's timeout) skips the pipeline's finally — cleanup doesn't run, and the
  // next run's sweep deletes what this one left. The lock must not outlive the process either way.
  for (const [sig, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)
    process.once(sig, () => {
      release();
      process.exit(code);
    });
  const ledger = openLedger(join(home, 'ledger.dev.jsonl'));
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${args.tier}`;
  const out = runDir(worktree, runId);
  const shotsDir = join(out, 'shots');
  mkdirSync(shotsDir, { recursive: true });
  const log = (msg: string) => console.log(`[devcheck] ${msg}`);
  log(
    `run ${runId}: ${scenarios.map((s) => s.id).join(', ')}${feature.length ? ` (feature: ${feature.join(', ')})` : ''} against ${sha.slice(0, 7)} → ${out}`,
  );

  try {
    const result = await runPipeline({
      runId,
      tier: args.tier,
      feature,
      expectedSha: sha,
      scenarioSha,
      scenarios,
      ledger,
      shotsDir,
      waitForDeploy: args.deployWait
        ? () =>
            waitForDeploy(sha, {
              listRuns,
              fetchShell,
              sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
              now: Date.now,
              log,
            })
        : undefined,
      fetchShell,
      async openBrowser() {
        validateCachedState(statePath(main), env, log);
        const { browser, context } = await launch(pw, statePath(main));
        await blockClaude(context); // before any page: no claude host is ever reached
        const page = await context.newPage();
        return {
          page,
          signIn: (shot) =>
            ensureSignedIn(page, context, env, { statePath: statePath(main), shot }),
          readSession: () => readCheckedSession(page, env),
          signInMcp: (shot) =>
            ensureMcpSignedIn(context, env, {
              fetch,
              shot,
              statePath: statePath(main),
              log,
              now: Date.now,
            }),
          close: () => browser.close(),
        };
      },
      makeApi: (token) => createApiClient({ fetch, token, ledger, run: runId }),
      makeMcp: (token) => createMcpClient({ fetch, token, ledger, run: runId }),
      now: Date.now,
      log,
    });
    writeFileSync(join(out, 'report.md'), renderReport(result));
    writeFileSync(join(out, 'report.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(`\n${statusLine(result)}\nreport: ${join(out, 'report.md')}`);
    return exitCode(result);
  } finally {
    release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(2);
    },
  );
