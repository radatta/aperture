// The LeetCode coach on dev (docs/areas/recruiting/coach.md): today's plan through the API and leetcode_today,
// a sitting on a slot moving it in progress then done, an off-plan sitting leaving the queue alone, the review
// merge, and the four MCP writes as the test user. Everything this run makes is ledgered by id and cleaned by the
// pipeline: sittings (with their reps), attempts (deleteCoachAttempt), slot changes (restored). Problem slugs
// outside the catalog are synthetic; a sitting on a slot uses the slot's own (public) catalog slug.
import { McpRpcError, PARAM_ERROR } from '../mcp';
import type { DevCoachToday, DevSittingEvent, DevSittingStart } from '../api';
import type { Ctx, Scenario } from '../scenario';
import { devUlid } from './flux-history';

const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const tag = (ctx: Ctx) => ctx.nonce.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const slugOf = (ctx: Ctx, which: string) => `devcheck-coach-${tag(ctx)}-${which}`;
const titleOf = (ctx: Ctx, which: string) => `devcheck-coach ${ctx.nonce} ${which}`;
const start = (slug: string, title: string): DevSittingStart => ({
  clientSittingId: devUlid(),
  problemSlug: slug,
  problemTitle: title,
  difficulty: 'Easy',
  topicTags: ['Array'],
  lang: 'python3',
  startedAt: Date.now(),
  tzOffsetMinutes: 480, // the test user's day is LA's
});
const accepted = (at: number): DevSittingEvent => ({
  id: devUlid(),
  type: 'submit',
  at,
  payload: {
    request: { lang: 'python3', typed_code: 'print("devcheck")' },
    result: { status_code: 10, status_msg: 'Accepted', total_correct: 3, total_testcases: 3 },
  },
});
const fail = (msg: string): never => {
  throw new Error(msg);
};
const expectParamError = async (what: string, call: () => Promise<unknown>) => {
  try {
    await call();
  } catch (err) {
    if (err instanceof McpRpcError && err.code === PARAM_ERROR) return;
    throw err;
  }
  fail(`${what}: expected a param error (-32602), got a result`);
};
const slugs = (t: DevCoachToday) => t.slots.map((s) => s.slug);
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

// What this run made and read, shared across steps (a scenario's steps run in order).
const state = {
  plan: null as DevCoachToday | null,
  slotSlug: '',
  slotKind: '',
  sittingId: '',
  repId: '',
  offId: '',
};
const plan = () => state.plan ?? fail('no plan read — the plan step failed');

// A sitting through to Done: an accepted submit, the actual, Done on its rep.
async function finish(ctx: Ctx, sittingId: string, repId: string) {
  await ctx.api.writes.lcSittingEvents(sittingId, [accepted(Date.now())]);
  await ctx.api.writes.setTaskActual(repId, 15);
  await ctx.api.writes.finishTask(repId, 'done');
}

