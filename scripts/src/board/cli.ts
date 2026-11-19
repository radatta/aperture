// Board CLI for the decisions that deserve tests (docs/ops/SESSION-BOARD.md), called by scripts/board/*.sh and
// `pnpm board lane`; the commands are in USAGE below.
// Plain `node` (Node 22 strips types; same as classify-changes.ts): erasable syntax, node: builtins only.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { check, parseCache, type GitRun, type Head } from './conflicts.ts';
import { decideHeavy } from './lease.ts';
import { budgetNow, logJobBudget } from './budget-read.ts';
import { budgetReport, formatBudgetReport } from './budget-report.ts';
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
import { MAIN_LOCK, MainBusy, withMainLock, withRestartLock } from './main-lock.ts';
import { execRun, syncMain } from './sync-main.ts';
import { cliGuard, isHelp } from '../bot/help.ts';
import type { Spec } from '../bot/help.ts';
import { boardDir } from '../bot/lock-cache.ts';
import { LANE_USAGE, parseLaneArgs, writeLane } from './tower/lanes.ts';
import { readMacStats } from './tower/health.ts';
import { formatStale } from './tower/stale.ts';
import { compactJob } from './tower/history.ts';
import { machine } from './machine.ts';
import { ranId, ranOut, ranSuffix } from './ran.ts';
import { BRIEF_FILE, BRIEF_STALE_MS, briefOut } from './tower/brief.ts';
import { MAC_PLACEHOLDER, MAC_ROOT_NOTE, macRoot } from '../mac-root.ts';
import { parseQueue } from './tower/queue.ts';
import {
  addAsk,
  answerAsks,
  askLines,
  askShow,
  closeAsk,
  openAsks,
  pruneAsks,
} from './tower/asks.ts';
import { readLanes } from './tower/lanes.ts';
import { MERGE_LINE_FILE, withSuffix } from './mergeline.ts';
import { PRS_FILE, readPrIndex, whatIs } from './lookup.ts';
import {
  AWAY_FILE,
  AWAY_LAST,
  awayStamp,
  backDigest,
  readStamp,
  stopAt,
  stopLine,
  usageRow,
  withStop,
  type Merged,
  type Started,
} from './away.ts';
import { hhmm } from './tower/fmt.ts';

export const USAGE = `node scripts/src/board/cli.ts <command>   (-h / --help on any command: its usage; nothing runs)
  decide-heavy                          stdin {limits, liveLimits, live, slots, req} → HeavyDecision
  staleness <limits.json> <historyDir>  warning lines
  overlap <repo> <boardDir>             writes <boardDir>/overlap.json and its merge cache, conflicts-cache.json
  report <historyDir> [days] [--json]   usage by mix + job peaks
  barriers <historyDir> [days] [--json] how limiting the cap is
  machine <boardDir> [--json]           the Mac's power line and the slowdown ratio (F120)
  budget <boardDir> [--json]            the log-only budget's units now: jobs, lanes, sessions, k
  budget-report <historyDir> [days] [--json]  what the log-only budget would have decided, against what ran
  lane <phase> [--step …] [--plan …] [--needs … --link|--cmd …] | --clear   this lane's status file (pnpm board lane --help)
  sync-main                             the main checkout to origin/main; restarts the web tower if its code changed
  stale [--json]                        where queue.json contradicts the derived board (the web tower's stale.json)
  brief                                 the status block the hub pastes verbatim (the web tower's brief.txt)
  ran <slug>                            the suffix that records a Mac line's exit code for merge-watch.sh
  asks list|add|show|answer|close …     dispatch's asks of the maintainer, in queue.json asks[] (docs/ops/HUB.md → Asks):
      list [--json]                     the open ones, numbered, with how to reply
      add                               stdin {text, options, pick?, lane?, pane?, go?} → the new id (d<n>)
      show <id>                         one ask in full, any status
      answer <id|all> <letter|ok>       mark it answered; prints the meaning and the [relay] line (never a pane ask's go)
      close <id>                        withdrawn, answered in words, or a pane go that arrived
  merge-line                            the one Mac line that merges every MERGE ME PR in landing order (prints only)
  wi <id>                               what an F-number, PR n, d<n> or lane name is
  away [ping]                           stamp the maintainer away (the hub's /away)
  back                                  what moved since /away, then clear the stamp
  stop <HH:MM>|off                      the hub's hard stop: pace-control.json stopAt (pace-watch.sh exit 12)`;

