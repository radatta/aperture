// LeetCode sittings (docs/areas/recruiting) — the one place the ingest rules live, so the stub and the
// Lambda can't drift: what an extension write may carry (normalize*), how events fold into the head and
// the live row (fold*), and the metrics read off them. Pure; no clock, no I/O.
//
// The extension only ever observes LeetCode's own traffic; everything it sends is kept raw under
// `payload`. The server trusts those payloads as opaque bytes and recomputes everything it decides on.

import { msToMin } from './dates';
import { normalizeVerdict } from './leetcode';
import { findOpenRollTask } from './rolls';
import { isUlid } from './ulid';
import type {
  BaseEntity,
  CauseTag,
  CoachEventKind,
  CoachMark,
  HelpLevel,
  LcStartGate,
  LeetcodeProblem,
  LcTimerState,
  Sitting,
  SittingBudget,
  SittingCoach,
  SittingEvent,
  SittingEventType,
  SittingFacts,
  SittingHeadRow,
  SittingLive,
  SittingReview,
  SittingSummary,
  SittingVerdict,
  Task,
} from './types';

export const PREP_TARGET_DEFAULT = 'General';
// The rep title a sitting gives its task, so Home and the calendar say which problem it is.
export const sittingRepTitle = (problemTitle: string) => `LeetCode · ${problemTitle}`;

// --- Caps (a leaked device token's ceiling — recruiting doc → Device token) ---
export const SITTING_EVENTS_PER_CALL = 50;
export const SITTING_CALL_BYTES = 256 * 1024;
export const SITTING_MAX_EVENTS = 3000;
export const SITTING_MAX_BYTES = 16 * 1024 * 1024;
// Starts a day: well above real use (a handful) and the dev check's three a run across a day's lanes; a leaked
// token's ceiling is this many visible junk reps a day.
export const SITTING_STARTS_PER_DAY = 100;
// Events are refused this long after Start: a sitting left open forever stops taking writes.
export const SITTING_INGEST_WINDOW_MS = 24 * 3600_000;
// After its end a sitting still takes, this long, the events stamped before the end (the outbox's retries
// land after Done) — inside its window only. Stamps are the extension's clock, shifted onto the server's
// by the Start's offset, which runs late by the Start's latency: the skew allowance covers one failed try.
export const SITTING_END_GRACE_MS = 10 * 60_000;
export const SITTING_END_SKEW_MS = 60_000;
// Raw bulk (snapshots, replay, submitDetails) is kept this long past the ingest window, then DynamoDB's TTL
// deletes it. What's kept forever is the head, the live row (final code + facts) and every run/submit.
export const SITTING_RAW_KEEP_MS = 14 * 24 * 3600_000;
export const SITTING_FOCUS_MAX = 300;
export const SITTING_PAYLOAD_MAX: Record<SittingEventType | 'replay', number> = {
  snapshot: 64 * 1024,
  run: 96 * 1024,
  submit: 96 * 1024,
  submitDetails: 96 * 1024,
  note: 16 * 1024,
  timer: 1024,
  coach: 4 * 1024, // three ≤ 300-char inputs, even at 4 UTF-8 bytes a character
  replay: 64 * 1024,
};
export const SITTING_PROBLEM_MAX = 64 * 1024;
const SLUG_RE = /^[a-z0-9-]{1,128}$/;

export const LC_ROLL_UNLINKED_ERROR =
  'Pick your LeetCode roll in Settings first — a sitting is a rep of it.';
export const SITTING_ACTIVE_ERROR = 'Another sitting is still open — end it in Aperture first.';
export const SITTING_ENDED_ERROR = 'This sitting has ended — start a new one.';
export const SITTING_CAP_ERROR = 'This sitting is over its capture limit.';
export const SITTING_START_CAP_ERROR = 'Too many sittings started today.';
export const SITTING_EVENT_TIME_ERROR = 'An event’s time is off the sitting’s clock.';
export const SITTING_START_TIME_ERROR = 'The Start’s time is off by more than a day.';
export const LC_START_ATTEMPTS_PER_DAY = 400;
export const LC_START_ATTEMPT_CAP_ERROR = 'Too many Start attempts today.';
// A gate claim this young may be a Start still writing its head; older and not found, it died — let through.
const CLAIM_IN_FLIGHT_MS = 2 * 60_000;

// --- Inputs ---
export interface SittingStartInput {
  clientSittingId: string; // ULID the extension mints — a repeat Start resumes
  problemSlug: string;
  problemTitle: string;
  questionId?: string | null;
  frontendId?: string | null;
  difficulty?: string | null;
  topicTags?: string[] | null;
  lang: string;
  startedAt: number; // the click, by the extension's clock
  tzOffsetMinutes: number;
  lcSolveSessionId?: string | null;
  problem?: unknown; // raw questionDetail.question
}
export type SittingEventInput =
  | { id: string; type: SittingEventType; at: number; payload: unknown }
  | { id: string; type: 'replay'; at: number; clientSessionId?: string | null; events: string };
export interface SittingEventsInput {
  sittingId: string;
  events: SittingEventInput[];
}
export interface SittingEventsResult {
  accepted: number;
  duplicates: number;
  skipped: number; // stamped after the end of an ended sitting, never stored
  version: number; // the live row's snapshot version after this call
  status: Sitting['status'];
}
export interface SittingStartResult {
  sitting: Sitting;
  resumed: boolean;
}

