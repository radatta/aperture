// The LeetCode coach's engine (docs/areas/recruiting/coach.md): pure folds over the user's sittings and the few
// decisions they store (CoachAttempt, CoachDay, CoachFocus), so the stub and the Lambda can't drift. Nothing
// here writes; `today` is recomputed on every read, and the day's plan reads only what happened before the day,
// so it holds still all day.

import {
  addDays,
  daysBetween,
  fmtSpokenDay,
  isDayKey,
  isoWeekKey,
  USER_TIME_ZONE,
  zonedEpoch,
} from './dates';
import { CATALOGS, DEFAULT_CATALOG, catalogProblem, listsOf } from './catalogs';
import type { CatalogId } from './catalogs';
import { PATTERNS, PATTERN_NAMES, isPatternId } from './neetcode150';
import type { CatalogProblem, Difficulty, PatternId } from './neetcode150';
import {
  CAUSE_TAGS,
  HELP_LEVELS,
  isCauseTag,
  isSittingOpen,
  sittingElapsedMs,
  SITTING_INGEST_WINDOW_MS,
} from './sittings';
import type {
  AttemptOutcome,
  CauseTag,
  CoachAiReason,
  CoachAttempt,
  CoachDay,
  CoachDayAi,
  CoachFocus,
  CoachPlanMode,
  CoachSlotChange,
  CoachVoid,
  HelpLevel,
  LeetcodeVerdict,
  LegacyLeetcodeAttempt,
  Sitting,
  SlotKind,
} from './types';

export const CAUSE_NAMES: Record<CauseTag, string> = {
  'no-trace': 'No trace',
  'api-slip': 'API slip',
  boundary: 'Boundary',
  'off-by-one': 'Off by one',
  'quit-early': 'Quit early',
};
export const SLOT_KINDS: readonly SlotKind[] = ['carry-over', 'new', 're-solve', 'stretch'];
export const ATTEMPT_OUTCOMES: readonly AttemptOutcome[] = ['clean', 'solved', 'failed'];

// --- Parameters (never inline, so a later A/B arm is a parameter) ---
export interface CoachParams {
  // Days to the next re-solve, per step. `retry` is the track a failed attempt lands on (never accepted, or the
  // solution read) — named apart from the peeked flag, which only says the solution was read.
  gaps: { clean: readonly number[]; retry: readonly number[] };
  lastStepWindowDays: number; // the last step's due window
  capMin: number; // a slot's time cap
  carryOverDays: number; // a carry-over comes from the last active day only this recently
  blockDays: number; // active days a focus pattern holds
  swappedBackDays: number; // a problem swapped out this recently goes to the back of `new`
  minPracticeMin: number; // shorter, with no accepted submit, is a test sitting
  catchUp: { enterDue: number; exitDue: number }; // Auto plan mode: catch-up from enterDue due, balanced below exitDue
}
export const COACH_PARAMS: CoachParams = {
  gaps: { clean: [3, 7, 14], retry: [1, 3, 7, 14] },
  lastStepWindowDays: 7,
  capMin: 30,
  carryOverDays: 2,
  blockDays: 3,
  swappedBackDays: 3,
  minPracticeMin: 3,
  catchUp: { enterDue: 10, exitDue: 5 },
};
const MAX_PER_KIND = 2;
const MAX_SLOTS = 4;

// --- The working catalog: the plan's list (catalogs.ts), plus any problem the user has a record on ---
const PLAN_LIST = CATALOGS[DEFAULT_CATALOG].problems;
// A non-catalog problem's pattern from its LeetCode topic tags, the most specific tag first; else `other`.
const TAG_PATTERNS: [string, PatternId][] = [
  ['Trie', 'tries'],
  ['Shortest Path', 'advanced-graphs'],
  ['Minimum Spanning Tree', 'advanced-graphs'],
  ['Topological Sort', 'advanced-graphs'],
  ['Backtracking', 'backtracking'],
  ['Heap (Priority Queue)', 'heap'],
  ['Sliding Window', 'sliding-window'],
  ['Monotonic Stack', 'stack'],
  ['Stack', 'stack'],
  ['Linked List', 'linked-list'],
  ['Binary Search', 'binary-search'],
  ['Bit Manipulation', 'bit-manipulation'],
  ['Union Find', 'graphs'],
  ['Graph', 'graphs'],
  ['Breadth-First Search', 'graphs'],
  ['Binary Search Tree', 'trees'],
  ['Binary Tree', 'trees'],
  ['Tree', 'trees'],
  ['Dynamic Programming', 'dp-1d'],
  ['Greedy', 'greedy'],
  ['Two Pointers', 'two-pointers'],
  ['Geometry', 'math-geometry'],
  ['Math', 'math-geometry'],
  ['Hash Table', 'arrays-hashing'],
  ['Array', 'arrays-hashing'],
  ['String', 'arrays-hashing'],
];
export function patternOfTags(tags: readonly string[] | null): PatternId {
  const set = new Set((tags ?? []).map((t) => t.toLowerCase()));
  return TAG_PATTERNS.find(([t]) => set.has(t.toLowerCase()))?.[1] ?? 'other';
}
const asDifficulty = (v: string | null): Difficulty | null =>
  v === 'Easy' || v === 'Medium' || v === 'Hard' ? v : null;

