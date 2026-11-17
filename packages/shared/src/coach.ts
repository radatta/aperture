// The LeetCode coach's engine (docs/areas/recruiting/coach.md): pure folds over the user's sittings and the few
// decisions they store (CoachAttempt, CoachDay, CoachFocus), so the stub and the Lambda can't drift. Nothing
// here writes; `today` is recomputed on every read, and the day's plan reads only what happened before the day,
// so it holds still all day.

import { addDays, daysBetween, fmtSpokenDay, isDayKey, USER_TIME_ZONE, zonedEpoch } from './dates';
import { NEETCODE_150, PATTERNS, PATTERN_NAMES, isPatternId } from './neetcode150';
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
  CoachAttempt,
  CoachDay,
  CoachFocus,
  CoachSlotChange,
  HelpLevel,
  LeetcodeVerdict,
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
  gaps: { clean: readonly number[]; peeked: readonly number[] }; // days to the next re-solve, per step
  lastStepWindowDays: number; // the last step's due window
  capMin: number; // a slot's time cap
  carryOverDays: number; // a carry-over comes from the last active day only this recently
  blockDays: number; // active days a focus pattern holds
  swappedBackDays: number; // a problem swapped out this recently goes to the back of `new`
  minPracticeMin: number; // shorter, with no accepted submit, is a test sitting
}
export const COACH_PARAMS: CoachParams = {
  gaps: { clean: [3, 7, 14], peeked: [1, 3, 7, 14] },
  lastStepWindowDays: 7,
  capMin: 30,
  carryOverDays: 2,
  blockDays: 3,
  swappedBackDays: 3,
  minPracticeMin: 3,
};
const MAX_PER_KIND = 2;
const MAX_SLOTS = 4;