// --- Normalizers (throw with nothing written) ---
const str = (v: unknown, label: string, max: number): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${label} is required`);
  const s = v.trim();
  if (s.length > max) throw new Error(`${label} is limited to ${max} characters`);
  return s;
};
const optStr = (v: unknown, label: string, max: number): string | null =>
  v == null || v === '' ? null : str(v, label, max);
const finite = (v: unknown, label: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${label} must be a number`);
  return v;
};
// Sizes are UTF-8 bytes (what DynamoDB stores), never UTF-16 characters.
const encoder = new TextEncoder();
export const utf8Bytes = (s: string): number => encoder.encode(s).length;
export const jsonSize = (v: unknown): number => {
  try {
    return utf8Bytes(JSON.stringify(v ?? null));
  } catch {
    throw new Error('Payload must be JSON');
  }
};
// What DynamoDB can store as given: nesting at most 20 deep, numbers finite and exact. A payload that fails
// here is refused before the budget is touched (not reserved, then lost to a write that can't happen).
export function payloadError(v: unknown, depth = 0): string | null {
  if (depth > 20) return 'Payload is nested too deep';
  if (typeof v === 'number')
    return Number.isFinite(v) &&
      Math.abs(v) <= Number.MAX_SAFE_INTEGER &&
      (v === 0 || Math.abs(v) >= 1e-130) // DynamoDB's smallest magnitude
      ? null
      : 'Payload has an unstorable number';
  if (Array.isArray(v)) {
    for (const x of v) {
      const err = payloadError(x, depth + 1);
      if (err) return err;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    for (const x of Object.values(v as Record<string, unknown>)) {
      const err = payloadError(x, depth + 1);
      if (err) return err;
    }
  }
  return null;
}

export interface NormalizedSittingStart extends Omit<SittingStartInput, 'problem'> {
  questionId: string | null;
  frontendId: string | null;
  difficulty: string | null;
  topicTags: string[] | null;
  lcSolveSessionId: string | null;
  problem: unknown; // null when absent
}
export function normalizeSittingStart(input: SittingStartInput): NormalizedSittingStart {
  if (!input || typeof input !== 'object') throw new Error('A sitting start is required');
  if (typeof input.clientSittingId !== 'string' || !isUlid(input.clientSittingId))
    throw new Error('A sitting needs a valid id');
  const slug = str(input.problemSlug, 'Problem slug', 128);
  if (!SLUG_RE.test(slug)) throw new Error('Problem slug is malformed');
  let tags: string[] | null = null;
  if (input.topicTags != null) {
    if (!Array.isArray(input.topicTags) || input.topicTags.length > 20)
      throw new Error('Topic tags must be a list of at most 20');
    tags = input.topicTags.map((t) => str(t, 'Topic tag', 40));
  }
  const problem = input.problem ?? null;
  if (jsonSize(problem) > SITTING_PROBLEM_MAX) throw new Error('Problem detail is too large');
  const problemErr = payloadError(problem);
  if (problemErr) throw new Error(problemErr);
  const tz = finite(input.tzOffsetMinutes, 'tzOffsetMinutes');
  if (Math.abs(tz) > 14 * 60) throw new Error('tzOffsetMinutes is out of range');
  return {
    clientSittingId: input.clientSittingId,
    problemSlug: slug,
    problemTitle: str(input.problemTitle, 'Problem title', 200),
    questionId: optStr(input.questionId, 'questionId', 20),
    frontendId: optStr(input.frontendId, 'frontendId', 20),
    difficulty: optStr(input.difficulty, 'Difficulty', 20),
    topicTags: tags,
    lang: str(input.lang, 'Language', 40),
    startedAt: finite(input.startedAt, 'startedAt'),
    tzOffsetMinutes: tz,
    lcSolveSessionId: optStr(input.lcSolveSessionId, 'Solve session id', 80),
    problem,
  };
}

export type NormalizedSittingEvent =
  | { id: string; type: SittingEventType; at: number; payload: unknown; bytes: number }
  | {
      id: string;
      type: 'replay';
      at: number;
      clientSessionId: string | null;
      events: string;
      bytes: number;
    };
const EVENT_TYPES: readonly (SittingEventType | 'replay')[] = [
  'snapshot',
  'run',
  'submit',
  'submitDetails',
  'note',
  'timer',
  'coach',
  'replay',
];
export function normalizeSittingEvents(input: SittingEventsInput): {
  sittingId: string;
  events: NormalizedSittingEvent[];
} {
  if (!input || typeof input !== 'object') throw new Error('Sitting events are required');
  if (typeof input.sittingId !== 'string' || !isUlid(input.sittingId))
    throw new Error('A sitting id is required');
  if (!Array.isArray(input.events) || input.events.length === 0)
    throw new Error('At least one event is required');
  if (input.events.length > SITTING_EVENTS_PER_CALL)
    throw new Error(`At most ${SITTING_EVENTS_PER_CALL} events per call`);
  const seen = new Set<string>();
  let total = 0;
  const events = input.events.map((e): NormalizedSittingEvent => {
    if (!e || typeof e !== 'object') throw new Error('An event must be an object');
    if (typeof e.id !== 'string' || !isUlid(e.id)) throw new Error('An event needs a valid id');
    if (!EVENT_TYPES.includes(e.type)) throw new Error(`Unknown event type: ${String(e.type)}`);
    const at = finite(e.at, 'Event time');
    if (e.type === 'replay') {
      if (typeof e.events !== 'string') throw new Error('Replay events must be text');
      const bytes = utf8Bytes(e.events);
      if (bytes > SITTING_PAYLOAD_MAX.replay) throw new Error('A replay chunk is too large');
      total += bytes;
      return {
        id: e.id,
        type: 'replay',
        at,
        clientSessionId: optStr(e.clientSessionId, 'clientSessionId', 80),
        events: e.events,
        bytes,
      };
    }
    const payload = e.payload ?? null;
    const bytes = jsonSize(payload);
    const shapeErr = payloadError(payload);
    if (shapeErr) throw new Error(shapeErr);
    if (bytes > SITTING_PAYLOAD_MAX[e.type]) throw new Error(`A ${e.type} event is too large`);
    if (e.type === 'snapshot' && snapshotCode(payload) === null)
      throw new Error('A snapshot needs its code');
    total += bytes;
    return { id: e.id, type: e.type, at, payload, bytes };
  });
  for (const e of events) {
    if (seen.has(e.id)) throw new Error('Duplicate event id in one call');
    seen.add(e.id);
  }
  if (total > SITTING_CALL_BYTES) throw new Error('Too much in one call');
  return { sittingId: input.sittingId, events };
}

// --- Reading LeetCode's payloads (defensive: the shapes are LeetCode's, verified 2026-11-08) ---
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
// A number DynamoDB can store as given (exact, and 0 or at least 1e-130 in magnitude), else null — strings too,
// so a hostile "1e300" in a payload never reaches a head or live row.
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER)
    return null;
  return n === 0 || Math.abs(n) >= 1e-130 ? n : null;
};
export function snapshotCode(payload: unknown): string | null {
  const code = obj(payload)?.code;
  return typeof code === 'string' ? code : null;
}
// A run's or submit's judged result: `payload.result` is the final /check/ response. A Run's "Accepted" (10)
// only says the code ran; whether its answers matched is `correct_answer` (captured 2026-11-08), so a false one
// is a wrong answer, said in our words. With no flag, fewer passed than run reads as wrong — an inference.
export function verdictOf(
  payload: unknown,
  at: number,
  type: 'run' | 'submit',
): SittingVerdict | null {
  const r = obj(obj(payload)?.result);
  if (!r) return null;
  const statusMsg = typeof r.status_msg === 'string' ? r.status_msg.slice(0, 200) : null; // it's on the head
  const v: SittingVerdict = {
    verdict: normalizeVerdict(num(r.status_code), statusMsg),
    statusMsg,
    passed: num(r.total_correct),
    total: num(r.total_testcases),
    at,
  };
  if (type !== 'run' || v.verdict !== 'accepted') return v;
  const wrong =
    r.correct_answer === false ||
    (r.correct_answer !== true && v.passed !== null && v.total !== null && v.passed < v.total);
  return wrong ? { ...v, verdict: 'wrong_answer', statusMsg: 'Wrong Answer' } : v;
}
// QD_TIMER_STATE (one capture, 2026-11-08): {mode:'reverse', startTimestamp, pauseMs, endMs, status}. The
// bar read 19:07 while endMs − pauseMs ≈ 19:06, so pauseMs is read as elapsed-at-pause and a running
// timer as pauseMs + (now − startTimestamp) — an inference until the debug log confirms it.
export function lcTimerState(payload: unknown, at: number): LcTimerState | null {
  const s = obj(obj(payload)?.state) ?? obj(payload);
  if (!s) return null;
  const pauseMs = num(s.pauseMs) ?? 0;
  const startTs = num(s.startTimestamp);
  const status = typeof s.status === 'string' ? s.status : null;
  const running = startTs !== null && status !== 'pause';
  return {
    mode: typeof s.mode === 'string' ? s.mode : null,
    status,
    elapsedMs: running ? pauseMs + Math.max(0, at - startTs) : num(s.pauseMs),
    at,
    raw: s,
  };
}

