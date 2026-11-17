// The tower's IO: reads the board's own files (never `board.sh status`, which scans /proc and peeks at
// GitHub on every call), keeps incremental tails, and assembles a TowerState. No terminal here.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { parseBench, type Bench } from './bench.ts';
import { clean, hhmm } from './fmt.ts';
import { compactJob, compactSample } from './history.ts';
import { DayFiles, parseLines, readNew, stamp, tail, type Tail } from './jsonl.ts';
import { foldRuns, type Run } from './ledger.ts';
import type { FeedItem, Gauges, Job, Lock, Point, Session, TowerState } from './model.ts';
import { PrCache } from './prs.ts';
import { parseQueue, type Queue, type QueueData } from './queue.ts';

export type Paths = {
  boardDir: string; // devlock.json, queue.json, history/
  limits: string; // scripts/board/limits.json
  ledger: string; // localNotes/devcheck/ledger.dev.jsonl
  ledgerB?: string; // slot B's, ledger.devb.jsonl (absent: slot A's runs only)
  bench: string; // localNotes/bench-vitest/
  cores?: number; // the CPU-guard's core count; default the host's (fixtures pin theirs)
};

const DAY = 86400000;
const JOB_DAYS = 7;

const readOr = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

// The last `n` bytes of a file (a log rewritten every few seconds needs only its end), or null.
function tailText(p: string, n = 4096): string | null {
  let fd: number;
  try {
    fd = openSync(p, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(n, size));
    return buf.subarray(0, readSync(fd, buf, 0, buf.length, size - buf.length)).toString('utf8'); // a shrink mid-read reads less
  } finally {
    closeSync(fd);
  }
}

// Re-reads a file only when its mtime/size/inode changed.
class Watched<T> {
  private key: string | null | undefined = undefined;
  value: T;
  private path: string;
  private parse: (text: string | null, prev: T) => T;
  private read: (p: string) => string | null;
  constructor(path: string, init: T, parse: (text: string | null, prev: T) => T, read = readOr) {
    this.path = path;
    this.value = init;
    this.parse = parse;
    this.read = read;
  }
  get(): T {
    const k = stamp(this.path);
    if (k !== this.key) {
      this.key = k;
      this.value = this.parse(k === null ? null : this.read(this.path), this.value);
    }
    return this.value;
  }
}

type Limits = {
  anonSoftFrac: number;
  anonHardFrac: number;
  pidsSoftFrac: number;
  pidsHardFrac: number;
  enforce: boolean;
};

function parseLimitsFile(text: string | null): Limits {
  const c = (() => {
    try {
      return JSON.parse(text ?? '{}') as { enforce?: boolean; container?: Record<string, number> };
    } catch {
      return {};
    }
  })();
  const k = c.container ?? {};
  return {
    anonSoftFrac: k.anonSoftFrac ?? 0.6,
    anonHardFrac: k.anonHardFrac ?? 0.8,
    pidsSoftFrac: k.pidsSoftFrac ?? 0.8,
    pidsHardFrac: k.pidsHardFrac ?? 0.92,
    enforce: c.enforce !== false,
  };
}

type LockSlot = 'dev' | 'devb';
type LockFile = {
  holder?: { branch?: string; sha?: string; expiresAt?: string } | null;
  t?: string;
  failedAt?: string | null;
  failedWhy?: string | null;
  unreadable?: boolean;
};

export class Source {
  readonly paths: Paths;
  readonly prs: PrCache | null;
  private samples: DayFiles;
  private events: DayFiles;
  private points: Point[] = [];
  private jobs: Job[] = [];
  private leaseFeed: FeedItem[] = [];
  private lastRaw: Record<string, unknown> | null = null;
  private ledgerTails: [Run['slot'], Tail][];
  private runs = new Map<string, Run>();
  private lockFiles: Record<LockSlot, Watched<LockFile | null>>;
  private limits: Watched<Limits>;
  private queue: Watched<Queue>;
  private benchTsv: Watched<string | null>;
  private benchLog: Watched<string | null>;
  private lockFeed: FeedItem[] = [];
  private lastHolder: Record<LockSlot, string | null | undefined> = {
    dev: undefined,
    devb: undefined,
  };
  private cores: number;