// --- Attempts: one problem on one user day ---
// Test sittings never count: a sitting under minPracticeMin with no accepted submit and no peek, or one the user
// flagged.
export function countsAsPractice(
  s: Pick<Sitting, 'startedAt' | 'endedAt' | 'summary' | 'review' | 'idleMs'>,
  now: number,
  params: CoachParams = COACH_PARAMS,
): boolean {
  if (s.review?.test === true) return false;
  if (s.review?.help === 'solution') return true; // a quick peek is still a peek
  const end = s.endedAt ?? Math.min(now, s.startedAt + SITTING_INGEST_WINDOW_MS);
  const ms = sittingElapsedMs({ startedAt: s.startedAt, endedAt: end, idleMs: s.idleMs }, now);
  return s.summary.firstAcceptedAt !== null || ms >= params.minPracticeMin * 60_000;
}
export function outcomeOf(accepted: boolean, firstSubmitAccepted: boolean, help: HelpLevel) {
  if (!accepted || help === 'solution') return 'failed' as const;
  return firstSubmitAccepted && help === 'none' ? ('clean' as const) : ('solved' as const);
}
// The trace state at the first submit (sittings.ts foldCoach): a trace comment in the code before the first judged
// event is a hit, and so is the card at all three inputs. No trace data counts nowhere, nor does a sitting with the
// card off that the server never scanned for a comment (one from before the comment rule).
const tracedAtFirstSubmit = (c: Sitting['summary']['coach']): boolean | null => {
  if (c?.traceBy === 'comment') return true;
  if (!c?.trace || (c.config?.trace === false && !c.scanned)) return null;
  return c.trace === 'traced';
};
// A sitting's minutes on its problem: to the first accept (both on the extension's clock), else the whole sitting
// once it ended; null while it's open with no accept. At least 1.
export function sittingTryMinutes(
  s: Pick<Sitting, 'clientStartedAt' | 'startedAt' | 'endedAt' | 'summary'>,
): number | null {
  const ms =
    s.summary.firstAcceptedAt !== null
      ? s.summary.firstAcceptedAt - s.clientStartedAt
      : s.endedAt !== null
        ? s.endedAt - s.startedAt
        : null;
  return ms === null ? null : Math.max(1, Math.round(ms / 60_000));
}
// What one sitting says, as an attempt.
export function sittingAttempt(s: Sitting): Attempt {
  const help = s.review?.help ?? 'none';
  const accepted = s.summary.firstAcceptedAt !== null;
  const first = s.summary.firstSubmit;
  const firstSubmitAccepted = first ? first.verdict === 'accepted' : null;
  const last = s.summary.lastSubmit ?? s.summary.lastRun;
  return {
    slug: s.problemSlug,
    title: s.problemTitle,
    pattern: catalogProblem(s.problemSlug)?.pattern ?? patternOfTags(s.topicTags),
    difficulty: catalogProblem(s.problemSlug)?.difficulty ?? asDifficulty(s.difficulty),
    day: s.day,
    at: s.endedAt ?? s.startedAt,
    outcome: outcomeOf(accepted, firstSubmitAccepted === true, help),
    help,
    cause: s.review?.cause ?? null,
    accepted,
    firstSubmitAccepted,
    submits: s.summary.submits,
    runs: s.summary.runs,
    runFirst: first ? s.summary.runsBeforeFirstSubmit > 0 : null,
    traced: first ? tracedAtFirstSubmit(s.summary.coach) : null,
    lastError:
      last && last.verdict !== 'accepted'
        ? { verdict: last.verdict, statusMsg: last.statusMsg }
        : null,
    minutes: sittingTryMinutes(s),
    note: null,
    historical: false,
    sittingIds: [s.id],
    attemptIds: [],
    sources: ['sitting'],
  };
}
export function manualAttempt(a: CoachAttempt): Attempt {
  const cat = catalogProblem(a.slug);
  return {
    slug: a.slug,
    title: a.title ?? cat?.title ?? a.slug,
    pattern: cat?.pattern ?? 'other',
    difficulty: cat?.difficulty ?? a.difficulty ?? null,
    day: a.day,
    at: a.at,
    outcome: a.outcome,
    help: a.help,
    cause: a.cause,
    accepted: a.accepted ?? a.outcome !== 'failed', // a peek after an accept stays failed, but accepted
    firstSubmitAccepted: a.outcome === 'clean', // a manual solved or failed was no first-try accept
    submits: 0,
    runs: 0,
    runFirst: null,
    traced: null,
    lastError: null,
    minutes: a.minutes,
    note: a.note,
    historical: a.historical === true,
    sittingIds: [],
    attemptIds: [a.id],
    sources: [a.source],
  };
}
export interface Attempt {
  slug: string;
  title: string;
  pattern: PatternId;
  difficulty: Difficulty | null;
  day: string;
  at: number;
  outcome: AttemptOutcome;
  help: HelpLevel;
  cause: CauseTag | null;
  accepted: boolean;
  firstSubmitAccepted: boolean | null;
  submits: number;
  runs: number;
  runFirst: boolean | null; // a Run before the first submit; null with no captured submit
  traced: boolean | null; // all three trace inputs stood at the first submit; null with no trace data or the card off
  lastError: { verdict: LeetcodeVerdict; statusMsg: string | null } | null;
  minutes: number | null; // the day's minutes on it: sittings to the first accept (else their length), logged ones as given
  note: string | null; // the newest logged note
  historical: boolean; // a history-only solve (CoachAttempt.historical): seen, never scheduled or counted
  sittingIds: string[]; // newest first
  attemptIds: string[]; // the logged attempts' (CoachAttempt) ids, newest first
  sources: AttemptSource[];
}
export type AttemptSource = 'sitting' | 'legacy' | CoachAttempt['source'];
const HELP_RANK: Record<HelpLevel, number> = { none: 0, hint: 1, solution: 2 };
// Same-day pieces on one problem fold into one attempt, judged as one first try: clean only when the earliest
// piece with a submit was a first-submit accept and no help was taken all day; accepted anywhere → solved; else
// failed. The most help taken wins (a peek sticks); counts are summed.
function foldDay(parts: Attempt[]): Attempt {
  const sorted = [...parts].sort((a, b) => a.at - b.at);
  const last = sorted[sorted.length - 1]!;
  const help = sorted.reduce<HelpLevel>(
    (h, p) => (HELP_RANK[p.help] > HELP_RANK[h] ? p.help : h),
    'none',
  );
  const accepted = sorted.some((p) => p.accepted);
  const first = sorted.find((p) => p.firstSubmitAccepted !== null);
  const outcome = outcomeOf(accepted, first?.firstSubmitAccepted === true, help);
  return {
    ...last,
    // A captured title (a sitting's, then the legacy capture's) over a logged one, and any over the bare slug.
    title:
      sorted.find((p) => p.sources.includes('sitting'))?.title ??
      sorted.find((p) => p.sources.includes('legacy'))?.title ??
      [...sorted].reverse().find((p) => p.title !== p.slug)?.title ??
      last.title,
    pattern: sorted.find((p) => p.pattern !== 'other')?.pattern ?? last.pattern,
    difficulty: sorted.find((p) => p.difficulty)?.difficulty ?? null,
    outcome,
    help,
    cause: [...sorted].reverse().find((p) => p.cause)?.cause ?? null,
    accepted,
    firstSubmitAccepted: first?.firstSubmitAccepted ?? null,
    submits: sorted.reduce((n, p) => n + p.submits, 0),
    runs: sorted.reduce((n, p) => n + p.runs, 0),
    // The first captured submit's: a logged piece never has one, so it can't blank a sitting's run or trace.
    runFirst: sorted.find((p) => p.runFirst !== null)?.runFirst ?? null,
    traced: sorted.find((p) => p.runFirst !== null)?.traced ?? null,
    lastError: [...sorted].reverse().find((p) => p.submits || p.runs)?.lastError ?? null,
    minutes: sorted.some((p) => p.minutes !== null)
      ? sorted.reduce((n, p) => n + (p.minutes ?? 0), 0)
      : null,
    note: [...sorted].reverse().find((p) => p.note)?.note ?? null,
    historical: sorted.every((p) => p.historical),
    sittingIds: sorted.flatMap((p) => p.sittingIds).reverse(),
    attemptIds: sorted.flatMap((p) => p.attemptIds).reverse(),
    sources: [...new Set(sorted.flatMap((p) => p.sources))],
  };
}
// Every counted attempt, oldest first. An open sitting is not an attempt yet (it's today's `in-progress`) — except
// one from before `today`: a sitting left open overnight counts on its own day, so the day's plan doesn't move
// when a later Start ends it.
// `more`: the legacy capture's rows and the stored voids (legacyAttempts) — every coach read passes its input's.
export function attemptsOf(
  sittings: readonly Sitting[],
  manual: readonly CoachAttempt[],
  now: number,
  params: CoachParams = COACH_PARAMS,
  today?: string,
  more: Pick<CoachInput, 'legacy' | 'voids'> = {},
): Attempt[] {
  const settled = (s: Sitting) => !isSittingOpen(s, now) || (today !== undefined && s.day < today);
  return foldDays([
    ...sittings.filter((s) => settled(s) && countsAsPractice(s, now, params)).map(sittingAttempt),
    ...manual.filter((a) => a.deletedAt === null && a.historical !== true).map(manualAttempt),
    ...legacyAttempts(more.legacy ?? [], more.voids ?? []),
  ]);
}
// The history-only solves (logged with `historical`), folded by day the same way, oldest first. They never reach
// attemptsOf: a remembered result isn't a measured try, so they only mark a problem seen and show on Progress.
function historyAttemptsOf(manual: readonly CoachAttempt[]): Attempt[] {
  return foldDays(
    manual.filter((a) => a.deletedAt === null && a.historical === true).map(manualAttempt),
  );
}
function foldDays(parts: Attempt[]): Attempt[] {
  const groups = new Map<string, Attempt[]>();
  for (const p of parts) {
    const k = `${p.day} ${p.slug}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  return [...groups.values()]
    .map(foldDay)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.at - b.at));
}

// --- Legacy history: the pre-sittings extension's submissions (lc#, read-only; coach.md → Legacy history) ---
// Legacy groups excluded unless the user lifts them (a stored void: false): the extension was tested on these.
// Applied to legacy pieces only — never to a sitting or a logged attempt. `day` narrows an entry to one day.
export const LEGACY_TEST_DEFAULTS: readonly { slug: string; day?: string }[] = [{ slug: 'two-sum' }];
export const COACH_VOIDS_MAX = 50;
export const coachVoidId = (day: string, slug: string) => `${day}#${slug}`;
export interface LegacyGroup {
  day: string;
  slug: string;
  title: string;
  difficulty: Difficulty | null;
  submits: number;
  accepted: boolean;
  firstSubmitAccepted: boolean;
  counted: boolean;
  voidedBy: 'you' | 'default' | null; // why it doesn't count
}
// Whether a legacy (day, slug) group counts: a stored void row wins, then the default list, else it counts.
export function legacyVoidedBy(
  day: string,
  slug: string,
  voids: readonly CoachVoid[],
): LegacyGroup['voidedBy'] {
  const row = voids.find((v) => v.deletedAt === null && v.day === day && v.slug === slug);
  if (row) return row.void ? 'you' : null;
  return LEGACY_TEST_DEFAULTS.some((d) => d.slug === slug && (d.day === undefined || d.day === day))
    ? 'default'
    : null;
}
// Every legacy (day, slug) group, oldest day first, with whether it counts.
export function legacyGroups(
  rows: readonly LegacyLeetcodeAttempt[],
  voids: readonly CoachVoid[],
): LegacyGroup[] {
  const groups = new Map<string, LegacyLeetcodeAttempt[]>();
  for (const r of rows) {
    if (r.deletedAt !== null) continue;
    const k = `${r.day} ${r.problemSlug}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()]
    .map((list) => {
      const sorted = [...list].sort((a, b) => a.submittedAt - b.submittedAt);
      const first = sorted[0]!;
      const cat = catalogProblem(first.problemSlug);
      const voidedBy = legacyVoidedBy(first.day, first.problemSlug, voids);
      return {
        day: first.day,
        slug: first.problemSlug,
        title: cat?.title ?? (first.problemTitle || first.problemSlug),
        difficulty: cat?.difficulty ?? asDifficulty(first.difficulty),
        submits: sorted.length,
        accepted: sorted.some((r) => r.verdict === 'accepted'),
        firstSubmitAccepted: first.verdict === 'accepted',
        counted: voidedBy === null,
        voidedBy,
      };
    })
    .sort((a, b) => a.day.localeCompare(b.day) || a.slug.localeCompare(b.slug));
}
// The counted legacy groups as attempt pieces: judged like a sitting's submits (the earliest one decides the first
// try), no help (the capture couldn't see a peek; a logged peek the same day still wins in foldDay), no runs.
export function legacyAttempts(
  rows: readonly LegacyLeetcodeAttempt[],
  voids: readonly CoachVoid[],
): Attempt[] {
  if (!rows.length) return [];
  const bySlugDay = new Map<string, LegacyLeetcodeAttempt[]>();
  for (const r of rows) {
    if (r.deletedAt !== null || legacyVoidedBy(r.day, r.problemSlug, voids) !== null) continue;
    const k = `${r.day} ${r.problemSlug}`;
    bySlugDay.set(k, [...(bySlugDay.get(k) ?? []), r]);
  }
  return [...bySlugDay.values()].map((list) => {
    const sorted = [...list].sort((a, b) => a.submittedAt - b.submittedAt);
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const cat = catalogProblem(first.problemSlug);
    const accepted = sorted.some((r) => r.verdict === 'accepted');
    const firstSubmitAccepted = first.verdict === 'accepted';
    return {
      slug: first.problemSlug,
      title: cat?.title ?? (first.problemTitle || first.problemSlug),
      pattern: cat?.pattern ?? patternOfTags(first.topicTags),
      difficulty: cat?.difficulty ?? asDifficulty(first.difficulty),
      day: first.day,
      at: first.submittedAt,
      outcome: outcomeOf(accepted, firstSubmitAccepted, 'none'),
      help: 'none',
      cause: null,
      accepted,
      firstSubmitAccepted,
      submits: sorted.length,
      runs: 0,
      runFirst: null,
      traced: null,
      lastError: last.verdict !== 'accepted' ? { verdict: last.verdict, statusMsg: null } : null,
      sittingIds: [],
      attemptIds: [],
      sources: ['legacy'],
    };
  });
}

// --- The re-solve scheduler ---
export interface ResolveState {
  track: 'clean' | 'retry';
  step: number; // index into the track's gaps
  lastDay: string;
  dueDay: string;
  dueBy: string | null; // the last step's window end
  graduated: boolean; // past the last step: dormant
}
const stepState = (
  track: ResolveState['track'],
  step: number,
  day: string,
  params: CoachParams,
): ResolveState => {
  const gaps = params.gaps[track];
  const dueDay = addDays(day, gaps[step]!);
  return {
    track,
    step,
    lastDay: day,
    dueDay,
    dueBy: step === gaps.length - 1 ? addDays(dueDay, params.lastStepWindowDays) : null,
    graduated: false,
  };
};
function nextState(
  st: ResolveState | null,
  a: Pick<Attempt, 'day' | 'outcome'>,
  params: CoachParams,
): ResolveState {
  if (a.outcome === 'failed') return stepState('retry', 0, a.day, params);
  if (!st) return stepState('clean', 0, a.day, params);
  if (st.graduated) return { ...st, lastDay: a.day };
  if (a.outcome === 'solved') return stepState(st.track, st.step, a.day, params);
  if (st.step + 1 < params.gaps[st.track].length)
    return stepState(st.track, st.step + 1, a.day, params);
  return { ...st, lastDay: a.day, dueBy: null, graduated: true };
}
// One problem's attempts, oldest first → its schedule. A first try clean or solved starts the clean track, a
// failed one the retry track; a clean re-solve steps on (past the last → graduated), a solved one repeats the
// same gap from its day, a failed one restarts the retry track.
export function resolveState(
  attempts: readonly Pick<Attempt, 'day' | 'outcome'>[],
  params: CoachParams = COACH_PARAMS,
): ResolveState | null {
  let st: ResolveState | null = null;
  for (const a of attempts) st = nextState(st, a, params);
  return st;
}

// --- Problem records (derived on read, never stored) ---
export interface ProblemRecord {
  slug: string;
  title: string;
  pattern: PatternId;
  difficulty: Difficulty | null;
  inCatalog: boolean;
  attempts: number; // days tried
  firstDay: string;
  firstOutcome: AttemptOutcome; // the first try — the focus ranking's input
  everAccepted: boolean;
  firstSubmitAccepted: boolean | null; // the newest attempt's
  submits: number;
  runs: number;
  lastError: Attempt['lastError'];
  peeked: boolean; // the solution was read on any attempt
  cause: CauseTag | null; // the newest attempt's
  causes: Partial<Record<CauseTag, number>>;
  lastDay: string;
  lastOutcome: AttemptOutcome;
  schedule: ResolveState | null; // over live tries only: a history-only problem has none
  historical: { tries: number; firstDay: string; lastDay: string } | null; // its history-only solves
  lists: CatalogId[]; // the problem lists it's on (catalogs.ts); [] = off every list
  sittingIds: string[]; // newest first, ≤ 10
  tries: ProblemTry[]; // every attempt, history-only ones too, oldest first — get_problem's history, delete_attempt's ids
}
export interface ProblemTry {
  day: string;
  outcome: AttemptOutcome;
  help: HelpLevel;
  cause: CauseTag | null;
  minutes: number | null;
  note: string | null;
  historical: boolean;
  sittingIds: string[];
  attemptIds: string[];
  sources: AttemptSource[]; // where the try came from: a sitting, a logged attempt, the legacy capture
}
// The base fields come from the live tries when there are any, else from the history-only ones; the schedule only
// ever from live tries, so a history-only problem never comes due. `history` is historyAttemptsOf's.
export function problemRecords(
  attempts: readonly Attempt[],
  params: CoachParams = COACH_PARAMS,
  history: readonly Attempt[] = [],
): ProblemRecord[] {
  const live = new Map<string, Attempt[]>();
  for (const a of attempts) live.set(a.slug, [...(live.get(a.slug) ?? []), a]);
  const past = new Map<string, Attempt[]>();
  for (const a of history) past.set(a.slug, [...(past.get(a.slug) ?? []), a]);
  return [...new Set([...live.keys(), ...past.keys()])].map((slug) => {
    const own = live.get(slug) ?? [];
    const old = past.get(slug) ?? [];
    const list = own.length ? own : old;
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const cat = catalogProblem(slug);
    const causes: Partial<Record<CauseTag, number>> = {};
    for (const a of own) if (a.cause) causes[a.cause] = (causes[a.cause] ?? 0) + 1;
    const every = [...old, ...own].sort((a, b) =>
      a.day < b.day ? -1 : a.day > b.day ? 1 : a.at - b.at,
    );
    return {
      slug,
      // Off the catalog: the newest real title (a later untitled log must not revert it to the slug), the newest
      // difficulty known.
      title: cat?.title ?? [...list].reverse().find((a) => a.title !== slug)?.title ?? last.title,
      pattern: cat?.pattern ?? last.pattern,
      difficulty:
        cat?.difficulty ?? [...list].reverse().find((a) => a.difficulty)?.difficulty ?? null,
      inCatalog: !!cat,
      attempts: list.length,
      firstDay: first.day,
      firstOutcome: first.outcome,
      everAccepted: list.some((a) => a.accepted),
      firstSubmitAccepted: last.firstSubmitAccepted,
      submits: list.reduce((n, a) => n + a.submits, 0),
      runs: list.reduce((n, a) => n + a.runs, 0),
      lastError: last.lastError,
      peeked: list.some((a) => a.help === 'solution'),
      cause: last.cause,
      causes,
      lastDay: last.day,
      lastOutcome: last.outcome,
      schedule: own.length ? resolveState(own, params) : null,
      historical: old.length
        ? { tries: old.length, firstDay: old[0]!.day, lastDay: old[old.length - 1]!.day }
        : null,
      lists: listsOf(slug),
      sittingIds: own
        .flatMap((a) => a.sittingIds)
        .reverse()
        .slice(0, 10),
      tries: every.map((a) => ({
        day: a.day,
        outcome: a.outcome,
        help: a.help,
        cause: a.cause,
        minutes: a.minutes,
        note: a.note,
        historical: a.historical,
        sittingIds: a.sittingIds,
        attemptIds: a.attemptIds,
        sources: a.sources,
      })),
    };
  });
}

// --- Focus: one pattern held for blockDays active days ---
const PATTERN_ORDER = new Map<PatternId, number>(PATTERNS.map((p, i) => [p, i]));
const orderOf = (p: PatternId) => PATTERN_ORDER.get(p) ?? PATTERNS.length; // 'other' last
export interface Ranked {
  pattern: PatternId;
  misses: number;
  of: number;
}
// What the engine reads beyond the live attempts: whether Premium problems can be picked (Settings.leetcodePremium),
// and the history-only solves, slug → its earliest day. Absent = Premium never picked, no history: the engine as
// it was.
export interface CoachScope {
  premium: boolean;
  history: ReadonlyMap<string, string>;
}
const NO_SCOPE: CoachScope = { premium: false, history: new Map() };
export function coachScope(ci: Pick<CoachInput, 'attempts' | 'premium'>): CoachScope {
  const history = new Map<string, string>();
  for (const a of historyAttemptsOf(ci.attempts))
    if (!history.has(a.slug)) history.set(a.slug, a.day);
  return { premium: ci.premium === true, history };
}
// A live try on a problem with a history-only solve dated before it: seen already, so never a first try.
const historyBefore = (scope: CoachScope, a: Pick<Attempt, 'slug' | 'day'>) => {
  const h = scope.history.get(a.slug);
  return h !== undefined && h < a.day;
};
// Slugs seen before `day`: live attempts and history-only solves alike.
const seenBefore = (attempts: readonly Attempt[], scope: CoachScope, day: string) =>
  new Set([
    ...attempts.filter((a) => a.day < day).map((a) => a.slug),
    ...[...scope.history].filter(([, d]) => d < day).map(([slug]) => slug),
  ]);
// Patterns by a shrunk first-try miss rate, (misses + 1) / (first tries + 2), as of `day` (attempts before it),
// ties by the roadmap order; a pattern with no unseen catalog problem left drops out. A live try after a
// history-only solve on the same problem is no first try (a re-solve); one before it still is.
export function rankPatterns(
  attempts: readonly Attempt[],
  day: string,
  scope: CoachScope = NO_SCOPE,
): Ranked[] {
  const firsts = new Map<string, Attempt>();
  const met = new Set<string>();
  for (const a of attempts) {
    if (a.day >= day || met.has(a.slug)) continue;
    met.add(a.slug);
    if (!historyBefore(scope, a)) firsts.set(a.slug, a);
  }
  const seen = seenBefore(attempts, scope, day);
  const stat = new Map<PatternId, Ranked>();
  for (const a of firsts.values()) {
    const r = stat.get(a.pattern) ?? { pattern: a.pattern, misses: 0, of: 0 };
    stat.set(a.pattern, { ...r, misses: r.misses + (a.outcome === 'clean' ? 0 : 1), of: r.of + 1 });
  }
  const score = (r: Ranked) => (r.misses + 1) / (r.of + 2);
  return PATTERNS.filter((p) =>
    PLAN_LIST.some((c) => c.pattern === p && pickable(c, seen, scope.premium)),
  )
    .map((p) => stat.get(p) ?? { pattern: p, misses: 0, of: 0 })
    .sort(
      (a, b) =>
        score(b) - score(a) || PATTERN_ORDER.get(a.pattern)! - PATTERN_ORDER.get(b.pattern)!,
    );
}
export interface CoachFocusState {
  pattern: PatternId;
  day: number; // 1..blockDays
  of: number;
  source: 'engine' | 'override' | 'ai';
  why: string;
}
const whyRanked = (r: Ranked | undefined, p: PatternId) =>
  r && r.of
    ? `${PATTERN_NAMES[p]}: the weakest first tries (${r.misses} of ${r.of} not clean)`
    : `${PATTERN_NAMES[p]}: next in the roadmap order`;
// Deterministic replay, so a read writes nothing: from the anchor (the override's day, else the first counted
// attempt), every blockDays active days is a block; block 0 is the override's pattern (else the top-ranked as of
// the anchor), each later block the top-ranked as of its first day, never the previous block's pattern.
export function focusOn(
  attempts: readonly Attempt[],
  override: (Pick<CoachFocus, 'pattern' | 'sinceDay'> & Partial<Pick<CoachFocus, 'source'>>) | null,
  today: string,
  params: CoachParams = COACH_PARAMS,
  scope: CoachScope = NO_SCOPE,
): CoachFocusState {
  const days = [...new Set(attempts.map((a) => a.day))].sort();
  const anchor = override?.sinceDay ?? days[0] ?? today;
  const active = days.filter((d) => d >= anchor && d < today);
  const blocks = Math.floor(active.length / params.blockDays);
  const top = (day: string, not: PatternId | null) =>
    rankPatterns(attempts, day, scope).find((r) => r.pattern !== not);
  let ranked = override ? undefined : top(anchor, null);
  let pattern: PatternId = override?.pattern ?? ranked?.pattern ?? PATTERNS[0];
  for (let k = 1; k <= blocks; k++) {
    ranked = top(active[k * params.blockDays] ?? today, pattern);
    pattern = ranked?.pattern ?? pattern;
  }
  const held = override && blocks === 0;
  return {
    pattern,
    day: (active.length % params.blockDays) + 1,
    of: params.blockDays,
    source: held ? (override.source === 'ai' ? 'ai' : 'override') : 'engine',
    why: held
      ? `${PATTERN_NAMES[pattern]}: ${override.source === 'ai' ? 'Opus’s' : 'your'} pick since ${fmtSpokenDay(override.sinceDay, today)}`
      : whyRanked(ranked, pattern),
  };
}

// --- The day's plan ---
export interface CoachSlot {
  kind: SlotKind;
  slug: string;
  title: string;
  pattern: PatternId;
  difficulty: Difficulty | null;
  url: string;
  reason: string;
  capMin: number;
  dueAt: number; // the end of the user's day
  status: 'open' | 'in-progress' | 'done' | 'skipped';
  sittingId: string | null;
  outcome: AttemptOutcome | null;
  swappedFrom: string | null; // the engine's pick, when the user swapped it
  alternatives: { slug: string; title: string; difficulty: Difficulty }[]; // easier, same pattern
  aiWhy: string | null; // the AI pick's "why today"; null on a rule slot (and on a slot swapped in)
}
export interface QueueItem {
  slug: string;
  title: string;
  pattern: PatternId;
  difficulty: Difficulty | null;
  track: ResolveState['track'];
  step: number;
  dueDay: string;
  dueAt: number; // the start of dueDay
  lastDay: string;
}
export interface CoachToday {
  day: string;
  mode: 'general' | 'countdown';
  target: null; // countdown mode's interview, later
  arm: null; // an A/B arm, later
  focus: CoachFocusState;
  slots: CoachSlot[];
  floor: {
    kind: SlotKind; // what the floor problem is: a due re-solve, the carry-over, or the new pick
    slug: string;
    title: string;
    reason: string;
    on: boolean; // the user chose a floor day
    done: boolean;
  } | null;
  offPlan: { sittingId: string; slug: string; title: string }[];
  due: QueueItem[];
  next48h: QueueItem[];
  momentum: {
    activeDays: number;
    of: 7;
    lastActiveDay: string | null;
    missedYesterday: boolean;
  };
  unreviewed: { sittingId: string; slug: string; title: string }[];
  // Ended sittings with no Claude's notes yet (the last NOTES_CATCHUP_DAYS days, newest first, ≤ 20): a new thread
  // offers to write them (set_claude_notes) — the catch-up when the user left without telling it.
  unnoted: { sittingId: string; slug: string; title: string; day: string }[];
  ai: CoachAiView | null; // null: the AI pick is off, or nothing to pick from
  planMode: CoachPlanModeView;
}
// The day's slot mix: the setting, the mode it resolved to today, the due count it read, and the one line a
// client shows ("Catch-up: 31 due").
export interface CoachPlanModeView {
  setting: CoachPlanMode;
  mode: 'balanced' | 'catch-up';
  due: number;
  line: string;
}
export const NOTES_CATCHUP_DAYS = 14;
const NOTES_CATCHUP_MAX = 20;
// The day's AI pick as the plan shows it. `due`: a pick should start (startCoachPick); `pending`: it's running —
// the slots are the rules' until it lands, and a client shows neither; `fallback`: the rules, said out loud.
export interface CoachAiView {
  status: 'due' | 'pending' | 'ok' | 'fallback';
  source: 'ai' | 'rules';
  notice: string | null; // AI_PICK_NOTICE on a fallback — never silent
  reason: CoachAiReason | null;
  note: string | null; // the model's day note
  focusChange: { from: PatternId; to: PatternId; why: string } | null; // only while the focus it set holds
  model: string | null;
  pickedAt: number | null;
}
export const AI_PICK_NOTICE = 'AI pick unavailable today, using the rules';
// A claim older than this reads as a timeout: the worker's ≤ 20 s queue + 60 s call + writes end inside its 90 s
// timeout, so a result can never land after readers saw the day fall back.
export const AI_PICK_STALE_MS = 120_000;
// Live: a claim the worker may still settle. A slot change waits for it (the slots are about to be replaced).
export const aiPickPending = (ai: CoachDayAi | undefined, now: number): boolean =>
  ai?.status === 'pending' && now - ai.claimedAt <= AI_PICK_STALE_MS;
export interface CoachInput {
  today: string;
  now: number;
  dayStartHour: number;
  sittings: readonly Sitting[]; // alive heads
  attempts: readonly CoachAttempt[]; // alive
  days: readonly CoachDay[]; // alive
  focus: CoachFocus | null;
  aiPick?: boolean; // the setting (and the feature) is on: a stored AI pick overlays the rule slots
  aiCanStart?: boolean; // and a pick may start now: the server's today, with a worker to run it
  premium?: boolean; // Settings.leetcodePremium: Premium problems can be picked; absent = never
  legacy?: readonly LegacyLeetcodeAttempt[]; // the pre-sittings capture (read-only), alive
  voids?: readonly CoachVoid[]; // legacy groups' stored void states
  planMode?: CoachPlanMode; // the setting; absent → auto
}
// The CoachInput fields attemptsOf reads beyond the sittings and logged attempts.
const moreOf = (ci: Pick<CoachInput, 'legacy' | 'voids'>) => ({ legacy: ci.legacy, voids: ci.voids });

const UP: Record<Difficulty, Difficulty | null> = { Easy: 'Medium', Medium: 'Hard', Hard: null };
const DIFF_RANK: Record<Difficulty, number> = { Easy: 0, Medium: 1, Hard: 2 };
const dayStartHhmm = (h: number) => `${String(h).padStart(2, '0')}:00`;
const dayStartAt = (day: string, h: number) => zonedEpoch(day, dayStartHhmm(h), USER_TIME_ZONE);
// A catalog problem the plan may offer: never seen, and not Premium unless Premium can be picked
// (Settings.leetcodePremium). The AI pick's candidates use it too.
export const pickable = (c: CatalogProblem, seen: ReadonlySet<string>, premium = false) =>
  (premium || !c.premium) && !seen.has(c.slug);

// Every problem on the plan: each slot's, and each engine pick a swap replaced.
const slotProblems = (slots: readonly Pick<CoachSlot, 'slug' | 'swappedFrom'>[]) =>
  new Set(slots.flatMap((s) => (s.swappedFrom ? [s.slug, s.swappedFrom] : [s.slug])));
// Unseen catalog problems in `pattern` strictly easier than `than`, the nearest level first (Hard → Medium before
// Easy), then catalog order; only when the pattern has nothing easier left, the same difficulty — a slot's
// "Another", and swap_slot's default. `than` null (an unknown difficulty) reads as Hard.
export function easierIn(
  pattern: PatternId,
  than: Difficulty | null,
  seen: ReadonlySet<string>,
  not: ReadonlySet<string>,
  premium = false,
): CatalogProblem[] {
  const cap = than ? DIFF_RANK[than] : 2;
  const open = PLAN_LIST.filter(
    (c) => c.pattern === pattern && pickable(c, seen, premium) && !not.has(c.slug),
  );
  const easier = open
    .filter((c) => DIFF_RANK[c.difficulty] < cap)
    .sort((a, b) => DIFF_RANK[b.difficulty] - DIFF_RANK[a.difficulty]);
  return easier.length ? easier : open.filter((c) => DIFF_RANK[c.difficulty] === cap);
}

// A re-solve slot's reason: today's rule first, then why it's due.
const resolveReason = (r: ProblemRecord, today: string) => {
  const due = r.schedule!.dueDay;
  const when = due === today ? 'Due today' : `Due since ${fmtSpokenDay(due, today)}`;
  return `Re-solve today: blank editor, no hints. ${when} (${r.schedule!.track} track, step ${r.schedule!.step + 1}); last tried ${fmtSpokenDay(r.lastDay, today)}`;
};
const queueItem = (r: ProblemRecord, h: number): QueueItem => ({
  slug: r.slug,
  title: r.title,
  pattern: r.pattern,
  difficulty: r.difficulty,
  track: r.schedule!.track,
  step: r.schedule!.step,
  dueDay: r.schedule!.dueDay,
  dueAt: dayStartAt(r.schedule!.dueDay, h),
  lastDay: r.schedule!.lastDay,
});

// Everything the day's plan picks from, as of the start of the day — the rules' pools, and the AI pick's
// candidates (coachAi.ts) are cut from the same pools so the two can't drift.
export interface CoachPools {
  all: Attempt[]; // counted, through today
  before: Attempt[]; // before today
  records: ProblemRecord[]; // from `before`
  seen: Set<string>;
  focus: CoachFocusState;
  ranks: Ranked[];
  carry: Attempt[];
  fresh: CatalogProblem[]; // unseen in the focus pattern, swapped-out last
  due: ProblemRecord[]; // due re-solves, oldest first, the carry-over out
  stretch: CatalogProblem[];
  cands: Record<SlotKind, { slug: string; reason: string }[]>; // each kind's, in the rules' order
  row: CoachDay | null; // today's
  planMode: CoachPlanModeView;
}
// From state as of the start of the day: carry-over (the last active day's unaccepted, unpeeked problem, if
// within carryOverDays), new (the focus pattern's next unseen problem), re-solve (the oldest due, other patterns
// first, retry track first), stretch (one difficulty up in the focus pattern, else an unseen Medium from the
// next-ranked pattern).
export function coachPools(input: CoachInput, params: CoachParams = COACH_PARAMS): CoachPools {
  const { today, now } = input;
  const all = attemptsOf(input.sittings, input.attempts, now, params, today, moreOf(input)).filter(
    (a) => a.day <= today,
  );
  const before = all.filter((a) => a.day < today);
  const scope = coachScope(input);
  const history = historyAttemptsOf(input.attempts).filter((a) => a.day < today);
  const records = problemRecords(before, params, history);
  const seen = new Set(records.map((r) => r.slug));
  const focus = focusOn(all, input.focus, today, params, scope);
  const ranks = rankPatterns(before, today, scope);

  // carry-over
  const lastActive = before.length ? before[before.length - 1]!.day : null;
  const carry =
    lastActive && daysBetween(lastActive, today) <= params.carryOverDays
      ? before
          .filter((a) => a.day === lastActive && !a.accepted && a.help !== 'solution')
          .reverse()
          .slice(0, 1) // one carry-over (no kind spills into it); any other stays a due re-solve
      : [];
  const carrySlugs = new Set(carry.map((a) => a.slug));
  // new
  const recentDays = input.days.filter(
    (d) => d.day < today && d.day >= addDays(today, -params.swappedBackDays),
  );
  const swappedOut = new Set(
    recentDays.flatMap((d) => d.changes.filter((c) => c.action === 'swap').map((c) => c.from)),
  );
  const unseen = PLAN_LIST.filter(
    (c) => c.pattern === focus.pattern && pickable(c, seen, scope.premium),
  );
  const fresh = [
    ...unseen.filter((c) => !swappedOut.has(c.slug)),
    ...unseen.filter((c) => swappedOut.has(c.slug)),
  ];
  // re-solve
  const due = records
    .filter((r) => r.schedule && !r.schedule.graduated && r.schedule.dueDay <= today)
    .sort(
      (a, b) =>
        a.schedule!.dueDay.localeCompare(b.schedule!.dueDay) ||
        (a.schedule!.track === b.schedule!.track ? 0 : a.schedule!.track === 'retry' ? -1 : 1) ||
        a.slug.localeCompare(b.slug),
    );
  // The carry-over leaves the re-solve list (and the due list) for the day: it's already a slot.
  const dueNow = due.filter((r) => !carrySlugs.has(r.slug));
  const resolve = [
    ...dueNow.filter((r) => r.pattern !== focus.pattern),
    ...dueNow.filter((r) => r.pattern === focus.pattern),
  ];
  // stretch
  const up = fresh[0] ? UP[fresh[0].difficulty] : 'Medium';
  const next = ranks.find((r) => r.pattern !== focus.pattern)?.pattern;
  const stretch = [
    ...fresh.filter((c) => c.difficulty === up),
    ...(next
      ? PLAN_LIST.filter(
          (c) =>
            c.pattern === next && c.difficulty === 'Medium' && pickable(c, seen, scope.premium),
        )
      : []),
  ];

  const planMode = planModeOf(input.planMode ?? 'auto', before, today, due.length, params);
  const cands: CoachPools['cands'] = {
    'carry-over': carry.map((a) => ({
      slug: a.slug,
      reason: `Carry-over from ${fmtSpokenDay(a.day, today)}: not accepted yet${a.lastError ? ` (${a.lastError.verdict.replace('_', ' ')})` : ''}; finish it before it goes cold`,
    })),
    new: fresh.map((c) => ({
      slug: c.slug,
      reason: `New in ${PATTERN_NAMES[focus.pattern]}, focus day ${focus.day} of ${focus.of}`,
    })),
    're-solve': resolve.map((r) => ({
      slug: r.slug,
      reason: resolveReason(r, today),
    })),
    // Catch-up takes no stretch: the slots go to the re-solves.
    stretch:
      planMode.mode === 'catch-up'
        ? []
        : stretch.map((c) => ({
            slug: c.slug,
            reason: `Stretch: ${c.difficulty} in ${PATTERN_NAMES[c.pattern]}`,
          })),
  };
  const row = input.days.find((d) => d.day === today) ?? null;
  return {
    all,
    before,
    records,
    seen,
    focus,
    ranks,
    carry,
    fresh,
    due: dueNow,
    stretch,
    cands,
    row,
    planMode,
  };
}

// --- Plan mode (coach.md → Plan mode) ---
// Auto's state, derived by replay so a read writes nothing: day by day from the first attempt, count the problems
// due (not graduated, due that day or earlier, from attempts before the day); catch-up from enterDue, back to
// balanced below exitDue, unchanged in between. Reads only attempts before `today`, so it holds still all day.
export function autoCatchUp(
  before: readonly Attempt[],
  today: string,
  params: CoachParams = COACH_PARAMS,
): boolean {
  if (!before.length) return false;
  const states = new Map<string, ResolveState>();
  let i = 0;
  let on = false;
  for (let d = before[0]!.day; d <= today; d = addDays(d, 1)) {
    for (; i < before.length && before[i]!.day < d; i++) {
      const a = before[i]!;
      states.set(a.slug, nextState(states.get(a.slug) ?? null, a, params));
    }
    let n = 0;
    for (const st of states.values()) if (!st.graduated && st.dueDay <= d) n += 1;
    if (n >= params.catchUp.enterDue) on = true;
    else if (n < params.catchUp.exitDue) on = false;
  }
  return on;
}
export const COACH_PLAN_MODES: readonly CoachPlanMode[] = ['auto', 'balanced', 'catch-up'];
export const COACH_PLAN_MODE_ERROR = 'coachPlanMode must be auto, balanced or catch-up';
export const coachPlanModeOf = (s: { coachPlanMode?: CoachPlanMode }): CoachPlanMode =>
  s.coachPlanMode ?? 'auto';
function planModeOf(
  setting: CoachPlanMode,
  before: readonly Attempt[],
  today: string,
  due: number,
  params: CoachParams,
): CoachPlanModeView {
  const mode =
    setting === 'auto'
      ? autoCatchUp(before, today, params)
        ? 'catch-up'
        : 'balanced'
      : setting;
  const line = `${mode === 'catch-up' ? 'Catch-up' : 'Balanced'}: ${due} due${setting === 'auto' ? ' · auto' : ''}`;
  return { setting, mode, due, line };
}

// The rules' pick: one of each kind; an empty kind lets the next kind (stretch wraps to new) take a second; at
// most 2 a kind and 4 in all, never padded. A stored AI pick (coachAi.ts), when on, replaces it in its own order.
// Then the day's changes, then today's sittings and attempts.
export function planDay(input: CoachInput, params: CoachParams = COACH_PARAMS): CoachToday {
  const { today, now, dayStartHour: h } = input;
  const pools = coachPools(input, params);
  const { all, before, records, seen, focus, carry, fresh, cands, row } = pools;
  const dueNow = pools.due;
  const carrySlugs = new Set(carry.map((a) => a.slug));
  const titleOf = (slug: string) =>
    catalogProblem(slug)?.title ?? records.find((r) => r.slug === slug)?.title ?? slug;
  const lastActive = before.length ? before[before.length - 1]!.day : null;

  type Cand = { slug: string; reason: string };
  const picked: Record<SlotKind, Cand[]> = {
    'carry-over': [],
    new: [],
    're-solve': [],
    stretch: [],
  };
  const used = new Set<string>();
  const take = (k: SlotKind, max = MAX_PER_KIND) => {
    const c = cands[k].find((x) => !used.has(x.slug));
    if (!c || picked[k].length >= max) return false;
    used.add(c.slug);
    picked[k].push(c);
    return true;
  };
  if (pools.planMode.mode === 'catch-up') {
    // The carry-over, one new (the focus still advances), then re-solves in every free slot; no stretch, never
    // padded.
    take('carry-over');
    take('new');
    while (SLOT_KINDS.reduce((n, k) => n + picked[k].length, 0) < MAX_SLOTS)
      if (!take('re-solve', MAX_SLOTS)) break;
  } else {
    for (const k of SLOT_KINDS) take(k);
    const nextKind: Record<SlotKind, SlotKind> = {
      'carry-over': 'new',
      new: 're-solve',
      're-solve': 'stretch',
      stretch: 'new',
    };
    for (const k of SLOT_KINDS) if (!picked[k].length) take(nextKind[k]);
  }

  const endOfDay = dayStartAt(addDays(today, 1), h);
  let slots: CoachSlot[] = SLOT_KINDS.flatMap((kind) =>
    picked[kind].map((c) => slotOf(kind, c.slug, c.reason, null)),
  ).slice(0, MAX_SLOTS);
  const ai = aiViewOf(input, pools);
  if (ai?.status === 'ok')
    slots = row!.ai!.picks.map((p) => ({
      ...slotOf(p.kind, p.slug, pickReason(p.kind, p.slug), null),
      aiWhy: p.why,
    }));
  // A pick's rule reason: its candidate's, else (a pattern the AI moved the focus to) what it is.
  function pickReason(kind: SlotKind, slug: string): string {
    const own =
      cands[kind].find((c) => c.slug === slug) ??
      SLOT_KINDS.flatMap((k) => cands[k]).find((c) => c.slug === slug);
    if (own) return own.reason;
    const cat = catalogProblem(slug);
    return cat
      ? `${kind === 'stretch' ? 'Stretch' : 'New'}: ${cat.difficulty} in ${PATTERN_NAMES[cat.pattern]}`
      : 'Opus’s pick';
  }
  function slotOf(kind: SlotKind, slug: string, reason: string, from: string | null): CoachSlot {
    const cat = catalogProblem(slug);
    const rec = records.find((r) => r.slug === slug);
    const difficulty = cat?.difficulty ?? rec?.difficulty ?? null;
    const pattern = cat?.pattern ?? rec?.pattern ?? 'other';
    return {
      kind,
      slug,
      title: titleOf(slug),
      pattern,
      difficulty,
      url: `https://leetcode.com/problems/${slug}/`,
      reason,
      capMin: params.capMin,
      dueAt: endOfDay,
      status: 'open',
      sittingId: null,
      outcome: null,
      swappedFrom: from,
      alternatives: [],
      aiWhy: null,
    };
  }

  // A swapped-in problem takes its own kind, so its coaching rules are right: the carry-over, a due re-solve or
  // a problem already tried (a re-solve's rules: blank editor, no hints), else unseen — new, or still a stretch
  // when it replaced one.
  const dueSlugs = new Set(dueNow.map((r) => r.slug));
  function swappedIn(was: SlotKind, slug: string, from: string): CoachSlot {
    // (The carry-over is always a slot already, so a swap can't target it: kept as a guard.)
    const kind: SlotKind = carrySlugs.has(slug)
      ? 'carry-over'
      : dueSlugs.has(slug) || seen.has(slug)
        ? 're-solve'
        : was === 'stretch'
          ? 'stretch'
          : 'new';
    const rec = records.find((r) => r.slug === slug);
    const what =
      kind === 'carry-over'
        ? 'the carry-over'
        : kind === 're-solve'
          ? rec && dueSlugs.has(slug)
            ? `a due re-solve — ${resolveReason(rec, today)}`
            : 'a problem you’ve tried before: re-solve it today with a blank editor and no hints'
          : kind === 'stretch'
            ? 'a stretch'
            : `new in ${PATTERN_NAMES[catalogProblem(slug)?.pattern ?? rec?.pattern ?? 'other']}`;
    return slotOf(kind, slug, `Swapped in for ${titleOf(from)}: ${what}`, from);
  }

  // The day's changes, by the engine's pick: a swap replaces it (the original stays in its queue), a skip marks it.
  for (const c of row?.changes ?? []) {
    // A change names its slot by the engine's pick alone (picks are unique across slots); its `kind` is the slot's
    // as shown when it was changed — a record, never matched on.
    const i = slots.findIndex((s) => (s.swappedFrom ?? s.slug) === c.from);
    if (i < 0) continue;
    if (c.action === 'skip') slots[i] = { ...slots[i]!, status: 'skipped' };
    else if (c.to && !slots.some((s) => s.slug === c.to))
      slots[i] = swappedIn(slots[i]!.kind, c.to, c.from);
  }

  // Today's sittings and attempts, linked to a slot by slug on read.
  const todays = input.sittings.filter((s) => s.day === today && s.review?.test !== true);
  const doneToday = all.filter((a) => a.day === today);
  // A slot's alternatives skip every slot's problem and every engine pick a swap replaced, so "Another" never
  // offers back what was just swapped out.
  const taken = slotProblems(slots);
  slots = slots.map((s) => {
    const sitting = todays
      .filter((x) => x.problemSlug === s.slug)
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    const done = doneToday.find((a) => a.slug === s.slug);
    const status: CoachSlot['status'] =
      sitting && isSittingOpen(sitting, now) ? 'in-progress' : done ? 'done' : s.status;
    return {
      ...s,
      status,
      sittingId: sitting?.id ?? null,
      outcome: status === 'done' ? (done?.outcome ?? null) : null,
      alternatives: easierIn(s.pattern, s.difficulty, seen, taken, input.premium === true)
        .slice(0, 2)
        .map((c) => ({ slug: c.slug, title: c.title, difficulty: c.difficulty })),
    };
  });

  const floorPick: { kind: SlotKind; slug: string } | null = dueNow[0]
    ? { kind: 're-solve', slug: dueNow[0].slug }
    : carry[0]
      ? { kind: 'carry-over', slug: carry[0].slug }
      : fresh[0]
        ? { kind: 'new', slug: fresh[0].slug }
        : null;
  const floor = floorPick
    ? {
        kind: floorPick.kind,
        slug: floorPick.slug,
        title: titleOf(floorPick.slug),
        reason: dueNow[0]
          ? `The oldest due re-solve (due since ${fmtSpokenDay(dueNow[0].schedule!.dueDay, today)}); this alone counts as showing up`
          : carry[0]
            ? 'Finish the carry-over; this alone counts as showing up'
            : 'One new problem; this alone counts as showing up',
        on: row?.floor === true,
        done: doneToday.some((a) => a.slug === floorPick.slug),
      }
    : null;
  const onPlan = new Set([...slots.map((s) => s.slug), ...(floor ? [floor.slug] : [])]);
  const offPlan = todays
    .filter((s) => !onPlan.has(s.problemSlug))
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((s) => ({ sittingId: s.id, slug: s.problemSlug, title: s.problemTitle }));

  const queued = records.filter((r) => r.schedule && !r.schedule.graduated);
  const in48 = addDays(today, 2);
  const activeDays = new Set(all.filter((a) => a.day > addDays(today, -7)).map((a) => a.day));
  const yesterday = addDays(today, -1);
  const unreviewed = input.sittings
    .filter(
      (s) =>
        s.day >= yesterday &&
        s.day <= today &&
        !isSittingOpen(s, now) &&
        countsAsPractice(s, now, params) &&
        !s.review?.cause,
    )
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((s) => ({ sittingId: s.id, slug: s.problemSlug, title: s.problemTitle }));
  const unnoted = input.sittings
    .filter(
      (s) =>
        s.day >= addDays(today, -NOTES_CATCHUP_DAYS) &&
        s.day <= today &&
        !isSittingOpen(s, now) &&
        s.review?.test !== true &&
        (countsAsPractice(s, now, params) || s.summary.runs + s.summary.submits > 0) &&
        !s.claudeNotes?.text,
    )
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, NOTES_CATCHUP_MAX)
    .map((s) => ({ sittingId: s.id, slug: s.problemSlug, title: s.problemTitle, day: s.day }));

  return {
    day: today,
    mode: 'general',
    target: null,
    arm: null,
    focus,
    slots,
    floor,
    offPlan,
    due: dueNow.map((r) => queueItem(r, h)),
    next48h: queued
      .filter((r) => r.schedule!.dueDay > today && r.schedule!.dueDay <= in48)
      .sort((a, b) => a.schedule!.dueDay.localeCompare(b.schedule!.dueDay))
      .map((r) => queueItem(r, h)),
    momentum: {
      activeDays: activeDays.size,
      of: 7,
      lastActiveDay: all.length ? all[all.length - 1]!.day : null,
      missedYesterday: !!lastActive && lastActive < yesterday,
    },
    unreviewed,
    unnoted,
    ai,
    planMode: pools.planMode,
  };
}

