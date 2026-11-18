// The machine-history maths: compact samples and job events, bucket them onto a chart's columns, mark
// event ticks, and the failures-by-concurrency table (docs/ops/SESSION-BOARD.md → Control tower).
import { clean, parseTime } from './fmt.ts';
import type { Job, Point } from './model.ts';
import type { Run } from './ledger.ts';

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

// cpuCores over maxCpu (the caller passes 2 × the cores) is a bad tick (SESSION-BOARD.md → History): unknown.
export function compactSample(raw: unknown, maxCpu = 64): Point | null {
  const r = raw as {
    t?: unknown;
    cg?: Record<string, unknown>;
    mix?: Record<string, unknown>;
    sessions?: unknown;
  };
  const t = parseTime(r?.t);
  if (t === null || !r.cg || typeof r.cg !== 'object') return null;
  const sessions = (Array.isArray(r.sessions) ? r.sessions : []) as ({
    name?: unknown;
    state?: unknown;
  } | null)[];
  const cpu = r.cg.cpuCores;
  return {
    t,
    anon: num(r.cg.anonMiB),
    pids: num(r.cg.pids),
    cpu: typeof cpu === 'number' && Number.isFinite(cpu) && cpu >= 0 && cpu <= maxCpu ? cpu : null,
    heavy: num(r.mix?.heavy),
    working: num(r.mix?.working),
    names: sessions
      .filter((x) => x?.state === 'working' && typeof x.name === 'string')
      .map((x) => clean(x!.name as string)),
  };
}

const text = (x: unknown) => (typeof x === 'string' && x ? clean(x) : null);

export function compactJob(raw: unknown): Job | null {
  const r = raw as Record<string, unknown>;
  if (r?.kind !== 'job') return null;
  const t = parseTime(r.t);
  if (t === null) return null;
  const wallSec = num(r.wallSec);
  return {
    t,
    start: t - wallSec * 1000,
    cls: text(r.class) ?? 'other',
    label: text(r.label) ?? '',
    name: text(r.name),
    branch: text(r.branch),
    exit: typeof r.exit === 'number' ? r.exit : null,
    signal:
      typeof r.signal === 'string' || typeof r.signal === 'number' ? `signal ${r.signal}` : null, // heavy.sh writes a number
    wallSec,
    verdict: text(r.verdict),
    excluded: r.loadTest === true || r.guard === true,
  };
}

// An interrupt (Ctrl-C 130, TERM 143) is the operator, not a failure; 1 is red tests, 134/137 the container.
export const failed = (j: Job) =>
  j.exit !== null && j.exit !== 0 && j.exit !== 130 && j.exit !== 143;
export const isSuite = (j: Job) => j.cls === 'test' && !j.excluded;

export type Bucket = {
  from: number;
  to: number;
  anon: number | null;
  pids: number | null;
  cpu: number | null;
  heavy: number | null;
  working: number | null;
  last: Point | null; // the bucket's latest tick
  src: Point | null; // last, or the tick carried into an empty bucket: what the readout shows
};

// `n` equal buckets over [from, to): each field is the bucket's max (peaks are what hurt); a bucket with
// no tick is all null, so a sampler gap draws as a gap. `points` must be sorted by t.
export function bucket(points: Point[], from: number, to: number, n: number): Bucket[] {
  const w = (to - from) / n;
  const out: Bucket[] = Array.from({ length: n }, (_, i) => ({
    from: from + i * w,
    to: from + (i + 1) * w,
    anon: null,
    pids: null,
    cpu: null,
    heavy: null,
    working: null,
    last: null,
    src: null,
  }));
  const mx = (a: number | null, b: number) => (a === null || b > a ? b : a);
  let prev: Point | null = null;
  for (const p of points) {
    if (p.t >= to) break;
    if (p.t < from) {
      prev = p;
      continue;
    }
    const b = out[Math.min(n - 1, Math.floor((p.t - from) / w))]!;
    b.anon = mx(b.anon, p.anon);
    b.pids = mx(b.pids, p.pids);
    if (p.cpu !== null) b.cpu = mx(b.cpu, p.cpu);
    b.heavy = mx(b.heavy, p.heavy);
    b.working = mx(b.working, p.working);
    b.last = p;
  }
  // Buckets narrower than the sampler's 30 s tick: an empty one inside the normal cadence holds the
  // previous tick's values; only a real gap (no tick for CARRY_MS) stays blank.
  for (const b of out) {
    if (b.last) {
      prev = b.last;
      b.src = b.last;
      continue;
    }
    if (prev && b.from - prev.t < CARRY_MS) {
      b.src = prev;
      b.anon = prev.anon;
      b.pids = prev.pids;
      b.cpu = prev.cpu;
      b.heavy = prev.heavy;
      b.working = prev.working;
    }
  }
  return out;
}

