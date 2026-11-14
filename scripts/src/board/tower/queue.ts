// queue.json: the hub's hand-kept dev queue, the maintainer's to-dos and the wave checklist (schema v1:
// docs/ops/SESSION-BOARD.md → Control tower). Never throws: a bad file renders as its problems.
import { findIdentifiers } from '../../identifiers.ts';
import { clean, parseTime } from './fmt.ts';

export const LANE_STATES = ['on-dev', 'next', 'waiting', 'building', 'ready', 'needs-you'] as const;
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

// dispatch's timeline: the one source for "next merge" (the tower's PLAN panel and the statusline)
export type PlanItem = { at: number | null; what: string; kind: PlanKind; who: string | null };

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
export function sinceTime(x: unknown): { at: number | null; day: string | null } {
  const m = typeof x === 'string' ? DAY.exec(x) : null;
  if (!m) return { at: parseTime(x), day: null };
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1).getTime() - 1;
  return { at, day: `${m[2]}-${m[3]}` };
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
];

// An open follow-up whose `after` has happened: a merged branch or PR (`<branch>`, `<branch> merge(s)`, `PR <n>`,
// optionally `+ N day(s)|week(s)` and a trailing `(…)`), or a date that has begun (`2026-11-20 …`, `Sat 11-14 …`,
// this year). Exact shapes only: free text (`wave 4`, `repo goes public`) never fires. → when it fired.
const AFTER_REF =
  /^(?:PR (\d+)|([a-z0-9][a-z0-9-]*))(?: merges?)?(?: \+ (\d+) (day|week)s?)?(?: \(.*\))?$/;
const AFTER_ISO = /^(\d{4})-(\d{2})-(\d{2})(?:$|[ T(~])/;
const AFTER_MD = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]* )?(\d{1,2})-(\d{1,2})(?:$|[ (])/;
export type Merged = { branch: string; number: number; mergedAt: number };
export function firedAt(after: string, merged: Merged[], now: number): number | null {
  const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();
  let m = AFTER_ISO.exec(after);
  if (m) return day(+m[1]!, +m[2]!, +m[3]!);
  m = AFTER_MD.exec(after);
  if (m) return day(new Date(now).getFullYear(), +m[1]!, +m[2]!);
  const r = AFTER_REF.exec(after);
  const pr = r && merged.find((p) => (r[1] ? p.number === +r[1] : p.branch === r[2]));
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
  followups: Followup[];
  mergeOrder: MergeOrderItem[];
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
  // other extra key — the hub's own `mergeOrder` among them — passes.
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
    plan.push({ at, what, kind, who: str(p.who) });
  });
  // stable sort: equal times and the `at`-less keep their file order
  plan.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || 0); // ∞ − ∞ is NaN → 0

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
    const o = x as Record<string, unknown>;
    const branch = str(o?.branch);
    if (!branch) return void problems.push(`mergeOrder[${i}]: no branch`);
    if (mergeOrder.some((e) => e.branch === branch))
      return void problems.push(`mergeOrder[${i}]: duplicate branch ${branch}`);
    mergeOrder.push({ branch, pr: int(o.pr), note: str(o.note) });
  });

  return {
    status: problems.length ? 'bad' : 'ok',
    data: { updatedAt, devQueue, maintainer, wave, deadRows, plan, followups, mergeOrder },
    problems,
    ...(unread.length ? { unread } : {}),
  };
}

// amber past 30 min, red past 2 h
export const queueAgeTone = (sec: number) => (sec > 7200 ? 'bad' : sec > 1800 ? 'warn' : 'dim');
