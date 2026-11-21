// The estimate ledger, <usage dir>/estimates.jsonl: one row per `pnpm usage estimate --lane`, and a void row per
// abandoned estimate. The actual is never recorded: it is the PR table's QU for the PR the row's cycle merged as
// (docs/ops/USAGE-METER.md → Ledger and score). Pure: the CLI reads the files and passes them in.
import { BRANCH_RE, STEP_PHASES, type LaneFile, type LaneProblem } from '../board/tower/lanes.ts';
import { errStat, inputsOf, predict, type Basis, type EstimateIn, type Units } from './estimate.ts';
import { newestPR, type PR, type Stale } from './gh.ts';
import { clock } from './report.ts';
import { POST_MS, type Attributed, type PRRow } from './prs.ts';

export const LEDGER = 'estimates.jsonl';

export interface EstRow {
  v: 1;
  lane: string;
  at: number; // epoch ms (ISO on disk)
  phase: string | null; // the lane file's phase when recorded: past plan is late
  inp: EstimateIn;
  qu: number;
  lo: number;
  hi: number;
  pct: number;
  pctLo: number;
  pctHi: number;
  basis: { regime: number; band: Basis; k: Basis; priors: 'file' | 'placeholders' };
}
export interface VoidRow {
  v: 1;
  lane: string;
  at: number;
  void: string;
}
export type LedgerRow = EstRow | VoidRow;
export const isVoid = (r: LedgerRow): r is VoidRow => 'void' in r;

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const BASES = ['fitted', 'prior'];

function parseRow(x: unknown): LedgerRow | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const r = x as Record<string, unknown>;
  const at = typeof r.at === 'string' ? Date.parse(r.at) : NaN;
  if (r.v !== 1 || typeof r.lane !== 'string' || !BRANCH_RE.test(r.lane) || !Number.isFinite(at))
    return null;
  if ('void' in r)
    return typeof r.void === 'string' && r.void ? { v: 1, lane: r.lane, at, void: r.void } : null;
  const i = r.inp as Record<string, unknown> | undefined;
  const b = r.basis as Record<string, unknown> | undefined;
  const nums = [r.qu, r.lo, r.hi, r.pct, r.pctLo, r.pctHi];
  if (!nums.every(num) || !(r.lo! <= r.qu! && r.qu! <= r.hi!)) return null;
  if (!i || !num(i.lines) || typeof i.ui !== 'boolean' || !num(i.fanout)) return null;
  if (!Array.isArray(i.lenses) || !i.lenses.every((l) => typeof l === 'string')) return null;
  if (!b || !num(b.regime) || !BASES.includes(b.band as string) || !BASES.includes(b.k as string))
    return null;
  if (b.priors !== 'file' && b.priors !== 'placeholders') return null;
  if (r.phase !== null && typeof r.phase !== 'string') return null;
  return {
    v: 1,
    lane: r.lane,
    at,
    phase: r.phase as string | null,
    inp: { lines: i.lines, ui: i.ui, lenses: i.lenses as string[], fanout: i.fanout },
    qu: r.qu as number,
    lo: r.lo as number,
    hi: r.hi as number,
    pct: r.pct as number,
    pctLo: r.pctLo as number,
    pctHi: r.pctHi as number,
    basis: {
      regime: b.regime,
      band: b.band as Basis,
      k: b.k as Basis,
      priors: b.priors,
    },
  };
}

// A torn or foreign line goes in `bad` (its 1-based line number), never fatal: two lanes can append at once.
export function parseLedger(text: string): { rows: LedgerRow[]; bad: number[] } {
  const rows: LedgerRow[] = [];
  const bad: number[] = [];
  for (const [n, l] of text.split('\n').entries()) {
    if (!l.trim()) continue;
    let r: LedgerRow | null = null;
    try {
      r = parseRow(JSON.parse(l));
    } catch {
      // torn
    }
    if (r) rows.push(r);
    else bad.push(n + 1);
  }
  return { rows: rows.sort((a, b) => a.at - b.at), bad };
}

export const formatRow = (r: LedgerRow) =>
  JSON.stringify({ ...r, at: new Date(r.at).toISOString() });

// A cycle on a branch runs from its previous merged PR to the next: the row belongs to the first PR merged after it.
// A row inside a PR's post window is the next cycle's (a reused name), never that PR's.
export function cycleOf(lane: string, at: number, prs: PR[]): { prev: PR | null; pr: PR | null } {
  const mine = prs.filter((p) => p.branch === lane).sort((a, b) => a.mergedAt - b.mergedAt);
  return {
    prev: mine.filter((p) => p.mergedAt <= at).at(-1) ?? null,
    pr: mine.find((p) => p.mergedAt > at) ?? null,
  };
}

export interface Entry {
  lane: string;
  prev: PR | null;
  pr: PR | null;
  row: EstRow | null; // the cycle's newest estimate
  voided: string | null; // the reason, when a void row is newer than every estimate
  reestimates: number;
}

