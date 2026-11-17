import {
  addDays,
  CAUSE_TAGS,
  COACH_PARAMS,
  isCauseTag,
  isDayKey,
  isProblemSlug,
  isSittingOpen,
  isUlid,
  ATTEMPT_OUTCOMES,
  HELP_LEVELS,
  LOG_ATTEMPTS_MAX,
  PATTERN_NAMES,
  PATTERNS,
  catalogProblem,
  isPatternId,
  patternOfTags,
  sittingMinutes,
  sittingProblemUrl,
} from '@aperture/shared';
import type {
  CoachAttempt,
  CoachFocus,
  CoachSlot,
  CoachStats,
  CoachToday,
  PatternId,
  ProblemRecord,
  Rate,
  Sitting,
  Story,
} from '@aperture/shared';
import { RpcParamError } from './types';
import type { Tool, ToolContext } from './types';

// The LeetCode coach for Claude (docs/areas/recruiting/coach.md; docs/areas/mcp → Tools). leetcode_today,
// list_problems, get_problem, coach_stats and list_stories read; mark_peeked, set_cause_tag, swap_slot,
// log_attempt, set_focus_pattern and delete_attempt write the user's data, each only on their yes.

// Every write's description opens with this, so the posture travels with the tool (MCP has no annotations).
const ASK_FIRST =
  'Writes to their Aperture data. Before calling, say exactly what you will write and wait for their yes in this conversation; never infer it.';

const iso = (ms: number) => new Date(ms).toISOString();
const now = (ctx: ToolContext) => ctx.now?.() ?? Date.now();

// The coaching rules per slot kind — what live_sitting and leetcode_today hand Claude with each slot.
export const SLOT_RULES: Record<CoachSlot['kind'] | 'off-plan', string> = {
  're-solve':
    'A re-solve: a blank editor and no hints at all — the point is whether it comes back unaided. Stuck at the cap: stop, say so plainly, and the queue brings it back sooner.',
  'carry-over':
    'Unfinished from last time: the hint ladder applies (before the cap, one nudge — a question or the topic, never the approach; at the cap, first "trace the failing input by hand", then a pointer to the idea or line, never code).',
  new: 'A new problem in the focus pattern: the hint ladder applies (before the cap, one nudge — a question or the topic, never the approach; at the cap, first "trace the failing input by hand", then a pointer to the idea or line, never code).',
  stretch:
    'A stretch: one step harder. The hint ladder applies, and stopping at the cap is a fine outcome.',
  'off-plan':
    'Off the plan (curiosity, a class): fine. Coach it like a new problem; the re-solves due today stay due.',
};
const SOLUTION_RULE =
  'Asked for the solution: push back once with the live numbers (passed/total, the failing input — "trace it"). If they still want it, give it, then offer mark_peeked (it schedules the re-solve) and say when it is due.';
const TODAY_NOTE =
  'Say "due", never "overdue", and never count missed days or streaks — momentum is "N of the last 7 days". Offer the floor (one problem) when they are short on time or back after a gap. Open slot 1 with its link when they are ready. A new sitting starts from Start on the LeetCode page, never from here. When ai.source is "ai", Opus picked today’s slots: coach from ai.note and each slot’s `why` (its `reason` is the rules’ facts). When ai.notice is set, say it once, plainly, and coach from the rules’ slots.';
const PICKING_NOTE =
  'Opus is still picking today’s problems: say so, call leetcode_today again in about 10 seconds, and don’t coach from a plan until it lands.';
// leetcode_today waits this long for a pick it started (or found running) before answering `pending`.
const PICK_WAIT_MS = 7_500; // inside the MCP Lambda's 15 s with the reads around it
const PICK_POLL_MS = 1_500;