// Every command's allowed flags and positionals; anything else refuses before it runs (bot/help.ts). lane parses its own.
export const FLAGS: Record<string, Spec> = {
  'decide-heavy': {},
  staleness: { args: 2 },
  overlap: { args: 2 },
  report: { bare: ['json'], args: 2 },
  barriers: { bare: ['json'], args: 2 },
  machine: { bare: ['json'], args: 1 },
  budget: { bare: ['json'], args: 1 },
  'budget-report': { bare: ['json'], args: 2 },
  lane: null, // main skips the guard for lane; the entry keeps the table covering USAGE
  'sync-main': {},
  stale: { bare: ['json'] },
  brief: {},
  ran: { args: 1 },
  'asks list': { bare: ['json'] },
  'asks add': {},
  'asks show': { args: 1 },
  'asks answer': { args: 2 },
  'asks close': { args: 1 },
  'merge-line': {},
  wi: { args: 1 },
  away: { args: 1 },
  back: {},
  stop: { args: 1 },
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

// null when git failed — a caller that would read an empty answer as "nothing there" must tell the two apart.
const gitOr = (cwd: string, ...a: string[]): string | null => {
  try {
    return execFileSync('git', ['-C', cwd, ...a], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // Read-only scan of other sessions' worktrees: never take their index.lock to refresh the index.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
  } catch {
    return null;
  }
};
const git = (cwd: string, ...a: string[]) => gitOr(cwd, ...a) ?? '';

// A worktree's files from its three reads, any of which can fail (null). What git couldn't read can't be called
// committed: then every file counts as uncommitted, so none of its overlaps reads "merges clean".
export function treeOf(
  branch: string,
  committed: string | null,
  dirty: string | null,
  untracked: string | null,
): Tree {
  const files = branchFiles(committed ?? '', dirty ?? '', untracked ?? '');
  const unknown = committed === null || dirty === null || untracked === null;
  return { branch, files, uncommitted: unknown ? files : branchFiles('', dirty, untracked) };
}

// Every worktree on a branch (the detached main checkout is skipped) with the files its branch touches, and its
// committed head for the merge-tree check (a branch with no commit of its own has none).
function worktrees(repo: string): { trees: Tree[]; heads: Head[] } {
  const trees: Tree[] = [];
  const heads: Head[] = [];
  let path = '';
  let sha = '';
  const list = gitOr(repo, 'worktree', 'list', '--porcelain');
  // no list is no news: keep the last overlap.json rather than write an empty one over it
  if (list === null) throw new Error(`git worktree list failed in ${repo}`);
  for (const line of list.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice(9);
    if (line.startsWith('HEAD ')) sha = line.slice(5).trim();
    if (!line.startsWith('branch refs/heads/') || !path) continue;
    const base = git(path, 'merge-base', 'origin/main', 'HEAD').trim();
    if (!base) continue;
    const branch = line.slice('branch refs/heads/'.length);
    const committed = gitOr(path, 'diff', '--name-only', base, 'HEAD');
    const tree = treeOf(
      branch,
      committed,
      gitOr(path, 'diff', '--name-only', 'HEAD'),
      gitOr(path, 'ls-files', '--others', '--exclude-standard'),
    );
    trees.push(tree);
    const at = Number(git(path, 'log', '-1', '--format=%ct', 'HEAD').trim()) * 1000;
    // a head whose committed files are unknown can't be judged (landed or not): left out of the merge check
    if (committed !== null && sha && sha !== base && at)
      heads.push({ branch, sha, base, files: branchFiles(committed, '', ''), at });
  }
  return { trees, heads };
}

const SCRATCH = 'aperture-conflicts-';
const SCRATCH_TTL_MS = 3600_000;

// A run killed before its finally (SIGKILL, the VM's memory killer) leaves its scratch store: sweep old ones.
function sweepScratch(now: number) {
  for (const d of readdirSync(tmpdir()))
    if (d.startsWith(SCRATCH))
      try {
        if (now - statSync(join(tmpdir(), d)).mtimeMs > SCRATCH_TTL_MS)
          rmSync(join(tmpdir(), d), { recursive: true, force: true });
      } catch {
        // another run's, removed under us
      }
}

// The merge-tree check's git: read-only, and the objects each merge writes go to a scratch store on the
// container's own disk, removed after the run — none are added to the shared store (docs/ops/SESSION-BOARD.md →
// Overlaps).
function conflictCheck(repo: string, boardDir: string, heads: Head[], now: Date) {
  const mainSha = git(repo, 'rev-parse', '--verify', '--quiet', 'origin/main').trim();
  const mainTree = git(repo, 'rev-parse', '--verify', '--quiet', 'origin/main^{tree}').trim();
  const common = git(repo, 'rev-parse', '--git-common-dir').trim();
  if (!mainSha || !mainTree || !common) return undefined;
  const cacheFile = join(boardDir, 'conflicts-cache.json');
  sweepScratch(now.getTime());
  const objects = mkdtempSync(join(tmpdir(), SCRATCH));
  const run: GitRun = (args, timeoutMs) => {
    const r = spawnSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_OBJECT_DIRECTORY: objects,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(resolve(repo, common), 'objects'),
      },
    });
    return { code: r.status, stdout: r.stdout ?? '' };
  };
  try {
    const c = check(
      { heads, main: { sha: mainSha, tree: mainTree }, now: now.getTime() },
      run,
      parseCache(readOr(cacheFile)),
    );
    writeFileSync(`${cacheFile}.tmp.${process.pid}`, JSON.stringify(c.cache) + '\n');
    renameSync(`${cacheFile}.tmp.${process.pid}`, cacheFile);
    return c;
  } finally {
    rmSync(objects, { recursive: true, force: true });
  }
}

