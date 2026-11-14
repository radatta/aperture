// The web tower (docs/ops/TOWER.md): `scripts/board/tower-web.sh [flags]`, normally started by `board.sh tower start`.
//   --port <n>        default 6183 (COI_PORT_VITE10: the Mac reaches it at http://localhost:6183)
//   --bind <addr>     default 0.0.0.0 (the COI proxy device's connect address isn't visible from inside)
//   --fixtures <dir>  read <dir>/board, ledgers, prs.json, runs.json, checks.json, files.json, costs-daily.json
//   --now <iso>       a fixed clock          --no-gh   no GitHub reads (their sources show `gh off`)
//   --once            print one View as JSON and exit (no socket)
// Plain `node` (Node 22 strips types): erasable syntax, node: builtins only, no dependencies.
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionNames } from '../../sessions.ts';
import { derive, type Inputs, type View } from '../derive.ts';
import {
  ChecksCache,
  FilesCache,
  MinutesCache,
  Poller,
  ghText,
  minutesPoller,
  monthKey,
  runsPoller,
  type GhRun,
  type GhText,
} from '../gh.ts';
import { readCosts, readMacStats, type MacRead } from '../health.ts';
import { readLanes } from '../lanes.ts';
import { fixturePaths } from '../main.ts';
import { PrCache, ghFetch, type Fetch } from '../prs.ts';
import { Source, defaultPaths, type Paths } from '../source.ts';
import { createHandler, serve } from './server.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const TICK_MS = 5000;
const DEVLOCK_MS = 60000;

// NEEDS YOU's command when the Mac stats agent is missing (tools/macstats/install.sh; TOWER.md → Mac stats).
export const MAC_INSTALL =
  "cd /Users/rahuldatta/Coding/Personal/aperture && /bin/bash <(curl -sSf -H @<(printf 'Authorization: Bearer %s\\n' \"$(security find-generic-password -s aperture-mailroom-gh -w)\") -H 'Accept: application/vnd.github.raw+json' 'https://api.github.com/repos/radatta/aperture/contents/tools/macstats/install.sh?ref=main')";

export type Args = {
  port: number;
  bind: string;
  fixtures: string | null;
  now: number | null;
  gh: boolean;
  once: boolean;
};

export function parseArgs(argv: string[]): Args {
  const a: Args = { port: 6183, bind: '0.0.0.0', fixtures: null, now: null, gh: true, once: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--port') {
      a.port = Number(argv[++i]);
      if (!Number.isInteger(a.port) || a.port < 1 || a.port > 65535)
        throw new Error('--port wants 1–65535');
    } else if (k === '--bind') a.bind = argv[++i] ?? '';
    else if (k === '--fixtures') a.fixtures = resolve(argv[++i] ?? '.');
    else if (k === '--now') a.now = Date.parse(argv[++i] ?? '');
    else if (k === '--no-gh') a.gh = false;
    else if (k === '--once') a.once = true;
    else throw new Error(`unknown flag ${k}`);
  }
  if (!a.bind) throw new Error('--bind wants an address');
  if (a.now !== null && Number.isNaN(a.now)) throw new Error('--now wants an ISO time');
  return a;
}

// Live heavy `test` slots: lease files whose wrapper is still the same process (lib.sh sb_slot_live).
export function liveTests(boardDir: string): number {
  const dir = join(boardDir, 'leases/heavy');
  let n = 0;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return 0;
  }
  for (const f of files) {
    try {
      const l = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
        class?: string;
        wrapperPid?: number;
        wrapperStart?: string | number;
      };
      if (l.class !== 'test') continue;
      const stat = readFileSync(`/proc/${l.wrapperPid}/stat`, 'utf8');
      const r = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
      if (r[0] !== 'Z' && r[0] !== 'X' && String(r[19]) === String(l.wrapperStart)) n++;
    } catch {
      // gone, or half-written
    }
  }
  return n;
}

function testCap(limits: string): number | null {
  try {
    const c = (JSON.parse(readFileSync(limits, 'utf8')) as { concurrency?: { test?: unknown } })
      .concurrency?.test;
    return typeof c === 'number' ? c : null;
  } catch {
    return null;
  }
}