const slotView = (s: CoachSlot, n: number) => ({
  n,
  kind: s.kind,
  title: s.title,
  slug: s.slug,
  url: s.url,
  pattern: PATTERN_NAMES[s.pattern],
  difficulty: s.difficulty,
  reason: s.reason,
  why: s.aiWhy, // the AI pick's "why today"; null on a rule slot
  capMin: s.capMin,
  status: s.status,
  outcome: s.outcome,
  sittingId: s.sittingId,
  swappedFrom: s.swappedFrom,
  easier: s.alternatives,
});
// While the pick is due or running the slots aren't shown: they are about to be replaced.
export function todayView(t: CoachToday) {
  const picking = t.ai?.status === 'due' || t.ai?.status === 'pending';
  return {
    day: t.day,
    mode: t.mode,
    focus: { ...t.focus, pattern: PATTERN_NAMES[t.focus.pattern], patternId: t.focus.pattern },
    ai: t.ai && {
      status: t.ai.status,
      source: t.ai.source,
      notice: t.ai.notice,
      reason: t.ai.reason,
      note: t.ai.note,
      focusChange: t.ai.focusChange && {
        from: PATTERN_NAMES[t.ai.focusChange.from],
        to: PATTERN_NAMES[t.ai.focusChange.to],
        why: t.ai.focusChange.why,
      },
      model: t.ai.model,
      ...(picking ? { next: PICKING_NOTE } : {}),
    },
    slots: picking ? [] : t.slots.map((s, i) => slotView(s, i + 1)),
    floor: t.floor,
    offPlan: t.offPlan,
    due: t.due.map((q) => ({ title: q.title, slug: q.slug, dueDay: q.dueDay, track: q.track })),
    next48h: t.next48h.map((q) => ({
      title: q.title,
      slug: q.slug,
      dueDay: q.dueDay,
      track: q.track,
    })),
    momentum: t.momentum,
    unreviewed: t.unreviewed,
    rules: { ...SLOT_RULES, solution: SOLUTION_RULE },
    note: TODAY_NOTE,
  };
}

// Today's plan for live_sitting, read beside its pull; a failure is null, never a failed live read.
export const todayOrNull = (ctx: ToolContext): Promise<CoachToday | null> =>
  (ctx.dispatch('getCoachToday', []) as Promise<CoachToday>).catch(() => null);
// What live_sitting adds about the open sitting's place in the plan.
export function slotOfSitting(
  today: CoachToday | null,
  sitting: Pick<Sitting, 'problemSlug' | 'startedAt' | 'endedAt'>,
  at: number,
) {
  if (!today) return null;
  // A slot's problem, else the floor's (it's on the plan too), else off the plan.
  const slot = today.slots.find((s) => s.slug === sitting.problemSlug);
  const floor = today.floor?.slug === sitting.problemSlug ? today.floor : null;
  const kind = slot?.kind ?? floor?.kind ?? 'off-plan';
  const capMin = slot?.capMin ?? COACH_PARAMS.capMin;
  return {
    kind,
    floor: !slot && !!floor,
    reason: slot?.reason ?? floor?.reason ?? 'Not one of today’s slots',
    why: slot?.aiWhy ?? null,
    capMin,
    overCap: sittingMinutes(sitting, at) >= capMin,
    rules: `${SLOT_RULES[kind]} ${SOLUTION_RULE}`,
  };
}

const nextDue = (records: ProblemRecord[], slug: string) => {
  const r = records.find((x) => x.slug === slug);
  return r?.schedule && !r.schedule.graduated
    ? { dueDay: r.schedule.dueDay, track: r.schedule.track }
    : null;
};
// A peek on a sitting still open isn't an attempt yet: the re-solve it will schedule, from the sitting's day.
const peekDue = (day: string) => ({
  dueDay: addDays(day, COACH_PARAMS.gaps.peeked[0]!),
  track: 'peeked' as const,
  once: 'the sitting ends',
});
const optDay = (v: unknown, name: string) => {
  if (v !== undefined && (typeof v !== 'string' || !isDayKey(v)))
    throw new RpcParamError(`"${name}" must be an ISO date (YYYY-MM-DD)`);
  return v as string | undefined;
};
const optSittingId = (v: unknown) => {
  if (v !== undefined && (typeof v !== 'string' || !isUlid(v)))
    throw new RpcParamError('"sittingId" must be a sitting id — list_sittings gives them');
  return v as string | undefined;
};

// --- The read tools' views ---
const PROBLEMS_LIMIT_MAX = 100;
const scheduleView = (r: ProblemRecord) =>
  r.schedule
    ? {
        track: r.schedule.track,
        step: r.schedule.step + 1,
        of: COACH_PARAMS.gaps[r.schedule.track].length,
        dueDay: r.schedule.graduated ? null : r.schedule.dueDay,
        dueBy: r.schedule.dueBy,
        graduated: r.schedule.graduated,
      }
    : null;