// --- Folds ---
export const emptySummary = (): SittingSummary => ({
  runs: 0,
  submits: 0,
  notes: 0,
  lastRun: null,
  lastSubmit: null,
  firstSubmit: null,
  firstAcceptedAt: null,
  submitsBeforeAccepted: null,
  runsBeforeFirstSubmit: 0,
  lcTimer: null,
  lastEventAt: null,
  headEvents: 0,
});
export const emptyFacts = (): SittingFacts => ({
  firstEditAt: null,
  lastEditAt: null,
  edits: 0,
  longestStallMs: 0,
  rewrites: 0,
  maxCodeLength: 0,
  focus: [],
});
// The live row's fields before any snapshot (the BaseEntity is the caller's).
export const emptyLiveFields = (sittingId: string) => ({
  sittingId,
  version: 0,
  code: null,
  lang: null,
  codeAt: null,
  receivedAt: null,
  snapshots: 0,
  replayChunks: 0,
  bytes: 0,
  facts: emptyFacts(),
});

// Whether an event folds into the head (and so costs a head write) or only into the live row.
// A type guard: past it, the type is a HeadEventType (headRowOf's input) with no cast.
export const isHeadEvent = (type: SittingEventType | 'replay'): type is HeadEventType =>
  type === 'run' || type === 'submit' || type === 'note' || type === 'timer' || type === 'coach';

// An unreadable judge result still counts — as 'other' — so it holds its place in the order.
const verdictOrOther = (payload: unknown, at: number, type: 'run' | 'submit'): SittingVerdict =>
  verdictOf(payload, at, type) ?? {
    verdict: 'other',
    statusMsg: null,
    passed: null,
    total: null,
    at,
  };
export type HeadEventType = SittingHeadRow['type'];
const timerWithoutRaw = (t: LcTimerState | null): LcTimerState | null =>
  t ? { ...t, raw: null } : null;
// The compact row a head event is folded from, taken from its payload once, at write.
export function headRowOf(
  sittingId: string,
  e: { id: string; type: HeadEventType; at: number; payload: unknown },
): SittingHeadRow {
  return {
    id: e.id,
    sittingId,
    type: e.type,
    at: e.at,
    verdict:
      e.type === 'run' || e.type === 'submit' ? verdictOrOther(e.payload, e.at, e.type) : null,
    // The timer's state without its raw value: a head row stays ~200 B, whatever the payload carried.
    timer: e.type === 'timer' ? timerWithoutRaw(lcTimerState(e.payload, e.at)) : null,
    coach: e.type === 'coach' ? coachMarkOf(e.payload) : null,
    deletedAt: null,
  };
}
export function foldSummary(s: SittingSummary, r: SittingHeadRow): SittingSummary {
  const next: SittingSummary = {
    ...s,
    lastEventAt: Math.max(s.lastEventAt ?? 0, r.at),
    headEvents: s.headEvents + 1,
  };
  const v = r.verdict ?? {
    verdict: 'other' as const,
    statusMsg: null,
    passed: null,
    total: null,
    at: r.at,
  };
  if (r.type === 'run') {
    next.runs = s.runs + 1;
    if (s.submits === 0) next.runsBeforeFirstSubmit = s.runsBeforeFirstSubmit + 1;
    next.lastRun = v;
  } else if (r.type === 'submit') {
    next.submits = s.submits + 1;
    next.lastSubmit = v;
    if (s.submits === 0) next.firstSubmit = v;
    if (v.verdict === 'accepted' && s.firstAcceptedAt === null) {
      next.firstAcceptedAt = r.at;
      next.submitsBeforeAccepted = s.submits; // failed submits before this one
    }
  } else if (r.type === 'note') next.notes = s.notes + 1;
  else if (r.type === 'timer') next.lcTimer = r.timer ?? s.lcTimer;
  else if (r.type === 'coach' && r.coach?.kind) next.coach = foldCoach(s.coach, r.coach, s.submits);
  return next;
}