// One entry per lane and cycle: the newest estimate wins, and a void row newer than it closes the cycle.
export function current(rows: LedgerRow[], prs: PR[]): Entry[] {
  const by = new Map<string, Entry>();
  for (const r of [...rows].sort((a, b) => a.at - b.at)) {
    const c = cycleOf(r.lane, r.at, prs);
    const key = `${r.lane}|${c.pr?.number ?? 'open'}`;
    const e = by.get(key) ?? { lane: r.lane, ...c, row: null, voided: null, reestimates: -1 };
    if (isVoid(r)) e.voided = r.void;
    else {
      e.row = r;
      e.voided = null;
      e.reestimates++;
    }
    by.set(key, e);
  }
  return [...by.values()].map((e) => ({ ...e, reestimates: Math.max(0, e.reestimates) }));
}

export type ScoreState = 'so-far' | 'provisional' | 'final' | 'no-calls' | 'void';
export interface ScoreRow {
  lane: string;
  at: number;
  late: boolean;
  reestimates: number;
  inp: EstimateIn;
  qu: number;
  lo: number;
  hi: number;
  pr: number | null;
  state: ScoreState;
  actual: number | null;
  ratio: number | null;
  inRange: boolean | null; // final only
  actualLines: number | null;
  actualUi: boolean | null;
  atActual: number | null; // the model now, at the merged PR's own lines, paths and lenses: input error apart
}

export const isLate = (r: EstRow) => r.phase !== null && r.phase !== 'plan';

