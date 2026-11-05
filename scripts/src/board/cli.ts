// Board CLI for the decisions that deserve tests (docs/ops/SESSION-BOARD.md). Called by scripts/board/*.sh:
//   node scripts/src/board/cli.ts decide-heavy   < {limits, liveLimits, live, slots, req} → HeavyDecision
//   node scripts/src/board/cli.ts staleness <limits.json> <historyDir>                    → warning lines
//   node scripts/src/board/cli.ts overlap <repo> <boardDir>                              → writes <boardDir>/overlap.json
//   node scripts/src/board/cli.ts report <historyDir> [days] [--json]                     → usage by mix + job peaks
//   node scripts/src/board/cli.ts barriers <historyDir> [days] [--json]                   → how limiting the cap is
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
    default:
      throw new Error(
        `usage: cli.ts decide-heavy | staleness | overlap | report | barriers (got ${cmd ?? 'nothing'})`,
      );
  }
}

if (process.argv[1]?.endsWith('cli.ts')) {
  try {
    const out = main(process.argv.slice(2), () => readFileSync(0, 'utf8'));
    if (out) process.stdout.write(out + '\n');
  } catch (e) {
    process.stderr.write(`board cli: ${(e as Error).message}\n`);
    process.exit(2);
  }
}
