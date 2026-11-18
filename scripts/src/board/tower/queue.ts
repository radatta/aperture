// queue.json: the hub's hand-kept dev queue, the maintainer's to-dos and the wave checklist (schema v1:
// docs/ops/SESSION-BOARD.md → Control tower). Never throws: a bad file renders as its problems.
import { findIdentifiers } from '../../identifiers.ts';
import { clean, parseTime } from './fmt.ts';

// pr-open: the lane opened its PR and checks aren't green yet (between building and ready)
export const LANE_STATES = [
  'on-dev',
  'next',
  'waiting',
  'building',
  'pr-open',
  'ready',
  'needs-you',
] as const;
export const WAVE_STATES = ['merged', 'open', 'in-flight', 'not-started'] as const;
export type LaneState = (typeof LANE_STATES)[number];
export type WaveState = (typeof WAVE_STATES)[number];
// the dev slot a lane is on (CI-BOT.md → Dev slots): optional, `dev` when absent
export const LANE_SLOTS = ['dev', 'devb'] as const;
export type LaneSlot = (typeof LANE_SLOTS)[number];
export const PLAN_KINDS = ['dev', 'merge', 'maintainer', 'ci'] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];

export type Lane = {
  branch: string;
  session: string | null;
  state: LaneState;
  slot: LaneSlot;
  pr: number | null;
  eta: number | null;
  waitingOn: string | null;
  note: string | null;
  hold: string | null; // dispatch's merge hold reason (the web tower's HOLD(<reason>))
};
export type Todo = { text: string; since: string | null };
export type WaveItem = {
  branch: string;
  state: WaveState;
  pr: number | null;
  session: string | null;
  title: string | null;
};

// dispatch's timeline: the one source for "next merge" (the tower's PLAN panel and the statusline). Optional, for the
// plan table (TOWER.md → NEXT expanded): `you` the maintainer's cost, `eta` the window the row finishes in, `lane` the
// lane whose ETA it waits on, `done` finished (an ISO time is when: the actual).
export const ETA_SOURCES = ['measured', 'guess'] as const;
export type EtaSource = (typeof ETA_SOURCES)[number];
export type PlanItem = {
  at: number | null;
  what: string;
  kind: PlanKind;
  who: string | null;
  you: string | null;
  eta: { from: number; to: number; source: EtaSource } | null;
  lane: string | null;
  done: boolean;
  doneAt: number | null;
};

// dispatch's follow-up ledger (docs/ops/HUB.md → The hub's duties): the web tower's SLIPPING panel reads it.
export const FOLLOWUP_STATUS = ['open', 'tracked', 'done', 'dropped'] as const;
export const FOLLOWUP_OWNERS = ['maintainer', 'lane', 'dispatch'] as const;
export type Followup = {
  id: string;
  what: string;
  owner: string;
  after: string;
  status: string;
  source: string | null;
  since: number | null;
  sinceDay?: string | null; // `since` was a bare date (MM-DD): the page shows the day, not a timer
};

// A `since` the hub writes as a bare date (2026-11-13) means some time that local day: read as its end, so an age
// is never overstated (as UTC midnight it read a follow-up raised that evening as 32 h old). Anything else is an
// ISO time.
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
// A local time from its parts, or null when they aren't a real one (2026-02-31 and 13-40 don't roll over).
function local(y: number, mo: number, d: number, h = 0, mi = 0): number | null {
  const t = new Date(y, mo - 1, d, h, mi);
  return t.getFullYear() === y && t.getMonth() === mo - 1 && t.getDate() === d && h < 24 && mi < 60
    ? t.getTime()
    : null;
}
export function sinceTime(x: unknown): { at: number | null; day: string | null } {
  const m = typeof x === 'string' ? DAY.exec(x) : null;
  if (!m) return { at: parseTime(x), day: null };
  const start = local(+m[1]!, +m[2]!, +m[3]!);
  if (start === null) return { at: null, day: null };
  return { at: new Date(+m[1]!, +m[2]! - 1, +m[3]! + 1).getTime() - 1, day: `${m[2]}-${m[3]}` };
}

