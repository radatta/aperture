// Lane state the lifecycle reads: the name rule, the worktree list, who counts toward the cap, the lifecycle record
// (the lane's tmux window identity) and the seam every effect goes through. docs/ops/LANES.md.
import type { Clock } from '../bot/dispatch.ts';
import type { Run } from '../bot/sh.ts';
import { BRANCH_RE } from '../board/tower/lanes.ts';
import type { LaneFile } from '../board/tower/lanes.ts';
import { readMacStats, type MacRead } from '../board/tower/health.ts';

export const EXIT = { ok: 0, failed: 1, usage: 2, refused: 3, later: 75 } as const;
export const DEFAULT_CAP = 5;
// `test` too: lib.sh's heavy classifier would read `pnpm lanes start test` as a suite.
export const RESERVED = ['main', 'master', 'dev', 'devb', 'test'];

export interface LaneFs {
  read(p: string): string | null; // null when missing
  write(p: string, s: string): void; // parents made, tmp + rename
  writeNew(p: string, s: string): boolean; // false when it exists (O_EXCL)
  exists(p: string): boolean;
  rm(p: string): void;
  mkdirp(p: string): void;
  list(dir: string): string[]; // [] when missing
  archive(src: string, dst: string): number; // copy a tree to a new dst, verify it; files copied, or throws
  sameTree(a: string, b: string, ignore: string[]): boolean;
}

export interface Lanes {
  read(): LaneFile[];
  write(branch: string, phase: 'plan', step: string, session: string, sha: string | null): void;
  clear(branch: string): void;
}

export interface Env {
  mainRoot: string; // the main checkout (/workspace)
  cwdTop: string; // the toplevel of where the command was typed
  invokedIn: string; // where it was typed (relative --kickoff paths)
  boardDir: string;
  home: string;
  tmuxPane: string | null;
  macRoot: string; // or the placeholder
  macNote: string; // '' or MAC_ROOT_NOTE
  slug: string;
  procDir: string; // /proc
}

export interface Deps {
  run: Run;
  fs: LaneFs;
  lanes: Lanes;
  clock: Clock;
  log: (s: string) => void;
  env: Env;
  syncMain: () => string; // board/sync-main.ts: the main checkout to origin/main, the tower restarted if stale; throws
  lock: <T>(fn: () => T) => T; // board/main-lock.ts: git writes in the main checkout, one session at a time; throws busy
}

export const LS_REMOTE_TIMEOUT_MS = 30_000; // the fetch's is board/sync-main.ts FETCH_TIMEOUT_MS

// Both lifecycle commands end here: a failure warns and never changes the command's outcome.
export function syncMainSoft(d: Deps): void {
  try {
    d.log(d.syncMain());
  } catch (err) {
    d.log(`warning: sync-main failed (retry: pnpm board sync-main): ${(err as Error).message}`);
  }
}

export const worktreePath = (e: Env, b: string) => `${e.mainRoot}/.claude/worktrees/${b}`;
export const lifecyclePath = (e: Env, b: string) => `${e.boardDir}/lifecycle/${b}.json`;
export const archivePath = (e: Env, b: string) => `${e.mainRoot}/localNotes/archive/${b}`;
export const expectedGitdir = (b: string) => `gitdir: ../../../.git/worktrees/${b}`;

export function hubName(d: Deps): string {
  try {
    const h = JSON.parse(d.fs.read(`${d.env.mainRoot}/scripts/board/hub.json`) ?? '{}');
    return typeof h.name === 'string' ? h.name : 'dispatch';
  } catch {
    return 'dispatch';
  }
}

// null when it is a usable lane name: safe in a path, a tmux target and an unquoted zsh word.
export function nameProblem(b: string | undefined, hub: string): string | null {
  const rule = `${BRANCH_RE}; not ${[...RESERVED, hub].join('/')}`;
  if (!b || !BRANCH_RE.test(b) || [...RESERVED, hub].includes(b))
    return `"${b ?? ''}" is not a lane name (${rule})`;
  return null;
}

export type Tree = { path: string; branch: string | null };

export function parseWorktrees(porcelain: string): Tree[] {
  const out: Tree[] = [];
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) out.push({ path: line.slice(9), branch: null });
    else if (line.startsWith('branch refs/heads/') && out.length)
      out[out.length - 1]!.branch = line.slice('branch refs/heads/'.length);
  }
  return out;
}

// A lane's tree: on a branch, under <main>/.claude/worktrees/, not a board-matrix-* scratch tree (lib.sh).
export const laneTrees = (trees: Tree[], mainRoot: string) =>
  trees.filter(
    (t): t is Tree & { branch: string } =>
      !!t.branch &&
      t.path.startsWith(`${mainRoot}/.claude/worktrees/`) &&
      !t.path.slice(`${mainRoot}/.claude/worktrees/`.length).startsWith('board-matrix-'),
  );

// A pid alive and, given a start tick, the same process (lib.sh sb_alive): zombies and reused pids are not.
export function alive(d: Deps, pid: number, start: string | null): boolean {
  const s = d.fs.read(`${d.env.procDir}/${pid}/stat`);
  if (!s) return false;
  const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
  if (f[0] === 'Z' || f[0] === 'X') return false;
  return start === null || f[19] === start;
}

