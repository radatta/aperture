// queue.json: the hub's hand-kept dev queue, Rahul's to-dos and the wave checklist (schema v1:
// docs/ops/SESSION-BOARD.md → Control tower). Never throws: a bad file renders as its problems.
import { parseTime } from './fmt.ts';

export const LANE_STATES = ['on-dev', 'next', 'waiting', 'building'] as const;
export const WAVE_STATES = ['merged', 'open', 'in-flight', 'not-started'] as const;
export type LaneState = (typeof LANE_STATES)[number];
export type WaveState = (typeof WAVE_STATES)[number];

export type Lane = {
  branch: string;
  session: string | null;
  state: LaneState;
  pr: number | null;
  eta: number | null;
  waitingOn: string | null;
  note: string | null;
};
export type Todo = { text: string; since: string | null };
export type WaveItem = {
  branch: string;
  state: WaveState;
  pr: number | null;
  session: string | null;
  title: string | null;
};

export type QueueData = {
  updatedAt: number;
  devQueue: Lane[];
  rahul: Todo[];
  wave: { name: string; items: WaveItem[] } | null;
  deadRows: { since: number; target: number; excludedRuns: string[] } | null;
};

// `data` is the last good parse (kept through a bad write); `problems` say what's wrong with the current file.
export type Queue = {
  status: 'ok' | 'missing' | 'bad';
  data: QueueData | null;
  problems: string[];
};

const str = (x: unknown) => (typeof x === 'string' && x.length > 0 ? x : null);
const int = (x: unknown) => (Number.isInteger(x) ? (x as number) : null);
const arr = (x: unknown) => (Array.isArray(x) ? (x as unknown[]) : []);

export function parseQueue(text: string | null, prev: QueueData | null = null): Queue {
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
    devQueue.push({
      branch,
      session: str(l.session),
      state,
      pr: int(l.pr),
      eta: parseTime(l.eta),
      waitingOn: str(l.waitingOn),
      note: str(l.note),
    });
  });

  const rahul: Todo[] = [];
  arr(raw.rahul).forEach((x, i) => {
    const t = x as Record<string, unknown>;
    const text = typeof x === 'string' ? x : str(t?.text);
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

  return {
    status: problems.length ? 'bad' : 'ok',
    data: { updatedAt, devQueue, rahul, wave, deadRows },
    problems,
  };
}

// amber past 30 min, red past 2 h
export const queueAgeTone = (sec: number) => (sec > 7200 ? 'bad' : sec > 1800 ? 'warn' : 'dim');