// STALE: open, due now (`after: "now"`), and older than 24 h. One definition; localNotes/board/pq-check.ts imports it.
export const STALE_MS = 24 * 3600e3;
export const staleFollowups = (fu: Followup[], now: number) =>
  fu.filter(
    (f) => f.status === 'open' && f.after === 'now' && f.since !== null && now - f.since > STALE_MS,
  );

const QUEUE_KEYS = [
  'v',
  'updatedAt',
  'devQueue',
  'maintainer',
  'wave',
  'proofs',
  'plan',
  'followups',
  'mergeOrder',
  'planNotes',
  'planAt',
];

// An open follow-up whose `after` has happened: a merged branch or PR (`<branch>`, `<branch> merge(s)`, `PR <n>`,
// optionally `+ N day(s)|week(s)` and a trailing `(…)`), or a real date that has begun (`2026-11-20 …`, at its
// `~HH:MM` when it gives one; `Sat 11-14 …`, zero-padded, the nearest such date: one over half a year back is next
// year's). Exact shapes only: free text (`wave 4`, `1-2 days after …`) never fires. → when it fired.
const AFTER_REF =
  /^(?:PR (\d+)|([a-z0-9][a-z0-9-]*))(?: merges?)?(?: \+ (\d+) (day|week)s?)?(?: \(.*\))?$/;
const AFTER_ISO = /^(\d{4})-(\d{2})-(\d{2})(?:(?:T| ~?)(\d{1,2}):(\d{2}))?(?=$|[ (~])/;
const AFTER_MD = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]* )?(\d{2})-(\d{2})(?=$|[ (])/;
export type Merged = { branch: string; number: number; mergedAt: number };
export function firedAt(after: string, merged: Merged[], now: number): number | null {
  const iso = planAt(after.split(/[ (]/)[0]); // a whole ISO date-time (`2026-11-20T09:00Z`), as the plan takes it
  if (iso !== null) return iso;
  let m = AFTER_ISO.exec(after);
  if (m) return local(+m[1]!, +m[2]!, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0));
  m = AFTER_MD.exec(after);
  if (m) {
    const y = new Date(now).getFullYear();
    const at = local(y, +m[1]!, +m[2]!);
    if (at === null) return null;
    const half = 183 * 86400e3; // the nearest such date: over half a year off is the next or the last year's
    return now - at > half
      ? local(y + 1, +m[1]!, +m[2]!)
      : at - now > half
        ? local(y - 1, +m[1]!, +m[2]!)
        : at;
  }
  return refFiredAt(after, merged);
}
// The merge half alone (`<branch> merges`, `PR <n>`, `+ N days`): what a devQueue `waitingOn` can name (stale.ts).
// `branchSince`: a branch reference counts only a merge at or after it (a reused name: mergelog.ts REUSE_MS); a PR
// number is exact.
export function refFiredAt(
  after: string,
  merged: Merged[],
  branchSince = -Infinity,
): number | null {
  const r = AFTER_REF.exec(after);
  const pr =
    r &&
    merged.find((p) =>
      r[1] ? p.number === +r[1] : p.branch === r[2] && p.mergedAt >= branchSince,
    );
  if (!r || !pr) return null;
  return pr.mergedAt + (r[3] ? +r[3] * (r[4] === 'week' ? 7 : 1) * 86400e3 : 0);
}
export const firedFollowups = (fu: Followup[], merged: Merged[], now: number) =>
  fu.flatMap((f) => {
    if (f.status !== 'open' || f.after === 'now') return [];
    const at = firedAt(f.after, merged, now);
    return at !== null && at <= now ? [{ ...f, firedAt: at }] : [];
  });

// dispatch's landing order for the lanes in flight (NEXT): file order is the order.
export type MergeOrderItem = { branch: string; pr: number | null; note: string | null };

export type QueueData = {
  updatedAt: number;
  devQueue: Lane[];
  maintainer: Todo[];
  wave: { name: string; items: WaveItem[] } | null;
  deadRows: { since: number; target: number; excludedRuns: string[] } | null;
  plan: PlanItem[]; // by `at`, the `at`-less last in file order
  planNotes: string[]; // dispatch's notes on the plan as a whole: what slips, what moved and why
  planAt: number | null; // when dispatch last rewrote the plan
  followups: Followup[];
  mergeOrder: MergeOrderItem[];
  autoStart?: string[]; // dispatch's auto-start queue, branches only (its shape is pq-check's); read leniently
};

// A plan time: a whole ISO date-time to the second, a real calendar date, an optional Z / offset. The
// statusline's `date -d` reads anything looser differently (a bare 22:40, " PST", 11-31 rolled to 12-01).
const PLAN_AT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:Z|[+-]\d{2}:?\d{2})?$/;
export function planAt(x: unknown): number | null {
  const m = typeof x === 'string' ? PLAN_AT.exec(x) : null;
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map((v) => Number(v ?? 0)) as number[];
  const days = new Date(Date.UTC(y!, mo!, 0)).getUTCDate(); // day 0 of the next month
  if (mo! < 1 || mo! > 12 || d! < 1 || d! > days || h! > 23 || mi! > 59 || se! > 59) return null;
  return parseTime(x);
}