export const lcCoach: Scenario = {
  id: 'lc-coach',
  title: 'The LeetCode coach: today’s plan, slots by sitting, and the MCP tools',
  tiers: ['full'],
  rows: [
    {
      id: 'plan',
      entry: 'api',
      kind: 'nominal',
      what: 'getCoachToday answers today’s plan: 1–4 slots, each with a kind, a reason and the 30-minute cap, and a floor',
    },
    {
      id: 'today-mcp',
      entry: 'mcp',
      kind: 'nominal',
      what: '"what’s today?" — tools/list has the coach’s five tools; leetcode_today answers the same slots with their coaching rules',
    },
    {
      id: 'slot-in-progress',
      entry: 'api',
      kind: 'nominal',
      what: 'A Start on a slot’s problem marks that slot in progress, with its sitting',
    },
    {
      id: 'live-slot',
      entry: 'mcp',
      kind: 'nominal',
      what: 'live_sitting on that sitting names its slot kind, the cap and the rules for it',
    },
    {
      id: 'slot-done',
      entry: 'api',
      kind: 'nominal',
      what: 'Done on its rep marks the slot done with its outcome; the plan’s problems don’t move',
    },
    {
      id: 'review-merge',
      entry: 'api',
      kind: 'edge',
      what: 'A cause set by patchSittingReview survives a review save that doesn’t send it',
    },
    {
      id: 'off-plan',
      entry: 'api',
      kind: 'edge',
      what: 'A sitting on a problem off the plan lands in offPlan; the slots and the due list are unchanged',
    },
    {
      id: 'mcp-peeked',
      entry: 'mcp',
      kind: 'nominal',
      what: '"I looked at the solution" — mark_peeked puts the problem on the peeked track, due tomorrow; a repeat is one state',
    },
    {
      id: 'mcp-swap',
      entry: 'mcp',
      kind: 'nominal',
      what: '"too hard, an easier one" — swap_slot swaps a slot to an easier problem; restore brings the original back',
    },
    {
      id: 'mcp-log',
      entry: 'mcp',
      kind: 'nominal',
      what: '"I did one on paper, clean" — log_attempt counts toward momentum and schedules the re-solve in 3 days',
    },
    {
      id: 'mcp-bad-args',
      entry: 'mcp',
      kind: 'edge',
      what: 'Bad arguments are param errors and an unknown slot is refused, with nothing written',
    },
    {
      id: 'empty-account',
      entry: 'api',
      kind: 'edge',
      what: 'An account with no history gets new problems and a stretch, no carry-over; the floor is the new pick',
      offDev: {
        file: 'packages/shared/src/coach.test.ts',
        test: 'empty account: new problems in the first pattern, a stretch, no carry-over; floor = the new pick',
        why: 'the dev test user has history, and a scenario can’t clear it',
      },
    },
    {
      id: 'stretch-two',
      entry: 'api',
      kind: 'edge',
      what: 'With no re-solve due, the stretch takes a second slot; never more than 4',
      offDev: {
        file: 'packages/shared/src/coach.test.ts',
        test: 'an empty re-solve queue lets the stretch take two; never more than 4, never padded',
        why: 'the queue’s state on dev depends on past days’ sittings, which a run can’t make',
      },
    },
    {
      id: 'scheduler',
      entry: 'api',
      kind: 'edge',
      what: 'The re-solve schedule: every transition of the table (clean, solved, failed; graduation)',
      offDev: {
        file: 'packages/shared/src/coach.test.ts',
        test: 'a solved re-solve repeats the same gap from its day',
        why: 'a transition needs attempts on past days; its siblings in the same describe cover the rest of the table',
      },
    },
    {
      id: 'day-boundary',
      entry: 'api',
      kind: 'edge',
      what: 'The plan’s day turns at dayStartHour in the user’s zone',
      offDev: {
        file: 'packages/shared/src/coach.test.ts',
        test: 'slots are due at the end of the user’s day (dayStartHour, their zone)',
        why: 'dev’s clock can’t be moved to the boundary; the contract’s lc coach suite pins the day turn on all three clients',
      },
    },
    {
      id: 'test-sitting',
      entry: 'api',
      kind: 'edge',
      what: 'A test sitting (flagged, or under 3 minutes with no accept) changes nothing',
      offDev: {
        file: 'packages/shared/src/coach.test.ts',
        test: 'a test sitting changes nothing',
        why: 'its effect is on the next days’ plans, which a run can’t reach',
      },
    },
    {
      id: 'ownership',
      entry: 'mcp',
      kind: 'edge',
      what: 'Another user never sees this user’s attempts, slot changes or focus',
      offDev: {
        file: 'lambdas/src/mcp/coachTools.test.ts',
        test: 'coach rows sit under the caller’s partition: another user sees none of them',
        why: 'dev has one test user, so there is no second partition to read',
      },
    },
    {
      id: 'claude-asks',
      entry: 'mcp',
      kind: 'nominal',
      what: 'In a real claude.ai thread, Claude says what it will write and waits for a yes before each coach write',
      needsYou:
        'the claude.ai connector and the model’s behaviour are the user’s to watch (the dev thread walk)',
    },
  ],
  steps: [
    {
      id: 'plan',
      title: 'Read today’s plan through the API',
      entry: 'api',
      proves: ['plan'],
      async run(ctx) {
        const t = await ctx.api.reads.getCoachToday();
        if (t.day !== ctx.dates.today && t.day !== addDays(ctx.dates.today, -1))
          fail(`plan day ${t.day}, the run's day ${ctx.dates.today}`);
        if (!t.slots.length || t.slots.length > 4) fail(`${t.slots.length} slots`);
        const kinds = ['carry-over', 'new', 're-solve', 'stretch'];
        for (const s of t.slots)
          if (!kinds.includes(s.kind) || !s.reason.trim() || s.capMin !== 30)
            fail(`slot ${JSON.stringify(s)}`);
        if (!t.floor || t.mode !== 'general') fail(`floor/mode: ${JSON.stringify(t)}`);
        state.plan = t;
      },
    },
    {
      id: 'tools',
      title: 'tools/list has the coach’s tools; leetcode_today answers the same plan',
      entry: 'mcp',
      proves: ['today-mcp'],
      async run(ctx) {
        const names = await ctx.mcp.reads.toolsList();
        for (const n of [
          'leetcode_today',
          'mark_peeked',
          'set_cause_tag',
          'swap_slot',
          'log_attempt',
        ])
          if (!names.includes(n)) fail(`tools/list has no ${n}`);
        const t = (await ctx.mcp.reads.leetcodeToday()) as DevCoachToday & {
          rules?: Record<string, string>;
        };
        if (t.day !== plan().day || !same(slugs(t), slugs(plan())))
          fail(`leetcode_today ${slugs(t).join(',')} vs the API's ${slugs(plan()).join(',')}`);
        if (!t.rules?.['re-solve']?.includes('no hints'))
          fail('leetcode_today has no coaching rules');
      },
    },
    {
      id: 'start-on-slot',
      title: 'Link a roll; Start a sitting on the first open slot’s problem',
      entry: 'api',
      proves: ['slot-in-progress'],
      async run(ctx) {
        const slot = plan().slots.find((s) => s.status === 'open') ?? fail('no open slot to start');
        const roll = await ctx.api.writes.upsertRoll({
          name: titleOf(ctx, 'roll'),
          estimateMin: 45,
        });
        await ctx.api.writes.linkLeetcodeRoll(roll.id);
        const { sitting } = await ctx.api.writes.lcSittingStart(start(slot.slug, slot.title));
        Object.assign(state, {
          slotSlug: slot.slug,
          slotKind: slot.kind,
          sittingId: sitting.id,
          repId: sitting.repTaskId,
        });
        const t = await ctx.api.reads.getCoachToday();
        const now = t.slots.find((s) => s.slug === slot.slug);
        if (now?.status !== 'in-progress' || now.sittingId !== sitting.id)
          fail(`slot after Start: ${JSON.stringify(now)}`);
      },
    },
    {
      id: 'live-slot',
      title: 'live_sitting names the sitting’s slot',
      entry: 'mcp',
      proves: ['live-slot'],
      async run(ctx) {
        const live = await ctx.mcp.reads.liveSitting();
        if (!live.active || live.sitting?.id !== state.sittingId)
          fail('live_sitting isn’t on this run’s sitting');
        const slot = live.slot ?? fail('live_sitting has no slot');
        if (
          slot.kind !== state.slotKind ||
          slot.capMin !== 30 ||
          slot.overCap ||
          !slot.rules.trim()
        )
          fail(`slot: ${JSON.stringify(slot)}`);
      },
    },
    {
      id: 'finish-slot',
      title: 'Accepted submit and Done: the slot is done; a patched cause survives a review save',
      entry: 'api',
      proves: ['slot-done', 'review-merge'],
      async run(ctx) {
        await finish(ctx, state.sittingId, state.repId);
        const t = await ctx.api.reads.getCoachToday();
        const slot = t.slots.find((s) => s.slug === state.slotSlug);
        if (slot?.status !== 'done' || slot.outcome !== 'clean')
          fail(`slot after Done: ${JSON.stringify(slot)}`);
        if (!same(slugs(t), slugs(plan()))) fail('the plan’s problems moved after a sitting');
        await ctx.api.writes.patchSittingReview(state.sittingId, { cause: 'boundary' });
        const saved = await ctx.api.writes.setSittingReview(state.sittingId, {
          insight: `devcheck ${ctx.nonce}`,
          help: 'none',
          mistakes: [],
          howItWent: null,
          tags: [],
          draftUsed: false,
        });
        const cause = (saved.review as { cause?: string } | null | undefined)?.cause;
        if (cause !== 'boundary') fail(`cause after a form save: ${String(cause)}`);
      },
    },
    {
      id: 'off-plan',
      title: 'A sitting on a problem off the plan',
      entry: 'api',
      proves: ['off-plan'],
      async run(ctx) {
        const before = await ctx.api.reads.getCoachToday();
        const { sitting } = await ctx.api.writes.lcSittingStart(
          start(slugOf(ctx, 'off'), titleOf(ctx, 'off')),
        );
        state.offId = sitting.id;
        await finish(ctx, sitting.id, sitting.repTaskId);
        const t = await ctx.api.reads.getCoachToday();
        if (!t.offPlan.some((o) => o.sittingId === sitting.id))
          fail('the off-plan sitting isn’t in offPlan');
        if (!same(slugs(t), slugs(before))) fail('an off-plan sitting moved the slots');
        const due = (x: DevCoachToday) => x.due.map((q) => `${q.slug}@${q.dueDay}`);
        if (!same(due(t), due(before)))
          fail(`due changed: ${due(before).join(',')} → ${due(t).join(',')}`);
        await ctx.api.writes.linkLeetcodeRoll(null); // for the scenarios after
      },
    },
    {
      id: 'peeked',
      title: 'mark_peeked on a problem with no sitting today, twice',
      entry: 'mcp',
      proves: ['mcp-peeked'],
      async run(ctx) {
        const slug = slugOf(ctx, 'peek');
        const tomorrow = addDays(plan().day, 1);
        const a = await ctx.mcp.writes.markPeeked({ slug });
        if (!a.attemptId || a.nextDue?.dueDay !== tomorrow || a.nextDue.track !== 'peeked')
          fail(`mark_peeked: ${JSON.stringify(a)}`);
        const b = await ctx.mcp.writes.markPeeked({ slug });
        if (b.attemptId !== a.attemptId) fail('a repeated mark_peeked logged a second attempt');
        const rec = (await ctx.api.reads.listProblemRecords()).find((r) => r.slug === slug);
        if (!rec?.peeked) fail('the record isn’t peeked');
      },
    },
    {
      id: 'swap',
      title: 'swap_slot on an open slot, then restore',
      entry: 'mcp',
      proves: ['mcp-swap'],
      async run(ctx) {
        const t0 = await ctx.mcp.reads.leetcodeToday();
        const slot =
          [...t0.slots].reverse().find((s) => s.status === 'open' && s.kind !== 're-solve') ??
          t0.slots.find((s) => s.status === 'open') ??
          fail('no open slot to swap');
        const t1 = await ctx.mcp.writes.swapSlot(t0.day, slot.slug, {
          slug: slot.slug,
          action: 'swap',
        });
        const swapped =
          t1.slots.find((s) => s.swappedFrom === slot.slug && s.slug !== slot.slug) ??
          fail(`no swapped slot: ${slugs(t1).join(',')}`);
        const t2 = await ctx.mcp.writes.swapSlot(t0.day, slot.slug, {
          slug: swapped.slug,
          action: 'restore',
        });
        if (!same(slugs(t2), slugs(t0)))
          fail(`restore: ${slugs(t2).join(',')} vs ${slugs(t0).join(',')}`);
      },
    },
    {
      id: 'log',
      title: 'log_attempt: a clean attempt today',
      entry: 'mcp',
      proves: ['mcp-log'],
      async run(ctx) {
        const slug = slugOf(ctx, 'paper');
        const out = await ctx.mcp.writes.logAttempt([
          { slug, outcome: 'clean', minutes: 15, note: `devcheck ${ctx.nonce}` },
        ]);
        const a = out.attempts[0] ?? fail('log_attempt stored nothing');
        if (a.slug !== slug || a.nextDue?.dueDay !== addDays(plan().day, 3))
          fail(`log_attempt: ${JSON.stringify(a)}`);
        const t = await ctx.mcp.reads.leetcodeToday();
        if (t.momentum.lastActiveDay !== t.day || t.momentum.activeDays < 1)
          fail(`momentum: ${JSON.stringify(t.momentum)}`);
      },
    },
    {
      id: 'bad-args',
      title: 'Bad arguments and an unknown slot write nothing',
      entry: 'mcp',
      proves: ['mcp-bad-args'],
      async run(ctx) {
        const before = (await ctx.api.reads.listCoachAttempts()).length;
        await expectParamError('mark_peeked {}', () => ctx.mcp.writes.markPeeked({}));
        await expectParamError('log_attempt []', () => ctx.mcp.writes.logAttempt([]));
        await expectParamError('swap_slot flip', () =>
          ctx.mcp.writes.swapSlot(plan().day, slugOf(ctx, 'none'), {
            slug: slugOf(ctx, 'none'),
            action: 'flip',
          }),
        );
        try {
          await ctx.mcp.writes.swapSlot(plan().day, slugOf(ctx, 'none'), {
            slug: slugOf(ctx, 'none'),
            action: 'skip',
          });
          fail('a skip on no slot was accepted');
        } catch (err) {
          if (!/No slot/.test(String(err))) throw err;
        }
        if ((await ctx.api.reads.listCoachAttempts()).length !== before)
          fail('a refused call wrote an attempt');
      },
    },
  ],
};