// The AI pick's view of the day (see CoachAiView). A stale claim reads as a timeout; nothing is written.
function aiViewOf(input: CoachInput, pools: CoachPools): CoachAiView | null {
  if (!input.aiPick) return null;
  const a = pools.row?.ai;
  const base = {
    notice: null,
    reason: null,
    note: null,
    focusChange: null,
    model: null,
    pickedAt: null,
  };
  if (!a) {
    // A day already under way on the rules (a slot changed, or practice logged today) keeps them: a pick landing now
    // would replace a plan in use and orphan its changes.
    const today = input.today;
    const underway =
      (pools.row?.changes.length ?? 0) > 0 ||
      pools.all.some((x) => x.day === today) ||
      input.sittings.some((x) => x.day === today && x.review?.test !== true);
    const options = new Set(SLOT_KINDS.flatMap((k) => pools.cands[k].map((c) => c.slug)));
    const due =
      input.aiCanStart === true && !underway && pools.before.length > 0 && options.size >= 2;
    return due ? { ...base, status: 'due', source: 'rules' } : null;
  }

  if (aiPickPending(a, input.now)) return { ...base, status: 'pending', source: 'rules' };
  if (a.status === 'ok') {
    const f = pools.focus;
    return {
      ...base,
      status: 'ok',
      source: 'ai',
      note: a.note,
      focusChange: a.focus && f.source === 'ai' && f.pattern === a.focus.to ? a.focus : null,
      model: a.model,
      pickedAt: a.settledAt,
    };
  }
  return {
    ...base,
    status: 'fallback',
    source: 'rules',
    notice: AI_PICK_NOTICE,
    reason: a.status === 'pending' ? 'timeout' : a.reason,
    model: a.model,
  };
}