  constructor(paths: Paths, prs: PrCache | null) {
    this.paths = paths;
    this.prs = prs;
    this.cores = paths.cores ?? availableParallelism();
    const hist = join(paths.boardDir, 'history');
    this.samples = new DayFiles(hist, 'samples');
    this.events = new DayFiles(hist, 'events');
    // The ledger is mostly created/deleted rows (~2 MB): read it once, then only what's appended.
    this.ledgerTails = [['dev', tail(paths.ledger)]];
    if (paths.ledgerB) this.ledgerTails.push(['devb', tail(paths.ledgerB)]);
    const lockFile = (name: string) =>
      new Watched<LockFile | null>(join(paths.boardDir, name), null, (t) => {
        try {
          return t === null ? null : (JSON.parse(t) as LockFile);
        } catch {
          return { unreadable: true }; // present but not JSON: not the same as no cache
        }
      });
    // one cache per dev slot, both written by devlock.sh / the bot (docs/ops/SESSION-BOARD.md → Dev lock line)
    this.lockFiles = { dev: lockFile('devlock.json'), devb: lockFile('devlock.devb.json') };
    this.limits = new Watched(paths.limits, parseLimitsFile(null), parseLimitsFile);
    this.queue = new Watched<Queue>(
      join(paths.boardDir, 'queue.json'),
      { status: 'missing', data: null, problems: [] },
      (t, prev) => parseQueue(t, prev.data as QueueData | null),
    );
    this.benchTsv = new Watched(join(paths.bench, 'results.tsv'), null, (t) => t);
    this.benchLog = new Watched(join(paths.bench, 'bench.log'), null, (t) => t, tailText); // only its last line shows
  }

  refresh(now: number): TowerState {
    for (const raw of this.samples.read(now - DAY, now)) {
      const p = compactSample(raw, 2 * this.cores);
      if (!p) continue;
      this.points.push(p);
      this.lastRaw = raw as Record<string, unknown>;
    }
    this.points.sort((a, b) => a.t - b.t); // two day files can land out of order on the first read
    this.points = this.points.filter((p) => p.t >= now - DAY);

    for (const raw of this.events.read(now - JOB_DAYS * DAY, now)) {
      const j = compactJob(raw);
      if (j) this.jobs.push(j);
      else this.lease(raw as Record<string, unknown>);
    }
    this.jobs.sort((a, b) => a.t - b.t);
    this.jobs = this.jobs.filter((j) => j.t >= now - JOB_DAYS * DAY);
    this.leaseFeed = this.leaseFeed.filter((f) => f.t >= now - DAY);
    this.lockFeed = this.lockFeed.filter((f) => f.t >= now - DAY);

    for (const [slot, t] of this.ledgerTails) foldRuns(this.runs, parseLines(readNew(t)), slot);
    // full runs stay: the TTL proof counts them from queue.json's `since`, however old (a handful a day)
    for (const [id, r] of this.runs)
      if (!r.full && (r.end ?? r.start ?? now) < now - JOB_DAYS * DAY) this.runs.delete(id);

    const sessions = this.sessionsNow();
    const lock = this.lockNow('dev', sessions, now);
    const lockB = this.lockNow('devb', sessions, now);
    const tsv = this.benchTsv.get();
    let bench: Bench | null = null;
    if (tsv !== null) bench = parseBench(tsv, this.benchLog.get());

    return {
      now,
      gauges: this.gauges(),
      sessions,
      lock,
      lockB,
      points: this.points,
      jobs: this.jobs,
      runs: [...this.runs.values()].sort(
        (a, b) => (a.start ?? a.end ?? 0) - (b.start ?? b.end ?? 0),
      ),
      queue: this.queue.get(),
      prs: {
        list: this.prs?.list ?? [],
        at: this.prs?.at ?? null,
        error: this.prs?.error ?? null,
        forks: this.prs?.forks ?? 0,
      },
      bench,
      lockFeed: this.lockFeed,
      leaseFeed: this.leaseFeed,
    };
  }

  private lease(r: Record<string, unknown>) {
    if (r?.kind !== 'lease' || typeof r.t !== 'string') return;
    const t = Date.parse(r.t);
    if (Number.isNaN(t)) return;
    const s = (x: unknown) => (typeof x === 'string' ? clean(x) : '');
    const tone = r.action === 'gaveUp' || r.action === 'denied' ? 'bad' : 'warn';
    this.leaseFeed.push({
      t,
      kind: 'lease',
      text: `${s(r.lease)} ${s(r.action)}  ${s(r.name ?? r.holderName)} ${s(r.class ?? r.branch)}`.trim(),
      tone,
    });
  }