export const CARRY_MS = 75000; // 2.5 sampler ticks

export type Tick = 'fail' | 'merge' | 'devcheck-pass' | 'devcheck-fail' | 'suite' | null;
const RANK: Record<NonNullable<Tick>, number> = {
  fail: 5,
  'devcheck-fail': 4,
  merge: 3,
  'devcheck-pass': 2,
  suite: 1,
};

// One tick per column over [from, to): the highest-ranked event ending in it.
export function ticks(
  n: number,
  from: number,
  to: number,
  jobs: Job[],
  runs: Run[],
  merges: number[],
): Tick[] {
  const out: Tick[] = Array.from({ length: n }, () => null);
  const w = (to - from) / n;
  const put = (t: number, k: NonNullable<Tick>) => {
    if (t < from || t >= to) return;
    const i = Math.min(n - 1, Math.floor((t - from) / w));
    const cur = out[i];
    if (!cur || RANK[k] > RANK[cur]) out[i] = k;
  };
  for (const j of jobs) if (isSuite(j)) put(j.t, failed(j) ? 'fail' : 'suite');
  for (const r of runs)
    if (r.end !== null) put(r.end, r.status === 'PASS' ? 'devcheck-pass' : 'devcheck-fail');
  for (const m of merges) put(m, 'merge');
  return out;
}

// Jobs that hold a heavy slot (heavy.sh: test-file and other take none). A gate:fast counts once, as its outer run
// (gate-wide / gate-narrow); its steps log gate-* classes and hold none.
const SLOT = new Set([
  'test',
  'test-fast',
  'ui',
  'typecheck',
  'lint',
  'build',
  'dev',
  'gate-wide',
  'gate-narrow',
  'warm', // lanes start's cache warm (scripts/board/warm.sh)
]);

export type ConcRow = { bin: string; runs: number; failed: number; p50Sec: number | null };

// Test suites since `since`, binned by how many OTHER slot-class jobs overlapped them at any point. Interval
// overlap, not the event's `mix.heavy`: that's a snapshot at the job's end and counts the job itself.
export function failuresByConcurrency(jobs: Job[], since: number): ConcRow[] {
  const slot = jobs.filter((j) => SLOT.has(j.cls) && !j.excluded).sort((a, b) => a.start - b.start);
  const bins = [0, 1, 2, 3].map(() => ({ runs: 0, failed: 0, walls: [] as number[] }));
  for (const s of slot) {
    if (!isSuite(s) || s.t < since) continue;
    let k = 0;
    for (const o of slot) {
      if (o.start >= s.t) break;
      if (o !== s && o.t > s.start) k++;
    }
    const b = bins[Math.min(3, k)]!;
    b.runs++;
    if (failed(s)) b.failed++;
    b.walls.push(s.wallSec);
  }
  return bins.map((b, i) => ({
    bin: i === 0 ? 'alone' : i === 3 ? '3+ others' : `${i} other${i > 1 ? 's' : ''}`,
    runs: b.runs,
    failed: b.failed,
    p50Sec: b.walls.length
      ? b.walls.sort((x, y) => x - y)[Math.ceil(b.walls.length / 2) - 1]!
      : null,
  }));
}
