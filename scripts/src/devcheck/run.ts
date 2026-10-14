// The dev check CLI — docs/ops/DEV-CHECK.md. From a worktree whose branch is (being) deployed to dev:
//   pnpm --filter @aperture/scripts devcheck --tier smoke|delta|full [--scenario a,b] [--sha <40-hex>]
//     [--no-deploy-wait]
// Never alongside tests or a dev server (CLAUDE.md → COI ceilings). One run at a time per container: the
// sweep of earlier runs' leftovers would otherwise race a live run.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { openLedger } from './ledger';
import { ensureSignedIn, readSession } from './login';
import { exitCode, runPipeline } from './pipeline';
import { renderReport, statusLine } from './report';
import { SCENARIOS, selectScenarios, type RunTier } from './scenarios/index';

const exec = promisify(execFile);

export interface Args {
  tier: RunTier;
  scenarios: string[];
  sha?: string;
  deployWait: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { tier: 'smoke', scenarios: [], deployWait: true };
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
    } else if (a === '--scenario') args.scenarios = val().split(',').filter(Boolean);
    else if (a === '--sha') {
      const s = val();
      if (!/^[0-9a-f]{40}$/.test(s)) throw new Error(`--sha needs a full 40-hex SHA, got ${s}`);
      args.sha = s;
    } else if (a === '--no-deploy-wait') args.deployWait = false;
    else if (a !== '--') throw new Error(`unknown argument ${a}`);
  }
  return args;
}

// One live run per container: a pid file in the shared devcheck home.
function takeLock(path: string): () => void {
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      // stale — that run died without releasing
    }
    if (alive) throw new Error(`another dev check (pid ${pid}) is running — wait for it`);
  }
  writeFileSync(path, String(process.pid));
  return () => {
    if (existsSync(path) && readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path);
  };
}

async function listRuns(): Promise<DeployRun[]> {
  const gh = async (args: string[]) => {
    try {
      const { stdout } = await exec('gh', [
        'run',
        'list',
        ...args,
        '--limit',
        '10',
        '--json',
        RUN_FIELDS,
      ]);
      return JSON.parse(stdout) as DeployRun[];
    } catch {
      return []; // deploy-dev.yml exists only once ci-bot lands
    }
  };
  const runs = [
    ...(await gh(['--workflow', 'deploy.yml', '--branch', 'dev'])),
    ...(await gh(['--workflow', 'deploy-dev.yml'])),
  ];
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const fetchShell = async (): Promise<string> =>
  (
    await fetch(`${DEV_ORIGIN}/`, {
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(15_000),
    })
  ).text();

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const main = mainCheckout();
  const worktree = worktreeRoot();
  const sha = args.sha ?? (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
  const scenarios = selectScenarios(args.tier, args.scenarios, SCENARIOS);
  const env = loadEnv(envPath(main));
  const pw = loadPlaywright();

  const home = devcheckHome(main);
  mkdirSync(home, { recursive: true });
  const release = takeLock(join(home, 'run.lock'));
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${args.tier}`;
  const out = runDir(worktree, runId);
  const shotsDir = join(out, 'shots');
  mkdirSync(shotsDir, { recursive: true });
  const log = (msg: string) => console.log(`[devcheck] ${msg}`);
  log(`run ${runId}: ${scenarios.map((s) => s.id).join(', ')} against ${sha.slice(0, 7)} → ${out}`);

  try {
    const result = await runPipeline({
      runId,
      tier: args.tier,
      expectedSha: sha,
      scenarios,
      ledger: openLedger(join(home, 'ledger.dev.jsonl')),
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
        const { browser, context } = await launch(pw, statePath(main));
        const page = await context.newPage();
        return {
          page,
          signIn: (shot) =>
            ensureSignedIn(page, context, env, { statePath: statePath(main), shot }),
          readSession: () => readSession(page, env),
          close: () => browser.close(),
        };
      },
      makeApi: (token) =>
        createApiClient({
          fetch,
          token,
          ledger: openLedger(join(home, 'ledger.dev.jsonl')),
          run: runId,
        }),
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

if (import.meta.url === `file://${process.argv[1]}`)
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(2);
    },
  );
