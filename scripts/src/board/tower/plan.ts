// The plan table (docs/ops/TOWER.md → NEXT): dispatch's plan[] (queue.json) with what the tower works out live —
// which rows are finished, which slip behind a lane's ETA, where now falls, and when the maintainer is next asked.
// Pure: derive.ts feeds it the lanes and PRs.
import type { LaneEta, Range } from './lanes.ts';
import type { PlanItem } from './queue.ts';

export type PlanRow = PlanItem & {
  due: number | null; // when the row should be finished: its eta's end, else its time
  deltaMin: number | null; // a finished row's actual less its due, whole minutes (+ late, − early)
  slip: number | null; // the lane's ETA end, when it falls after the row's due: amber "now HH:MM"
  slipLo: number | null; // that ETA's start: the next ask's window
  overdue: boolean; // not finished, its due passed, and no lane ETA still ahead to say when instead
};
export type PlanPr = { state: string; mergedAt: number | null } | null;
export type Ask = {
  lo: number;
  hi: number;
  what: string;
  branch: string | null;
  source: 'lane' | 'plan';
  late: boolean;
};

const PAST_MS = 2 * 3600e3; // a row past due longer than this (and not slipping) drops off the glance

// A lane-less merge row names its PRs in its text ("Merges: PR 183, PR 184 …"): `PR <n>` only, and only when that is
// every number in it (clock times aside) — "tower 183, PR 184" may still wait on 183, so it names none.
export const namedPrs = (what: string) => {
  const prs = [...what.matchAll(/\bPR (\d+)\b/g)].map((m) => +m[1]!);
  const all = what.replace(/\b\d{1,2}:\d{2}\b/g, '').match(/\b\d+\b/g) ?? [];
  return all.length === prs.length ? prs : [];
};

// `prOf` gives a lane's PR (newest 40, or main's log); `etaOf` its lane file's ETAs; `mergedAt` when a PR number
// merged (gh or main's log), else null.
export function planTable(
  plan: PlanItem[],
  etaOf: (branch: string) => LaneEta | null,
  prOf: (branch: string) => PlanPr,
  now: number,
  mergedAt: (n: number) => number | null = () => null,
): { rows: PlanRow[]; nowIndex: number } {
  const rows = plan.map((p): PlanRow => {
    const pr = p.lane ? prOf(p.lane) : null;
    // a merge row whose lane's PR merged is finished then, whether or not dispatch has marked it; so is one once
    // every PR its text names has merged (the last merge is its actual). A lane's row may name the PR it lands on top
    // of, so it reads only its own "(PR n…)" (the first parenthesis opening with its PR), and only when nothing
    // places the lane's PR.
    let mergedTime = p.kind === 'merge' && pr?.state === 'MERGED' ? pr.mergedAt : null;
    if (p.kind === 'merge' && mergedTime === null && !(p.lane && pr)) {
      const own = /\(PR (\d+)[,)]/.exec(p.what);
      const at = (p.lane ? (own ? [+own[1]!] : []) : namedPrs(p.what)).map(mergedAt);
      if (at.length && at.every((t) => t !== null)) mergedTime = Math.max(...(at as number[]));
    }
    const merged = mergedTime !== null;
    const done = p.done || merged;
    const doneAt = p.doneAt ?? mergedTime;
    const due = p.eta?.to ?? p.at;
    let slip: number | null = null;
    let slipLo: number | null = null;
    // an open PR means the lane's part is done: what's left is the maintainer's, not a slip
    if (!done && p.lane && due !== null && pr?.state !== 'OPEN') {
      const e = etaOf(p.lane);
      const r: Range | null | undefined = p.kind === 'merge' ? e?.pr : (e?.next ?? e?.pr);
      if (r && r.hi > due) [slipLo, slip] = [r.lo, r.hi];
    }
    return {
      ...p,
      done,
      doneAt,
      due,
      deltaMin: doneAt !== null && due !== null ? Math.round((doneAt - due) / 60e3) : null,
      slip,
      slipLo,
      // a slip whose time has passed too (the lane went quiet) is late, not "now <a past time>"
      overdue: !done && due !== null && due < now && (slip === null || slip < now),
    };
  });
  // the now-line sits before the first row still ahead (rows are by time, the undated last)
  const k = rows.findIndex((r) => r.at === null || r.at > now);
  return { rows, nowIndex: k < 0 ? rows.length : k };
}

// The glance: the next few rows not yet finished, a late or slipping one first since it sits above the now-line.
export const planSoon = (rows: PlanRow[], now: number, n = 3) =>
  rows
    .filter((r) => !r.done && (r.due === null || r.due >= now - PAST_MS || r.slip !== null))
    .slice(0, n);

// When the maintainer is next asked for something: a lane's PR (its ETA, while it has no open PR), or dispatch's
// next maintainer or merge row (its slip if it has one). The earliest start wins, among those still ahead first: a
// late one (a lane gone quiet) would otherwise hide a real ask behind it until someone marks it done.
export function nextAsk(
  rows: PlanRow[],
  lanes: { branch: string; eta: LaneEta | null; prOpen: boolean }[],
  now: number,
): Ask | null {
  const asks: Ask[] = [];
  for (const l of lanes)
    if (l.eta?.pr && !l.prOpen)
      asks.push({
        ...l.eta.pr,
        what: `${l.branch} PR`,
        branch: l.branch,
        source: 'lane',
        late: l.eta.pr.hi < now,
      });
  for (const r of rows) {
    if (r.done || (r.kind !== 'maintainer' && r.kind !== 'merge') || r.due === null) continue;
    if (r.slip === null && r.due < now) continue; // passed and nothing says when: the overdue row says so
    const lo = r.slipLo ?? r.eta?.from ?? r.at ?? r.due;
    const hi = r.slip ?? r.due;
    asks.push({
      lo: Math.min(lo, hi),
      hi,
      what: r.what,
      branch: r.lane,
      source: 'plan',
      late: hi < now,
    });
  }
  return asks.sort((a, b) => Number(a.late) - Number(b.late) || a.lo - b.lo)[0] ?? null;
}
