// The control tower's one state shape (docs/ops/SESSION-BOARD.md → Control tower). data/ fills it, render/
// draws it; nothing here knows about the terminal, so a web page can reuse the data half.
import type { Queue } from './queue.ts';
import type { Run } from './ledger.ts';
import type { Pr } from './prs.ts';
import type { Bench } from './bench.ts';
import { MAIN, type Conflict } from '../conflicts.ts';

export type Range = '1h' | '6h' | '24h';
export const RANGE_SEC: Record<Range, number> = { '1h': 3600, '6h': 6 * 3600, '24h': 24 * 3600 };

// The board's merge-tree check, from overlap.json (docs/ops/SESSION-BOARD.md → Overlaps): `at` is the file's own
// `t`, null when it has none. A warning only: it never sets a lane's state, tone or needs.
export type Conflicts = { at: number | null; list: Conflict[] };
// One lane's share of it: the files it can't merge with main, and with each other lane (sorted by branch).
// `oldMin`: the file's age in whole minutes once it is CONFLICTS_OLD_MS old (board.sh's line), else null.
export type LaneConflicts = {
  main: string[] | null;
  lanes: { branch: string; files: string[] }[];
  oldMin: number | null;
};
export const CONFLICTS_OLD_MS = 10 * 60_000;

export function conflictsOf(
  c: Conflicts | null,
  branch: string | null,
  now: number,
): LaneConflicts | null {
  if (!c || !branch) return null;
  let main: string[] | null = null;
  const lanes: LaneConflicts['lanes'] = [];
  for (const x of c.list) {
    if (x.b === MAIN) {
      if (x.a === branch) main = x.files;
    } else if (x.a === branch) lanes.push({ branch: x.b, files: x.files });
    else if (x.b === branch) lanes.push({ branch: x.a, files: x.files });
  }
  if (!main && !lanes.length) return null;
  lanes.sort((x, y) => (x.branch < y.branch ? -1 : x.branch > y.branch ? 1 : 0));
  const age = c.at === null ? 0 : now - c.at;
  return { main, lanes, oldMin: age >= CONFLICTS_OLD_MS ? Math.floor(age / 60_000) : null };
}

// One sampler tick, compacted: 24 h of raw samples is ~14 MB; these are a few dozen bytes each.
export type Point = {
  t: number; // epoch ms
  anon: number; // MiB
  pids: number;
  cpu: number | null; // cores; null for a bad tick
  heavy: number;
  working: number;
  names: string[]; // working sessions
};

export type Job = {
  t: number; // end, epoch ms
  start: number;
  cls: string;
  label: string;
  name: string | null;
  branch: string | null;
  exit: number | null;
  signal: string | null;
  wallSec: number;
  verdict: string | null;
  excluded: boolean; // loadTest / guard: not a real job
  cold?: boolean; // heavy.sh's cache.cold: a tsc or eslint cache was missing at the start (SESSION-BOARD.md → Perf fields)
};

export type Session = {
  name: string;
  branch: string | null;
  state: string;
  thr: number;
  rssMiB: number;
  heavy: string | null;
};

export type Lock = {
  branch: string | null; // null = free
  sha?: string | null; // the holder's dispatched sha (the web tower matches its deploy-dev run)
  session: string | null;
  expiresAt: number | null;
  asOf: number | null; // cache time
  failed: boolean; // the last refresh failed
  failedWhy?: string | null; // why, as devlock.sh recorded it (git's last error line, or the tag read)
  bad?: string | null; // the cache or its holder is unreadable: the web tower says so, never "free"
};

export type Gauges = {
  t: number;
  anonMiB: number;
  highMiB: number;
  anonSoft: number;
  anonHard: number;
  pids: number;
  pidsMax: number;
  pidsSoft: number;
  pidsHard: number;
  cpu: number | null;
  cores: number;
  enforcing: boolean;
};

export type FeedItem = {
  t: number;
  kind: 'job' | 'lock' | 'run' | 'merge' | 'pr' | 'lease';
  text: string;
  tone: Tone;
};
export type Tone = 'normal' | 'dim' | 'good' | 'warn' | 'bad';

export type TowerState = {
  now: number;
  gauges: Gauges | null; // null: no sample yet
  sessions: Session[];
  lock: Lock | null; // slot A (`dev`); null: no cache file
  lockB: Lock | null; // slot B (`devb`, devlock.devb.json); null: no cache file — the header leaves it out
  points: Point[]; // oldest first, the last 24 h
  jobs: Job[]; // oldest first, the last 7 d
  runs: Run[]; // devcheck runs, oldest first
  queue: Queue;
  prs: { list: Pr[]; at: number | null; error: string | null; forks?: number }; // forks: dropped fork PRs
  bench: Bench | null;
  lockFeed: FeedItem[]; // transitions this tower saw
  leaseFeed: FeedItem[];
  conflicts: Conflicts | null; // overlap.json's merge-tree conflicts; null: no file, or one from before the check
};