const readOr = (p: string) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

const board = () => {
  const dir = boardDir((c, a) => execFileSync(c, a, { encoding: 'utf8' }).trim());
  if (!dir) throw new Error('no board dir (set APERTURE_BOARD_DIR)');
  return dir;
};
// tmp + rename, so a reader never sees half a file
const put = (f: string, text: string) => {
  writeFileSync(`${f}.tmp.${process.pid}`, text);
  renameSync(`${f}.tmp.${process.pid}`, f);
};
const readQueue = (dir: string) => parseQueue(readOr(join(dir, 'queue.json')));

// The hub's files are written from the main checkout only (/workspace, where the hub runs): a lane's run of a writer
// would act for the hub. The main checkout is the one whose git dir is the common dir.
function hubBoard(verb: string): string {
  const here = process.env.INIT_CWD ?? process.cwd(); // pnpm runs scripts from the root; INIT_CWD is where it was typed
  const g = gitOr(here, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir');
  const [gd, common] = (g ?? '').trim().split('\n');
  if (!gd || gd !== common)
    throw new Error(
      `${verb} writes the hub's files: run it from the main checkout (/workspace), not a worktree`,
    );
  return board();
}

// Each ran id is handed out once: a create-only `.<id>` (the watcher reads no dot-file) reserves it, and an id taken
// (reserved, or its marker already written) moves to the next second's, within the minute.
function mintRan(dir: string, slug: string, now: Date): string {
  // the suffix writes <mac-repo>/localNotes/board/ran: a board dir anywhere else is a different folder
  if (!/\/localNotes\/board\/?$/.test(dir))
    throw new Error(
      `ran: the board dir ${dir} is not <repo>/localNotes/board, where the suffix writes`,
    );
  const ran = join(dir, 'ran');
  mkdirSync(ran, { recursive: true }); // the suffix never makes it: a missing folder fails loud
  for (let k = 0; k < 60; k++) {
    const next = ranId(slug, new Date(now.getTime() + k * 1000));
    if (existsSync(join(ran, next))) continue;
    try {
      writeFileSync(join(ran, `.${next}`), '', { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw e;
    }
    return next;
  }
  throw new Error(`ran: every ${slug} id for the next minute is already on disk: try again later`);
}

// lane starts: lifecycle/<branch>.json `startedAt`
function lifecycle(dir: string): Started[] {
  let files: string[];
  try {
    files = readdirSync(join(dir, 'lifecycle')).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files.flatMap((f) => {
    try {
      const l = JSON.parse(readFileSync(join(dir, 'lifecycle', f), 'utf8')) as Record<
        string,
        unknown
      >;
      return typeof l.branch === 'string' &&
        typeof l.startedAt === 'string' &&
        Date.parse(l.startedAt) > 0
        ? [{ branch: l.branch, startedAt: l.startedAt }]
        : [];
    } catch {
      return [];
    }
  });
}

// `asks <sub>`: reads go anywhere; writes (add, answer, close) are the hub's, from the main checkout, and land only
// when the whole file still parses with no asks problem.
function asks(args: string[], rest: string[], stdin: () => string, now: number): string {
  const [sub, a1, a2] = args;
  if (sub === 'list' || sub === 'show') {
    const q = readQueue(board());
    if (!q.data)
      throw new Error(
        `queue.json: ${q.status}${q.problems.length ? ` (${q.problems.join('; ')})` : ''}`,
      );
    if (sub === 'show') {
      const a = (q.data.asks ?? []).find((x) => x.id === (a1 ?? '').toLowerCase());
      if (!a) throw new Error(`asks show: no ask ${a1 ?? '(none given)'}`);
      return askShow(a);
    }
    const open = openAsks(q.data);
    return rest.includes('--json') ? JSON.stringify(open) : askLines(open);
  }
  const dir = hubBoard(`asks ${sub}`);
  const f = join(dir, 'queue.json');
  const text = readOr(f);
  if (text === null) throw new Error(`no ${f}`);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`queue.json is not JSON (${(e as Error).message}): fix it first`, { cause: e });
  }
  const before = parseQueue(text);
  if (!before.data) throw new Error(`queue.json: ${before.problems.join('; ')}`);
  const list = before.data.asks ?? [];
  let next: Record<string, unknown>;
  let out: string;
  if (sub === 'add') {
    let input: unknown;
    try {
      input = JSON.parse(stdin());
    } catch (e) {
      throw new Error(`asks add: stdin is not JSON (${(e as Error).message})`, { cause: e });
    }
    const r = addAsk(raw, input, now);
    next = r.raw;
    out = r.id;
  } else if (sub === 'answer') {
    if (!a1 || !a2) throw new Error('usage: asks answer <id|all> <letter|ok>');
    const r = answerAsks(raw, list, a1, a2, now);
    if (!r.answered) return r.out.join('\n'); // nothing to write
    next = r.raw;
    out = r.out.join('\n');
  } else if (sub === 'close') {
    if (!a1) throw new Error('usage: asks close <id>');
    next = closeAsk(raw, list, a1, now);
    out = `CLOSED ${a1.toLowerCase()}`;
  } else throw new Error(`unknown asks subcommand "${sub ?? ''}"`);
  next = { ...pruneAsks(next, now), updatedAt: new Date(now).toISOString() };
  const body = JSON.stringify(next, null, 2) + '\n';
  const bad = parseQueue(body).problems.filter((p) => /^asks|^askSeq/.test(p));
  if (bad.length)
    throw new Error(`asks ${sub}: refused, the result would not parse: ${bad.join('; ')}`);
  put(f, body);
  return out;
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
      const input = JSON.parse(stdin());
      const { limits, liveLimits: ll, live, slots, req } = input;
      const d = decideHeavy(parseLimits(limits), ll, live, slots ?? [], req, now);
      const out = JSON.stringify(d);
      // The log-only budget (budget-read.ts): beside the decision, never part of it — any error is swallowed.
      try {
        if (input.budget) logJobBudget(input, d, now.getTime());
      } catch {
        // an unwritable history or a torn file costs the log line, never the admission
      }
      return out;
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
      const { trees, heads } = worktrees(repo);
      const result = {
        v: 1,
        t: now.toISOString(),
        ...overlaps(trees, sessionNames(boardDir), conflictCheck(repo, boardDir, heads, now)),
      };
      const file = join(boardDir, 'overlap.json');
      writeFileSync(`${file}.tmp.${process.pid}`, JSON.stringify(result) + '\n');
      renameSync(`${file}.tmp.${process.pid}`, file);
      return `${result.pairs.length} overlapping pair(s), ${result.conflicts?.length ?? 0} conflict(s)${result.pending ? `, ${result.pending} merge(s) pending` : ''}`;
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
    case 'budget': {
      const [dir] = args;
      if (!dir) throw new Error('usage: budget <boardDir> [--json]');
      const limitsPath =
        process.env.APERTURE_LIMITS_JSON ?? resolve(import.meta.dirname, '../../board/limits.json'); // lib.sh's LIMITS_JSON
      const b = budgetNow(
        dir,
        JSON.parse(readFileSync(limitsPath, 'utf8')),
        '/proc',
        now.getTime(),
      );
      return rest.includes('--json') ? JSON.stringify(b) : (b?.line ?? '');
    }
    case 'budget-report': {
      const [historyDir, days = '1'] = args;
      if (!historyDir || !(Number(days) > 0 && Number.isFinite(Number(days)) && Number(days) <= 90))
        throw new Error('usage: budget-report <historyDir> [days, 0 < days <= 90] [--json]');
      const since = new Date(now.getTime() - Number(days) * 86400_000);
      const limitsPath =
        process.env.APERTURE_LIMITS_JSON ?? resolve(import.meta.dirname, '../../board/limits.json');
      const psiLine = JSON.parse(readOr(limitsPath) ?? '{}')?.pace?.psiCpuBelow; // the pace gate's line
      const r = budgetReport(
        readJsonl(historyDir, 'events-'),
        readJsonl(historyDir, 'samples-') as Sample[],
        since,
        now,
        typeof psiLine === 'number' ? psiLine : undefined,
      );
      return rest.includes('--json') ? JSON.stringify(r) : formatBudgetReport(r);
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
    case 'sync-main': {
      const here = process.env.INIT_CWD ?? process.cwd(); // pnpm runs scripts from the root; INIT_CWD is where it was typed
      const dir = boardDir((c, a) => execFileSync(c, a, { cwd: here, encoding: 'utf8' }).trim());
      return syncMain(
        execRun,
        here,
        withMainLock,
        withRestartLock,
        dir ? { dir, now: () => new Date() } : undefined, // the merge log (merge-record.ts)
      );
    }
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
    case 'brief': {
      const dir = boardDir((c, a) => execFileSync(c, a, { encoding: 'utf8' }).trim());
      if (!dir) throw new Error('no board dir (set APERTURE_BOARD_DIR)');
      const f = join(dir, BRIEF_FILE);
      let text: string, mtime: number;
      try {
        text = readFileSync(f, 'utf8');
        mtime = statSync(f).mtimeMs;
      } catch {
        throw new Error(`no ${f} yet: the web tower writes it every 30 s (board.sh tower start)`);
      }
      return briefOut(text, mtime, now.getTime());
    }
    case 'ran': {
      const [slug] = args;
      if (!slug) throw new Error('usage: ran <slug>');
      return ranOut(macRoot(), mintRan(board(), slug, now));
    }
    case 'asks':
      return asks(args, rest, stdin, now.getTime());
    case 'merge-line': {
      const dir = board();
      const f = join(dir, MERGE_LINE_FILE);
      let text: string, mtime: number;
      try {
        text = readFileSync(f, 'utf8');
        mtime = statSync(f).mtimeMs;
      } catch {
        throw new Error(`no ${f} yet: the web tower writes it every 30 s (board.sh tower start)`);
      }
      // a stale file never prints a line to run: what it would merge is no longer known
      if (now.getTime() - mtime > BRIEF_STALE_MS)
        return `TOWER DOWN: the merge line is from ${hhmm(mtime)}, no line printed (board.sh tower status; board.sh tower start)\n${text
          .replace(/\n$/, '')
          .split('\n')
          .filter((l) => !l.startsWith('cd '))
          .join('\n')}`;
      if (!text.split('\n').some((l) => l.startsWith('cd '))) return text.replace(/\n$/, '');
      const root = macRoot();
      const out = withSuffix(text, ranSuffix(root, mintRan(dir, 'merge', now)));
      return root === MAC_PLACEHOLDER ? `${out}\n${MAC_ROOT_NOTE}` : out;
    }
    case 'wi': {
      const [id] = args;
      if (!id) throw new Error('usage: wi <F-number | PR n | d<n> | lane>');
      const dir = board();
      return whatIs(id, {
        queue: readQueue(dir).data,
        lanes: readLanes(dir).lanes,
        prs: readPrIndex(readOr(join(dir, PRS_FILE))),
        roadmap: readOr(join(dir, '..', 'roadmap.md')),
        kickoff: (b) => readOr(join(dir, '..', 'kickoffs', `${b}.md`)),
        now: now.getTime(),
      });
    }
    case 'away': {
      const [ping] = args;
      if (ping !== undefined && ping !== 'ping') throw new Error('usage: away [ping]');
      const dir = hubBoard('away');
      const usage = usageRow(readOr(join(dir, 'board.line')));
      const prev = readStamp(readOr(join(dir, AWAY_FILE)));
      put(join(dir, AWAY_FILE), JSON.stringify(awayStamp(now.getTime(), !!ping, usage)) + '\n');
      return `AWAY since ${hhmm(now.getTime())}${ping ? ' · ping on asks' : ''} · usage ${usage ?? 'unknown'}${prev ? ` (replaces the stamp from ${hhmm(Date.parse(prev.at))})` : ''}`;
    }
    case 'back': {
      const dir = hubBoard('back');
      const stamp = readStamp(readOr(join(dir, AWAY_FILE)));
      if (!stamp) throw new Error(`back: no ${AWAY_FILE} (no /away stamp to digest from)`);
      const day = stamp.at.slice(0, 10); // events files are named by UTC day
      const merged = readJsonl(join(dir, 'history'), 'events-')
        .filter((e): e is Merged & { kind: string } => {
          const x = e as Record<string, unknown>;
          return (
            x?.kind === 'merged' &&
            Number.isInteger(x.pr) &&
            typeof x.sha === 'string' &&
            typeof x.mergedAt === 'string' &&
            typeof x.title === 'string'
          );
        })
        .filter((e) => e.mergedAt.slice(0, 10) >= day);
      const out = backDigest({
        stamp,
        now: now.getTime(),
        merged,
        started: lifecycle(dir),
        lanes: readLanes(dir).lanes,
        asks: openAsks(readQueue(dir).data),
        usageNow: usageRow(readOr(join(dir, 'board.line'))),
      });
      renameSync(join(dir, AWAY_FILE), join(dir, AWAY_LAST));
      return out;
    }
    case 'stop': {
      const [t] = args;
      if (!t) throw new Error('usage: stop <HH:MM>|off');
      const dir = hubBoard('stop');
      const f = join(dir, 'pace-control.json');
      const at = t === 'off' ? null : stopAt(t, now.getTime());
      put(f, JSON.stringify(withStop(readOr(f), at, now.getTime()), null, 2) + '\n');
      return at === null ? 'STOP off' : stopLine(at, now.getTime());
    }
    default:
      throw new Error(
        `usage: cli.ts decide-heavy | staleness | overlap | report | barriers | machine | budget | budget-report | lane | sync-main | stale | brief | ran | asks | merge-line | wi | away | back | stop (got ${cmd ?? 'nothing'})`,
      );
  }
}

// A busy main checkout (its lock, before anything moved) is no failure: 75, and the main sync loop tries again next
// round (sync.sh). A busy tower restart comes after a move, so it stays an error (2) that says so.
export const exitCode = (e: unknown) => (e instanceof MainBusy && e.file === MAIN_LOCK ? 75 : 2);

if (process.argv[1]?.endsWith('cli.ts')) {
  try {
    const out = main(process.argv.slice(2), () => readFileSync(0, 'utf8'));
    if (out) process.stdout.write(out + '\n');
  } catch (e) {
    process.stderr.write(`board cli: ${(e as Error).message}\n`);
    process.exit(exitCode(e));
  }
}
