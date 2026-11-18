// Board freshness (docs/ops/TOWER.md → Board freshness): where dispatch's hand-written queue.json says something the
// tower's derived facts contradict. The page shows the derived fact; each contradiction is one item here, telling
// dispatch what to fix. queue.json is never written. A fact that can change back (an open PR, a lock) counts only
// while its source is fresh; a merge is final, so it always counts.
import { refFiredAt, type Lane, type Merged, type QueueData } from './queue.ts';
import type { LaneFile } from './lanes.ts';
import type { PlanRow } from './plan.ts';
import type { CtxView } from './ctx.ts';
import type { Pr } from './prs.ts';

export type StaleKind =
  | 'queue-merged'
  | 'queue-state'
  | 'queue-pr'
  | 'waiting-on'
  | 'plan-done'
  | 'plan-age'
  | 'merge-order'
  | 'wave'
  | 'auto-start'
  | 'orphan-lane'
  | 'followup'
  | 'queue-bad';
export type StaleItem = {
  kind: StaleKind;
  what: string;
  fix: string;
  branch: string | null;
  since: number | null; // when the derived fact became true, when known
};
export type BoardTone = 'dim' | 'warn' | 'bad';
export type Board = {
  updatedAt: number | null; // queue.json's own updatedAt: "board updated N min ago"
  items: StaleItem[];
  unsure: string | null; // gh or the locks can't tell: the count may be short
  tone: BoardTone;
  why: string | null; // what made it red
};

// The main-sync loop's heartbeat (sync.sh → main-sync.json): one round every 2 min.
export type MainSync = { at: number; ok: boolean; msg: string };
export const SYNC_SILENT_MS = 5 * 60e3;
export function parseMainSync(text: string | null): MainSync | null {
  if (text === null) return null;
  try {
    const j = JSON.parse(text) as { t?: unknown; ok?: unknown; msg?: unknown };
    const at = typeof j.t === 'string' ? Date.parse(j.t) : NaN;
    if (Number.isNaN(at) || typeof j.ok !== 'boolean') return null;
    return { at, ok: j.ok, msg: typeof j.msg === 'string' ? j.msg : '' };
  } catch {
    return null;
  }
}
// Red on the chip: the loop failed its last round, or went silent. Missing (never started) isn't: SOURCES says it.
export const syncBad = (s: MainSync | null, now: number, hm: (t: number) => string) =>
  !s
    ? null
    : !s.ok
      ? `main sync failed: ${s.msg || 'no message'}`
      : now - s.at > SYNC_SILENT_MS
        ? `main sync silent since ${hm(s.at)}`
        : null;

export const PLAN_STALE_MS = 6 * 3600e3; // pq-check's rule: plan[], mergeOrder, maintainer[] rewritten together
export const ORPHAN_MS = 24 * 3600e3; // a lane file this long past its merge was never ended
export const ITEM_RED_MS = 30 * 60e3;
export const RED_COUNT = 5;

const FINISHED = ['MERGED', 'DEPLOYING', 'DONE', 'DEPLOY FAILED'];

export type StaleInputs = {
  now: number;
  queue: QueueData | null;
  problems: string[];
  rows: Map<string, { state: string; pr: { number: number } | null }>; // derived lane rows
  prs: Pr[]; // gh's list plus main's log stand-ins
  mergedAt: (n: number) => number | null;
  lanes: LaneFile[];
  liveHolder: (branch: string) => 'dev' | 'devb' | null; // a fresh live lock's slot
  ghOk: boolean;
  locksOk: boolean;
  table: PlanRow[];
  staleFollowups: { id: string; what: string; since: number | null }[];
};