const localMidnight = (now: number) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export function build(a: Args) {
  const fx = a.fixtures;
  const paths: Paths = fx ? fixturePaths(fx) : defaultPaths(REPO);
  const clock = () => a.now ?? Date.now();
  const fileGh: GhText = async (args) => {
    const route = args.join(' ');
    if (route.includes('/jobs')) return readFileSync(join(fx!, 'jobs.json'), 'utf8');
    if (route.includes('head_sha=')) {
      const sha = /head_sha=([0-9a-f]+)/.exec(route)![1]!;
      const all = JSON.parse(readFileSync(join(fx!, 'checks.json'), 'utf8')) as Record<
        string,
        unknown[]
      >;
      return JSON.stringify({ workflow_runs: all[sha] ?? [] });
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const all = JSON.parse(readFileSync(join(fx!, 'files.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      return JSON.stringify(all[args[2]!] ?? {});
    }
    return readFileSync(join(fx!, 'runs.json'), 'utf8');
  };
  const gh: GhText | null = fx ? fileGh : a.gh ? ghText : null;
  const prFetch: Fetch | null = fx
    ? async () => readFileSync(join(fx, 'prs.json'), 'utf8')
    : a.gh
      ? ghFetch
      : null;
  const prs = prFetch ? new PrCache(prFetch) : null;
  const source = new Source(paths, prs);
  const runs = gh ? runsPoller(gh) : new Poller<GhRun[]>([], async () => [], Infinity);
  const checks = gh ? new ChecksCache(gh) : null;
  const files = gh ? new FilesCache(gh) : null;
  const minutes = gh
    ? minutesPoller(
        new MinutesCache(
          fx
            ? join(tmpdir(), `tower-fixture-runs-${process.pid}.json`)
            : join(paths.boardDir, 'tower/actions-runs.json'),
          gh,
        ),
        clock,
      )
    : null;
  const costsPath = fx ? join(fx, 'costs-daily.json') : join(paths.boardDir, '../costs-daily.json');
  const macPath = join(paths.boardDir, 'mac-stats.json');
  let version: string | null = null;
  try {
    version = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // not a checkout
  }
  const macHist: { t: number; usedMiB: number; totalMiB: number }[] = [];

  // GitHub, in the background: never awaited by a request, never two of one kind at once.
  // The minutes backfill (up to 100 job reads) runs detached: it never delays the PR and run reads.
  async function poll(now: number, withMinutes = true) {
    if (withMinutes) void minutes?.poll(now);
    await Promise.all([prs?.poll(now), runs.poll(now)]);
    for (const p of prs?.list ?? []) {
      if (p.state !== 'OPEN' || !p.sha) continue;
      await checks?.want(p.sha, now);
      await files?.want(p.number, p.sha, now);
    }
  }

  function view(history: boolean): View & { history?: unknown } {
    const now = clock();
    const tower = source.refresh(now);
    const lanes = readLanes(paths.boardDir);
    const mac: MacRead = readMacStats(macPath, now);
    if (mac.stats && macHist.at(-1)?.t !== mac.stats.t) {
      macHist.push({
        t: mac.stats.t,
        usedMiB: mac.stats.mem.usedMiB,
        totalMiB: mac.stats.memTotalMiB,
      });
      while (macHist.length && macHist[0]!.t < now - 24 * 3600e3) macHist.shift();
    }
    const inputs: Inputs = {
      now,
      version,
      tower,
      lanes: lanes.lanes,
      laneProblems: lanes.problems,
      sessionsByBranch: sessionNames(paths.boardDir),
      runs: runs.state,
      checks: (sha) => checks?.get(sha) ?? null,
      files: (sha) => files?.get(sha) ?? null,
      minutes,
      mac,
      aws: readCosts(costsPath, now, monthKey(now)),
      tests: fx ? 0 : liveTests(paths.boardDir),
      testCap: testCap(paths.limits),
      macInstall: MAC_INSTALL,
      midnight: localMidnight(now),
    };
    const v = derive(inputs);
    if (!history) return v;
    return {
      ...v,
      history: {
        container: tower.points.map((p) => [p.t, p.anon, p.cpu]),
        mac: macHist.map((m) => [m.t, m.usedMiB, m.totalMiB]),
      },
    };
  }
  return { poll, view, clock, paths };
}

// devlock.sh keeps the lock caches fresh; the TUI calls it the same way (main.ts → refreshDevlock).
function refreshDevlock() {
  execFile(
    'bash',
    [join(REPO, 'scripts/board/devlock.sh'), 'refresh', '--max-age', '50'],
    { timeout: 30000 },
    () => undefined,
  );
}

async function run(a: Args) {
  const t = build(a);
  if (a.once) {
    await t.poll(t.clock(), false);
    await t.poll(t.clock(), false); // the second round reads checks and files for the PRs the first one listed
    process.stdout.write(JSON.stringify(t.view(false), null, 2) + '\n');
    return;
  }
  const server = await serve(
    createHandler((h) => t.view(h)),
    a.bind,
    a.port,
  );
  process.stdout.write(
    `tower-web: http://localhost:${a.port} (bound ${a.bind}:${a.port}, pid ${process.pid})\n`,
  );
  // The pidfile is written only once the port is bound: `board.sh tower` reads "running" from it, and the port
  // itself is the one-server lock (a second server fails with EADDRINUSE). Fixture servers never write it.
  const pidFile = process.env.APERTURE_TOWER_PID;
  if (pidFile && !a.fixtures) writeFileSync(pidFile, `${process.pid}\n`);
  void t.poll(t.clock());
  setInterval(() => void t.poll(t.clock()), TICK_MS);
  if (!a.fixtures) {
    refreshDevlock();
    setInterval(refreshDevlock, DEVLOCK_MS);
  }
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(parseArgs(process.argv.slice(2))).catch((e: Error) => {
    process.stderr.write(`tower-web: ${e.message}\n`);
    process.exit(1);
  });
}
