// The dev check CLI — docs/ops/DEV-CHECK.md. From a worktree whose branch is (being) deployed to dev:
//   pnpm --filter @aperture/scripts devcheck --tier smoke|delta|full|all [--scenario a,b] [--feature a,b] [--sha <40-hex>]
//     [--no-deploy-wait]
//   DEVCHECK_LANES=one-user|serial|parallel — slot A's two users (DEV-CHECK.md → Two users); unset: serial when the
//   browser user's env file exists, else one-user
// Never alongside tests or a dev server (CLAUDE.md → COI ceilings). One run at a time per slot: the
// sweep of earlier runs' leftovers would otherwise race a live run on the same slot. Each slot sweeps its own ledger
// and table, so another session's run on the other slot may overlap.
import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { run as sh } from '../bot/sh.ts';
import { REPO_SLUG } from '../identifiers.ts';
import { hostjobsDir, nodeFs, repoRunnerVersion } from '../mailroom/submit.ts';
import { createApiClient } from './api';
import { loadPlaywright } from './browser';
import {
  TEST_USERS,
  currentSlot,
  devcheckHome,
  envPath,
  ledgerFile,
  loadEnv,
  mainCheckout,
  runDir,
  runLockFile,
  slotOrigin,
  statePath,
  useSlot,
  worktreeRoot,
  type DevcheckEnv,
  type TestUser,
} from './config';
import { RUN_FIELDS, waitForDeploy, type DeployRun } from './deploy';
import { DevcheckError } from './errors';
import { leftovers, openLedger } from './ledger';
import { IPHONE_SHOTS, LANES_ENV, laneMode, planLanes, runLanes } from './lanes';
import { matrixProblems } from './matrix';
import { createMcpClient } from './mcp';
import { ensureMcpSignedIn } from './mcp-login';
import { ensureSignedIn, launchCached, readCheckedSession, refreshSession } from './login';
import { globMatch } from './glob';
import { createIos, iosSlotNote, type Ios } from './ios';
import { IOS_SLOW_PATHS } from './scenarios/ios-paths';
import { exitCode, runPipeline } from './pipeline';
import { writeHeavyDetail } from './heavy-detail';
import { lanesLine, renderReport, statusLine, type RunResult } from './report';
import type { Scenario } from './scenario';
import { pickSlot } from './slot';
import {
  SCENARIOS,
  probeSkip,
  selectFeature,
  selectScenarios,
  slowScenarios,
  type RunTier,
} from './scenarios/index';

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
      if (t !== 'smoke' && t !== 'delta' && t !== 'full' && t !== 'all')
        throw new Error(`--tier smoke|delta|full|all, got ${t}`);
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

// One live run per slot: a pid file in the shared devcheck home (runLockFile), created exclusively (O_EXCL) so two
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
      '20', // both slots' dispatches share this list
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

// Where the iPhone lane's browser page waits while the Simulator works (pipeline.ts park): the health route is one
// cheap call, and an /api/ path never boots the app from the service worker, so no second app polls dev meanwhile.
export const PARK_PATH = '/api/health';

