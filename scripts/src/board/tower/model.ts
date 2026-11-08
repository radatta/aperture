// The control tower's one state shape (docs/ops/SESSION-BOARD.md → Control tower). data/ fills it, render/
// draws it; nothing here knows about the terminal, so a web page can reuse the data half.
import type { Queue } from './queue.ts';
import type { Run } from './ledger.ts';
import type { Pr } from './prs.ts';
import type { Bench } from './bench.ts';

export type Range = '1h' | '6h' | '24h';
export const RANGE_SEC: Record<Range, number> = { '1h': 3600, '6h': 6 * 3600, '24h': 24 * 3600 };

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
  session: string | null;
  expiresAt: number | null;
  asOf: number | null; // cache time
  failed: boolean; // the last refresh failed
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
  kind: 'job' | 'lock' | 'run' | 'merge' | 'lease';
  text: string;
  tone: Tone;
};
export type Tone = 'normal' | 'dim' | 'good' | 'warn' | 'bad';

export type TowerState = {
  now: number;
  gauges: Gauges | null; // null: no sample yet
  sessions: Session[];
  lock: Lock | null; // null: no cache file
  points: Point[]; // oldest first, the last 24 h
  jobs: Job[]; // oldest first, the last 7 d
  runs: Run[]; // devcheck runs, oldest first
  queue: Queue;
  prs: { list: Pr[]; at: number | null; error: string | null };
  bench: Bench | null;
  lockFeed: FeedItem[]; // transitions this tower saw
  leaseFeed: FeedItem[];
};
