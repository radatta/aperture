// Board CLI for the decisions that deserve tests (docs/ops/SESSION-BOARD.md), called by scripts/board/*.sh and
// `pnpm board lane`; the commands are in USAGE below.
// Plain `node` (Node 22 strips types; same as classify-changes.ts): erasable syntax, node: builtins only.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideHeavy } from './lease.ts';
import { parseLimits, staleness } from './limits.ts';
import { branchFiles, overlaps, type Tree } from './overlap.ts';
import { parseLimit } from './proc.ts';
import {
  barriers,
  formatBarriers,
  formatReport,
  rollup,
  type JobEvent,
  type Sample,
} from './rollup.ts';
import { sessionNames } from './sessions.ts';
import { MainBusy, withMainLock, withRestartLock } from './main-lock.ts';
import { execRun, syncMain } from './sync-main.ts';
import { cliGuard, isHelp } from '../bot/help.ts';
import type { Spec } from '../bot/help.ts';
import { boardDir } from '../bot/lock-cache.ts';
import { LANE_USAGE, parseLaneArgs, writeLane } from './tower/lanes.ts';
import { readMacStats } from './tower/health.ts';
import { formatStale } from './tower/stale.ts';
import { compactJob } from './tower/history.ts';
import { machine } from './machine.ts';

export const USAGE = `node scripts/src/board/cli.ts <command>   (-h / --help on any command: its usage; nothing runs)
  decide-heavy                          stdin {limits, liveLimits, live, slots, req} → HeavyDecision
  staleness <limits.json> <historyDir>  warning lines
  overlap <repo> <boardDir>             writes <boardDir>/overlap.json
  report <historyDir> [days] [--json]   usage by mix + job peaks
  barriers <historyDir> [days] [--json] how limiting the cap is
  machine <boardDir> [--json]           the Mac's power line and the slowdown ratio (F120)
  lane <phase> [--step …] [--plan …] [--needs … --link|--cmd …] | --clear   this lane's status file (pnpm board lane --help)
  sync-main                             the main checkout to origin/main; restarts the web tower if its code changed
  stale [--json]                        where queue.json contradicts the derived board (the web tower's stale.json)`;

// Every command's allowed flags and positionals; anything else refuses before it runs (bot/help.ts). lane parses its own.
export const FLAGS: Record<string, Spec> = {
  'decide-heavy': {},
  staleness: { args: 2 },
  overlap: { args: 2 },
  report: { bare: ['json'], args: 2 },
  barriers: { bare: ['json'], args: 2 },
  machine: { bare: ['json'], args: 1 },
  lane: null, // main skips the guard for lane; the entry keeps the table covering USAGE
  'sync-main': {},
  stale: { bare: ['json'] },
};

// Board flags are bare (--json); lane, the one with values, is skipped by the guard.
const bareFlags = (argv: string[]) => ({
  positional: argv.filter((a) => !a.startsWith('--')),
  flags: Object.fromEntries(
    argv.filter((a) => a.startsWith('--')).map((a) => [a.slice(2), 'true']),
  ),
});

const cgroup = process.env.APERTURE_CGROUP_DIR ?? '/sys/fs/cgroup';

function liveLimits() {
  const read = (f: string) => parseLimit(readFileSync(join(cgroup, f), 'utf8'));
  return {
    pidsMax: read('pids.max') ?? 4194304,
    highBytes: read('memory.high') ?? Number.MAX_SAFE_INTEGER,
  };
}

function readJsonl(dir: string, prefix: string): unknown[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  return files.flatMap((f) =>
    readFileSync(join(dir, f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as unknown];
        } catch {
          return []; // a torn last line from a concurrent append
        }
      }),
  );
}