// --- Coach events (the extension's trace card and resubmit nudge) ---
const COACH_KINDS: readonly CoachEventKind[] = [
  'config',
  'trace',
  'trace-skip',
  'untraced-submit',
  'nudge-shown',
];
const TRACE_INPUTS = ['empty', 'boundary', 'normal'] as const;
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
// What a coach event's head row keeps, read defensively from the extension's payload: an unknown kind is
// kept as null (its payload is still stored) and folds nothing; a trace counts its non-blank inputs.
export function coachMarkOf(payload: unknown): CoachMark {
  const p = obj(payload);
  const kind = COACH_KINDS.find((k) => k === p?.kind) ?? null;
  const inputs = obj(p?.inputs);
  const sw = { trace: bool(p?.trace), hold: bool(p?.hold), nudge: bool(p?.nudge) };
  return {
    kind,
    inputs:
      kind === 'trace'
        ? TRACE_INPUTS.filter((k) => {
            const v = inputs?.[k];
            return typeof v === 'string' && v.trim() !== '';
          }).length
        : null,
    config:
      kind === 'config' && sw.trace !== null && sw.hold !== null && sw.nudge !== null
        ? { trace: sw.trace, hold: sw.hold, nudge: sw.nudge }
        : null,
  };
}
// One coach row into the sitting's coaching. The trace state is what stood at the first submit: a trace or
// a skip counts only before it (the latest wins), and a submit seen untraced marks `none` unless one came first.
function foldCoach(c: SittingCoach | undefined, m: CoachMark, submits: number): SittingCoach {
  const next: SittingCoach = c ? { ...c } : { config: null, trace: null, nudges: 0 };
  if (m.kind === 'config') next.config = m.config ?? next.config;
  else if (m.kind === 'nudge-shown') next.nudges += 1;
  else if (m.kind === 'untraced-submit') next.trace ??= 'none';
  else if (submits === 0)
    next.trace =
      m.kind === 'trace-skip' || !m.inputs ? 'skipped' : m.inputs === 3 ? 'traced' : 'partial';
  return next;
}
// The head's summary, recomputed from every stored head row in time order — never an increment, so a retry
// or a lost write can't skew it: the next call carrying any head event, fresh or a repeat, rebuilds it, and the
// write is skipped when the stored one already folds more rows (headEvents) — a slower call never rolls it back.
export function summarizeHeadRows(rows: readonly SittingHeadRow[]): SittingSummary {
  return [...rows]
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
    .reduce(foldSummary, emptySummary());
}
export const newerSummary = (cur: SittingSummary, next: SittingSummary): boolean =>
  next.headEvents > (cur.headEvents ?? 0);

// LeetCode's replay events (type 7 = an editor change, 3 = a [val] toggle) fold into the facts.
function foldReplay(f: SittingFacts, raw: string): SittingFacts {
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return f; // kept raw anyway; an unreadable chunk adds no facts
  }
  if (!Array.isArray(list)) return f;
  const next = { ...f, focus: [...f.focus] };
  const edits = list
    .map(obj)
    .filter((e): e is Record<string, unknown> => !!e)
    .sort((a, b) => (num(a.timestamp) ?? 0) - (num(b.timestamp) ?? 0));
  for (const e of edits) {
    const t = num(e.timestamp);
    if (t === null) continue;
    if (e.type === 7) {
      if (next.lastEditAt !== null && t > next.lastEditAt)
        next.longestStallMs = Math.max(next.longestStallMs, t - next.lastEditAt);
      next.firstEditAt = next.firstEditAt === null ? t : Math.min(next.firstEditAt, t);
      next.lastEditAt = Math.max(next.lastEditAt ?? t, t);
      next.edits += 1;
    } else if (e.type === 3 && typeof e.val === 'boolean' && next.focus.length < SITTING_FOCUS_MAX)
      next.focus.push([t, e.val]);
  }
  return next;
}

// Snapshots and replay fold into the live row. A snapshot older than the stored code (an out-of-order
// retry) still counts but doesn't replace it.
export function foldLive<L extends Omit<SittingLive, keyof BaseEntity>>(
  live: L,
  e: NormalizedSittingEvent,
  receivedAt: number,
  fresh = true,
): L {
  if (e.type === 'replay' && !fresh) return live;
  if (e.type === 'replay')
    return {
      ...live,
      replayChunks: live.replayChunks + 1,
      bytes: live.bytes + e.bytes,
      receivedAt,
      facts: foldReplay(live.facts, e.events),
    };
  if (e.type !== 'snapshot') return live;
  const code = snapshotCode(e.payload) ?? '';
  if (!fresh)
    // a repeat: count nothing, but its code still lands if it's the newest (a lost fold heals)
    return live.codeAt === null || e.at > live.codeAt
      ? { ...live, code, codeAt: e.at, receivedAt }
      : live;
  const lang = obj(e.payload)?.lang;
  const facts = { ...live.facts };
  if (facts.maxCodeLength > 200 && code.length < facts.maxCodeLength / 2) {
    facts.rewrites += 1;
    facts.maxCodeLength = code.length;
  } else facts.maxCodeLength = Math.max(facts.maxCodeLength, code.length);
  const newer = live.codeAt === null || e.at >= live.codeAt;
  return {
    ...live,
    version: live.version + 1,
    snapshots: live.snapshots + 1,
    bytes: live.bytes + e.bytes,
    receivedAt,
    facts,
    ...(newer ? { code, codeAt: e.at, lang: lang == null ? live.lang : String(lang) } : {}),
  };
}

// The raw bulk's TTL (epoch seconds, as DynamoDB wants): past the ingest window plus the keep.
export const sittingRawExpiresAt = (s: Pick<Sitting, 'startedAt'>): number =>
  Math.floor((s.startedAt + SITTING_INGEST_WINDOW_MS + SITTING_RAW_KEEP_MS) / 1000);
export const isRawEventType = (type: SittingEventType | 'replay') =>
  type === 'snapshot' || type === 'submitDetails' || type === 'replay';