// Every problem the user has a record on, newest first, from all counted attempts (today's too).
// `today`: a sitting left open overnight counts on its day, as the plan counts it.
// History-only solves are records too (schedule null), so Progress and get_problem see them.
export function listRecords(
  input: Omit<CoachInput, 'today' | 'days' | 'focus' | 'dayStartHour' | 'premium'> & {
    today?: string;
  },
) {
  return problemRecords(
    attemptsOf(input.sittings, input.attempts, input.now, COACH_PARAMS, input.today, moreOf(input)),
    COACH_PARAMS,
    historyAttemptsOf(input.attempts),
  ).sort((a, b) => b.lastDay.localeCompare(a.lastDay) || a.slug.localeCompare(b.slug));
}

// --- Stats (coach_stats; the Patterns tab grows it): counts over counted attempts, derived on read ---
export interface Rate {
  hit: number;
  of: number;
}
export interface PatternStat extends PatternDetail {
  pattern: PatternId;
  problems: number; // with an attempt in range
  attempts: number;
  firstTry: Rate; // first tries ever, in range, that were clean
  resolve: Rate; // repeat attempts (a later day), in range, that were clean
  peeked: number; // attempts that read the solution
  causes: Partial<Record<CauseTag, number>>;
  rank: number | null; // its place in the focus ranking now (1 = weakest); null once nothing unseen is left
}
export interface CoachStats {
  from: string | null; // the range asked, inclusive; null = from the first attempt
  to: string;
  activeDays: number;
  problems: number;
  attempts: number;
  firstTry: Rate;
  resolve: Rate;
  peeked: number;
  causes: Partial<Record<CauseTag, number>>;
  untagged: number; // attempts that went wrong (not clean) with no cause tag
  weeks: { week: string; attempts: number; firstTry: Rate; resolve: Rate }[]; // ISO weeks in range, oldest first
  patterns: PatternStat[]; // those with an attempt in range: weakest first (rank), then the roadmap order
  weakest: PatternId | null; // the ranking's top now, whatever the range (it may have no row in `patterns`)
  ranking: PatternId[]; // the focus ranking now, every pattern with something unseen left, weakest first
}
export interface CoachStatsRange {
  from?: string;
  to?: string;
}
// The range's input: day keys, both optional, from ≤ to.
export function normalizeStatsRange(v: unknown): CoachStatsRange {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('range must be an object');
  const r = v as Record<string, unknown>;
  for (const k of Object.keys(r))
    if (k !== 'from' && k !== 'to') throw new Error(`Unknown range field: ${k}`);
  for (const k of ['from', 'to'] as const)
    if (r[k] !== undefined && (typeof r[k] !== 'string' || !isDayKey(r[k])))
      throw new Error(`${k} must be an ISO date (YYYY-MM-DD)`);
  if (typeof r.from === 'string' && typeof r.to === 'string' && r.from > r.to)
    throw new Error('from must not be after to');
  return r as CoachStatsRange;
}
const blankRate = (): Rate => ({ hit: 0, of: 0 });
const bump = (r: Rate, hit: boolean) => {
  r.of += 1;
  if (hit) r.hit += 1;
};
// A first try is the problem's first attempt ever, with no history-only solve dated before it (so a range never
// turns a re-solve into a first try); every later day on it is a re-solve. Clean is the only hit for both — the gap
// is first-try accuracy. `to` defaults to today; the ranking is as of now (today's attempts in).
export function coachStats(
  attempts: readonly Attempt[],
  today: string,
  range: CoachStatsRange = {},
  scope: CoachScope = NO_SCOPE,
): CoachStats {
  const from = range.from ?? null;
  const to = range.to ?? today;
  if (from !== null && from > to) throw new Error('from must not be after to');
  const seen = new Set<string>();
  const ranked = rankPatterns(attempts, addDays(today, 1), scope);
  const ranks = new Map(ranked.map((r, i) => [r.pattern, i + 1]));
  const out: CoachStats = {
    from,
    to,
    activeDays: 0,
    problems: 0,
    attempts: 0,
    firstTry: blankRate(),
    resolve: blankRate(),
    peeked: 0,
    causes: {},
    untagged: 0,
    weeks: [],
    patterns: [],
    weakest: ranked[0]?.pattern ?? null,
    ranking: [...ranks.keys()],
  };
  const pats = new Map<
    PatternId,
    Omit<PatternStat, keyof PatternDetail> & { slugs: Set<string> }
  >();
  const weeks = new Map<string, CoachStats['weeks'][number]>();
  const days = new Set<string>();
  const slugs = new Set<string>();
  for (const a of attempts) {
    const first = !seen.has(a.slug) && !historyBefore(scope, a); // after a history-only solve: a re-solve
    seen.add(a.slug);
    if ((from !== null && a.day < from) || a.day > to) continue;
    const clean = a.outcome === 'clean';
    const p =
      pats.get(a.pattern) ??
      pats
        .set(a.pattern, {
          pattern: a.pattern,
          problems: 0,
          attempts: 0,
          firstTry: blankRate(),
          resolve: blankRate(),
          peeked: 0,
          causes: {},
          rank: ranks.get(a.pattern) ?? null,
          slugs: new Set(),
        })
        .get(a.pattern)!;
    const wk = isoWeekKey(a.day);
    const w =
      weeks.get(wk) ??
      weeks
        .set(wk, { week: wk, attempts: 0, firstTry: blankRate(), resolve: blankRate() })
        .get(wk)!;
    days.add(a.day);
    slugs.add(a.slug);
    p.slugs.add(a.slug);
    for (const x of [out, p, w]) {
      x.attempts += 1;
      bump(first ? x.firstTry : x.resolve, clean);
    }
    if (a.help === 'solution') {
      out.peeked += 1;
      p.peeked += 1;
    }
    if (a.cause) {
      out.causes[a.cause] = (out.causes[a.cause] ?? 0) + 1;
      p.causes[a.cause] = (p.causes[a.cause] ?? 0) + 1;
    } else if (!clean) out.untagged += 1;
  }
  out.activeDays = days.size;
  out.problems = slugs.size;
  out.weeks = [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week));
  const detail = patternDetail(attempts, from, to, scope);
  out.patterns = [...pats.values()]
    .map(({ slugs: s, ...p }) => ({ ...p, problems: s.size, ...detail.get(p.pattern)! }))
    .sort(
      (a, b) =>
        (a.rank ?? Infinity) - (b.rank ?? Infinity) || orderOf(a.pattern) - orderOf(b.pattern),
    );
  return out;
}