export function staleItems(s: StaleInputs): StaleItem[] {
  const q = s.queue;
  const out: StaleItem[] = [];
  const add = (it: StaleItem) => out.push(it);
  const mergedPr = (branch: string) =>
    s.prs
      .filter((p) => p.branch === branch && p.state === 'MERGED')
      .sort((a, b) => (b.mergedAt ?? 0) - (a.mergedAt ?? 0))[0] ?? null;
  const openPr = (branch: string) =>
    s.prs.find((p) => p.branch === branch && p.state === 'OPEN') ?? null;
  const merged: Merged[] = s.prs.flatMap((p) =>
    p.state === 'MERGED' && p.mergedAt !== null
      ? [{ branch: p.branch, number: p.number, mergedAt: p.mergedAt }]
      : [],
  );

  for (const l of q?.devQueue ?? []) {
    const row = s.rows.get(l.branch);
    if (row && FINISHED.includes(row.state)) {
      const pr = row.pr ? s.mergedAt(row.pr.number) : null;
      add({
        kind: 'queue-merged',
        what: `${l.branch} merged${row.pr ? ` (PR ${row.pr.number})` : ''}; still in devQueue as ${l.state}`,
        fix: `drop ${l.branch} from devQueue`,
        branch: l.branch,
        since: pr ?? mergedPr(l.branch)?.mergedAt ?? null,
      });
      continue;
    }
    laneState(l, s, openPr(l.branch), add);
    if (l.waitingOn) {
      // a merge reference only (`<branch> merges`, `PR <n>`): a date is dispatch's own schedule
      const at = refFiredAt(l.waitingOn, merged);
      if (at !== null && at <= s.now)
        add({
          kind: 'waiting-on',
          what: `${l.branch} waits on "${l.waitingOn}", which has merged`,
          fix: `update ${l.branch}'s waitingOn`,
          branch: l.branch,
          since: at,
        });
    }
  }

  // planTable keeps plan[]'s order, so row k is plan[k]
  s.table.forEach((r, k) => {
    const hand = q?.plan[k];
    if (r.done && hand && !hand.done)
      add({
        kind: 'plan-done',
        what: `plan row "${r.what}" has happened`,
        fix: 'mark it done',
        branch: r.lane,
        since: r.doneAt,
      });
  });
  if (q && q.plan.some((p) => !p.done)) {
    const at = q.planAt;
    if (at === null || s.now - at > PLAN_STALE_MS)
      add({
        kind: 'plan-age',
        what: at === null ? 'plan has no planAt' : 'plan not rewritten in over 6 h',
        fix: 'rewrite plan[], mergeOrder, maintainer[] and planAt',
        branch: null,
        since: at === null ? null : at + PLAN_STALE_MS,
      });
  }

  for (const o of q?.mergeOrder ?? []) {
    const p = o.pr !== null ? s.prs.find((x) => x.number === o.pr) : mergedPr(o.branch);
    if (p?.state === 'MERGED')
      add({
        kind: 'merge-order',
        what: `${o.branch} landed (PR ${p.number}); still in mergeOrder`,
        fix: `drop ${o.branch} from mergeOrder`,
        branch: o.branch,
        since: p.mergedAt,
      });
  }

  for (const w of q?.wave?.items ?? []) {
    const at = w.pr !== null ? s.mergedAt(w.pr) : null;
    if (w.state !== 'merged' && at !== null)
      add({
        kind: 'wave',
        what: `wave item ${w.branch} merged (PR ${w.pr}); marked ${w.state}`,
        fix: `mark ${w.branch} merged`,
        branch: w.branch,
        since: at,
      });
  }

  for (const b of q?.autoStart ?? []) {
    const started = s.lanes.some((l) => l.branch === b) || (s.ghOk && openPr(b));
    if (started)
      add({
        kind: 'auto-start',
        what: `${b} has started; still in autoStart`,
        fix: `drop ${b} from autoStart`,
        branch: b,
        since: s.lanes.find((l) => l.branch === b)?.phaseSince ?? null,
      });
  }

  for (const l of s.lanes) {
    const p = l.pr !== null ? s.prs.find((x) => x.number === l.pr) : mergedPr(l.branch);
    if (
      p?.state === 'MERGED' &&
      p.mergedAt !== null &&
      s.now - p.mergedAt > ORPHAN_MS &&
      !openPr(l.branch)
    )
      if (
        (l.phaseSince ?? l.updatedAt) <= p.mergedAt ||
        l.phase === 'merged' ||
        l.phase === 'cleanup'
      )
        add({
          kind: 'orphan-lane',
          what: `lane file ${l.branch} is over a day past its merge (PR ${p.number})`,
          fix: `pnpm lanes end ${l.branch}`,
          branch: l.branch,
          since: p.mergedAt + ORPHAN_MS,
        });
  }

  for (const f of s.staleFollowups)
    add({
      kind: 'followup',
      what: `${f.id}: ${f.what}`,
      fix: 'act on it, or give it a real trigger',
      branch: null,
      since: f.since,
    });

  if (s.problems.length)
    add({
      kind: 'queue-bad',
      what: `queue.json: ${s.problems[0]}${s.problems.length > 1 ? ` (+${s.problems.length - 1} more)` : ''}`,
      fix: 'fix the write (pq-check.ts)',
      branch: null,
      since: null,
    });
  return out;
}

// A queue state the derived lane contradicts: lock facts only from a fresh read, PR facts only from a fresh list.
function laneState(l: Lane, s: StaleInputs, open: Pr | null, add: (it: StaleItem) => void) {
  const item = (what: string, since: number | null = null) =>
    add({
      kind: 'queue-state',
      what: `${l.branch}: ${what}`,
      fix: `update ${l.branch}'s state`,
      branch: l.branch,
      since,
    });
  if (s.locksOk) {
    const slot = s.liveHolder(l.branch);
    if (l.state === 'on-dev' && !slot) item('queue says on-dev; no slot holds it');
    if (l.state !== 'on-dev' && slot) item(`queue says ${l.state}; it holds ${slot}`);
  }
  if (!s.ghOk) return;
  if (open && !open.draft && ['waiting', 'next', 'building'].includes(l.state))
    item(`queue says ${l.state}; PR ${open.number} is open`, open.createdAt);
  if (!open && (l.state === 'pr-open' || l.state === 'ready'))
    item(`queue says ${l.state}; no open PR`);
  if (open && l.pr !== null && l.pr !== open.number)
    add({
      kind: 'queue-pr',
      what: `${l.branch}: queue names PR ${l.pr}; its open PR is ${open.number}`,
      fix: `set ${l.branch}'s pr to ${open.number}`,
      branch: l.branch,
      since: open.createdAt,
    });
}