// 'open' takes everything; 'grace' only events stamped before the end; 'closed' refuses.
export function sittingIngestPhase(
  s: Pick<Sitting, 'status' | 'startedAt' | 'endedAt'>,
  now: number,
): 'open' | 'grace' | 'closed' {
  if (now - s.startedAt > SITTING_INGEST_WINDOW_MS) return 'closed'; // the window stays a hard ceiling
  if (s.status === 'active') return 'open';
  return s.endedAt !== null && now - s.endedAt <= SITTING_END_GRACE_MS ? 'grace' : 'closed';
}
// The events a call may store: all while active; after the end, those stamped before it on the extension's clock.
export function eventsBeforeEnd<E extends { at: number }>(
  s: Pick<Sitting, 'status' | 'startedAt' | 'clientStartedAt' | 'endedAt'>,
  events: readonly E[],
): E[] {
  if (s.status === 'active' || s.endedAt === null) return [...events];
  const cutoff = s.endedAt - (s.startedAt - s.clientStartedAt) + SITTING_END_SKEW_MS;
  return events.filter((e) => e.at <= cutoff);
}
// Why an events call is refused before anything is written, or null: the sitting is past its grace or its
// window, or an event's time — skipped ones included — is off the sitting's clock (the extension's — bounds
// keep junk out of the metrics and the sort).
export function sittingIngestError(
  s: Pick<Sitting, 'status' | 'startedAt' | 'clientStartedAt' | 'endedAt'>,
  events: readonly { at: number }[],
  now: number,
): string | null {
  if (sittingIngestPhase(s, now) === 'closed') return SITTING_ENDED_ERROR;
  const lo = s.clientStartedAt - 24 * 3600_000;
  const hi = s.clientStartedAt + 2 * SITTING_INGEST_WINDOW_MS;
  return events.some((e) => e.at < lo || e.at > hi) ? SITTING_EVENT_TIME_ERROR : null;
}
// The budget after reserving a call's events, or SITTING_CAP_ERROR when it would pass a cap.
export function reserveBudget<B extends Pick<SittingBudget, 'events' | 'bytes'>>(
  b: B,
  incoming: { count: number; bytes: number },
): B {
  const next = { ...b, events: b.events + incoming.count, bytes: b.bytes + incoming.bytes };
  if (next.events > SITTING_MAX_EVENTS || next.bytes > SITTING_MAX_BYTES)
    throw new Error(SITTING_CAP_ERROR);
  return next;
}

// --- Metrics (derived, never stored) ---
export function sittingElapsedMs(s: Pick<Sitting, 'startedAt' | 'endedAt'>, now: number): number {
  return Math.max(0, (s.endedAt ?? now) - s.startedAt);
}
// Whole minutes for display, at least 1.
export const sittingMinutes = (s: Pick<Sitting, 'startedAt' | 'endedAt'>, now: number): number =>
  Math.max(1, msToMin(sittingElapsedMs(s, now)));
export interface SittingMetrics {
  firstSubmitAccepted: boolean | null; // null = no submit yet — the headline
  submitsBeforeAccepted: number | null;
  timeToFirstSubmitMs: number | null;
}
// Event times are the extension's clock, so time-to-first-submit runs from the click on the same clock.
export function sittingMetrics(s: Pick<Sitting, 'clientStartedAt' | 'summary'>): SittingMetrics {
  const first = s.summary.firstSubmit;
  return {
    firstSubmitAccepted: first ? first.verdict === 'accepted' : null,
    submitsBeforeAccepted: s.summary.submitsBeforeAccepted,
    timeToFirstSubmitMs: first ? Math.max(0, first.at - s.clientStartedAt) : null,
  };
}

// --- Start: which rep, and whether to refuse (one open rep per roll — rolls.md D6) ---
export type SittingStartPlan = (
  { kind: 'resume'; sitting: Sitting } | { kind: 'attach'; rep: Task } | { kind: 'spawn' }
) & {
  // Open sittings to end first: past their window, or their rep finished (Done → done, else abandoned),
  // or — for a Start on another problem — a half-made one whose rep was never created.
  ends: { sitting: Sitting; to: 'done' | 'abandoned'; at: number }[];
};
// `sittings` and `tasks` are the alive rows. Stale open sittings end first (they'd otherwise block every
// Start). Then a repeat Start (same clientSittingId), or one on the problem a still-open sitting is on,
// resumes it; a Start on another problem while one is open is refused; otherwise the roll's open rep is
// attached when no open sitting holds it, else a fresh rep is spawned.
export function planSittingStart(
  input: Pick<NormalizedSittingStart, 'clientSittingId' | 'problemSlug'>,
  sittings: readonly Sitting[],
  tasks: Task[],
  rollId: string,
  now: number,
): SittingStartPlan {
  const ends: SittingStartPlan['ends'] = [];
  const repOf = (x: Sitting) => tasks.find((t) => t.id === x.repTaskId);
  for (const x of sittings) {
    if (x.status !== 'active') continue;
    const rep = repOf(x);
    // A rep finished some other way ends its sitting when it finished, so its minutes don't stretch to now.
    if (rep?.status === 'done') ends.push({ sitting: x, to: 'done', at: rep.completedAt ?? now });
    else if (rep?.status === 'cancelled')
      ends.push({ sitting: x, to: 'abandoned', at: rep.cancelledAt ?? now });
    else if (now - x.startedAt > SITTING_INGEST_WINDOW_MS)
      ends.push({ sitting: x, to: 'abandoned', at: now });
  }
  const ended = new Set(ends.map((e) => e.sitting.id));
  const open = sittings.filter((x) => x.status === 'active' && !ended.has(x.id));
  const finish = (x: Sitting) => ends.find((e) => e.sitting.id === x.id);
  const same = sittings.find((x) => x.clientSittingId === input.clientSittingId);
  if (same) {
    const e = finish(same);
    return { kind: 'resume', sitting: e ? endedSitting(same, e.to, e.at) : same, ends };
  }
  const onThis = open.find((x) => x.problemSlug === input.problemSlug);
  if (onThis) return { kind: 'resume', sitting: onThis, ends };
  for (const x of open)
    if (repOf(x) || now - x.startedAt < CLAIM_IN_FLIGHT_MS) throw new Error(SITTING_ACTIVE_ERROR);
    else ends.push({ sitting: x, to: 'abandoned', at: now }); // a Start that died before making its rep
  // No sitting is open past this point, so the roll's open rep is free — one left by a sitting that ran out
  // its window is reused (one open rep per roll).
  const rep = findOpenRollTask(tasks, rollId);
  if (rep) return { kind: 'attach', rep, ends };
  return { kind: 'spawn', ends };
}
export const sittingProblemUrl = (slug: string) => `https://leetcode.com/problems/${slug}/`;
// A tag of at most 40 characters; blank is the default target.
export function normalizePrepTarget(v: unknown): string {
  if (typeof v !== 'string') throw new Error('Prep target must be text');
  const t = v.trim();
  if (!t) return PREP_TARGET_DEFAULT;
  if (t.length > 40) throw new Error('Prep target is limited to 40 characters');
  return t;
}
// The sitting a rep's finish ends, as the hook writes it: Done → done, anything else → abandoned.
export const endedSitting = (s: Sitting, rep: 'done' | 'abandoned', now: number): Sitting => ({
  ...s,
  status: rep,
  endedAt: now,
  updatedAt: Math.max(now, s.updatedAt + 1),
});