// --- The Patterns tab's per-pattern detail (coach_stats grows it): how each try went, over the same range ---
export interface PatternDetail {
  submitsPerTry: number | null; // captured submits ÷ attempts with one (a re-solve is its own), 1 decimal; null with none
  runBeforeSubmit: Rate; // attempts with a captured submit whose first submit had a Run before it
  traced: Rate; // attempts with trace data whose trace stood at all three inputs at the first submit
  weeks: { week: string; firstTry: Rate }[]; // ISO weeks in range with a first try, oldest first
}
// Every attempt in range counts toward the first three (a re-solve too); `weeks` counts first tries only, by
// coachStats' rule — the problem's first attempt ever, with no history-only solve dated before it.
export function patternDetail(
  attempts: readonly Attempt[],
  from: string | null,
  to: string,
  scope: CoachScope = NO_SCOPE,
): Map<PatternId, PatternDetail> {
  const seen = new Set<string>();
  const acc = new Map<
    PatternId,
    PatternDetail & { submits: number; submitted: number; byWeek: Map<string, Rate> }
  >();
  for (const a of attempts) {
    const first = !seen.has(a.slug) && !historyBefore(scope, a); // after a history-only solve: a re-solve
    seen.add(a.slug);
    if ((from !== null && a.day < from) || a.day > to) continue;
    const d =
      acc.get(a.pattern) ??
      acc
        .set(a.pattern, {
          submitsPerTry: null,
          runBeforeSubmit: blankRate(),
          traced: blankRate(),
          weeks: [],
          submits: 0,
          submitted: 0,
          byWeek: new Map(),
        })
        .get(a.pattern)!;
    if (a.submits > 0) {
      d.submits += a.submits;
      d.submitted += 1;
    }
    if (a.runFirst !== null) bump(d.runBeforeSubmit, a.runFirst);
    if (a.traced !== null) bump(d.traced, a.traced);
    if (first) {
      const wk = isoWeekKey(a.day);
      bump(d.byWeek.get(wk) ?? d.byWeek.set(wk, blankRate()).get(wk)!, a.outcome === 'clean');
    }
  }
  return new Map(
    [...acc].map(([p, { submits, submitted, byWeek, ...d }]) => [
      p,
      {
        ...d,
        submitsPerTry: submitted ? Math.round((submits / submitted) * 10) / 10 : null,
        weeks: [...byWeek]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([week, firstTry]) => ({ week, firstTry })),
      },
    ]),
  );
}