// One tone for the age and the count: red when a fact has sat wrong 30 min, there are 5, or the sync failed. A STALE
// follow-up is a judgment backlog, not a wrong fact: amber at most (else two old ones would hold it red for days).
export function boardTone(
  items: StaleItem[],
  unsure: string | null,
  now: number,
  syncBad: string | null = null,
): { tone: BoardTone; why: string | null } {
  if (syncBad) return { tone: 'bad', why: syncBad };
  const facts = items.filter((it) => it.kind !== 'followup');
  if (facts.length >= RED_COUNT) return { tone: 'bad', why: `${facts.length} stale items` };
  const old = facts.find((it) => it.since !== null && now - it.since > ITEM_RED_MS);
  if (old) return { tone: 'bad', why: `stale over 30 min: ${old.what}` };
  if (items.length || unsure) return { tone: 'warn', why: null };
  return { tone: 'dim', why: null };
}

// The tower's derived files in the board dir, written on its tick (web/main.ts), read by the status line
// (statusline-board.sh: builtins only) and `pnpm board stale`. board.line:
//   <writtenEpoch> <boardEpoch|-> <count>[?] <tone>
//   merge <atEpoch> <HH:MM> <what>    the next merge row not done (derived), due no more than 2 h ago; absent when none
//   usage <atEpoch> <text>            `pnpm usage line`'s last good answer; absent when none
//   ctx <n≥40> <n≥50> <names≥50,…>     sessions over the context lines (ctx.ts); absent when none is, or ctx.json is stale
export const NEXT_MERGE_PAST_MS = 2 * 3600e3; // next-merge.sh's window
export type UsageLine = { at: number; text: string };
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
export function boardLine(
  b: Board,
  table: PlanRow[],
  now: number,
  hhmm: (t: number) => string,
  usage: UsageLine | null = null,
  ctx: CtxView | null = null,
): string {
  const sec = (t: number) => Math.floor(t / 1000);
  const head = `${sec(now)} ${b.updatedAt === null ? '-' : sec(b.updatedAt)} ${b.items.length}${b.unsure ? '?' : ''} ${b.tone}`;
  const next = table
    .filter(
      (r) => r.kind === 'merge' && !r.done && r.at !== null && r.at >= now - NEXT_MERGE_PAST_MS,
    )
    .sort((x, y) => x.at! - y.at!)[0];
  // one line each: the status line reads it with `read`, so no tab or newline may survive
  return [
    head,
    next ? `merge ${sec(next.at!)} ${hhmm(next.at!)} ${oneLine(next.what)}` : null,
    usage ? `usage ${sec(usage.at)} ${oneLine(usage.text)}` : null,
    ctx && ctx.warn.length + ctx.bad.length
      ? `ctx ${ctx.warn.length + ctx.bad.length} ${ctx.bad.length} ${ctx.bad.map((e) => e.name).join(',') || '-'}`
      : null,
  ]
    .filter((l) => l !== null)
    .map((l) => `${l}\n`)
    .join('');
}

export type StaleFile = { v: 1; t: number } & Board;
export const staleFile = (b: Board, now: number): StaleFile => ({ v: 1, t: now, ...b });

// `pnpm board stale`: the tower's last stale.json, with its age, for dispatch and pq-check.
export function formatStale(text: string | null, now: number): string {
  if (text === null) return 'no stale.json: is the web tower running? (board.sh tower start)';
  let f: StaleFile;
  try {
    f = JSON.parse(text) as StaleFile;
  } catch {
    return 'stale.json unreadable';
  }
  const min = (t: number) => `${Math.max(0, Math.round((now - t) / 60e3))} min`;
  const lines = [
    `board updated ${f.updatedAt === null ? '?' : `${min(f.updatedAt)} ago`} · ${f.items.length}${f.unsure ? '?' : ''} stale · ${f.tone}${f.why ? ` (${f.why})` : ''} · read ${min(f.t)} ago`,
  ];
  if (f.unsure) lines.push(`  can't tell all: ${f.unsure}`);
  for (const it of f.items) lines.push(`  ${it.kind}: ${it.what} → ${it.fix}`);
  return lines.join('\n');
}