// --- The Start gate (types.ts LcStartGate): every Start counts an attempt before anything is read, and a new
// sitting claims the gate before its head is written, both CAS writes on the one row ---
type GateFields = Pick<
  LcStartGate,
  'day' | 'attempts' | 'starts' | 'openSittingId' | 'openClaimedAt'
>;
export const emptyGate = (day: string): GateFields => ({
  day,
  attempts: 0,
  starts: 0,
  openSittingId: null,
  openClaimedAt: null,
});
// Counts roll forward to a new day only — a call that worked out its day just before the rollover never
// resets a gate another call already moved on.
const onDay = <G extends GateFields>(g: G, day: string): G =>
  day > g.day ? { ...g, day, attempts: 0, starts: 0 } : g;
export function countStartAttempt<G extends GateFields>(g: G, day: string): G {
  const d = onDay(g, day);
  if (d.attempts >= LC_START_ATTEMPTS_PER_DAY) throw new Error(LC_START_ATTEMPT_CAP_ERROR);
  return { ...d, attempts: d.attempts + 1 };
}
// The claim for a new sitting `self`. Refused while the gate holds another sitting that's open by `sittings`
// (alive, as read for this Start, after its stale ends) — or one this Start can't see yet, claimed moments ago
// (a parallel Start). null = already this sitting's (a double-fired Start), nothing to write.
export function claimStart<G extends GateFields>(
  g: G,
  day: string,
  self: string,
  sittings: readonly Pick<Sitting, 'id' | 'status'>[],
  ended: ReadonlySet<string>,
  now: number,
): G | null {
  if (g.openSittingId === self) return null;
  const held = g.openSittingId;
  if (held) {
    const known = sittings.find((x) => x.id === held);
    const open = known
      ? known.status === 'active' && !ended.has(held)
      : now - (g.openClaimedAt ?? 0) < CLAIM_IN_FLIGHT_MS;
    if (open) throw new Error(SITTING_ACTIVE_ERROR);
  }
  const d = onDay(g, day);
  if (d.starts >= SITTING_STARTS_PER_DAY) throw new Error(SITTING_START_CAP_ERROR);
  return { ...d, starts: d.starts + 1, openSittingId: self, openClaimedAt: now };
}
export const releaseStart = <G extends GateFields>(g: G, id: string): G | null =>
  g.openSittingId === id ? { ...g, openSittingId: null, openClaimedAt: null } : null;

// --- Claude's live pull (live_sitting; docs/areas/recruiting) ---
// Open = still taking events: active and inside its window. One left active past it reads closed here without
// a write; the next Start ends it (planSittingStart).
export const isSittingOpen = (s: Pick<Sitting, 'status' | 'startedAt'>, now: number): boolean =>
  s.status === 'active' && now - s.startedAt <= SITTING_INGEST_WINDOW_MS;

// The newest event of a type by (at, id): ids are ULIDs, so a tie on `at` goes to the later one.
export function newestOfType<E extends { type: string; at: number; id: string }>(
  events: readonly E[],
  type: E['type'],
): E | null {
  let best: E | null = null;
  for (const e of events)
    if (e.type === type && (!best || e.at > best.at || (e.at === best.at && e.id > best.id)))
      best = e;
  return best;
}

// What a judged Run or Submit says beyond its verdict: the failing input, expected vs output, the error head.
// Field names are LeetCode's /check/ response as captured 2026-11-08 (a submit's last_testcase /
// expected_output / code_output, a run's code_answer / expected_code_answer with its input on the request's
// data_input — a run's code_output is its prints, so its answer is read first); the error fields are inferred
// from LeetCode's names, not yet captured. An unknown shape is all null, never a throw. Capped, so a huge case
// can't flood a reader.
export interface JudgeDetail {
  input: string | null;
  expected: string | null;
  output: string | null;
  error: string | null;
}
export const JUDGE_TEXT_MAX = 1024;
export const JUDGE_ERROR_MAX = 600;
const capText = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
function judgeText(v: unknown, max: number): string | null {
  const s =
    typeof v === 'string'
      ? v
      : Array.isArray(v) && v.every((x) => typeof x === 'string')
        ? v.join('\n')
        : null;
  return s ? capText(s, max) : null;
}
const firstText = (r: Record<string, unknown> | null, keys: string[], max: number) => {
  for (const k of keys) {
    const t = judgeText(r?.[k], max);
    if (t !== null) return t;
  }
  return null;
};
export function judgeDetail(payload: unknown): JudgeDetail {
  const p = obj(payload);
  const r = obj(p?.result);
  return {
    input:
      firstText(r, ['last_testcase', 'input_formatted', 'input'], JUDGE_TEXT_MAX) ??
      firstText(obj(p?.request), ['data_input'], JUDGE_TEXT_MAX),
    expected: firstText(r, ['expected_output', 'expected_code_answer'], JUDGE_TEXT_MAX),
    // A run's answer whenever it has one, even empty (an errored Run's []); a submit has none, so its output.
    output:
      r?.code_answer != null
        ? judgeText(r.code_answer, JUDGE_TEXT_MAX)
        : firstText(r, ['code_output'], JUDGE_TEXT_MAX),
    error: firstText(
      r,
      ['full_runtime_error', 'runtime_error', 'full_compile_error', 'compile_error'],
      JUDGE_ERROR_MAX,
    ),
  };
}