const isDue = (r: ProblemRecord, today: string) =>
  !!r.schedule && !r.schedule.graduated && r.schedule.dueDay <= today;
const problemRow = (r: ProblemRecord) => ({
  slug: r.slug,
  title: r.title,
  pattern: PATTERN_NAMES[r.pattern],
  patternId: r.pattern,
  difficulty: r.difficulty,
  attempts: r.attempts,
  firstDay: r.firstDay,
  firstOutcome: r.firstOutcome,
  lastDay: r.lastDay,
  lastOutcome: r.lastOutcome,
  everAccepted: r.everAccepted,
  peeked: r.peeked,
  cause: r.cause,
  reSolve: scheduleView(r),
});
// A sitting on the problem, short: get_sitting reads one in full.
const problemSitting = (s: Sitting, at: number) => ({
  id: s.id,
  day: s.day,
  status: s.status,
  open: isSittingOpen(s, at),
  minutes: sittingMinutes(s, at),
  submits: s.summary.submits,
  runs: s.summary.runs,
  accepted: s.summary.firstAcceptedAt !== null,
  firstSubmitAccepted: s.summary.firstSubmit ? s.summary.firstSubmit.verdict === 'accepted' : null,
  review: s.review
    ? { help: s.review.help, cause: s.review.cause ?? null, test: s.review.test === true }
    : null,
});
const pct = (r: Rate) => (r.of >= STATS_PCT_MIN ? Math.round((100 * r.hit) / r.of) : null);
const rateView = (r: Rate) => ({ ...r, pct: pct(r) });
const STATS_PCT_MIN = 5; // under this many tries a rate is only a count
const STATS_NOTE = `Read rates as counts ("3 of 8"); \`pct\` is null under ${STATS_PCT_MIN} tries. A clean first try (accepted on the first submit, no help) is the number that matters; a re-solve is any later day on a problem already tried. \`untagged\` counts attempts that went wrong with no cause tag. \`weakest\` is the focus ranking's top as of now, whatever the range: the plan's next pick unless it is the pattern just held or they set one. Compare with their own earlier weeks, never with other people; say "not enough yet" rather than read a trend into one or two weeks. Mock scores are not in this yet.`;
const statsView = (s: CoachStats) => ({
  from: s.from,
  to: s.to,
  activeDays: s.activeDays,
  problems: s.problems,
  attempts: s.attempts,
  firstTry: rateView(s.firstTry),
  resolve: rateView(s.resolve),
  peeked: s.peeked,
  causes: s.causes,
  untagged: s.untagged,
  weeks: s.weeks.map((w) => ({
    week: w.week,
    attempts: w.attempts,
    firstTry: rateView(w.firstTry),
    resolve: rateView(w.resolve),
  })),
  patterns: s.patterns.map((p) => ({
    pattern: PATTERN_NAMES[p.pattern],
    patternId: p.pattern,
    rank: p.rank,
    problems: p.problems,
    attempts: p.attempts,
    firstTry: rateView(p.firstTry),
    resolve: rateView(p.resolve),
    peeked: p.peeked,
    causes: p.causes,
    // The Patterns tab's detail (patternDetail): every try in range, re-solves too.
    submitsPerTry: p.submitsPerTry,
    runBeforeSubmit: rateView(p.runBeforeSubmit),
    traced: rateView(p.traced),
    weeks: p.weeks.map((w) => ({ week: w.week, firstTry: rateView(w.firstTry) })),
  })),
  weakest: s.weakest && { pattern: PATTERN_NAMES[s.weakest], patternId: s.weakest },
  note: STATS_NOTE,
});
const storyView = (s: Story) => ({
  id: s.id,
  title: s.title,
  competencies: s.competencyTags,
  situation: s.situation,
  action: s.action,
  result: s.result,
  updatedAt: iso(s.updatedAt),
});
const optBool = (v: unknown, name: string) => {
  if (v !== undefined && typeof v !== 'boolean')
    throw new RpcParamError(`"${name}" must be true or false`);
  return v as boolean | undefined;
};
const PATTERN_LIST = PATTERNS.join(', ');
const patternArg = (v: unknown, name: string, other: boolean): PatternId => {
  if (!isPatternId(v) || (!other && v === 'other'))
    throw new RpcParamError(
      `"${name}" must be one of ${PATTERN_LIST}${other ? ', other' : ''} — the pattern ids`,
    );
  return v;
};
const todayDay = async (ctx: ToolContext) =>
  ((await ctx.dispatch('getCoachToday', [])) as CoachToday).day;

