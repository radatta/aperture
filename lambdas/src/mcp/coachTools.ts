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
  sittingMinutes,
} from '@aperture/shared';
import type { CoachAttempt, CoachSlot, CoachToday, ProblemRecord, Sitting } from '@aperture/shared';
import { RpcParamError } from './types';
import type { Tool, ToolContext } from './types';

// The LeetCode coach for Claude (docs/areas/recruiting/coach.md; docs/areas/mcp → Tools). leetcode_today reads;
// mark_peeked, set_cause_tag, swap_slot and log_attempt write the user's data, each only on their yes.

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
  'Say "due", never "overdue", and never count missed days or streaks — momentum is "N of the last 7 days". Offer the floor (one problem) when they are short on time or back after a gap. Open slot 1 with its link when they are ready. A new sitting starts from Start on the LeetCode page, never from here.';

const slotView = (s: CoachSlot, n: number) => ({
  n,
  kind: s.kind,
  title: s.title,
  slug: s.slug,
  url: s.url,
  pattern: PATTERN_NAMES[s.pattern],
  difficulty: s.difficulty,
  reason: s.reason,
  capMin: s.capMin,
  status: s.status,
  outcome: s.outcome,
  sittingId: s.sittingId,
  swappedFrom: s.swappedFrom,
  easier: s.alternatives,
});
export function todayView(t: CoachToday) {
  return {
    day: t.day,
    mode: t.mode,
    focus: { ...t.focus, pattern: PATTERN_NAMES[t.focus.pattern], patternId: t.focus.pattern },
    slots: t.slots.map((s, i) => slotView(s, i + 1)),
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

export const COACH_TOOLS: Tool[] = [
  {
    name: 'leetcode_today',
    description: [
      'The LeetCode coach’s plan for today — open every practice conversation with it ("what’s today?", "continue"). Up to 4 slots in order (carry-over, new in the focus pattern, re-solve due, stretch), each with its reason, 30-minute cap, status (open / in-progress / done / skipped) and easier alternatives; the focus pattern and its day of 3 with why; the floor (one problem that counts as showing up); sittings off the plan; the re-solves due and due in the next 48 h; momentum (active days of the last 7); ended sittings with no cause tag yet.',
      'Recomputed on every call from their sittings, so a new conversation picks up exactly where the last left off. `rules` says how to coach each slot kind; `note` how to talk about it.',
      'Read-only.',
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
      return todayView(
        (await ctx.dispatch('getCoachToday', day === undefined ? [] : [day])) as CoachToday,
      );
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
];