// --- Writes' inputs ---
const SLUG_RE = /^[a-z0-9-]{1,128}$/;
export const isProblemSlug = (v: unknown): v is string => typeof v === 'string' && SLUG_RE.test(v);
export const LOG_ATTEMPTS_MAX = 50;
export const ATTEMPT_NOTE_MAX = 300;
export const ATTEMPT_TITLE_MAX = 200;
export const ATTEMPT_BACKDATE_DAYS = 60;
export const ATTEMPT_HISTORY_DAYS = 3650; // a history-only solve: up to 10 years back
export interface CoachAttemptInput {
  slug: string;
  title?: string | null;
  day?: string; // the user's today when absent
  outcome?: AttemptOutcome; // optional only with help 'solution' (a peek: failed)
  help?: HelpLevel;
  cause?: CauseTag | null;
  minutes?: number | null;
  note?: string | null;
  historical?: boolean; // a solve from before the coach: lights up Progress, never scheduled or counted
  difficulty?: Difficulty | null; // an off-catalog problem's; the catalog's wins
  accepted?: boolean; // a peek that also got accepted that day (help 'solution' only)
}
export type NormalizedAttempt = Pick<
  CoachAttempt,
  | 'slug'
  | 'title'
  | 'day'
  | 'outcome'
  | 'help'
  | 'cause'
  | 'minutes'
  | 'note'
  | 'historical'
  | 'difficulty'
  | 'accepted'
