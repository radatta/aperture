// The web tower (docs/ops/TOWER.md): `scripts/board/tower-web.sh [flags]`, normally started by `board.sh tower start`.
//   --port <n>        default 6183 (COI_PORT_VITE10: the Mac reaches it at http://localhost:6183)
//   --bind <addr>     default 0.0.0.0 (the COI proxy device's connect address isn't visible from inside)
//   --fixtures <dir>  read <dir>/board, ledgers, prs.json, runs.json, checks.json, files.json, costs-daily.json
//   --now <iso>       a fixed clock          --no-gh   no GitHub reads (their sources show `gh off`)
//   --once            print one View as JSON and exit (no socket)
// Plain `node` (Node 22 strips types): erasable syntax, node: builtins only, no dependencies.
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_SLUG } from '../../../identifiers.ts';
import { MAC_PLACEHOLDER, MAC_ROOT_NOTE, macRoot } from '../../../mac-root.ts';
import { sessionNames } from '../../sessions.ts';
import { derive, type Inputs, type View } from '../derive.ts';
import {
  ChecksCache,
  FilesCache,
  Poller,
  ghText,
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
// The Mac repo path from the gitignored .local/mac-root (mac-root.ts); the placeholder, with a note, when unknown.
const MAC = macRoot();
export const macInstallLine = (root: string) =>
  `cd ${root} && /bin/bash <(curl -sSf -H @<(printf 'Authorization: Bearer %s\\n' "$(security find-generic-password -s aperture-mailroom-gh -w)") -H 'Accept: application/vnd.github.raw+json' 'https://api.github.com/repos/${REPO_SLUG}/contents/tools/macstats/install.sh?ref=main')`;
export const MAC_INSTALL =
  macInstallLine(MAC) + (MAC === MAC_PLACEHOLDER ? `\n${MAC_ROOT_NOTE}` : '');

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

// The health tiles' sparklines: the last hour, one point a minute (that minute's peak), null for a minute with no
// sample. A sample a little ahead of our clock (the Mac's) lands in the newest minute, not off the end.
export function sparkBuckets(pts: [number, number | null][], now: number): (number | null)[] {
  const out: (number | null)[] = Array(60).fill(null);
  for (const [t, y] of pts) {
    const k = Math.min(59, 59 - Math.floor((now - t) / 60000));
    if (k >= 0 && y !== null) out[k] = Math.max(out[k] ?? -Infinity, y);
  }
  return out;
}

// Where DONE TODAY begins: local midnight, but before noon it reaches back 12 h, so last night's merges stay in
// view through the morning (at 00:10, six merges from 23:00 had vanished) and age out by noon. No reset cliff.
export const dayStart = (now: number) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return Math.min(d.getTime(), now - 12 * 3600e3);
};

export function build(a: Args) {
  const fx = a.fixtures;
  const paths: Paths = fx ? fixturePaths(fx) : defaultPaths(REPO);
  const clock = () => a.now ?? Date.now();
  const fileGh: GhText = async (args) => {
    const route = args.join(' ');
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
  const costsPath = fx ? join(fx, 'costs-daily.json') : join(paths.boardDir, '../costs-daily.json');
  // The fixtures' cost rows use synthetic account ids, labelled by their own accounts.json.
  const fxAccounts = fx
    ? (JSON.parse(readFileSync(join(fx, 'accounts.json'), 'utf8')) as Record<string, string>)
    : null;
  const fixtureAccounts = fxAccounts ? (id: string) => fxAccounts[id] ?? 'other' : undefined;
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
  const startedAt = clock();
  // The Mac series, on the server's own 5 s tick (the agent writes every 15 s): read when a page polls, it had an
  // hour's gap for every hour no page was open, which read as a Mac outage.
  function sample(now: number): MacRead {
    const mac = readMacStats(macPath, now);
    if (mac.stats && macHist.at(-1)?.t !== mac.stats.t) {
      macHist.push({
        t: mac.stats.t,
        usedMiB: mac.stats.mem.usedMiB,
        totalMiB: mac.stats.memTotalMiB,
      });
      while (macHist.length && macHist[0]!.t < now - 24 * 3600e3) macHist.shift();
    }
    return mac;
  }
  // Is the Mac installer on origin/main yet (the install line fetches it from there)? Fixtures: yes. Re-checked
  // every 10 min with a local git read (the fetch that moves origin/main is the sessions'; no network here).
  let ready: { at: number; ok: boolean } | null = null;
  const installReady = (now: number) => {
    if (fx) return true;
    if (ready && now - ready.at < 600000) return ready.ok;
    let ok = false;
    try {
      execFileSync('git', ['-C', REPO, 'cat-file', '-e', 'origin/main:tools/macstats/install.sh'], {
        stdio: 'ignore',
      });
      ok = true;
    } catch {
      // not merged yet
    }
    ready = { at: now, ok };
    return ok;
  };

  // GitHub, in the background: never awaited by a request, never two of one kind at once.
  async function poll(now: number) {
    await Promise.all([prs?.poll(now), runs.poll(now)]);
    for (const p of prs?.list ?? []) {
      if (p.state !== 'OPEN' || !p.sha) continue;
      await checks?.want(p.sha, now);
      await files?.want(p.number, p.sha, now);
    }
  }

  function view(
    history: boolean,
  ): View & { history?: unknown; sparks: Record<string, (number | null)[]>; startedAt: number } {
    const now = clock();
    const tower = source.refresh(now);
    const lanes = readLanes(paths.boardDir);
    const mac = sample(now);
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
      mac,
      aws: readCosts(costsPath, now, monthKey(now), fixtureAccounts),
      tests: fx ? 0 : liveTests(paths.boardDir),
      testCap: testCap(paths.limits),
      macInstall: MAC_INSTALL,
      macInstallReady: installReady(now),
      dayStart: dayStart(now),
    };
    const v = derive(inputs);
    const sparks = {
      anon: sparkBuckets(
        tower.points.map((p) => [p.t, p.anon]),
        now,
      ),
      mac: sparkBuckets(
        macHist.map((m) => [m.t, m.usedMiB]),
        now,
      ),
    };
    if (!history) return { ...v, sparks, startedAt };
    return {
      ...v,
      sparks,
      startedAt,
      history: {
        container: tower.points.map((p) => [p.t, p.anon, p.cpu]),
        mac: macHist.map((m) => [m.t, m.usedMiB, m.totalMiB]),
      },
    };
  }
  return { poll, view, sample, clock, paths };
}

// devlock.sh keeps the lock caches fresh; the TUI calls it the same way (main.ts → refreshDevlock).
function refreshDevlock() {
  execFile(
    'bash',
    [join(REPO, 'scripts/board/devlock.sh'), 'refresh', '--max-age', '50'],
    { timeout: 30000, env: { ...process.env, APERTURE_DEVLOCK_CALLER: 'tower' } },
    () => undefined,
  );
}

async function run(a: Args) {
  const t = build(a);
  if (a.once) {
    await t.poll(t.clock());
    await t.poll(t.clock()); // the second round reads checks and files for the PRs the first one listed
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
  setInterval(() => {
    void t.poll(t.clock());
    t.sample(t.clock());
  }, TICK_MS);
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