// --- The working catalog: NeetCode 150, plus any problem the user has a record on ---
const CATALOG_BY_SLUG = new Map(NEETCODE_150.map((p) => [p.slug, p]));
export const catalogProblem = (slug: string): CatalogProblem | null =>
  CATALOG_BY_SLUG.get(slug) ?? null;
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
  s: Pick<Sitting, 'startedAt' | 'endedAt' | 'summary' | 'review'>,
  now: number,
  params: CoachParams = COACH_PARAMS,
): boolean {
  if (s.review?.test === true) return false;
  if (s.review?.help === 'solution') return true; // a quick peek is still a peek
  const end = s.endedAt ?? Math.min(now, s.startedAt + SITTING_INGEST_WINDOW_MS);
  const ms = sittingElapsedMs({ startedAt: s.startedAt, endedAt: end }, now);
  return s.summary.firstAcceptedAt !== null || ms >= params.minPracticeMin * 60_000;
}
export function outcomeOf(accepted: boolean, firstSubmitAccepted: boolean, help: HelpLevel) {
  if (!accepted || help === 'solution') return 'failed' as const;
  return firstSubmitAccepted && help === 'none' ? ('clean' as const) : ('solved' as const);
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
    lastError:
      last && last.verdict !== 'accepted'
        ? { verdict: last.verdict, statusMsg: last.statusMsg }
        : null,
    sittingIds: [s.id],
    sources: ['sitting'],
  };
}
export function manualAttempt(a: CoachAttempt): Attempt {
  const cat = catalogProblem(a.slug);
  return {
    slug: a.slug,
    title: a.title ?? cat?.title ?? a.slug,
    pattern: cat?.pattern ?? 'other',
    difficulty: cat?.difficulty ?? null,
    day: a.day,
    at: a.at,
    outcome: a.outcome,
    help: a.help,
    cause: a.cause,
    accepted: a.outcome !== 'failed',
    firstSubmitAccepted: a.outcome === 'clean', // a manual solved or failed was no first-try accept
    submits: 0,
    runs: 0,
    lastError: null,
    sittingIds: [],
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
  lastError: { verdict: LeetcodeVerdict; statusMsg: string | null } | null;
  sittingIds: string[]; // newest first
  sources: ('sitting' | CoachAttempt['source'])[];
}
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
    title: sorted.find((p) => p.sources.includes('sitting'))?.title ?? last.title,
    pattern: sorted.find((p) => p.pattern !== 'other')?.pattern ?? last.pattern,
    difficulty: sorted.find((p) => p.difficulty)?.difficulty ?? null,
    outcome,
    help,
    cause: [...sorted].reverse().find((p) => p.cause)?.cause ?? null,
    accepted,
    firstSubmitAccepted: first?.firstSubmitAccepted ?? null,
    submits: sorted.reduce((n, p) => n + p.submits, 0),
    runs: sorted.reduce((n, p) => n + p.runs, 0),
    lastError: [...sorted].reverse().find((p) => p.submits || p.runs)?.lastError ?? null,
    sittingIds: sorted.flatMap((p) => p.sittingIds).reverse(),
    sources: [...new Set(sorted.flatMap((p) => p.sources))],
  };
}
// Every counted attempt, oldest first. An open sitting is not an attempt yet (it's today's `in-progress`) — except
// one from before `today`: a sitting left open overnight counts on its own day, so the day's plan doesn't move
// when a later Start ends it.
export function attemptsOf(
  sittings: readonly Sitting[],
  manual: readonly CoachAttempt[],
  now: number,
  params: CoachParams = COACH_PARAMS,
  today?: string,
): Attempt[] {
  const settled = (s: Sitting) => !isSittingOpen(s, now) || (today !== undefined && s.day < today);
  const parts = [
    ...sittings.filter((s) => settled(s) && countsAsPractice(s, now, params)).map(sittingAttempt),
    ...manual.filter((a) => a.deletedAt === null).map(manualAttempt),
  ];
  const groups = new Map<string, Attempt[]>();
  for (const p of parts) {
    const k = `${p.day} ${p.slug}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  return [...groups.values()]
    .map(foldDay)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.at - b.at));
}

// --- The re-solve scheduler ---
export interface ResolveState {
  track: 'clean' | 'peeked';
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
  if (a.outcome === 'failed') return stepState('peeked', 0, a.day, params);
  if (!st) return stepState('clean', 0, a.day, params);
  if (st.graduated) return { ...st, lastDay: a.day };
  if (a.outcome === 'solved') return stepState(st.track, st.step, a.day, params);
  if (st.step + 1 < params.gaps[st.track].length)
    return stepState(st.track, st.step + 1, a.day, params);
  return { ...st, lastDay: a.day, dueBy: null, graduated: true };
}
// One problem's attempts, oldest first → its schedule. A first try clean or solved starts the clean track, a
// failed one the peeked track; a clean re-solve steps on (past the last → graduated), a solved one repeats the
// same gap from its day, a failed one restarts the peeked track.
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
  schedule: ResolveState | null;
  historical: null; // the history import's, later
  sittingIds: string[]; // newest first, ≤ 10
}
export function problemRecords(
  attempts: readonly Attempt[],
  params: CoachParams = COACH_PARAMS,
): ProblemRecord[] {
  const bySlug = new Map<string, Attempt[]>();
  for (const a of attempts) bySlug.set(a.slug, [...(bySlug.get(a.slug) ?? []), a]);
  return [...bySlug.entries()].map(([slug, list]) => {
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const cat = catalogProblem(slug);
    const causes: Partial<Record<CauseTag, number>> = {};
    for (const a of list) if (a.cause) causes[a.cause] = (causes[a.cause] ?? 0) + 1;
    return {
      slug,
      title: cat?.title ?? last.title,
      pattern: cat?.pattern ?? last.pattern,
      difficulty: cat?.difficulty ?? last.difficulty,
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
      schedule: resolveState(list, params),
      historical: null,
      sittingIds: list
        .flatMap((a) => a.sittingIds)
        .reverse()
        .slice(0, 10),
    };
  });
}

// --- Focus: one pattern held for blockDays active days ---
const PATTERN_ORDER = new Map<PatternId, number>(PATTERNS.map((p, i) => [p, i]));
interface Ranked {
  pattern: PatternId;
  misses: number;
  of: number;
}
// Patterns by a shrunk first-try miss rate, (misses + 1) / (first tries + 2), as of `day` (attempts before it),
// ties by the roadmap order; a pattern with no unseen catalog problem left drops out.
export function rankPatterns(attempts: readonly Attempt[], day: string): Ranked[] {
  const firsts = new Map<string, Attempt>();
  for (const a of attempts) if (a.day < day && !firsts.has(a.slug)) firsts.set(a.slug, a);
  const stat = new Map<PatternId, Ranked>();
  for (const a of firsts.values()) {
    const r = stat.get(a.pattern) ?? { pattern: a.pattern, misses: 0, of: 0 };
    stat.set(a.pattern, { ...r, misses: r.misses + (a.outcome === 'clean' ? 0 : 1), of: r.of + 1 });
  }
  const score = (r: Ranked) => (r.misses + 1) / (r.of + 2);
  return PATTERNS.filter((p) =>
    NEETCODE_150.some((c) => c.pattern === p && !c.premium && !firsts.has(c.slug)),
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
  source: 'engine' | 'override';
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
  override: Pick<CoachFocus, 'pattern' | 'sinceDay'> | null,
  today: string,
  params: CoachParams = COACH_PARAMS,
): CoachFocusState {
  const days = [...new Set(attempts.map((a) => a.day))].sort();
  const anchor = override?.sinceDay ?? days[0] ?? today;
  const active = days.filter((d) => d >= anchor && d < today);
  const blocks = Math.floor(active.length / params.blockDays);
  const top = (day: string, not: PatternId | null) =>
    rankPatterns(attempts, day).find((r) => r.pattern !== not);
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
    source: held ? 'override' : 'engine',
    why: held
      ? `${PATTERN_NAMES[pattern]}: your pick since ${fmtSpokenDay(override.sinceDay, today)}`
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
}
export interface CoachInput {
  today: string;
  now: number;
  dayStartHour: number;
  sittings: readonly Sitting[]; // alive heads
  attempts: readonly CoachAttempt[]; // alive
  days: readonly CoachDay[]; // alive
  focus: CoachFocus | null;
}

const UP: Record<Difficulty, Difficulty | null> = { Easy: 'Medium', Medium: 'Hard', Hard: null };
const DIFF_RANK: Record<Difficulty, number> = { Easy: 0, Medium: 1, Hard: 2 };
const dayStartHhmm = (h: number) => `${String(h).padStart(2, '0')}:00`;
const dayStartAt = (day: string, h: number) => zonedEpoch(day, dayStartHhmm(h), USER_TIME_ZONE);
const pickable = (c: CatalogProblem, seen: ReadonlySet<string>) => !c.premium && !seen.has(c.slug);

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
): CatalogProblem[] {
  const cap = than ? DIFF_RANK[than] : 2;
  const open = NEETCODE_150.filter(
    (c) => c.pattern === pattern && pickable(c, seen) && !not.has(c.slug),
  );
  const easier = open
    .filter((c) => DIFF_RANK[c.difficulty] < cap)
    .sort((a, b) => DIFF_RANK[b.difficulty] - DIFF_RANK[a.difficulty]);
  return easier.length ? easier : open.filter((c) => DIFF_RANK[c.difficulty] === cap);
}

// A re-solve slot's reason: today's rule first, then why it's due.
const resolveReason = (r: ProblemRecord, today: string) =>
  `Re-solve today: blank editor, no hints. Due since ${fmtSpokenDay(r.schedule!.dueDay, today)} (${r.schedule!.track === 'peeked' ? 'peeked or failed' : 'clean'} track, step ${r.schedule!.step + 1}); last tried ${fmtSpokenDay(r.lastDay, today)}`;
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

// From state as of the start of the day: carry-over (the last active day's unaccepted, unpeeked problem, if
// within carryOverDays), new (the focus pattern's next unseen problem), re-solve (the oldest due, other patterns
// first, peeked track first), stretch (one difficulty up in the focus pattern, else an unseen Medium from the
// next-ranked pattern). One of each; an empty kind lets the next kind (stretch wraps to new) take a second; at
// most 2 a kind and 4 in all, never padded. Then the day's changes, then today's sittings and attempts.
export function planDay(input: CoachInput, params: CoachParams = COACH_PARAMS): CoachToday {
  const { today, now, dayStartHour: h } = input;
  const all = attemptsOf(input.sittings, input.attempts, now, params, today).filter(
    (a) => a.day <= today,
  );
  const before = all.filter((a) => a.day < today);
  const records = problemRecords(before, params);
  const seen = new Set(records.map((r) => r.slug));
  const focus = focusOn(all, input.focus, today, params);
  const ranks = rankPatterns(before, today);
  const titleOf = (slug: string) =>
    catalogProblem(slug)?.title ?? records.find((r) => r.slug === slug)?.title ?? slug;

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
  const unseen = NEETCODE_150.filter((c) => c.pattern === focus.pattern && pickable(c, seen));
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
        (a.schedule!.track === b.schedule!.track ? 0 : a.schedule!.track === 'peeked' ? -1 : 1) ||
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
      ? NEETCODE_150.filter(
          (c) => c.pattern === next && c.difficulty === 'Medium' && pickable(c, seen),
        )
      : []),
  ];

  type Cand = { slug: string; reason: string };
  const cands: Record<SlotKind, Cand[]> = {
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
    stretch: stretch.map((c) => ({
      slug: c.slug,
      reason: `Stretch: ${c.difficulty} in ${PATTERN_NAMES[c.pattern]}`,
    })),
  };
  const picked: Record<SlotKind, Cand[]> = {
    'carry-over': [],
    new: [],
    're-solve': [],
    stretch: [],
  };
  const used = new Set<string>();
  const take = (k: SlotKind) => {
    const c = cands[k].find((x) => !used.has(x.slug));
    if (!c || picked[k].length >= MAX_PER_KIND) return false;
    used.add(c.slug);
    picked[k].push(c);
    return true;
  };
  for (const k of SLOT_KINDS) take(k);
  const nextKind: Record<SlotKind, SlotKind> = {
    'carry-over': 'new',
    new: 're-solve',
    're-solve': 'stretch',
    stretch: 'new',
  };
  for (const k of SLOT_KINDS) if (!picked[k].length) take(nextKind[k]);

  const endOfDay = dayStartAt(addDays(today, 1), h);
  let slots: CoachSlot[] = SLOT_KINDS.flatMap((kind) =>
    picked[kind].map((c) => slotOf(kind, c.slug, c.reason, null)),
  ).slice(0, MAX_SLOTS);
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
    };
  }

  // A swapped-in problem takes its own kind, so its coaching rules are right: the carry-over, a due re-solve or
  // a problem already tried (a re-solve's rules: blank editor, no hints), else unseen — new, or still a stretch
  // when it replaced one.
  const dueSlugs = new Set(dueNow.map((r) => r.slug));
  function swappedIn(was: SlotKind, slug: string, from: string): CoachSlot {
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
  const row = input.days.find((d) => d.day === today) ?? null;
  for (const c of row?.changes ?? []) {
    // A change names its slot by the engine's pick alone (picks are unique across slots); its `kind` is history.
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
      alternatives: easierIn(s.pattern, s.difficulty, seen, taken)
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
  };
}

// Every problem the user has a record on, newest first, from all counted attempts (today's too).
// `today`: a sitting left open overnight counts on its day, as the plan counts it.
export function listRecords(
  input: Omit<CoachInput, 'today' | 'days' | 'focus' | 'dayStartHour'> & { today?: string },
) {
  return problemRecords(
    attemptsOf(input.sittings, input.attempts, input.now, COACH_PARAMS, input.today),
  ).sort((a, b) => b.lastDay.localeCompare(a.lastDay) || a.slug.localeCompare(b.slug));
}

// --- Writes' inputs ---
const SLUG_RE = /^[a-z0-9-]{1,128}$/;
export const isProblemSlug = (v: unknown): v is string => typeof v === 'string' && SLUG_RE.test(v);
export const LOG_ATTEMPTS_MAX = 50;
export const ATTEMPT_NOTE_MAX = 300;
export const ATTEMPT_TITLE_MAX = 200;
export const ATTEMPT_BACKDATE_DAYS = 60;
export interface CoachAttemptInput {
  slug: string;
  title?: string | null;
  day?: string; // the user's today when absent
  outcome: AttemptOutcome;
  help?: HelpLevel;
  cause?: CauseTag | null;
  minutes?: number | null;
  note?: string | null;
}
export type NormalizedAttempt = Pick<
  CoachAttempt,
  'slug' | 'title' | 'day' | 'outcome' | 'help' | 'cause' | 'minutes' | 'note'
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
]);
// One manual attempt, validated: a problem slug, an outcome, a day no later than today and at most
// ATTEMPT_BACKDATE_DAYS back; `failed` with help `solution` is a peek. A clean attempt took no help.
export function normalizeCoachAttempt(v: unknown, today: string): NormalizedAttempt {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error('An attempt must be an object');
  const r = v as Record<string, unknown>;
  for (const k of Object.keys(r))
    if (!KNOWN_ATTEMPT_KEYS.has(k)) throw new Error(`Unknown attempt field: ${k}`);
  if (!isProblemSlug(r.slug))
    throw new Error('slug must be a LeetCode problem slug (lowercase letters, digits, dashes)');
  if (!ATTEMPT_OUTCOMES.includes(r.outcome as AttemptOutcome))
    throw new Error('outcome must be clean, solved or failed');
  const outcome = r.outcome as AttemptOutcome;
  const help = (r.help ?? 'none') as HelpLevel;
  if (!HELP_LEVELS.includes(help)) throw new Error('help must be none, hint or solution');
  if (outcome === 'clean' && help !== 'none') throw new Error('A clean attempt took no help');
  if (help === 'solution' && outcome !== 'failed')
    throw new Error('An attempt that read the solution is failed');
  const cause = r.cause ?? null;
  if (cause !== null && !isCauseTag(cause))
    throw new Error(`cause must be one of ${CAUSE_TAGS.join(', ')}`);
  const day = r.day ?? today;
  if (typeof day !== 'string' || !isDayKey(day)) throw new Error('day must be YYYY-MM-DD');
  if (day > today) throw new Error('day must not be after today');
  if (day < addDays(today, -ATTEMPT_BACKDATE_DAYS))
    throw new Error(`day must be within the last ${ATTEMPT_BACKDATE_DAYS} days`);
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
  };
}
// A peek already logged for that problem and day (logCoachAttempts returns it instead of a second row).
export const peekOf = (
  stored: readonly CoachAttempt[],
  n: Pick<CoachAttempt, 'slug' | 'day'>,
): CoachAttempt | null =>
  stored.find(
    (a) => a.deletedAt === null && a.help === 'solution' && a.slug === n.slug && a.day === n.day,
  ) ?? null;
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
    const easier = easierIn(slot.pattern, slot.difficulty, seen, slotProblems(today.slots))[0];
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
  const all = attemptsOf(ci.sittings, ci.attempts, ci.now, COACH_PARAMS, ci.today);
  return focusOn(all, cur, ci.today).source === 'override';
}
// An override on a pattern with nothing unseen left would leave no new slot: refused.
export function focusRoomError(ci: CoachInput, pattern: PatternId): string | null {
  const seen = new Set(
    attemptsOf(ci.sittings, ci.attempts, ci.now, COACH_PARAMS, ci.today)
      .filter((a) => a.day < ci.today)
      .map((a) => a.slug),
  );
  return NEETCODE_150.some((c) => c.pattern === pattern && pickable(c, seen))
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