>;
const KNOWN_ATTEMPT_KEYS = new Set([
  'slug',
  'title',
  'day',
  'outcome',
  'help',
  'cause',
  'minutes',
  'note',
  'historical',
  'difficulty',
  'accepted',
]);
const DIFFICULTIES: readonly Difficulty[] = ['Easy', 'Medium', 'Hard'];
// One manual attempt, validated: a problem slug, an outcome, a day no later than today and at most
// ATTEMPT_BACKDATE_DAYS back (a history-only one ATTEMPT_HISTORY_DAYS). A clean attempt took no help. Help `solution`
// is a peek in one call: it stores `failed` (the retry track), and `outcome: 'solved'` or `accepted: true` keeps that
// day's accept.
export function normalizeCoachAttempt(v: unknown, today: string): NormalizedAttempt {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error('An attempt must be an object');
  const r = v as Record<string, unknown>;
  for (const k of Object.keys(r))
    if (!KNOWN_ATTEMPT_KEYS.has(k)) throw new Error(`Unknown attempt field: ${k}`);
  if (!isProblemSlug(r.slug))
    throw new Error('slug must be a LeetCode problem slug (lowercase letters, digits, dashes)');
  const help = (r.help ?? 'none') as HelpLevel;
  if (!HELP_LEVELS.includes(help)) throw new Error('help must be none, hint or solution');
  if (r.outcome === undefined && help !== 'solution')
    throw new Error('outcome must be clean, solved or failed');
  if (r.outcome !== undefined && !ATTEMPT_OUTCOMES.includes(r.outcome as AttemptOutcome))
    throw new Error('outcome must be clean, solved or failed');
  if (r.accepted !== undefined && typeof r.accepted !== 'boolean')
    throw new Error('accepted must be true or false');
  if (r.accepted !== undefined && help !== 'solution')
    throw new Error('accepted is only for a peek (help solution); otherwise the outcome says it');
  const asked = (r.outcome ?? 'failed') as AttemptOutcome;
  if (asked === 'clean' && help !== 'none') throw new Error('A clean attempt took no help');
  // A peek is failed whatever was asked; a solved one (or accepted: true) keeps that it was accepted.
  const outcome: AttemptOutcome = help === 'solution' ? 'failed' : asked;
  const accepted =
    help === 'solution' && (asked === 'solved' || r.accepted === true) ? true : undefined;
  if (r.accepted === false && asked === 'solved')
    throw new Error('accepted: false contradicts outcome solved');
  const difficulty = r.difficulty ?? null;
  if (difficulty !== null && !DIFFICULTIES.includes(difficulty as Difficulty))
    throw new Error('difficulty must be Easy, Medium or Hard');
  const cause = r.cause ?? null;
  if (cause !== null && !isCauseTag(cause))
    throw new Error(`cause must be one of ${CAUSE_TAGS.join(', ')}`);
  if (r.historical !== undefined && typeof r.historical !== 'boolean')
    throw new Error('historical must be true or false');
  const historical = r.historical === true;
  // A solve from before the coach is dated before today (default yesterday): the plan reads it as already seen.
  const day = r.day ?? (historical ? addDays(today, -1) : today);
  if (typeof day !== 'string' || !isDayKey(day)) throw new Error('day must be YYYY-MM-DD');
  if (day > today) throw new Error('day must not be after today');
  if (historical && day >= today)
    throw new Error('A solve from before the coach is dated before today');
  const back = historical ? ATTEMPT_HISTORY_DAYS : ATTEMPT_BACKDATE_DAYS;
  if (day < addDays(today, -back))
    throw new Error(
      historical
        ? `day must be within the last ${ATTEMPT_HISTORY_DAYS / 365} years`
        : `day must be within the last ${ATTEMPT_BACKDATE_DAYS} days (a solve from before the coach: historical true)`,
    );
  const minutes = r.minutes ?? null;
  if (
    minutes !== null &&
    (!Number.isSafeInteger(minutes) || (minutes as number) < 1 || (minutes as number) > 600)
  )
    throw new Error('minutes must be a whole number from 1 to 600');
  const text = (x: unknown, label: string, max: number) => {
    if (x == null) return null;
    if (typeof x !== 'string') throw new Error(`${label} must be text`);
    const t = x.replace(/\s+/g, ' ').trim();
    if (t.length > max) throw new Error(`${label} is limited to ${max} characters`);
    return t || null;
  };
  return {
    slug: r.slug,
    title: text(r.title, 'title', ATTEMPT_TITLE_MAX),
    day,
    outcome,
    help,
    cause,
    minutes: minutes as number | null,
    note: text(r.note, 'note', ATTEMPT_NOTE_MAX),
    ...(historical ? { historical: true as const } : {}),
    ...(difficulty !== null ? { difficulty: difficulty as Difficulty } : {}),
    ...(accepted ? { accepted } : {}),
  };
}
// A peek already logged for that problem and day (logCoachAttempts returns it instead of a second row).
export const peekOf = (
  stored: readonly CoachAttempt[],
  n: Pick<CoachAttempt, 'slug' | 'day' | 'historical'>,
): CoachAttempt | null =>
  stored.find(
    (a) =>
      a.deletedAt === null &&
      a.help === 'solution' &&
      a.slug === n.slug &&
      a.day === n.day &&
      (a.historical === true) === (n.historical === true),
  ) ?? null;