  private gauges(): Gauges | null {
    const r = this.lastRaw;
    const cg = r?.cg as Record<string, number> | undefined;
    if (!r || !cg) return null;
    const l = this.limits.get();
    const high = cg.highMiB ?? 18432;
    const pmax = cg.pidsMax ?? 4096;
    return {
      t: Date.parse(r.t as string),
      anonMiB: cg.anonMiB ?? 0,
      highMiB: high,
      anonSoft: high * l.anonSoftFrac,
      anonHard: high * l.anonHardFrac,
      pids: cg.pids ?? 0,
      pidsMax: pmax,
      pidsSoft: pmax * l.pidsSoftFrac,
      pidsHard: pmax * l.pidsHardFrac,
      // a bad tick (null, or over 2 × the cores: SESSION-BOARD.md → History) shows as unknown
      cpu: typeof cg.cpuCores === 'number' && cg.cpuCores <= 2 * this.cores ? cg.cpuCores : null,
      cores: this.cores,
      enforcing: l.enforce,
    };
  }

  private sessionsNow(): Session[] {
    const raw = this.lastRaw?.sessions;
    const str = (x: unknown) => (typeof x === 'string' && x ? clean(x) : null);
    return ((Array.isArray(raw) ? raw : []) as (Record<string, unknown> | null)[])
      .filter(
        (s): s is Record<string, unknown> => !!s && typeof s === 'object' && s.state !== 'gone',
      )
      .map((s) => ({
        name: str(s.name) ?? '?',
        branch: str(s.branch),
        state: str(s.state) ?? '?',
        thr: Number(s.thr) || 0,
        rssMiB: Number(s.rssMiB) || 0,
        heavy: str(s.heavy),
      }))
      .sort(
        (a, b) =>
          Number(b.state === 'working') - Number(a.state === 'working') ||
          a.name.localeCompare(b.name),
      );
  }

  private lockNow(slot: LockSlot, sessions: Session[], now: number): Lock | null {
    const f = this.lockFiles[slot].get();
    if (!f) return null;
    const branch = typeof f.holder?.branch === 'string' ? clean(f.holder.branch) : null;
    const exp = f.holder?.expiresAt ? Date.parse(f.holder.expiresAt) : NaN;
    const expiresAt = Number.isNaN(exp) ? null : exp; // unreadable → null: the web tower calls that lock unknown
    const lock: Lock = {
      branch,
      sha:
        typeof f.holder?.sha === 'string' && /^[0-9a-f]{40}$/.test(f.holder.sha)
          ? f.holder.sha
          : null,
      session: branch ? (sessions.find((s) => s.branch === branch)?.name ?? null) : null,
      expiresAt,
      asOf: f.t && Number.isFinite(Date.parse(f.t)) ? Date.parse(f.t) : null, // garbled → unknown, never fresh
      failed: !!f.failedAt,
      failedWhy: f.failedAt && typeof f.failedWhy === 'string' ? clean(f.failedWhy) : null,
      bad: f.unreadable
        ? 'lock cache unreadable'
        : f.holder && !branch
          ? 'holder unreadable'
          : null,
    };
    // The feed's lock lines: transitions seen by this tower, in memory only (a viewer writes no history).
    // Slot A's lines keep their `lock:` text; slot B's say `lock devb:`.
    const last = this.lastHolder[slot];
    if (last !== undefined && branch !== last) {
      const tag = slot === 'dev' ? 'lock:' : `lock ${slot}:`;
      const text = branch
        ? `${tag} ${branch}${lock.session ? ` (${lock.session})` : ''}${expiresAt ? ` until ${hhmm(expiresAt)}` : ''}`
        : `${tag} free (was ${last})`;
      this.lockFeed.push({ t: now, kind: 'lock', text, tone: branch ? 'warn' : 'good' });
      if (this.lockFeed.length > 50) this.lockFeed.shift();
    }
    this.lastHolder[slot] = branch;
    return lock;
  }
}

// Default paths: the main checkout's localNotes, like lib.sh's BOARD_DIR.
export function defaultPaths(repo: string): Paths {
  const board =
    process.env.APERTURE_BOARD_DIR ??
    (existsSync('/workspace/localNotes')
      ? '/workspace/localNotes/board'
      : join(repo, 'localNotes/board'));
  const notes = join(board, '..');
  return {
    boardDir: board,
    limits: join(repo, 'scripts/board/limits.json'),
    ledger: join(notes, 'devcheck/ledger.dev.jsonl'),
    ledgerB: join(notes, 'devcheck/ledger.devb.jsonl'),
    bench: join(notes, 'bench-vitest'),
  };
}