const git = (cwd: string, ...a: string[]) => {
  try {
    return execFileSync('git', ['-C', cwd, ...a], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // Read-only scan of other sessions' worktrees: never take their index.lock to refresh the index.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
  } catch {
    return '';
  }
};

// Every worktree on a branch (the detached main checkout is skipped) with the files its branch touches.
function worktrees(repo: string): Tree[] {
  const trees: Tree[] = [];
  let path = '';
  for (const line of git(repo, 'worktree', 'list', '--porcelain').split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice(9);
    if (!line.startsWith('branch refs/heads/') || !path) continue;
    const base = git(path, 'merge-base', 'origin/main', 'HEAD').trim();
    if (!base) continue;
    trees.push({
      branch: line.slice('branch refs/heads/'.length),
      files: branchFiles(
        git(path, 'diff', '--name-only', base, 'HEAD'),
        git(path, 'diff', '--name-only', 'HEAD'),
        git(path, 'ls-files', '--others', '--exclude-standard'),
      ),
    });
  }
  return trees;
}

export function main(argv: string[], stdin: () => string): string {
  const [cmd, ...rest] = argv;
  // lane keeps its own, fuller usage (LANE_USAGE) and flag parsing
  const guard = cmd === 'lane' ? null : cliGuard(argv, USAGE, FLAGS, bareFlags);
  if (guard?.code === 0) return guard.out;
  if (guard) throw new Error(guard.out);
  const args = rest.filter((a) => !a.startsWith('--')); // flags (--json) are read separately, never as positionals
  const now = new Date();
  switch (cmd) {
    case 'decide-heavy': {
      const { limits, liveLimits: ll, live, slots, req } = JSON.parse(stdin());
      return JSON.stringify(decideHeavy(parseLimits(limits), ll, live, slots ?? [], req, now));
    }
    case 'staleness': {
      const [limitsPath, historyDir] = args;
      if (!limitsPath || !historyDir)
        throw new Error('usage: staleness <limits.json> <historyDir>');
      const limits = parseLimits(JSON.parse(readFileSync(limitsPath, 'utf8')));
      const events = readJsonl(historyDir, 'events-') as Parameters<typeof staleness>[2];
      return staleness(limits, liveLimits(), events, now).join('\n');
    }
    case 'overlap': {
      const [repo, boardDir] = args;
      if (!repo || !boardDir) throw new Error('usage: overlap <repo> <boardDir>');
      const result = {
        v: 1,
        t: now.toISOString(),
        ...overlaps(worktrees(repo), sessionNames(boardDir)),
      };
      const file = join(boardDir, 'overlap.json');
      writeFileSync(`${file}.tmp.${process.pid}`, JSON.stringify(result) + '\n');
      renameSync(`${file}.tmp.${process.pid}`, file);
      return `${result.pairs.length} overlapping pair(s)`;
    }
    case 'report': {
      const [historyDir, days = '7'] = args;
      if (!historyDir) throw new Error('usage: report <historyDir> [days] [--json]');
      const since = new Date(now.getTime() - Number(days) * 86400_000);
      const r = rollup(
        readJsonl(historyDir, 'samples-') as Sample[],
        readJsonl(historyDir, 'events-') as JobEvent[],
        since,
        now,
      );
      return rest.includes('--json') ? JSON.stringify(r) : formatReport(r);
    }
    case 'barriers': {
      const [historyDir, days = '7'] = args;
      if (!historyDir) throw new Error('usage: barriers <historyDir> [days] [--json]');
      const since = new Date(now.getTime() - Number(days) * 86400_000);
      const b = barriers(readJsonl(historyDir, 'events-'), since, now);
      return rest.includes('--json') ? JSON.stringify(b) : formatBarriers(b);
    }
    case 'machine': {
      const [dir] = args;
      if (!dir) throw new Error('usage: machine <boardDir> [--json]');
      const t = now.getTime();
      const events = readJsonl(join(dir, 'history'), 'events-');
      const jobs = events
        .flatMap((e) => compactJob(e) ?? [])
        .filter((j) => j.t >= t - 7 * 86400_000); // the tower's window (source.ts JOB_DAYS)
      const m = machine(readMacStats(join(dir, 'mac-stats.json'), t), jobs, t);
      return rest.includes('--json') ? JSON.stringify(m) : m.lines.join('\n');
    }
    case 'lane': {
      // docs/ops/TOWER.md → Lane files: the branch and sha come from git, never from an argument
      if (rest.some(isHelp) || rest.length === 0) return LANE_USAGE;
      let a;
      try {
        a = parseLaneArgs(rest);
      } catch (e) {
        throw new Error(`${(e as Error).message}\n${LANE_USAGE}`, { cause: e });
      }
      const here = process.env.INIT_CWD ?? process.cwd(); // pnpm runs scripts from the root; INIT_CWD is where it was typed
      const branch = git(here, 'branch', '--show-current').trim();
      if (!branch) throw new Error('not on a branch (a lane file is per feature branch)');
      const dir = boardDir((c, args) =>
        execFileSync(c, args, { cwd: here, encoding: 'utf8' }).trim(),
      );
      if (!dir) throw new Error('no board dir (set APERTURE_BOARD_DIR)');
      return writeLane(dir, a, {
        branch,
        sha: git(here, 'rev-parse', 'HEAD').trim() || null,
        session: sessionNames(dir)[branch] ?? null,
        now,
      });
    }
    case 'sync-main':
      return syncMain(
        execRun,
        process.env.INIT_CWD ?? process.cwd(), // pnpm runs scripts from the root; INIT_CWD is where it was typed
        withMainLock,
        withRestartLock,
      );
    case 'stale': {
      const dir = boardDir((c, a) => execFileSync(c, a, { encoding: 'utf8' }).trim());
      if (!dir) throw new Error('no board dir (set APERTURE_BOARD_DIR)');
      let text: string | null = null;
      try {
        text = readFileSync(join(dir, 'stale.json'), 'utf8');
      } catch {
        // not written yet
      }
      return rest.includes('--json') ? (text ?? '').trim() : formatStale(text, now.getTime());
    }
    default:
      throw new Error(
        `usage: cli.ts decide-heavy | staleness | overlap | report | barriers | machine | lane | sync-main | stale (got ${cmd ?? 'nothing'})`,
      );
  }
}

if (process.argv[1]?.endsWith('cli.ts')) {
  try {
    const out = main(process.argv.slice(2), () => readFileSync(0, 'utf8'));
    if (out) process.stdout.write(out + '\n');
  } catch (e) {
    process.stderr.write(`board cli: ${(e as Error).message}\n`);
    // a busy main checkout is no failure: the main sync loop tries again next round (sync.sh)
    process.exit(e instanceof MainBusy ? 75 : 2);
  }
}