// What a repeated peek adds to the stored one: a title, a difficulty or an accept it lacks; null when nothing.
export function peekFill(
  had: CoachAttempt,
  n: NormalizedAttempt,
): Partial<Pick<CoachAttempt, 'title' | 'difficulty' | 'accepted'>> | null {
  const fill: Partial<Pick<CoachAttempt, 'title' | 'difficulty' | 'accepted'>> = {};
  if (!had.title && n.title) fill.title = n.title;
  if (!had.difficulty && n.difficulty) fill.difficulty = n.difficulty;
  if (!had.accepted && n.accepted) fill.accepted = true;
  return Object.keys(fill).length ? fill : null;
}
export function normalizeCoachAttempts(v: unknown, today: string): NormalizedAttempt[] {
  if (!Array.isArray(v) || !v.length) throw new Error('attempts must be a non-empty list');
  if (v.length > LOG_ATTEMPTS_MAX) throw new Error(`At most ${LOG_ATTEMPTS_MAX} attempts at once`);
  return v.map((a) => normalizeCoachAttempt(a, today));
}

// A slot change: the slot by its slug now (or the engine's pick it replaced).
export interface CoachSlotInput {
  slug: string;
  action: 'swap' | 'skip' | 'restore';
  toSlug?: string;
}
export const SLOT_ACTIONS = ['swap', 'skip', 'restore'] as const;
// The day row with one slot change applied: a swap or skip replaces that slot's earlier change, a restore
// removes it. Throws when the slug names no slot today, or the swap's target is already a slot or unknown.
export function applySlotChange(
  today: CoachToday,
  changes: readonly CoachSlotChange[],
  input: CoachSlotInput,
  known: (slug: string) => boolean,
  seen: ReadonlySet<string>,
  now: number,
  premium = false,
): CoachSlotChange[] {
  if (!isProblemSlug(input.slug)) throw new Error('slug must be a LeetCode problem slug');
  if (!SLOT_ACTIONS.includes(input.action)) throw new Error('action must be swap, skip or restore');
  // The slot showing that problem now; else the one whose engine pick it was.
  const slot =
    today.slots.find((s) => s.slug === input.slug) ??
    today.slots.find((s) => s.swappedFrom === input.slug);
  if (!slot) throw new Error(`No slot today is on ${input.slug}`);
  const from = slot.swappedFrom ?? slot.slug;
  const rest = changes.filter((c) => c.from !== from);
  if (input.action === 'restore') return rest;
  if (input.action === 'skip')
    return [...rest, { kind: slot.kind, action: 'skip', from, to: null, at: now }];
  let to = input.toSlug;
  if (to === undefined) {
    const easier = easierIn(
      slot.pattern,
      slot.difficulty,
      seen,
      slotProblems(today.slots),
      premium,
    )[0];
    if (!easier)
      throw new Error(
        `No unseen problem left in ${PATTERN_NAMES[slot.pattern]} at or under ${slot.difficulty ?? 'Hard'}; pass toSlug`,
      );
    to = easier.slug;
  }
  if (!isProblemSlug(to)) throw new Error('toSlug must be a LeetCode problem slug');
  if (to === from) return rest;
  if (!known(to))
    throw new Error(`Unknown problem: ${to} — not in the catalog and never attempted`);
  // Another slot's problem, or another slot's engine pick (a swap target there would make two slots answer to
  // one slug).
  if (today.slots.some((s) => s !== slot && (s.slug === to || s.swappedFrom === to)))
    throw new Error(`${to} is already one of today's slots`);
  return [...rest, { kind: slot.kind, action: 'swap', from, to, at: now }];
}

// Whether setting `pattern` again changes nothing: the stored override names it and still holds (its block hasn't
// run out). Once the engine has moved on, the same pattern re-stamps from today.
export function focusHolds(ci: CoachInput, cur: CoachFocus, pattern: PatternId): boolean {
  if (cur.deletedAt !== null || cur.pattern !== pattern) return false;
  const all = attemptsOf(ci.sittings, ci.attempts, ci.now, COACH_PARAMS, ci.today, moreOf(ci));
  return focusOn(all, cur, ci.today, COACH_PARAMS, coachScope(ci)).source === 'override';
}
// What a slot change reads: the problems seen before today (live and history-only), and whether a slug is a
// problem at all (on a list, or tried).
export function slotChangeInputs(ci: CoachInput): {
  seen: Set<string>;
  known: (slug: string) => boolean;
} {
  const all = attemptsOf(ci.sittings, ci.attempts, ci.now, COACH_PARAMS, ci.today, moreOf(ci));
  const scope = coachScope(ci);
  const seen = seenBefore(all, scope, ci.today, moreOf(ci));
  const tried = new Set([...all.map((a) => a.slug), ...scope.history.keys()]);
  return { seen, known: (slug) => !!catalogProblem(slug) || tried.has(slug) };
}
// An override on a pattern with nothing unseen left would leave no new slot: refused.
export function focusRoomError(ci: CoachInput, pattern: PatternId): string | null {
  const scope = coachScope(ci);
  const seen = seenBefore(
    attemptsOf(ci.sittings, ci.attempts, ci.now, COACH_PARAMS, ci.today, moreOf(ci)),
    scope,
    ci.today,
  );
  return PLAN_LIST.some((c) => c.pattern === pattern && pickable(c, seen, scope.premium))
    ? null
    : `Nothing unseen is left in ${PATTERN_NAMES[pattern]} — pick another pattern`;
}
// The focus override's input: a roadmap pattern, or null to clear.
export function normalizeFocusPattern(v: unknown): PatternId | null {
  if (v === null) return null;
  if (!isPatternId(v) || v === 'other')
    throw new Error(`pattern must be one of ${PATTERNS.join(', ')}, or null`);
  return v;
}

// The review fields the coach writes over MCP (patchSittingReview), merged onto the stored review.
export interface SittingReviewPatch {
  cause?: CauseTag | null;
  help?: HelpLevel;
  test?: boolean;
}
export function normalizeReviewPatch(v: unknown): SittingReviewPatch {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('patch must be an object');
  const r = v as Record<string, unknown>;
  for (const k of Object.keys(r))
    if (k !== 'cause' && k !== 'help' && k !== 'test') throw new Error(`Unknown patch field: ${k}`);
  if (r.cause !== undefined && r.cause !== null && !isCauseTag(r.cause))
    throw new Error(`cause must be one of ${CAUSE_TAGS.join(', ')}`);
  if (r.help !== undefined && !HELP_LEVELS.includes(r.help as HelpLevel))
    throw new Error('Help must be none, hint or solution');
  if (r.test !== undefined && typeof r.test !== 'boolean')
    throw new Error('test must be true or false');
  if (r.cause === undefined && r.help === undefined && r.test === undefined)
    throw new Error('patch must set cause, help or test');
  return r as SittingReviewPatch;
}

// --- Legacy voids' input (setCoachVoids) ---
export interface CoachVoidInput {
  day: string;
  slug: string;
  void: boolean;
}
export function normalizeCoachVoids(v: unknown): CoachVoidInput[] {
  if (!Array.isArray(v) || !v.length) throw new Error('voids must be a non-empty list');
  if (v.length > COACH_VOIDS_MAX) throw new Error(`At most ${COACH_VOIDS_MAX} voids at once`);
  const seen = new Set<string>();
  return v.map((x) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('A void must be an object');
    const r = x as Record<string, unknown>;
    for (const k of Object.keys(r))
      if (k !== 'day' && k !== 'slug' && k !== 'void') throw new Error(`Unknown void field: ${k}`);
    if (typeof r.day !== 'string' || !isDayKey(r.day)) throw new Error('day must be YYYY-MM-DD');
    if (!isProblemSlug(r.slug)) throw new Error('slug must be a LeetCode problem slug');
    if (typeof r.void !== 'boolean') throw new Error('void must be true or false');
    const id = coachVoidId(r.day, r.slug);
    if (seen.has(id)) throw new Error(`${r.slug} on ${r.day} is listed twice`);
    seen.add(id);
    return { day: r.day, slug: r.slug, void: r.void };
  });
}

// --- Claude's notes on a sitting (setSittingClaudeNotes) ---
export const CLAUDE_NOTES_MAX = 800;
export const CLAUDE_NOTES_BATCH_MAX = 20;
export const CLAUDE_NOTES_OPEN_ERROR = "Claude's notes go on an ended sitting — this one is still open";
export interface ClaudeNotesInput {
  sittingId: string;
  text: string | null; // null or blank clears
}
// Line breaks kept (3–5 lines is the shape), runs of spaces and blank lines folded; ≤ CLAUDE_NOTES_MAX.
export function claudeNotesText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new Error('text must be text, or null to clear');
  const t = v
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .trim();
  if (t.length > CLAUDE_NOTES_MAX)
    throw new Error(`Claude's notes are limited to ${CLAUDE_NOTES_MAX} characters`);
  return t || null;
}
export function normalizeClaudeNotes(v: unknown): ClaudeNotesInput[] {
  if (!Array.isArray(v) || !v.length) throw new Error('notes must be a non-empty list');
  if (v.length > CLAUDE_NOTES_BATCH_MAX)
    throw new Error(`At most ${CLAUDE_NOTES_BATCH_MAX} sittings' notes at once`);
  const seen = new Set<string>();
  return v.map((x) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('A note must be an object');
    const r = x as Record<string, unknown>;
    for (const k of Object.keys(r))
      if (k !== 'sittingId' && k !== 'text') throw new Error(`Unknown note field: ${k}`);
    if (typeof r.sittingId !== 'string' || !r.sittingId) throw new Error('sittingId is required');
    if (seen.has(r.sittingId)) throw new Error(`Sitting ${r.sittingId} is listed twice`);
    seen.add(r.sittingId);
    return { sittingId: r.sittingId, text: claudeNotesText(r.text) };
  });
}