export const COACH_TOOLS: Tool[] = [
  {
    name: 'leetcode_today',
    description: [
      'The LeetCode coach’s plan for today — open every practice conversation with it ("what’s today?", "continue"). Up to 4 slots in order (carry-over, new in the focus pattern, re-solve due, stretch), each with its reason, 30-minute cap, status (open / in-progress / done / skipped) and easier alternatives; the focus pattern and its day of 3 with why; the floor (one problem that counts as showing up); sittings off the plan; the re-solves due and due in the next 48 h; momentum (active days of the last 7); ended sittings with no cause tag yet.',
      'Recomputed on every call from their sittings, so a new conversation picks up exactly where the last left off. `rules` says how to coach each slot kind; `note` how to talk about it.',
      '`ai`: with their AI pick setting on, the FIRST call of the day starts that day’s AI pick — a write: it claims the day, spends the day’s one Opus call (picking the slots from the rules’ candidates, with a `why` each and an optional day `note`) and may move the focus — then waits up to ~8 s for it. `ai.status` pending: slots are empty, call again shortly. `ai.notice`: the pick failed and the slots are the rules’.',
      'Otherwise read-only.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        day: { type: 'string', description: 'YYYY-MM-DD; omit for their today' },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const day = optDay(args.day, 'day');
      if (day !== undefined)
        return todayView((await ctx.dispatch('getCoachToday', [day])) as CoachToday);
      let t = (await ctx.dispatch('getCoachToday', [])) as CoachToday;
      if (t.ai?.status === 'due') t = (await ctx.dispatch('startCoachPick', [])) as CoachToday;
      const sleep = ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
      for (let waited = 0; t.ai?.status === 'pending' && waited < PICK_WAIT_MS;) {
        await sleep(PICK_POLL_MS);
        waited += PICK_POLL_MS;
        t = (await ctx.dispatch('getCoachToday', [])) as CoachToday;
      }
      return todayView(t);
    },
  },
  {
    name: 'mark_peeked',
    description: [
      ASK_FIRST,
      'Records that they read the solution for a problem: on that day’s sitting on it (its review’s help becomes "solution"), or, with no sitting, as a peeked attempt (also for seeding peeks from before the coach — pass `day`). Either way the problem moves to the peeked track: re-solve due the next day, then 3, 7, 14 days.',
      'Pass `sittingId`, or `slug` (+ optional `day`, default today). Repeating it is harmless. Returns what was written and `nextDue` — read the due day back to them.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'The LeetCode problem slug, e.g. "happy-number"' },
        sittingId: { type: 'string', description: 'A sitting id, instead of slug' },
        day: { type: 'string', description: 'YYYY-MM-DD (with slug); omit for today' },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const sittingId = optSittingId(args.sittingId);
      const day = optDay(args.day, 'day');
      const { slug } = args;
      if ((sittingId === undefined) === (slug === undefined))
        throw new RpcParamError('pass exactly one of "slug" or "sittingId"');
      if (slug !== undefined && !isProblemSlug(slug))
        throw new RpcParamError('"slug" must be a LeetCode problem slug (lowercase, dashes)');
      if (sittingId !== undefined && day !== undefined)
        throw new RpcParamError('"day" goes with "slug" only');
      let wrote: { sittingId: string } | { attemptId: string };
      let target: string;
      let onDay: string;
      let open = false; // a peek on an open sitting isn't an attempt until it ends: say when it will be due
      if (sittingId !== undefined) {
        // A sitting flagged as a test never counts: a peek on it would schedule nothing.
        const head = ((await ctx.dispatch('listSittings', [])) as Sitting[]).find(
          (x) => x.id === sittingId,
        );
        if (head?.review?.test === true)
          throw new Error(
            'That sitting is flagged as a test, so a peek on it counts for nothing — pass "slug" instead',
          );
        const s = (await ctx.dispatch('patchSittingReview', [
          sittingId,
          { help: 'solution' },
        ])) as Sitting;
        wrote = { sittingId: s.id };
        target = s.problemSlug;
        onDay = s.day;
        open = isSittingOpen(s, now(ctx));
      } else {
        const on = day ?? ((await ctx.dispatch('getCoachToday', [])) as CoachToday).day;
        const sittings = (await ctx.dispatch('listSittings', [{ from: on, to: on }])) as Sitting[];
        // A sitting flagged as a test never counts, so the peek goes on an attempt instead.
        const s = sittings.find((x) => x.problemSlug === slug && x.review?.test !== true);
        onDay = on;
        if (s) {
          open = isSittingOpen(s, now(ctx));
          await ctx.dispatch('patchSittingReview', [s.id, { help: 'solution' }]);
          wrote = { sittingId: s.id };
        } else {
          const [a] = (await ctx.dispatch('logCoachAttempts', [
            [{ slug, day: on, outcome: 'failed', help: 'solution' }],
          ])) as CoachAttempt[];
          wrote = { attemptId: a!.id };
        }
        target = slug as string;
      }
      const records = (await ctx.dispatch('listProblemRecords', [])) as ProblemRecord[];
      return {
        slug: target,
        peeked: true,
        ...wrote,
        nextDue: (!open && nextDue(records, target)) || peekDue(onDay),
      };
    },
  },
  {
    name: 'set_cause_tag',
    description: [
      ASK_FIRST,
      `Saves the ONE cause tag of a sitting’s review — why it went wrong: ${CAUSE_TAGS.join(' / ')} (no-trace = submitted without tracing an input by hand; api-slip = a language or library mistake; boundary = an edge case; off-by-one; quit-early = stopped before it was done). Ask them for it after the review; never pick it for them.`,
      'No `sittingId` → their newest ended sitting. `peeked: true` also records that they read the solution. Their other review fields are kept. Returns the sitting’s review — read the tag back.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        sittingId: { type: 'string' },
        cause: { type: 'string', enum: [...CAUSE_TAGS] },
        peeked: { type: 'boolean', description: 'true: they read the solution' },
      },
      required: ['cause'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      let id = optSittingId(args.sittingId);
      const { cause, peeked } = args;
      if (!isCauseTag(cause))
        throw new RpcParamError(`"cause" must be one of ${CAUSE_TAGS.join(', ')}`);
      if (peeked !== undefined && peeked !== true)
        throw new RpcParamError('"peeked" can only be true — leave it out otherwise');
      if (id === undefined) {
        const t = now(ctx);
        const ended = ((await ctx.dispatch('listSittings', [])) as Sitting[]).find(
          (s) => !isSittingOpen(s, t),
        );
        if (!ended) throw new Error('No ended sitting yet — pass sittingId');
        id = ended.id;
      }
      const s = (await ctx.dispatch('patchSittingReview', [
        id,
        { cause, ...(peeked ? { help: 'solution' } : {}) },
      ])) as Sitting;
      return {
        sittingId: s.id,
        problem: s.problemTitle,
        review: s.review ? { ...s.review, updatedAt: iso(s.review.updatedAt) } : null,
      };
    },
  },
  {
    name: 'swap_slot',
    description: [
      ASK_FIRST,
      'Changes one of today’s slots (by the slug on it): `swap` to an easier problem in the same pattern (no `toSlug` → the next easier unseen one) or to `toSlug`; `skip` it for today; `restore` undoes either. The swapped-out problem is never lost — a re-solve stays queued.',
      'Returns today’s plan after the change — read the new slot back.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'The slot’s problem slug (or the one it replaced)' },
        action: { type: 'string', enum: ['swap', 'skip', 'restore'] },
        toSlug: { type: 'string', description: 'swap only: the problem to put in' },
      },
      required: ['slug', 'action'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const { slug, action, toSlug } = args;
      if (!isProblemSlug(slug)) throw new RpcParamError('"slug" must be a LeetCode problem slug');
      if (action !== 'swap' && action !== 'skip' && action !== 'restore')
        throw new RpcParamError('"action" must be swap, skip or restore');
      if (toSlug !== undefined && (action !== 'swap' || !isProblemSlug(toSlug)))
        throw new RpcParamError('"toSlug" is a problem slug, with action "swap" only');
      const t = (await ctx.dispatch('setCoachSlot', [
        { slug, action, ...(toSlug !== undefined ? { toSlug } : {}) },
      ])) as CoachToday;
      return todayView(t);
    },
  },
  {
    name: 'log_attempt',
    description: [
      ASK_FIRST,
      `Logs practice done outside the extension — on paper, in an editor, in a mock — so the plan and the re-solve queue count it. Each attempt: \`slug\`, \`outcome\` (clean = right first time, no help; solved = got there with a hint or a few tries; failed = didn't, or read the solution), optional \`help\` (${HELP_LEVELS.join('/')}), \`cause\`, \`minutes\`, \`note\`, \`day\` (default today, up to 60 days back). Up to ${LOG_ATTEMPTS_MAX} at once.`,
      'It counts toward momentum and the queue; it does not touch their Roll or calibration. Returns the stored attempts and each problem’s next due day — read them back.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        attempts: {
          type: 'array',
          minItems: 1,
          maxItems: LOG_ATTEMPTS_MAX,
          items: {
            type: 'object',
            properties: {
              slug: { type: 'string' },
              title: { type: 'string' },
              day: { type: 'string' },
              outcome: { type: 'string', enum: [...ATTEMPT_OUTCOMES] },
              help: { type: 'string', enum: [...HELP_LEVELS] },
              cause: { type: 'string', enum: [...CAUSE_TAGS] },
              minutes: { type: 'integer', minimum: 1, maximum: 600 },
              note: { type: 'string' },
            },
            required: ['slug', 'outcome'],
            additionalProperties: false,
          },
        },
      },
      required: ['attempts'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const { attempts } = args;
      if (!Array.isArray(attempts) || !attempts.length || attempts.length > LOG_ATTEMPTS_MAX)
        throw new RpcParamError(`"attempts" must be a list of 1 to ${LOG_ATTEMPTS_MAX}`);
      for (const a of attempts)
        if (!a || typeof a !== 'object' || !isProblemSlug((a as { slug?: unknown }).slug))
          throw new RpcParamError('each attempt needs a LeetCode problem "slug"');
      // The rest (outcome, help, day bounds…) is the normalizer's: a refusal comes back as a readable error,
      // with nothing written — the whole list is checked before any row is stored.
      const stored = (await ctx.dispatch('logCoachAttempts', [attempts])) as CoachAttempt[];
      const records = (await ctx.dispatch('listProblemRecords', [])) as ProblemRecord[];
      return {
        attempts: stored.map((a) => ({
          id: a.id,
          slug: a.slug,
          day: a.day,
          outcome: a.outcome,
          help: a.help,
          cause: a.cause,
          nextDue: nextDue(records, a.slug),
        })),
      };
    },
  },
  {
    name: 'list_problems',
    description: [
      'Every problem they have tried (on LeetCode with the extension, or logged), newest first — the history and the re-solve queue ("what\u2019s due?", "which Two Pointers problems have I peeked?"). Each row: title, slug, pattern, difficulty, days tried, the first and the last outcome (clean / solved / failed), ever accepted, peeked, the newest cause tag, and the re-solve state (track, step of N, due day; null due day once graduated).',
      `Filters: \`pattern\` (a pattern id: ${PATTERN_LIST}, other), \`due\` (true: due today or earlier; false: not due), \`peeked\`; \`limit\` 1–${PROBLEMS_LIMIT_MAX} (default 30). With \`due: true\` the oldest due comes first. \`get_problem\` reads one in full.`,
      'Read-only.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', enum: [...PATTERNS, 'other'] },
        due: { type: 'boolean' },
        peeked: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: PROBLEMS_LIMIT_MAX },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const pattern =
        args.pattern === undefined ? undefined : patternArg(args.pattern, 'pattern', true);
      const due = optBool(args.due, 'due');
      const peeked = optBool(args.peeked, 'peeked');
      const { limit = 30 } = args;
      if (
        typeof limit !== 'number' ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > PROBLEMS_LIMIT_MAX
      )
        throw new RpcParamError(`"limit" must be a whole number from 1 to ${PROBLEMS_LIMIT_MAX}`);
      const [records, today] = await Promise.all([
        ctx.dispatch('listProblemRecords', []) as Promise<ProblemRecord[]>,
        due === undefined ? null : todayDay(ctx),
      ]);
      let rows = records.filter(
        (r) =>
          (pattern === undefined || r.pattern === pattern) &&
          (peeked === undefined || r.peeked === peeked) &&
          (today === null || isDue(r, today) === due),
      );
      if (due === true)
        rows = [...rows].sort((a, b) => a.schedule!.dueDay.localeCompare(b.schedule!.dueDay));
      return {
        ...(today !== null ? { today } : {}),
        problems: rows.slice(0, limit).map(problemRow),
        more: rows.length > limit,
        ...(records.length === 0
          ? {
              note: 'No practice recorded yet — a sitting started on LeetCode, or log_attempt, adds one.',
            }
          : {}),
      };
    },
  },
  {
    name: 'get_problem',
    description: [
      'One problem in full, by slug: its catalog place (pattern, difficulty, link), every day tried oldest first (outcome, help, cause, and the sitting and logged-attempt ids — `delete_attempt` takes a logged one), its sittings (minutes, submits, runs, accepted, review), and the re-solve state with its due day.',
      'A problem with no counted attempt comes back with `record: null` (its uncounted sittings still listed). Read-only.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'The LeetCode problem slug, e.g. "two-sum"' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const { slug } = args;
      if (!isProblemSlug(slug))
        throw new RpcParamError('"slug" must be a LeetCode problem slug (lowercase, dashes)');
      const [records, all] = await Promise.all([
        ctx.dispatch('listProblemRecords', []) as Promise<ProblemRecord[]>,
        ctx.dispatch('listSittings', []) as Promise<Sitting[]>,
      ]);
      const r = records.find((x) => x.slug === slug);
      const cat = catalogProblem(slug);
      const mine = all.filter((s) => s.problemSlug === slug);
      if (!r && !cat && !mine.length)
        throw new Error(
          `No record of "${slug}" and it isn\u2019t on the roadmap — list_problems lists the ones tried`,
        );
      const t = now(ctx);
      const sittings = mine.map((s) => problemSitting(s, t));
      // The record's own fields first (a logged problem off the roadmap has a null difficulty, and no sitting),
      // then the catalog's, then the newest uncounted sitting's.
      const s0 = mine[0];
      const src = r
        ? { title: r.title, pattern: r.pattern, difficulty: r.difficulty }
        : cat
          ? { title: cat.title, pattern: cat.pattern, difficulty: cat.difficulty }
          : {
              title: s0!.problemTitle,
              pattern: patternOfTags(s0!.topicTags),
              difficulty: s0!.difficulty,
            };
      const problem = {
        slug,
        title: src.title,
        pattern: PATTERN_NAMES[src.pattern],
        patternId: src.pattern,
        difficulty: src.difficulty,
        onRoadmap: !!cat,
        url: sittingProblemUrl(slug),
      };
      // Sittings that never counted (a test, or too short with no accept) still show, so they can be talked about.
      if (!r)
        return {
          problem,
          record: null,
          sittings,
          note: sittings.length
            ? 'No counted attempt yet: these sittings were tests or too short.'
            : 'Not tried yet.',
        };
      return {
        problem,
        record: {
          attempts: r.attempts,
          firstDay: r.firstDay,
          firstOutcome: r.firstOutcome,
          lastDay: r.lastDay,
          lastOutcome: r.lastOutcome,
          everAccepted: r.everAccepted,
          peeked: r.peeked,
          cause: r.cause,
          reSolve: scheduleView(r),
          submits: r.submits,
          runs: r.runs,
          causes: r.causes,
          lastError: r.lastError,
        },
        tries: r.tries,
        sittings,
      };
    },
  },
  {
    name: 'coach_stats',
    description: [
      'How practice is going — for the weekly check ("how am I doing?"): active days, problems, first tries and how many were clean, re-solves and how many were clean, peeks, the cause-tag mix, per ISO week (the trend) and per pattern (weakest first, by the ranking that picks the focus), each pattern also with submits per try, how often a Run came before the first Submit, how often all three trace inputs were in at the first Submit (card on only), and its first tries per week. The run and trace rates cover only attempts with captured data.',
      'Optional `from` / `to` (YYYY-MM-DD, inclusive; `to` defaults to their today). Test sittings never count. `note` says how to read it.',
      'Read-only.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        to: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const from = optDay(args.from, 'from');
      const to = optDay(args.to, 'to');
      if (from !== undefined && to !== undefined && from > to)
        throw new RpcParamError('"from" must not be after "to"');
      const range = {
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
      };
      return statsView((await ctx.dispatch('getCoachStats', [range])) as CoachStats);
    },
  },
  {
    name: 'list_stories',
    description: [
      'Their behavioral story bank — STAR stories they wrote in the app, newest edit first, each with its competency tags, situation, action and result. For mock behavioral rounds and "which story fits this question?". Stories are their own words: quote them, never rewrite one as theirs.',
      'Read-only (stories are written in the app).',
    ].join(' '),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      const stories = (await ctx.dispatch('listStories', [])) as Story[];
      return {
        stories: stories.map(storyView),
        ...(stories.length
          ? {}
          : { note: 'No stories yet — they are written on the Recruiting page.' }),
      };
    },
  },
  {
    name: 'set_focus_pattern',
    description: [
      ASK_FIRST,
      `Sets the pattern the plan holds from today (their pick over the engine\u2019s), for ${COACH_PARAMS.blockDays} active days; after that the engine picks again. \`pattern\` is a pattern id (${PATTERN_LIST}); null clears their pick and gives the choice back to the engine. Refused when the pattern has no untried roadmap problem left.`,
      `Setting the pattern already held keeps its day. Returns the focus as the plan now reads it (pattern, day N of ${COACH_PARAMS.blockDays}, why) — read it back.`,
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          anyOf: [{ type: 'string', enum: [...PATTERNS] }, { type: 'null' }],
          description: 'A pattern id, or null to clear',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!('pattern' in args)) throw new RpcParamError('"pattern" is required (null clears it)');
      const pattern = args.pattern === null ? null : patternArg(args.pattern, 'pattern', false);
      const stored = (await ctx.dispatch('setCoachFocus', [pattern])) as CoachFocus | null;
      const t = (await ctx.dispatch('getCoachToday', [])) as CoachToday;
      return {
        override: stored
          ? { pattern: PATTERN_NAMES[stored.pattern], since: stored.sinceDay }
          : null,
        focus: todayView(t).focus,
      };
    },
  },
  {
    name: 'delete_attempt',
    description: [
      ASK_FIRST,
      'Removes one attempt logged with log_attempt or mark_peeked (its id: from their result, or get_problem\u2019s `tries`). Sittings are never deleted here. The plan and the re-solve queue recompute without it.',
      'Returns what was removed and the problem\u2019s next due day after — read both back. An id with no live logged attempt writes nothing and says so.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The logged attempt\u2019s id' } },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const { id } = args;
      if (typeof id !== 'string' || !isUlid(id))
        throw new RpcParamError('"id" must be a logged attempt id — get_problem lists them');
      const before = (await ctx.dispatch('listProblemRecords', [])) as ProblemRecord[];
      const hit = before
        .flatMap((r) => r.tries.map((x) => ({ r, x })))
        .find(({ x }) => x.attemptIds.includes(id));
      if (!hit)
        return {
          id,
          deleted: false,
          note: 'No live logged attempt has that id (already removed, or not a logged attempt) — nothing written.',
        };
      await ctx.dispatch('deleteCoachAttempt', [id]);
      const after = (await ctx.dispatch('listProblemRecords', [])) as ProblemRecord[];
      return {
        id,
        deleted: true,
        slug: hit.r.slug,
        title: hit.r.title,
        day: hit.x.day,
        nextDue: nextDue(after, hit.r.slug),
        stillTried: after.some((r) => r.slug === hit.r.slug),
      };
    },
  },
];
