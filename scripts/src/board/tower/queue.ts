// queue.json: the hub's hand-kept dev queue, Rahul's to-dos and the wave checklist (schema v1:
// docs/ops/SESSION-BOARD.md → Control tower). Never throws: a bad file renders as its problems.
import { clean, parseTime } from './fmt.ts';

export const LANE_STATES = ['on-dev', 'next', 'waiting', 'building', 'ready', 'needs-you'] as const;
export const WAVE_STATES = ['merged', 'open', 'in-flight', 'not-started'] as const;
export type LaneState = (typeof LANE_STATES)[number];
export type WaveState = (typeof WAVE_STATES)[number];
// the dev slot a lane is on (CI-BOT.md → Dev slots): optional, `dev` when absent
export const LANE_SLOTS = ['dev', 'devb'] as const;
export type LaneSlot = (typeof LANE_SLOTS)[number];
export const PLAN_KINDS = ['dev', 'merge', 'rahul', 'ci'] as const;
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
export const FOLLOWUP_OWNERS = ['rahul', 'lane', 'dispatch'] as const;
export type Followup = {
  id: string;
  what: string;
  owner: string;
  after: string;
  status: string;
  source: string | null;
  since: number | null;
};

// STALE: open, due now (`after: "now"`), and older than 24 h. One definition; localNotes/board/pq-check.ts imports it.
export const STALE_MS = 24 * 3600e3;
export const staleFollowups = (fu: Followup[], now: number) =>
  fu.filter((f) => f.status === 'open' && f.after === 'now' && f.since !== null && now - f.since > STALE_MS);

export type QueueData = {
  updatedAt: number;
  devQueue: Lane[];
  rahul: Todo[];
  wave: { name: string; items: WaveItem[] } | null;
  deadRows: { since: number; target: number; excludedRuns: string[] } | null;
  plan: PlanItem[]; // by `at`, the `at`-less last in file order
  followups: Followup[];
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
    return { status: 'bad', data: prev, problems: [`not JSON: ${(e as Error).message}`] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { status: 'bad', data: prev, problems: ['not an object'] };
  if (raw.v !== 1)
    return { status: 'bad', data: prev, problems: [`v is ${JSON.stringify(raw.v)}, want 1`] };
  const updatedAt = parseTime(raw.updatedAt);
  if (updatedAt === null)
    return { status: 'bad', data: prev, problems: ['updatedAt is not an ISO time'] };

  const devQueue: Lane[] = [];
  arr(raw.devQueue).forEach((x, i) => {
    const l = x as Record<string, unknown>;
    const branch = str(l?.branch);
    const state = l?.state as LaneState;
    if (!branch) return void problems.push(`devQueue[${i}]: no branch`);
    if (!LANE_STATES.includes(state))
      return void problems.push(`devQueue[${i}]: state ${JSON.stringify(l.state)}`);
    const slot = (l.slot ?? 'dev') as LaneSlot;
    if (!LANE_SLOTS.includes(slot))
      return void problems.push(`devQueue[${i}]: slot ${JSON.stringify(l.slot)}`);
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

  const rahul: Todo[] = [];
  arr(raw.rahul).forEach((x, i) => {
    const t = x as Record<string, unknown>;
    const text = typeof x === 'string' ? str(x) : str(t?.text);
    if (!text) return void problems.push(`rahul[${i}]: no text`);
    rahul.push({ text, since: typeof x === 'string' ? null : str(t.since) });
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
    const since = parseTime(f.since);
    if (since === null) problems.push(`followups[${i}]: since is not a date`); // kept: never STALE, so say so
    followups.push({ id, what, owner, after, status, source: str(f.source), since });
  });

  return {
    status: problems.length ? 'bad' : 'ok',
    data: { updatedAt, devQueue, rahul, wave, deadRows, plan, followups },
    problems,
  };
}

// amber past 30 min, red past 2 h
export const queueAgeTone = (sec: number) => (sec > 7200 ? 'bad' : sec > 1800 ? 'warn' : 'dim');