// --- The review (setSittingReview; docs/areas/recruiting → Review) ---
export const REVIEW_INSIGHT_MAX = 200;
export const REVIEW_MISTAKES_MAX = 8;
export const REVIEW_LINE_MAX = 160; // a mistake line, and a draft line
export const REVIEW_HOW_MAX = 1000;
export const REVIEW_TAGS_MAX = 10;
export const REVIEW_TAG_MAX = 40;
export const HELP_LEVELS: readonly HelpLevel[] = ['none', 'hint', 'solution'];
// The coach's cause tags (docs/areas/recruiting/coach.md): one per sitting, the aggregate the mistakes can't be.
export const CAUSE_TAGS: readonly CauseTag[] = [
  'no-trace',
  'api-slip',
  'boundary',
  'off-by-one',
  'quit-early',
];
export const isCauseTag = (v: unknown): v is CauseTag => CAUSE_TAGS.includes(v as CauseTag);
// `help` is optional like `cause` and `test`: absent keeps the stored one, so a form saved after a peek over MCP
// never writes the peek back over.
export type SittingReviewInput = Omit<SittingReview, 'updatedAt' | 'help'> & { help?: HelpLevel };

const fold = (s: string) => s.replace(/\s+/g, ' ').trim();
const reviewText = (v: unknown, label: string, max: number, oneLine: boolean): string | null => {
  if (v == null) return null;
  if (typeof v !== 'string') throw new Error(`${label} must be text`);
  const t = oneLine ? fold(v) : v.replace(/\r\n?/g, '\n').trim();
  if (t.length > max) throw new Error(`${label} is limited to ${max} characters`);
  return t || null;
};
const reviewList = (v: unknown, label: string): string[] => {
  if (v == null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string'))
    throw new Error(`${label} must be a list of text`);
  return (v as string[]).map(fold).filter(Boolean);
};
// The one normalizer every review write runs: whitespace folded, empties dropped, tags lowercased and deduped
// (order kept); over a cap throws naming the field, with nothing written. Nothing said → null (no review).
export function normalizeSittingReview(input: unknown): SittingReviewInput | null {
  const r = obj(input);
  if (!r) throw new Error('Review must be an object');
  if (r.help !== undefined && !HELP_LEVELS.includes(r.help as HelpLevel))
    throw new Error('Help must be none, hint or solution');
  const help = r.help as HelpLevel | undefined;
  const insight = reviewText(r.insight, 'One-liner', REVIEW_INSIGHT_MAX, true);
  const howItWent = reviewText(r.howItWent, 'How it went', REVIEW_HOW_MAX, false);
  const mistakes = reviewList(r.mistakes, 'Mistakes');
  if (mistakes.length > REVIEW_MISTAKES_MAX)
    throw new Error(`Mistakes are limited to ${REVIEW_MISTAKES_MAX}`);
  if (mistakes.some((m) => m.length > REVIEW_LINE_MAX))
    throw new Error(`A mistake is limited to ${REVIEW_LINE_MAX} characters`);
  const tags = [...new Set(reviewList(r.tags, 'Tags').map((t) => t.toLowerCase()))];
  if (tags.length > REVIEW_TAGS_MAX) throw new Error(`Tags are limited to ${REVIEW_TAGS_MAX}`);
  if (tags.some((t) => t.length > REVIEW_TAG_MAX))
    throw new Error(`A tag is limited to ${REVIEW_TAG_MAX} characters`);
  if (r.cause !== undefined && r.cause !== null && !isCauseTag(r.cause))
    throw new Error(`Cause must be one of ${CAUSE_TAGS.join(', ')}`);
  if (r.test !== undefined && typeof r.test !== 'boolean')
    throw new Error('Test must be true or false');
  const out: SittingReviewInput = {
    insight,
    ...(help !== undefined ? { help } : {}),
    mistakes,
    howItWent,
    tags,
    draftUsed: r.draftUsed === true && mistakes.length > 0,
    // Said only when sent: an absent help, cause or test keeps the stored one (mergeReview); a null cause clears it.
    ...(r.cause !== undefined ? { cause: r.cause as CauseTag | null } : {}),
    ...(r.test !== undefined ? { test: r.test as boolean } : {}),
  };
  // Nothing said (help explicitly none, nothing else) → null, which clears; with help absent, the merge decides.
  return isEmptyReview(out) && help !== undefined && r.cause === undefined && r.test === undefined
    ? null
    : out;
}
export const isEmptyReview = (r: SittingReviewInput): boolean =>
  !r.insight &&
  !r.howItWent &&
  !r.mistakes.length &&
  !r.tags.length &&
  (r.help ?? 'none') === 'none' &&
  !r.cause &&
  r.test !== true;
const EMPTY_REVIEW: SittingReviewInput = {
  insight: null,
  help: 'none',
  mistakes: [],
  howItWent: null,
  tags: [],
  draftUsed: false,
};
// The stored review after a write: `next`'s fields (null = the form cleared everything, help `none` included), with
// help, the cause and the test flag kept from `cur` unless `next` sends them, so the app form's Save never wipes a
// peek or a cause the coach set over MCP. All empty → null. The cause and flag are stored only when set.
export function mergeReview(
  cur: SittingReview | null | undefined,
  next: SittingReviewInput | null,
  now: number,
): SittingReview | null {
  const cause = next?.cause !== undefined ? next.cause : (cur?.cause ?? null);
  const test = next?.test !== undefined ? next.test : cur?.test === true;
  const n = next ?? EMPTY_REVIEW;
  const help: HelpLevel = next === null ? 'none' : (next.help ?? cur?.help ?? 'none');
  const merged = {
    insight: n.insight,
    help,
    mistakes: n.mistakes,
    howItWent: n.howItWent,
    tags: n.tags,
    draftUsed: n.draftUsed,
    ...(cause ? { cause } : {}),
    ...(test ? { test: true } : {}),
  };
  return isEmptyReview(merged) ? null : { ...merged, updatedAt: now };
}
// The coach's partial write (patchSittingReview): help, cause or the test flag onto the stored review, or onto
// an empty one when there's none yet.
export function patchReview(
  cur: SittingReview | null | undefined,
  patch: { cause?: CauseTag | null; help?: HelpLevel; test?: boolean },
  now: number,
): SittingReview | null {
  return mergeReview(cur, { ...(cur ?? EMPTY_REVIEW), ...patch }, now);
}
// The help the form starts on when there's no review yet: a hint once a submit failed before the accepted one.
export const suggestedHelp = (s: Pick<Sitting, 'summary'>): HelpLevel =>
  (s.summary.submitsBeforeAccepted ?? 0) > 0 ? 'hint' : 'none';

// --- The Claude draft (draftSittingReview): mistake lines only — the one-liner and how it went are the user's words ---
export const DRAFT_LINES_MAX = 5;
export const DRAFT_CODE_MAX = 4096; // each of the first-submit and the final code, in the prompt
export type DraftFailReason =
  | 'unavailable'
  | 'timeout'
  | 'network'
  | 'api'
  | 'bad-json'
  | 'bad-shape' // the model's answer wasn't a list of text (draftMistakes)
  | 'nothing-to-draft'; // no Run or Submit judged yet — no model call
export type ReviewDraft = { ok: true; mistakes: string[] } | { ok: false; reason: DraftFailReason };
// The model's `mistakes`, made fit: folded, empties dropped, a line over 160 characters cut to 160 ending "…",
// deduped, the first five kept. Only a non-list, or a list with a non-text item, is null (bad-shape); an empty
// list is a fair answer.
const clip = (l: string) => {
  if (l.length <= REVIEW_LINE_MAX) return l;
  const end = REVIEW_LINE_MAX - 1;
  const lead = l.charCodeAt(end - 1); // never split a surrogate pair (an emoji) at the cut
  return `${l.slice(0, lead >= 0xd800 && lead <= 0xdbff ? end - 1 : end).trimEnd()}…`;
};
export function draftMistakes(v: unknown): string[] | null {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return null;
  return [...new Set((v as string[]).map(fold).filter(Boolean).map(clip))].slice(
    0,
    DRAFT_LINES_MAX,
  );
}

// --- Reading a sitting back (the detail page, get_sitting, the draft's input) ---
// The judged Runs and Submits in time order, each with its verdict and failing case, and between them how many
// snapshots landed ("code changed ×N"). Snapshots are raw bulk that expires after SITTING_RAW_KEEP_MS, so an
// older sitting's markers are missing, never wrong.
export type TimelineEntry =
  | {
      kind: 'judged';
      id: string;
      type: 'run' | 'submit';
      n: number; // 1-based among its type
      at: number;
      offsetMs: number; // from the Start click, on the extension's clock
      verdict: SittingVerdict;
      detail: JudgeDetail;
    }
  | { kind: 'codeChanged'; count: number };
const byTime = <E extends { at: number; id: string }>(a: E, b: E) =>
  a.at - b.at || (a.id < b.id ? -1 : 1);
export function timelineOf(
  s: Pick<Sitting, 'clientStartedAt'>,
  events: readonly SittingEvent[],
): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  const n = { run: 0, submit: 0 };
  let changed = 0;
  for (const e of [...events].sort(byTime)) {
    if (e.type === 'snapshot') changed++;
    if (e.type !== 'run' && e.type !== 'submit') continue;
    if (changed) out.push({ kind: 'codeChanged', count: changed });
    changed = 0;
    out.push({
      kind: 'judged',
      id: e.id,
      type: e.type,
      n: ++n[e.type],
      at: e.at,
      offsetMs: Math.max(0, e.at - s.clientStartedAt),
      verdict: verdictOrOther(e.payload, e.at, e.type),
      detail: judgeDetail(e.payload),
    });
  }
  if (changed) out.push({ kind: 'codeChanged', count: changed });
  return out;
}
// The code as first submitted: the first Submit's request body (LeetCode's typed_code), or null.
export function firstSubmitCode(events: readonly SittingEvent[]): string | null {
  const first = [...events].sort(byTime).find((e) => e.type === 'submit');
  const code = obj(obj(first?.payload)?.request)?.typed_code;
  return typeof code === 'string' ? code : null;
}