// branch → a live session in it, from the board's registry (board/sessions/<pid>.json, written by board.sh).
export function liveSessionBranches(d: Deps): Set<string> {
  const dir = `${d.env.boardDir}/sessions`;
  const out = new Set<string>();
  for (const f of d.fs.list(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const s = JSON.parse(d.fs.read(`${dir}/${f}`) ?? 'null');
      if (s?.branch && s.state !== 'gone' && Number.isInteger(s.pid))
        if (alive(d, s.pid, typeof s.pidStart === 'string' ? s.pidStart : null)) out.add(s.branch);
    } catch {
      // half-written by another session
    }
  }
  return out;
}

export type Active = { branch: string; phase: string | null; why: string };

// Active: a lane tree whose lane file isn't `parked` and that has a live session or a lifecycle record. A stale
// worktree with neither holds no dev slot and no suite (decisions.md, question 2).
export function activeLanes(d: Deps, trees: Tree[]): Active[] {
  const lanes = new Map(d.lanes.read().map((l) => [l.branch, l]));
  const live = liveSessionBranches(d);
  const out: Active[] = [];
  for (const t of laneTrees(trees, d.env.mainRoot)) {
    const phase = lanes.get(t.branch)?.phase ?? null;
    if (phase === 'parked') continue;
    const rec = d.fs.exists(lifecyclePath(d.env, t.branch));
    if (!live.has(t.branch) && !rec) continue;
    out.push({ branch: t.branch, phase, why: live.has(t.branch) ? 'session' : 'lifecycle' });
  }
  return out;
}

export function laneCap(d: Deps): number {
  try {
    const l = JSON.parse(d.fs.read(`${d.env.mainRoot}/scripts/board/limits.json`) ?? '{}');
    const n = l?.lanes?.maxActive;
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_CAP;
  } catch {
    return DEFAULT_CAP;
  }
}

// The lane's `claude --autocompact <tokens>`, from limits.json `lanes.autoCompactWindow`: 0 turns it off, absent is the
// default, anything else outside 100k-1M is noted and defaulted (docs/ops/LANES.md → Start step 8).
export const DEFAULT_COMPACT_WINDOW = 500_000; // about half a 1M window (the maintainer, 2026-11-17)
export function compactWindow(d: Deps): number | null {
  let v: unknown;
  try {
    v = JSON.parse(d.fs.read(`${d.env.mainRoot}/scripts/board/limits.json`) ?? '{}')?.lanes
      ?.autoCompactWindow;
  } catch {
    v = undefined;
  }
  if (v === undefined) return DEFAULT_COMPACT_WINDOW;
  if (v === 0) return null;
  if (Number.isInteger(v) && (v as number) >= 100_000 && (v as number) <= 1_000_000)
    return v as number;
  d.log(
    `note: limits.json lanes.autoCompactWindow ${JSON.stringify(v)} is not 0 or 100000-1000000 tokens; using ${DEFAULT_COMPACT_WINDOW}`,
  );
  return DEFAULT_COMPACT_WINDOW;
}

// The Mac's power, read through the lane seam (F120): `lanes status` prints its line, `lanes start` the ≤ 3 advice.
export function macRead(d: Deps): MacRead {
  return readMacStats(`${d.env.boardDir}/mac-stats.json`, d.clock.now(), (p) => {
    const t = d.fs.read(p);
    if (t === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return t;
  });
}

export const describeActive = (a: Active[]) =>
  a.map((x) => `${x.branch} (${x.phase ?? 'no lane file'})`).join(', ');

export type Lifecycle = {
  v: 1;
  branch: string;
  worktree: string;
  windowId: string | null;
  paneId: string | null;
  tmuxServerPid: string | null;
  tmuxServerStart: string | null;
  tmuxSession: string | null;
  baseSha: string | null;
  kickoff: string | null;
  overCap: string | null;
  overPace?: string | null; // absent in records written before the pace gate
  archive: string | null; // where `lanes end` archived localNotes, so a rerun writes there
  startedAt: string;
};

export function readLifecycle(d: Deps, b: string): Lifecycle | null {
  try {
    const r = JSON.parse(d.fs.read(lifecyclePath(d.env, b)) ?? 'null');
    return r?.v === 1 && r.branch === b ? (r as Lifecycle) : null;
  } catch {
    return null;
  }
}

export const lifecycleText = (r: Lifecycle) => JSON.stringify(r, null, 2) + '\n';

// The recorded window, only when it is provably the same one: the same tmux server (pid + start time) and the window
// still named after the lane. Never looked up by name; a reason when it can't be trusted.
export function windowCheck(d: Deps, r: Lifecycle | null): { id: string } | { why: string } {
  if (!r?.windowId) return { why: 'no window recorded for this lane' };
  let got: string;
  try {
    got = d.run('tmux', [
      'display',
      '-p',
      '-t',
      r.windowId,
      '#{pid}\t#{start_time}\t#{window_id}\t#{window_name}',
    ]);
  } catch {
    return { why: `window ${r.windowId} is gone` };
  }
  const [pid, start, id, ...rest] = got.split('\t');
  const name = rest.join('\t'); // a window name may hold a tab
  if (pid !== r.tmuxServerPid || start !== r.tmuxServerStart)
    return { why: `the tmux server restarted since ${r.windowId} was recorded` };
  if (id !== r.windowId || name !== r.branch)
    return { why: `${r.windowId} is now named ${name || '?'}, not ${r.branch}` };
  return { id: r.windowId };
}

export function tryRun(d: Deps, cmd: string, args: string[], cwd?: string): string | null {
  try {
    return d.run(cmd, args, { cwd });
  } catch {
    return null;
  }
}
