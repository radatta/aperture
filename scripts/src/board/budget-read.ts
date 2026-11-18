// The budget's board-dir reads and its one write (docs/ops/SESSION-BOARD.md → Budget): the live slots, sessions and
// lanes, the last sample, k, and the `kind: "budget"` event append. Every read fails soft — a missing or torn file is
// "nothing there" — and the callers wrap the whole thing in a catch: the budget never changes a decision.
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  budgetLine,
  jobBudget,
  jobsNow,
  lanesNow,
  lastSample,
  parseBudget,
  powerFactor,
  type Budget,
  type BudgetSlot,
  type SampleLite,
} from './budget.ts';
import { parseStat } from './proc.ts';
import { readMacStats } from './tower/health.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- board files are checked field by field
const json = (p: string): any => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
const list = (dir: string) => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
};

// lib.sh sb_alive: a pid alive and, given a start tick, the same process (zombies and reused pids are not).
export function alive(procDir: string, pid: unknown, start: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  let s;
  try {
    s = parseStat(readFileSync(join(procDir, String(pid), 'stat'), 'utf8'));
  } catch {
    return false;
  }
  if (!s || s.state === 'Z' || s.state === 'X') return false;
  return typeof start !== 'string' || s.startTime === start; // as lane/state.ts alive: '' is a start that never matches
}

// The last `bytes` of a file, '' when unreadable: the samples file is ~3 MB a day, its last line is all we need.
export function readTail(p: string, bytes = 32768): string {
  let fd: number | undefined;
  try {
    fd = openSync(p, 'r');
    const size = fstatSync(fd).size;
    const n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10); // lib.sh sb_today: UTC

// Today's last sample, else yesterday's (the first tick after UTC midnight).
export function readLastSample(boardDir: string, now: number): SampleLite | null {
  const h = join(boardDir, 'history');
  return (
    lastSample(readTail(join(h, `samples-${day(now)}.jsonl`))) ??
    lastSample(readTail(join(h, `samples-${day(now - 86400_000)}.jsonl`)))
  );
}

export const readK = (boardDir: string, b: Budget, now: number) =>
  powerFactor(readMacStats(join(boardDir, 'mac-stats.json'), now), b.power);

export const appendBudgetEvent = (boardDir: string, e: object, now: number) => {
  mkdirSync(join(boardDir, 'history'), { recursive: true });
  appendFileSync(join(boardDir, 'history', `events-${day(now)}.jsonl`), JSON.stringify(e) + '\n');
};

// decide-heavy's side log: what the job budget would have said about this admission, next to what the live rules
// said (`actual`). input: decide-heavy's stdin; budget: {board, owner, label, cmd} from lease.sh, first decision only.
export function logJobBudget(
  input: {
    limits?: { budget?: unknown };
    slots?: { pid: number; class: string; cmd?: string | null }[];
    req?: { class: string; loadTest?: boolean };
    budget?: { board?: string; owner?: number; label?: string; cmd?: string };
  },
  decision: { verdict: string; wait: boolean },
  now: number,
): void {
  const b = parseBudget(input.limits?.budget);
  const lg = input.budget;
  if (!b || !lg?.board || !input.req) return;
  const owner = Number.isInteger(lg.owner) ? (lg.owner as number) : 0;
  const reg = json(join(lg.board, 'sessions', `${owner}.json`));
  const pf = readK(lg.board, b, now);
  const cmd = typeof lg.cmd === 'string' ? lg.cmd.slice(0, 160) : null;
  const jb = jobBudget(
    b,
    input.slots ?? [],
    readLastSample(lg.board, now),
    now,
    owner,
    { class: input.req.class, cmd },
    pf.k,
  );
  appendBudgetEvent(
    lg.board,
    {
      v: 1,
      t: new Date(now).toISOString().replace(/\.\d+Z$/, 'Z'),
      kind: 'budget',
      scope: 'job',
      pid: owner,
      name: typeof reg?.name === 'string' ? reg.name : null,
      branch: typeof reg?.branch === 'string' && reg.branch ? reg.branch : null,
      class: input.req.class,
      label: lg.label ?? null,
      cmd,
      ...jb,
      k: pf.k,
      kWhy: pf.why,
      actual: { verdict: decision.verdict, wait: decision.wait },
      enforce: b.enforce,
      loadTest: !!input.req.loadTest,
    },
    now,
  );
}

// Live heavy slots, as lease.sh counts them (a dead or zombie wrapper's slot is no job).
export function liveSlots(boardDir: string, procDir: string): BudgetSlot[] {
  const dir = join(boardDir, 'leases', 'heavy');
  return list(dir).flatMap((f) => {
    const s = json(join(dir, f));
    if (!s || !alive(procDir, s.wrapperPid, s.wrapperStart)) return [];
    return [{ pid: s.pid, class: String(s.class), cmd: typeof s.cmd === 'string' ? s.cmd : null }];
  });
}

// Live registered sessions (sessions/<pid>.json, alive with the same start tick, not gone): the hub counts too.
export function liveSessions(boardDir: string, procDir: string) {
  const dir = join(boardDir, 'sessions');
  const out: { pid: number; branch: string | null }[] = [];
  for (const f of list(dir)) {
    const s = json(join(dir, f));
    if (s && s.state !== 'gone' && alive(procDir, s.pid, s.pidStart))
      out.push({ pid: s.pid, branch: typeof s.branch === 'string' && s.branch ? s.branch : null });
  }
  return out;
}

// The board's view of active lanes: a lane file not parked whose branch has a live session or a lifecycle record. A
// lane with no lane file yet isn't counted here (`pnpm lanes status`, from the worktrees, counts it as build), and
// `lanes status` also checks the worktree: it is the one `lanes start` logs (docs/ops/LANES.md).
export function boardLanes(boardDir: string, liveBranches: Set<string>) {
  const dir = join(boardDir, 'lanes');
  return list(dir).flatMap((f) => {
    const l = json(join(dir, f));
    if (!l || typeof l.branch !== 'string' || l.phase === 'parked') return [];
    const rec = json(join(boardDir, 'lifecycle', `${l.branch}.json`)) !== null;
    if (!liveBranches.has(l.branch) && !rec) return [];
    return [
      {
        branch: l.branch as string,
        phase: typeof l.phase === 'string' ? (l.phase as string) : null,
      },
    ];
  });
}

// `cli.ts budget`: the units committed now, for board.sh status. null when limits.json has no usable budget block.
export function budgetNow(boardDir: string, limitsRaw: unknown, procDir: string, now: number) {
  const b = parseBudget((limitsRaw as { budget?: unknown } | null)?.budget);
  if (!b) return null;
  const pf = readK(boardDir, b, now);
  const sessions = liveSessions(boardDir, procDir);
  const lanes = boardLanes(
    boardDir,
    new Set(sessions.flatMap((s) => (s.branch ? [s.branch] : []))),
  );
  const jobs = jobsNow(b, liveSlots(boardDir, procDir), readLastSample(boardDir, now), now);
  const l = lanesNow(b, lanes);
  return {
    jobs,
    lanes: l,
    laneList: lanes,
    sessions: sessions.length,
    k: pf.k,
    kWhy: pf.why,
    jobsAllowed: Math.round((b.jobUnits / pf.k) * 100) / 100,
    lanesAllowed: Math.round((b.laneUnits / pf.k) * 100) / 100,
    sessionsMax: b.sessionsMax,
    line: budgetLine(b, { jobs, lanes: l, sessions: sessions.length }, pf),
  };
}