// The problem statement as plain text, from questionDetail's `content` HTML (captured 2026-11-08): tags out,
// entities decoded, capped. An unknown shape → null.
export const PROBLEM_STATEMENT_MAX = 3072;
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
export function problemStatementText(problem: Pick<LeetcodeProblem, 'raw'> | null): string | null {
  const html = obj(problem?.raw)?.content;
  if (typeof html !== 'string') return null;
  const text = html
    .replace(/<sup>/gi, '^')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/p>|<br\s*\/?>|<\/pre>|<\/li>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
      const code =
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text ? capText(text, PROBLEM_STATEMENT_MAX) : null;
}
// The companies that asked it most lately: questionDetail's companyTagStatsV2 is a JSON string of
// {three_months, six_months, more_than_six_months: [{name, timesEncountered}]} (captured 2026-11-08). The
// most recent non-empty window, top three by count, names only. Unknown → [].
export function problemCompanies(problem: Pick<LeetcodeProblem, 'raw'> | null): string[] {
  const v = obj(problem?.raw)?.companyTagStatsV2;
  let stats: Record<string, unknown> | null;
  try {
    stats = obj(typeof v === 'string' ? JSON.parse(v) : v);
  } catch {
    return [];
  }
  for (const w of ['three_months', 'six_months', 'more_than_six_months']) {
    const list = stats && Array.isArray(stats[w]) ? (stats[w] as unknown[]) : [];
    const named = list
      .map(obj)
      .filter((c): c is Record<string, unknown> => !!c && typeof c.name === 'string' && !!c.name)
      .sort((a, b) => (num(b.timesEncountered) ?? 0) - (num(a.timesEncountered) ?? 0))
      .map((c) => capText(c.name as string, 60));
    if (named.length) return named.slice(0, 3);
  }
  return [];
}