const fetchShell = async (): Promise<string> =>
  (
    await fetch(`${slotOrigin()}/`, {
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
  // The branch's diff against origin/main (committed and not) decides which slow steps run; unreadable → all. No
  // renames, so a file moved out of a slowPath still counts.
  const changed = await Promise.all([
    git(['diff', '--name-only', '--no-renames', 'origin/main...HEAD']),
    git(['diff', '--name-only', '--no-renames', 'HEAD']),
  ]).then(
    (outs) => [...new Set(outs.flatMap((o) => o.split('\n').filter(Boolean)))],
    () => null,
  );
  const slow = slowScenarios(args.tier, feature, scenarios, changed);
  // Every scenario, whatever the tier: a broken matrix is a bug before anything waits on dev.
  const gaps = matrixProblems(SCENARIOS, worktree, {
    exists: existsSync,
    read: (p) => readFileSync(p, 'utf8'),
  });
  if (gaps.length) throw new DevcheckError('MATRIX_GAP', gaps.join('\n  '));
  // The slot is the lock's (slot.ts) — set before anything reads an origin, a host or a per-slot file.
  const branch = await git(['symbolic-ref', '--short', 'HEAD']).catch(() => '');
  const pick = await pickSlot(branch, {
    lsRemote: () => git(['ls-remote', 'origin', 'refs/locks/dev', 'refs/locks/devb']),
    tagMessage: async (tag) =>
      (
        await exec('gh', ['api', `repos/${REPO_SLUG}/git/tags/${tag}`, '--jq', '.message'], {
          cwd: worktree,
        })
      ).stdout.trim(),
  }).catch((err: unknown) => {
    if (err instanceof DevcheckError) throw err; // NO_LOCK, as is
    throw new DevcheckError(
      'SLOT_UNKNOWN',
      `couldn't read the dev locks (${err instanceof Error ? err.message : String(err)}) — rerun`,
    );
  });
  useSlot(pick.slot);
  const slot = currentSlot();
  const lanes = laneMode({
    slot,
    webEnv: existsSync(envPath(main, slot, 'web')),
    env: process.env[LANES_ENV],
  });
  const envs: Partial<Record<TestUser, DevcheckEnv>> = { main: loadEnv(envPath(main)) };
  if (lanes.mode !== 'one-user')
    envs.web = loadEnv(envPath(main, slot, 'web'), console.warn, 'web');
  const pw = loadPlaywright();

  const home = devcheckHome(main);
  mkdirSync(home, { recursive: true });
  const release = takeLock(join(home, runLockFile()));
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
  // One ledger per user (config.ts ledgerFile): cleanup reads its ids back with that user's token.
  const ledgers = {
    main: openLedger(join(home, ledgerFile())),
    web: openLedger(join(home, ledgerFile(slot, 'web'))),
  };
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${args.tier}`;
  const out = runDir(worktree, runId);
  const shotsDir = join(out, 'shots');
  mkdirSync(shotsDir, { recursive: true });
  const log = (msg: string) => console.log(`[devcheck] ${msg}`);
  const slotNote = iosSlotNote(
    slot,
    (changed ?? []).filter((f) => IOS_SLOW_PATHS.some((g) => globMatch(g, f))),
  );
  if (slotNote) log(`on ${slot}, the iPhone rows read needs-you — ${slotNote}`);
  log(`target: ${slot} → ${slotOrigin()} (${pick.why})`);
  log(
    `run ${runId}: ${scenarios.map((s) => s.id).join(', ')}${feature.length ? ` (feature: ${feature.join(', ')})` : ''} against ${sha.slice(0, 7)} → ${out}`,
  );
  const deferred = scenarios.filter((s) => s.slowPaths && !slow.includes(s.id)).map((s) => s.id);
  if (deferred.length)
    log(`slow steps deferred (branch touches none of their paths): ${deferred.join(', ')}`);
  const clock = {
    now: Date.now,
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  };
  const skip = probeSkip(slow);
  // One deploy wait, shared by the lanes — whichever asks first waits (in serial, the iPhone lane), and neither sends a
  // step before it confirmed the build.
  let deployed: Promise<DeployRun> | undefined;
  const waitOnce = args.deployWait
    ? () =>
        (deployed ??= waitForDeploy(sha, {
          listRuns,
          fetchShell,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          now: Date.now,
          log,
        }))
    : undefined;
  const iosFor = (dir: string, laneLog: (msg: string) => void) =>
    createIos({
      fs: nodeFs,
      clock,
      dir: hostjobsDir(sh),
      expectedSha: sha,
      outDir: dir,
      copy: copyFileSync,
      log: laneLog,
      repoVersion: () => repoRunnerVersion(sh('git', ['rev-parse', '--show-toplevel'])),
      slot,
      slotNote,
    });

  // One lane's pipeline: its user's env, browser state and ledger; everything else the run's.
  const lane = (o: {
    user: TestUser;
    scenarios: Scenario[];
    dir: string;
    ios?: Ios;
    park?: string;
    log: (msg: string) => void;
  }) => {
    const env = envs[o.user]!;
    const ledger = ledgers[o.user];
    const state = statePath(main, slot, o.user);
    return runPipeline({
      runId,
      tier: args.tier,
      feature,
      expectedSha: sha,
      scenarioSha,
      target: `${slot} (${slotOrigin()})`,
      scenarios: o.scenarios,
      ledger,
      shotsDir: o.dir,
      slow,
      skip,
      ios: o.ios,
      park: o.park,
      testUser: TEST_USERS[o.user],
      waitForDeploy: waitOnce,
      fetchShell,
      async openBrowser() {
        const { browser, context } = await launchCached(pw, state, env, {
          fetch,
          now: Date.now,
          log: o.log,
        });
        const page = await context.newPage();
        return {
          page,
          signIn: (shot) => ensureSignedIn(page, context, env, { statePath: state, shot }),
          readSession: () => readCheckedSession(page, env),
          refreshSession: () => refreshSession(page, env, fetch, Date.now),
          signInMcp: (shotOf) =>
            ensureMcpSignedIn(context, env, {
              fetch,
              shotOf,
              statePath: state,
              log: o.log,
              now: Date.now,
            }),
          close: () => browser.close(),
        };
      },
      makeApi: (token, fresh, onAnswer) =>
        createApiClient({ fetch, token, fresh, ledger, run: runId, onAnswer }),
      makeMcp: (token) => createMcpClient({ fetch, token, ledger, run: runId }),
      now: Date.now,
      log: o.log,
    });
  };

  try {
    let result: RunResult;
    if (lanes.mode === 'one-user') {
      log(`one test user (${lanes.why})`);
      const waiting = leftovers(ledgers.web.read(), runId);
      if (waiting)
        log(
          `the browser user's ledger has ${waiting} leftover(s) (pending ids, orphan intents): the next two-user run sweeps or lists them`,
        );
      result = await lane({
        user: 'main',
        scenarios,
        dir: shotsDir,
        ios: iosFor(shotsDir, log),
        log,
      });
      result.lanes = { mode: 'one-user' };
    } else {
      const split = planLanes({
        scenarios,
        defer: { skip, slow },
        mainLeftovers: leftovers(ledgers.main.read(), runId) > 0,
      });
      const iphoneRuns = split.iphoneRuns;
      const ilog = (msg: string) => log(`iPhone · ${msg}`);
      const iDir = join(shotsDir, IPHONE_SHOTS);
      log(
        iphoneRuns
          ? `lanes ${lanes.mode}: browser user ${scenarios.length - split.iphone.length} scenario(s), iPhone user ${split.iphone.map((s) => s.id).join(', ') || 'none (sweeping its ledger)'}`
          : 'lanes: browser user only — no iPhone step runs this time',
      );
      if (iphoneRuns) mkdirSync(iDir, { recursive: true });
      const browserLane = () =>
        lane({
          user: 'web',
          scenarios: split.browser,
          dir: shotsDir,
          // An idle iPhone lane's scenarios ride here, every step deferred: their client sends nothing.
          ...(split.browserGetsIos ? { ios: iosFor(shotsDir, log) } : {}),
          log,
        });
      const iphoneLane = () =>
        lane({
          user: 'main',
          scenarios: split.iphone,
          dir: iDir,
          ios: iosFor(iDir, ilog),
          park: PARK_PATH,
          log: ilog,
        });
      result = await runLanes({
        mode: lanes.mode,
        browser: { scenarios: split.browser, run: browserLane },
        ...(iphoneRuns ? { iphone: { scenarios: split.iphone, run: iphoneLane } } : {}),
        base: {
          runId,
          tier: args.tier,
          feature,
          expectedSha: sha,
          scenarioSha,
          target: `${slot} (${slotOrigin()})`,
        },
        order: scenarios.map((s) => s.id),
        now: Date.now,
      });
      log(lanesLine(result.lanes!, result.durationMs));
    }
    writeFileSync(join(out, 'report.md'), renderReport(result));
    writeFileSync(join(out, 'report.json'), JSON.stringify(result, null, 2) + '\n');
    writeHeavyDetail(result, join(out, 'report.json'));
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