// `data` is the last good parse (kept through a bad write); `problems` say what's wrong with the current file.
export type Queue = {
  status: 'ok' | 'missing' | 'bad';
  data: QueueData | null;
  problems: string[];
  // devQueue lanes this write couldn't read, so their `hold` is unknown ('all': the file, or an entry with no branch)
  unread?: 'all' | string[];
};

const str = (x: unknown) => (typeof x === 'string' && x.length > 0 ? clean(x) : null);
const LANE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/; // lanes.ts BRANCH_RE, kept local: this file's imports stay minimal
const int = (x: unknown) => (Number.isInteger(x) ? (x as number) : null);
const arr = (x: unknown) => (Array.isArray(x) ? (x as unknown[]) : []);

// Problems quote the file (a JSON.parse message carries its raw bytes): cleaned like the rest.
export function parseQueue(text: string | null, prev: QueueData | null = null): Queue {
  const q = parse(text, prev);
  return { ...q, problems: q.problems.map(clean) };
}

function parse(text: string | null, prev: QueueData | null): Queue {
  if (text === null) return { status: 'missing', data: null, problems: [] };
  const problems: string[] = [];
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    return {
      status: 'bad',
      data: prev,
      unread: 'all',
      problems: [`not JSON: ${(e as Error).message}`],
    };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { status: 'bad', data: prev, unread: 'all', problems: ['not an object'] };
  if (raw.v !== 1)
    return {
      status: 'bad',
      data: prev,
      unread: 'all',
      problems: [`v is ${JSON.stringify(raw.v)}, want 1`],
    };
  const updatedAt = parseTime(raw.updatedAt);
  if (updatedAt === null)
    return { status: 'bad', data: prev, unread: 'all', problems: ['updatedAt is not an ISO time'] };

  // The per-person to-dos were renamed to `maintainer`: a file still on the old key (the maintainer's name, which
  // the identifier rules know without this file spelling it) would drop them from NEEDS YOU without a word. Any
  // other extra key passes.
  for (const k of Object.keys(raw))
    if (!QUEUE_KEYS.includes(k) && findIdentifiers(k).some((h) => h.kind === 'name'))
      problems.push(
        `the to-dos sit under an old key — rename it to "maintainer" (docs/ops/TOWER.md)`,
      );

  const devQueue: Lane[] = [];
  let unread: 'all' | string[] = [];
  const drop = (b: string | null, why: string) => {
    problems.push(why);
    if (unread !== 'all') unread = b ? [...unread, b] : 'all';
  };
  if (raw.devQueue !== undefined && !Array.isArray(raw.devQueue))
    drop(null, 'devQueue is not an array');
  arr(raw.devQueue).forEach((x, i) => {
    const l = x as Record<string, unknown>;
    const branch = str(l?.branch);
    const state = l?.state as LaneState;
    if (!branch) return drop(null, `devQueue[${i}]: no branch`);
    if (!LANE_STATES.includes(state))
      return drop(branch, `devQueue[${i}]: state ${JSON.stringify(l.state)}`);
    const slot = (l.slot ?? 'dev') as LaneSlot;
    if (!LANE_SLOTS.includes(slot))
      return drop(branch, `devQueue[${i}]: slot ${JSON.stringify(l.slot)}`);
    devQueue.push({
      branch,
      session: str(l.session),
      state,
      slot,
      pr: int(l.pr),
      eta: parseTime(l.eta),
      waitingOn: str(l.waitingOn),
      note: str(l.note),
      hold: str(l.hold),
    });
  });

  const maintainer: Todo[] = [];
  arr(raw.maintainer).forEach((x, i) => {
    const t = x as Record<string, unknown>;
    const text = typeof x === 'string' ? str(x) : str(t?.text);
    if (!text) return void problems.push(`maintainer[${i}]: no text`);
    maintainer.push({ text, since: typeof x === 'string' ? null : str(t.since) });
  });

  let wave: QueueData['wave'] = null;
  if (raw.wave && typeof raw.wave === 'object') {
    const w = raw.wave as Record<string, unknown>;
    const items: WaveItem[] = [];
    arr(w.items).forEach((x, i) => {
      const it = x as Record<string, unknown>;
      const branch = str(it?.branch);
      const state = it?.state as WaveState;
      if (!branch) return void problems.push(`wave.items[${i}]: no branch`);
      if (!WAVE_STATES.includes(state))
        return void problems.push(`wave.items[${i}]: state ${JSON.stringify(it.state)}`);
      items.push({ branch, state, pr: int(it.pr), session: str(it.session), title: str(it.title) });
    });
    wave = { name: str(w.name) ?? 'Wave', items };
  }

  let deadRows: QueueData['deadRows'] = null;
  const d = (raw.proofs as Record<string, unknown> | undefined)?.deadRows as
    Record<string, unknown> | undefined;
  if (d) {
    const since = parseTime(d.since);
    if (since === null) problems.push('proofs.deadRows.since is not an ISO time');
    else
      deadRows = {
        since,
        target: int(d.target) ?? 12,
        excludedRuns: arr(d.excludedRuns).filter((r): r is string => typeof r === 'string'),
      };
  }

  const plan: PlanItem[] = [];
  arr(raw.plan).forEach((x, i) => {
    const p = x as Record<string, unknown>;
    const what = str(p?.what);
    const kind = p?.kind as PlanKind;
    if (!what) return void problems.push(`plan[${i}]: no what`);
    if (!PLAN_KINDS.includes(kind))
      return void problems.push(`plan[${i}]: kind ${JSON.stringify(p.kind)}`);
    const at = planAt(p.at);
    if (at === null && p.at != null) problems.push(`plan[${i}]: at is not an ISO time`); // kept, unscheduled
    // the optional fields: a bad one is named and dropped, the row kept (like `at`)
    const bad = (k: string, why: string) => void problems.push(`plan[${i}]: ${k} ${why}`);
    const you = str(p.you);
    if (p.you != null && !you) bad('you', 'is not text');
    let eta: PlanItem['eta'] = null;
    if (p.eta != null) {
      const e = p.eta as Record<string, unknown>;
      const from = planAt(e?.from);
      const to = planAt(e?.to);
      const source = e?.source as EtaSource;
      if (from === null || to === null) bad('eta', 'wants from and to as ISO times');
      else if (to < from) bad('eta', 'ends before it starts');
      else if (!ETA_SOURCES.includes(source)) bad('eta', `source ${JSON.stringify(e.source)}`);
      else eta = { from, to, source };
    }
    const lane = typeof p.lane === 'string' && LANE_RE.test(p.lane) ? p.lane : null;
    if (p.lane != null && !lane) bad('lane', 'is not a branch name');
    let done = false;
    let doneAt: number | null = null;
    if (p.done === true) done = true;
    else if (p.done != null && p.done !== false) {
      doneAt = planAt(p.done);
      if (doneAt === null) bad('done', 'wants true or an ISO time');
      else done = true;
    }
    plan.push({ at, what, kind, who: str(p.who), you, eta, lane, done, doneAt });
  });
  // stable sort: equal times and the `at`-less keep their file order
  plan.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || 0); // ∞ − ∞ is NaN → 0

  const planNotes: string[] = [];
  if (raw.planNotes !== undefined && !Array.isArray(raw.planNotes))
    problems.push('planNotes is not an array');
  arr(raw.planNotes).forEach((x, i) => {
    const t = str(x);
    if (!t) return void problems.push(`planNotes[${i}]: not text`);
    planNotes.push(t);
  });
  const planAtV = raw.planAt == null ? null : planAt(raw.planAt);
  if (raw.planAt != null && planAtV === null) problems.push('planAt is not an ISO time');

  const followups: Followup[] = [];
  const ids = new Set<string>();
  arr(raw.followups).forEach((x, i) => {
    const f = x as Record<string, unknown>;
    const id = str(f?.id);
    const what = str(f?.what);
    const after = str(f?.after);
    const owner = f?.owner as string;
    const status = f?.status as string;
    if (!id || !what || !after) return void problems.push(`followups[${i}]: no id, what or after`);
    if (!(FOLLOWUP_STATUS as readonly string[]).includes(status))
      return void problems.push(`followups[${i}]: status ${JSON.stringify(f.status)}`);
    if (!(FOLLOWUP_OWNERS as readonly string[]).includes(owner))
      return void problems.push(`followups[${i}]: owner ${JSON.stringify(f.owner)}`);
    if (ids.has(id)) problems.push(`followups[${i}]: duplicate id ${id}`);
    ids.add(id);
    const { at: since, day: sinceDay } = sinceTime(f.since);
    if (since === null) problems.push(`followups[${i}]: since is not a date`); // kept: never STALE, so say so
    followups.push({ id, what, owner, after, status, source: str(f.source), since, sinceDay });
  });

  const mergeOrder: MergeOrderItem[] = [];
  if (raw.mergeOrder !== undefined && !Array.isArray(raw.mergeOrder))
    problems.push('mergeOrder is not an array');
  arr(raw.mergeOrder).forEach((x, i) => {
    const o = (typeof x === 'string' ? { branch: x } : x) as Record<string, unknown>; // a bare branch name is fine too
    const branch = str(o?.branch);
    if (!branch) return void problems.push(`mergeOrder[${i}]: no branch`);
    if (mergeOrder.some((e) => e.branch === branch))
      return void problems.push(`mergeOrder[${i}]: duplicate branch ${branch}`);
    mergeOrder.push({ branch, pr: int(o.pr), note: str(o.note) });
  });

  // never a problem row: the tower only asks whether a listed lane has started (stale.ts)
  const autoStart = arr(raw.autoStart).flatMap((x) => {
    const b = str((x as Record<string, unknown> | null)?.branch);
    return b && LANE_RE.test(b) ? [b] : [];
  });

  return {
    status: problems.length ? 'bad' : 'ok',
    data: {
      updatedAt,
      devQueue,
      maintainer,
      wave,
      deadRows,
      plan,
      planNotes,
      planAt: planAtV,
      followups,
      mergeOrder,
      autoStart,
    },
    problems,
    ...(unread.length ? { unread } : {}),
  };
}

// amber past 30 min, red past 2 h
export const queueAgeTone = (sec: number) => (sec > 7200 ? 'bad' : sec > 1800 ? 'warn' : 'dim');