// lastCall: the newest call in the cache. A last-on-branch PR's actual is final once its post window has passed and
// the cache has been scanned past it; before that it is provisional. A PR with a later one on its branch is final.
export function scoreRows(o: {
  entries: Entry[];
  rows: PRRow[];
  prs: PR[];
  calls: Attributed[];
  units: Units;
  lastCall: number | null;
}): ScoreRow[] {
  const out: ScoreRow[] = [];
  for (const e of o.entries) {
    if (!e.row) continue;
    const r = e.row;
    const base = {
      lane: e.lane,
      at: r.at,
      late: isLate(r),
      reestimates: e.reestimates,
      inp: r.inp,
      qu: r.qu,
      lo: r.lo,
      hi: r.hi,
      pr: e.pr?.number ?? null,
      actualLines: null,
      actualUi: null,
      atActual: null,
      inRange: null,
    };
    if (e.voided) {
      out.push({ ...base, state: 'void', actual: null, ratio: null });
      continue;
    }
    if (!e.pr) {
      const from = e.prev?.mergedAt ?? -Infinity;
      const actual = o.calls
        .filter((c) => c.role === 'lane' && c.lane === e.lane && c.ts > from)
        .reduce((s, c) => s + c.qu, 0);
      out.push({ ...base, state: 'so-far', actual, ratio: actual / r.qu });
      continue;
    }
    const pr = e.pr;
    const row = o.rows.find((x) => x.number === pr.number);
    if (!row || !(row.qu > 0)) {
      out.push({ ...base, state: 'no-calls', actual: null, ratio: null });
      continue;
    }
    // a later PR on the branch ends this one's window at its own merge; either way the scan must have reached it
    const later = o.prs.some((p) => p.branch === pr.branch && p.mergedAt > pr.mergedAt);
    const final = o.lastCall !== null && o.lastCall >= pr.mergedAt + (later ? 0 : POST_MS);
    out.push({
      ...base,
      state: final ? 'final' : 'provisional',
      actual: row.qu,
      ratio: row.qu / r.qu,
      inRange: final ? r.lo <= row.qu && row.qu <= r.hi : null,
      actualLines: row.lines,
      actualUi: row.ui,
      atActual: predict(o.units, inputsOf(row)).qu,
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

// The live score over final rows: the backtest's error stats, plus how many fell in their range.
export function scoreStat(rows: ScoreRow[]) {
  const fin = rows.filter((r) => r.state === 'final');
  return {
    ...errStat(
      fin.map((r) => r.actual!),
      fin.map((r) => r.qu),
    ),
    inRange: fin.filter((r) => r.inRange).length,
    late: fin.filter((r) => r.late).length,
    open: rows.filter((r) => r.state === 'so-far' || r.state === 'provisional').length,
  };
}

// Merged PRs since the first estimate whose cycle has none: a count in the score, never a gap (it can't be cleared).
export function unestimated(entries: Entry[], rows: LedgerRow[], prRows: PRRow[]): number[] {
  const first = rows.find((r) => !isVoid(r))?.at;
  if (first === undefined) return [];
  const have = new Set(entries.filter((e) => e.row && e.pr).map((e) => e.pr!.number));
  return prRows
    .filter((r) => r.mergedAt > first && r.turns > 0 && !have.has(r.number))
    .map((r) => r.number);
}

// The phases a lane has left Plan in; parked and blocked say nothing, merged and cleanup are past the point.
const PAST_PLAN = new Set<string>(STEP_PHASES.filter((p) => p !== 'plan'));
const when = (ms: number) => `${clock(ms)} PT`;

// The fixed step's check (`pnpm usage score --check`): ledger, lane files and the cached PR list only, never the
// transcript cache, so it can run on every queue write. One line per gap; [] when there are none.
//   (a) a lane file past plan (or in plan with its step plan written) with no estimate this cycle;
//   (b) an estimate with no lane file and no merged PR after it: the PR table is stale, or the lane was abandoned.
export function gaps(o: {
  rows: LedgerRow[];
  bad: number[];
  lanes: LaneFile[];
  problems: LaneProblem[];
  prs: { prs: PR[]; fetchedAt: number; stale?: Stale | null } | null;
}): string[] {
  const out: string[] = [];
  const prs = o.prs?.prs ?? [];
  if (o.bad.length)
    out.push(
      `${LEDGER}: unreadable row${o.bad.length === 1 ? '' : 's'} at line ${o.bad.join(', ')} → delete ${o.bad.length === 1 ? 'it' : 'them'} by hand (a torn append; the rest is read)`,
    );
  for (const p of o.problems) out.push(`lanes/${p.file}: unreadable (${p.problem}), not checked`);
  const entries = current(o.rows, prs);
  const estimated = (e: Entry | undefined) => !!e && !!e.row && !e.voided;
  for (const l of o.lanes) {
    const due = PAST_PLAN.has(l.phase) || (l.phase === 'plan' && l.plan !== null);
    if (!due) continue;
    // The lane's own cycle: its PR once that merged (the lane file trails the merge, and a refreshed table moves
    // the estimate into the merged cycle), else the open one. A reused name's new lane starts after the old merge.
    const merged = prs
      .filter(
        (p) =>
          p.branch === l.branch &&
          (p.number === l.pr || (l.phaseSince !== null && p.mergedAt >= l.phaseSince)),
      )
      .sort((a, b) => a.mergedAt - b.mergedAt)[0];
    const mine = entries.find(
      (e) => e.lane === l.branch && (merged ? e.pr?.number === merged.number : !e.pr),
    );
    if (!estimated(mine))
      out.push(
        `${l.branch}: no usage estimate (phase ${l.phase}) → pnpm usage estimate --lane ${l.branch} --lines <n> [--ui] --lenses <…>`,
      );
  }
  const live = new Set([
    ...o.lanes.map((l) => l.branch),
    ...o.problems.map((p) => p.file.replace(/\.json$/, '')),
  ]);
  const table = o.prs
    ? prTableBasis(prs, o.prs.fetchedAt, o.prs.stale ?? null)
    : 'no PR table (cache/prs.json missing or unreadable)';
  for (const e of entries) {
    if (!e.row || e.voided || e.pr || live.has(e.lane)) continue;
    out.push(
      `${e.lane}: estimated ${when(e.row.at)}, no lane file and no merged PR after it: the PR table is stale (${table}) → pnpm usage score --refresh; or abandoned → pnpm usage score --lane ${e.lane} --void "<why>"`,
    );
  }
  return out;
}

export type LiveScore = {
  rows: ScoreRow[];
  stat: ReturnType<typeof scoreStat>;
  unestimated: number[];
  bad: number[];
  recorded: number; // estimate rows in the ledger
  left: number; // estimate rows before `from`, whose PRs the caller's table doesn't reach
};

// The report's and `pnpm usage score`'s one computation: the ledger against the PR table and the lane calls.
export function liveScore(o: {
  ledger: { rows: LedgerRow[]; bad: number[] };
  prs: PR[];
  rows: PRRow[];
  calls: Attributed[];
  units: Units;
  lastCall: number | null;
  from?: number;
}): LiveScore {
  const from = o.from ?? -Infinity;
  const kept = o.ledger.rows.filter((r) => r.at >= from);
  const entries = current(kept, o.prs);
  const rows = scoreRows({ ...o, entries });
  const est = (rs: LedgerRow[]) => rs.filter((r) => !isVoid(r)).length;
  return {
    rows,
    stat: scoreStat(rows),
    unestimated: unestimated(entries, kept, o.rows),
    bad: o.ledger.bad,
    recorded: est(kept),
    left: est(o.ledger.rows) - est(kept),
  };
}

// The PR table's basis, for the score and the check: newest PR and its fetch time, or stale and why.
export function prTableBasis(prs: PR[], fetchedAt: number | null, stale: Stale | null): string {
  const n = newestPR(prs)?.number ?? 'none';
  if (stale)
    return `STALE: newest PR ${n}, fetched ${clock(stale.fetchedAt)} PT (gh: ${stale.why})`;
  return `newest PR ${n}${fetchedAt ? `, fetched ${clock(fetchedAt)} PT` : ''}`;
}
