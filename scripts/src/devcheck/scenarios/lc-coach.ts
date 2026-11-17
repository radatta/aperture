// The LeetCode coach on dev (docs/areas/recruiting/coach.md): today's plan through the API and leetcode_today,
// a sitting on a slot moving it in progress then done, an off-plan sitting leaving the queue alone, the review
// merge, the four MCP writes as the test user, the floor and focus, and the schedule over backdated attempts; then
// the app (PR A-app): the Today card, the review's cause and Peeked, F169, Home's morning line.
// Everything this run makes is ledgered by id and cleaned by the pipeline: sittings (with their reps), rolls and the
// roll link, attempts (deleteCoachAttempt), slot changes (restored), the floor (off) and the focus (cleared). Problem
// slugs outside the catalog are synthetic; a sitting on a slot uses the slot's own (public) catalog slug. The
// schedule step's backdated attempts change the plan for any read after it, so the app steps after it read the plan
// live, never an earlier step's.
import { McpRpcError, PARAM_ERROR } from '../mcp';
import type { DevCoachSlot, DevCoachToday, DevSittingEvent, DevSittingStart } from '../api';
import { noConsoleErrors, type Ctx, type Scenario } from '../scenario';
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
const wrong = (at: number): DevSittingEvent => ({
  id: devUlid(),
  type: 'submit',
  at,
  payload: {
    request: { lang: 'python3', typed_code: 'print("devcheck")' },
    result: { status_code: 11, status_msg: 'Wrong Answer', total_correct: 1, total_testcases: 3 },
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
  offRep: '',
  offBefore: null as DevCoachToday | null,
};
const plan = () => state.plan ?? fail('no plan read — the plan step failed');
const today = () => plan().day;

// A sitting through to Done: an accepted submit (unless `accept` is false), the actual, Done on its rep.
async function finish(ctx: Ctx, sittingId: string, repId: string, accept = true) {
  if (accept) await ctx.api.writes.lcSittingEvents(sittingId, [accepted(Date.now())]);
  await ctx.api.writes.setTaskActual(repId, accept ? 15 : 1);
  await ctx.api.writes.finishTask(repId, 'done');
}
const due = (x: DevCoachToday) => x.due.map((q) => `${q.slug}@${q.dueDay}`);
const why = {
  history:
    'whether the dev test user has coach history depends on what earlier runs and other scenarios left; a run can’t make the account empty',
};

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
      what: 'live_sitting on that sitting names its slot kind, the cap and the rules for it, and no trace yet',
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
      id: 'mcp-peek-sitting',
      entry: 'mcp',
      kind: 'nominal',
      what: '"I looked at the solution" mid-sitting — mark_peeked on the open sitting records it and says the re-solve is due tomorrow; a form save after it without help keeps the peek',
    },
    {
      id: 'mcp-cause',
      entry: 'mcp',
      kind: 'nominal',
      what: '"it was a boundary case" — set_cause_tag saves the one cause on the sitting’s review',
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
      what: 'mark_peeked on a problem with no sitting puts it on the peeked track, due tomorrow; a repeat is one state',
    },
    {
      id: 'mcp-swap',
      entry: 'mcp',
      kind: 'nominal',
      what: '"too hard, an easier one" — swap_slot swaps a slot to an easier problem; restore brings the original back',
    },
    {
      id: 'mcp-skip',
      entry: 'mcp',
      kind: 'nominal',
      what: '"skip it today" — swap_slot skip marks the slot skipped; restore opens it again',
    },
    {
      id: 'mcp-log',
      entry: 'mcp',
      kind: 'nominal',
      what: '"I did one on paper, clean" — log_attempt counts toward momentum and schedules the re-solve in 3 days',
    },
    {
      id: 'floor-focus',
      entry: 'api',
      kind: 'nominal',
      what: 'The floor turns on and off; a focus override holds from today on its pattern, and clearing it hands back to the engine',
    },
    {
      id: 'mcp-bad-args',
      entry: 'mcp',
      kind: 'edge',
      what: 'Bad arguments are param errors and an unknown slot is refused, with nothing written',
    },
    {
      id: 'ownership',
      entry: 'mcp',
      kind: 'edge',
      what: 'A peek or a cause aimed at a sitting that isn’t the user’s is refused, nothing written',
    },
    {
      id: 'test-sitting',
      entry: 'api',
      kind: 'edge',
      what: 'A test sitting — under 3 minutes with no accept, or flagged — never becomes a problem record',
    },
    {
      id: 'scheduler',
      entry: 'mcp',
      kind: 'edge',
      what: 'Backdated attempts schedule by the table: clean steps on, solved repeats the gap, failed restarts the peeked track, past the last step graduates',
    },
    {
      id: 'empty-account',
      entry: 'api',
      kind: 'edge',
      what: 'An account with no history gets new problems and a stretch, no carry-over; the floor is the new pick',
      offDev: {
        file: 'packages/shared/src/coach.test.ts',
        test: 'empty account: new problems in the first pattern, a stretch, no carry-over; floor = the new pick',
        why: why.history,
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
        why: why.history,
      },
    },
    {
      id: 'day-boundary',
      entry: 'mcp',
      kind: 'edge',
      what: 'The plan’s day turns at dayStartHour in the user’s zone',
      offDev: {
        file: 'lambdas/src/mcp/coachTools.test.ts',
        test: 'turns its day at dayStartHour in the user’s zone',
        why: 'dev’s clock can’t be moved to the boundary',
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
    // --- The app (PR A-app): the Today card, the review's cause and Peeked, Home's morning line ---
    {
      id: 'ui-card',
      entry: 'ui',
      kind: 'nominal',
      what: 'The Today card on /recruiting shows each slot with its kind, the 30-minute cap, its reason and a LeetCode link, plus the focus and momentum',
    },
    {
      id: 'ui-swap',
      entry: 'ui',
      kind: 'nominal',
      what: 'Another swaps a slot to an easier problem (Skip when nothing easier is left); Restore brings the original back',
    },
    {
      id: 'ui-cause',
      entry: 'ui',
      kind: 'nominal',
      what: 'A cause chip and Peeked, saved in the review form, read back after a reload',
    },
    {
      id: 'review-cause-head',
      entry: 'api',
      kind: 'nominal',
      what: 'The form’s Save puts the cause and help: solution on the sitting’s head',
    },
    {
      id: 'ui-f169',
      entry: 'ui',
      kind: 'edge',
      what: 'A Save in a review form opened before Claude’s mark_peeked keeps the peek (F169)',
    },
    {
      id: 'ui-suggested',
      entry: 'ui',
      kind: 'nominal',
      what: 'A first submit that failed with no Run opens the form on a suggested No trace; an untouched Save stores it, and clearing the chip stores none',
    },
    {
      id: 'ui-unreviewed',
      entry: 'ui',
      kind: 'nominal',
      what: 'An ended sitting with no cause yet is listed on the card, linking to its review',
    },
    {
      id: 'ui-failed',
      entry: 'ui',
      kind: 'edge',
      what: 'A failed read of today’s plan says so on the card with Retry, and Retry recovers',
    },
    {
      id: 'ui-home',
      entry: 'ui',
      kind: 'nominal',
      what: 'Home’s morning line reads the day’s plan and links to the card',
    },
    {
      id: 'ui-home-absent',
      entry: 'ui',
      kind: 'edge',
      what: 'With no LeetCode roll linked, Home’s morning has no LeetCode line',
    },
    {
      id: 'ui-empty',
      entry: 'ui',
      kind: 'edge',
      what: 'An empty account’s card offers new problems only — no carry-over, no re-solves',
      offDev: {
        file: 'app/src/pages/Recruiting/TodayCard.test.tsx',
        test: 'an empty account gets new problems only — no carry-over, no re-solves',
        why: why.history,
      },
    },
    {
      id: 'ui-home-failed',
      entry: 'ui',
      kind: 'edge',
      what: 'A failed read on Home is one visible line linking to the card, never silence',
    },
    {
      id: 'ui-floor',
      entry: 'ui',
      kind: 'nominal',
      what: 'Full day and Floor day on the card turn the floor off and on',
    },
    {
      id: 'ui-focus',
      entry: 'ui',
      kind: 'nominal',
      what: 'Change on the focus line: the coach’s pick clears an override, a pattern sets one, Cancel closes it',
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
        if (t.day !== today() || !same(slugs(t), slugs(plan())))
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
        if (live.trace !== null) fail(`trace before any coach event: ${String(live.trace)}`);
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
      id: 'off-plan-start',
      title: 'Start a sitting on a problem off the plan',
      entry: 'api',
      async run(ctx) {
        state.offBefore = await ctx.api.reads.getCoachToday();
        const { sitting } = await ctx.api.writes.lcSittingStart(
          start(slugOf(ctx, 'off'), titleOf(ctx, 'off')),
        );
        Object.assign(state, { offId: sitting.id, offRep: sitting.repTaskId });
      },
    },
    {
      id: 'off-plan-mcp',
      title: 'mark_peeked and set_cause_tag on the open off-plan sitting',
      entry: 'mcp',
      proves: ['mcp-peek-sitting', 'mcp-cause'],
      async run(ctx) {
        const p = await ctx.mcp.writes.markPeeked({ sittingId: state.offId });
        if (p.sittingId !== state.offId || p.attemptId)
          fail(`mark_peeked on a sitting: ${JSON.stringify(p)}`);
        if (p.nextDue?.dueDay !== addDays(today(), 1) || p.nextDue.track !== 'peeked')
          fail(`mark_peeked's due: ${JSON.stringify(p.nextDue)}`);
        const c = await ctx.mcp.writes.setCauseTag({ sittingId: state.offId, cause: 'boundary' });
        const review = c.review as { cause?: string; help?: string } | null;
        if (review?.cause !== 'boundary' || review.help !== 'solution')
          fail(`set_cause_tag: ${JSON.stringify(c)}`);
        // The app form's Save landing after the peek, without help: the peek and the cause stay.
        const saved = await ctx.api.writes.setSittingReview(state.offId, {
          insight: `devcheck ${ctx.nonce} off`,
          mistakes: [],
          howItWent: null,
          tags: [],
          draftUsed: false,
        });
        const kept = saved.review as { cause?: string; help?: string } | null | undefined;
        if (kept?.help !== 'solution' || kept.cause !== 'boundary')
          fail(`a save without help: ${JSON.stringify(kept)}`);
      },
    },
    {
      id: 'off-plan-finish',
      title: 'Done on the off-plan sitting: it’s off the plan, the slots and due list unchanged',
      entry: 'api',
      proves: ['off-plan'],
      async run(ctx) {
        await finish(ctx, state.offId, state.offRep);
        const before = state.offBefore ?? fail('no plan before the off-plan Start');
        const t = await ctx.api.reads.getCoachToday();
        if (!t.offPlan.some((o) => o.sittingId === state.offId))
          fail('the off-plan sitting isn’t in offPlan');
        if (!same(slugs(t), slugs(before))) fail('an off-plan sitting moved the slots');
        if (!same(due(t), due(before)))
          fail(`due changed: ${due(before).join(',')} → ${due(t).join(',')}`);
      },
    },
    {
      id: 'peeked',
      title: 'mark_peeked on a problem with no sitting today, twice',
      entry: 'mcp',
      proves: ['mcp-peeked'],
      async run(ctx) {
        const slug = slugOf(ctx, 'peek');
        const a = await ctx.mcp.writes.markPeeked({ slug });
        if (
          !a.attemptId ||
          a.nextDue?.dueDay !== addDays(today(), 1) ||
          a.nextDue.track !== 'peeked'
        )
          fail(`mark_peeked: ${JSON.stringify(a)}`);
        const b = await ctx.mcp.writes.markPeeked({ slug });
        if (b.attemptId !== a.attemptId) fail('a repeated mark_peeked logged a second attempt');
        const rec = (await ctx.api.reads.listProblemRecords()).find((r) => r.slug === slug);
        if (!rec?.peeked) fail('the record isn’t peeked');
      },
    },
    {
      id: 'swap',
      title: 'swap_slot on an open slot then restore; skip then restore',
      entry: 'mcp',
      proves: ['mcp-swap', 'mcp-skip'],
      async run(ctx) {
        const t0 = await ctx.mcp.reads.leetcodeToday();
        const open = t0.slots.filter((s) => s.status === 'open');
        const slot =
          [...open].reverse().find((s) => s.kind !== 're-solve') ??
          open[0] ??
          fail('no open slot to swap');
        const t1 = await ctx.mcp.writes.swapSlot(t0.day, slot.slug, {
          slug: slot.slug,
          action: 'swap',
        });
        const swapped =
          t1.slots.find((s) => s.swappedFrom === slot.slug && s.slug !== slot.slug) ??
          fail(`no swapped slot: ${slugs(t1).join(',')}`);
        // The default swap takes an unseen problem: a stretch slot stays a stretch, any other is new.
        const wantKind = slot.kind === 'stretch' ? 'stretch' : 'new';
        if (swapped.kind !== wantKind) fail(`swapped-in kind ${swapped.kind}, want ${wantKind}`);
        const t2 = await ctx.mcp.writes.swapSlot(t0.day, slot.slug, {
          slug: swapped.slug,
          action: 'restore',
        });
        if (!same(slugs(t2), slugs(t0)))
          fail(`restore: ${slugs(t2).join(',')} vs ${slugs(t0).join(',')}`);
        const t3 = await ctx.mcp.writes.swapSlot(t0.day, slot.slug, {
          slug: slot.slug,
          action: 'skip',
        });
        if (t3.slots.find((s) => s.slug === slot.slug)?.status !== 'skipped')
          fail('skip didn’t mark it');
        const t4 = await ctx.mcp.writes.swapSlot(t0.day, slot.slug, {
          slug: slot.slug,
          action: 'restore',
        });
        if (t4.slots.find((s) => s.slug === slot.slug)?.status !== 'open')
          fail('restore didn’t reopen it');
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
        if (a.slug !== slug || a.nextDue?.dueDay !== addDays(today(), 3))
          fail(`log_attempt: ${JSON.stringify(a)}`);
        const t = await ctx.mcp.reads.leetcodeToday();
        if (t.momentum.lastActiveDay !== t.day || t.momentum.activeDays < 1)
          fail(`momentum: ${JSON.stringify(t.momentum)}`);
      },
    },
    {
      id: 'floor-focus',
      title: 'Floor on and off; a focus override on, then cleared',
      entry: 'api',
      proves: ['floor-focus'],
      async run(ctx) {
        const w = ctx.api.writes;
        if ((await w.setCoachFloor(today(), true)).floor?.on !== true)
          fail('the floor didn’t turn on');
        if ((await w.setCoachFloor(today(), false)).floor?.on !== false)
          fail('the floor didn’t turn off');
        // Only this scenario sets a focus on the test user, so clearing "the" override clears this run's.
        const f = await w.setCoachFocus('intervals');
        if (f?.pattern !== 'intervals' || f.sinceDay !== today())
          fail(`focus: ${JSON.stringify(f)}`);
        const held = await ctx.api.reads.getCoachToday();
        if (
          held.focus.pattern !== 'intervals' ||
          held.focus.source !== 'override' ||
          held.focus.day !== 1
        )
          fail(`focus in the plan: ${JSON.stringify(held.focus)}`);
        if ((await w.setCoachFocus(null)) !== null) fail('clearing the focus answered a row');
        if ((await ctx.api.reads.getCoachToday()).focus.source !== 'engine')
          fail('the focus didn’t clear');
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
          ctx.mcp.writes.swapSlot(today(), slugOf(ctx, 'none'), {
            slug: slugOf(ctx, 'none'),
            action: 'flip',
          }),
        );
        try {
          await ctx.mcp.writes.swapSlot(today(), slugOf(ctx, 'none'), {
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
    {
      id: 'ownership',
      title: 'A peek and a cause aimed at a sitting id that isn’t the user’s are refused',
      entry: 'mcp',
      proves: ['ownership'],
      async run(ctx) {
        const stranger = devUlid();
        const before = (await ctx.api.reads.listCoachAttempts()).length;
        try {
          await ctx.mcp.writes.markPeekedUnknown(stranger);
          fail('mark_peeked on an unknown sitting was accepted');
        } catch (err) {
          if (!/Not found/.test(String(err))) throw err;
        }
        try {
          await ctx.mcp.writes.setCauseTagUnknown(stranger);
          fail('set_cause_tag on an unknown sitting was accepted');
        } catch (err) {
          if (!/Not found/.test(String(err))) throw err;
        }
        if ((await ctx.api.reads.listSittings()).some((x) => x.id === stranger))
          fail('a refused patch made a sitting');
        if ((await ctx.api.reads.listCoachAttempts()).length !== before)
          fail('a refused peek wrote an attempt');
      },
    },
    {
      id: 'test-sitting',
      title: 'A short unaccepted sitting and a flagged one never become problem records',
      entry: 'api',
      proves: ['test-sitting'],
      async run(ctx) {
        const short = slugOf(ctx, 'short');
        const { sitting } = await ctx.api.writes.lcSittingStart(
          start(short, titleOf(ctx, 'short')),
        );
        await finish(ctx, sitting.id, sitting.repTaskId, false);
        await ctx.api.writes.patchSittingReview(state.sittingId, { test: true });
        const records = await ctx.api.reads.listProblemRecords();
        if (records.some((r) => r.slug === short))
          fail('a 1-minute sitting with no accept counted');
        if (records.some((r) => r.sittingIds.includes(state.sittingId)))
          fail('the flagged sitting still counts');
        await ctx.api.writes.linkLeetcodeRoll(null); // for the scenarios after
      },
    },
    {
      id: 'scheduler',
      title: 'Backdated attempts through log_attempt: each lands where the table says',
      entry: 'mcp',
      proves: ['scheduler'],
      async run(ctx) {
        const d = (n: number) => addDays(today(), n);
        const [step, solved, failed, grad] = ['step', 'solved', 'failed', 'grad'].map((w) =>
          slugOf(ctx, w),
        );
        const at = (slug: string, outcome: string, n: number) => ({ slug, outcome, day: d(n) });
        const out = await ctx.mcp.writes.logAttempt([
          at(step!, 'clean', -10), // clean track, due -7 …
          at(step!, 'clean', -7), // … a clean re-solve steps on: due -7 + 7 = today
          at(solved!, 'clean', -6), // due -3 …
          at(solved!, 'solved', -3), // … solved repeats the gap: -3 + 3 = today
          at(failed!, 'clean', -5),
          at(failed!, 'failed', -3), // the peeked track from the start: -3 + 1
          at(grad!, 'clean', -40),
          at(grad!, 'clean', -37),
          at(grad!, 'clean', -30),
          at(grad!, 'clean', -16), // past the last step: graduated, nothing due
        ]);
        const next = (slug: string) => out.attempts.find((a) => a.slug === slug)?.nextDue ?? null;
        const want: [string, { dueDay: string; track: string } | null][] = [
          [step!, { dueDay: today(), track: 'clean' }],
          [solved!, { dueDay: today(), track: 'clean' }],
          [failed!, { dueDay: d(-2), track: 'peeked' }],
          [grad!, null],
        ];
        for (const [slug, w] of want) {
          const got = next(slug);
          if (JSON.stringify(got && { dueDay: got.dueDay, track: got.track }) !== JSON.stringify(w))
            fail(`${slug}: ${JSON.stringify(got)}, want ${JSON.stringify(w)}`);
        }
      },
    },

    // --- The app (PR A-app). After the scheduler: the plan these read is whatever it left, read live. ---
    {
      id: 'ui-card',
      title: 'The Today card shows the API’s slots with their kind, cap, reason and link',
      entry: 'ui',
      proves: ['ui-card'],
      async run(ctx) {
        const t = await ctx.api.reads.getCoachToday();
        const c = await todayCard(ctx);
        for (const s of t.slots) {
          const link = c.getByRole('link', { name: s.title, exact: true }).first();
          await link.waitFor({ state: 'visible', timeout: 15_000 });
          if ((await link.getAttribute('href')) !== `https://leetcode.com/problems/${s.slug}/`)
            fail(`${s.slug}: link ${String(await link.getAttribute('href'))}`);
          if (!(await c.getByText(s.reason, { exact: true }).count()))
            fail(`no reason for ${s.slug}`);
        }
        if (!(await c.getByText(/· 30 min$/).count())) fail('no slot shows the 30-minute cap');
        await c
          .getByText(/ · day \d of 3/)
          .first()
          .waitFor({ timeout: 5_000 });
        await c.getByText(/of 7 days practised this week/).waitFor({ timeout: 5_000 });
        // The 48-hour list: a re-solve due beyond today's live slots is there (the scheduler step leaves some).
        const due = dueBeyond(t)[0];
        if (due) {
          const list = c.getByRole('region', { name: 'Re-solves coming up' });
          const title = (due as { title?: string }).title ?? fail('a due item with no title');
          await list.getByText(title).first().waitFor({ timeout: 5_000 }); // its row adds " · pattern"
        }
        await ctx.shot('lc-coach-today-card');
      },
    },
    {
      id: 'ui-swap',
      title: 'Another (or Skip) on a slot, then Restore — through the card',
      entry: 'ui',
      proves: ['ui-swap'],
      async run(ctx) {
        const t0 = await ctx.api.reads.getCoachToday();
        const open = t0.slots.filter((s) => s.status === 'open' && !s.swappedFrom);
        const slot =
          open.find(
            (s) => (s as DevCoachSlot & { alternatives?: unknown[] }).alternatives?.length,
          ) ??
          open[0] ??
          fail('no open slot to change');
        const canSwap = !!(slot as DevCoachSlot & { alternatives?: unknown[] }).alternatives
          ?.length;
        // The UI's change has no id of its own: a ledgered skip on the same slot first records it, so cleanup
        // restores the slot whatever the UI step leaves (mcp.ts swapSlot; api.ts coachSlotId).
        await ctx.mcp.writes.swapSlot(t0.day, slot.slug, { slug: slot.slug, action: 'skip' });
        const c = await todayCard(ctx);
        await c.getByRole('button', { name: `Restore — ${slot.title}` }).click();
        await until('the slot reopened', async () =>
          (await ctx.api.reads.getCoachToday()).slots.some(
            (s) => s.slug === slot.slug && s.status === 'open',
          ),
        );
        if (canSwap) {
          await c.getByRole('button', { name: `Another problem — ${slot.title}` }).click();
          let swapped: DevCoachSlot | undefined;
          await until('the swap', async () => {
            swapped = (await ctx.api.reads.getCoachToday()).slots.find(
              (s) => s.swappedFrom === slot.slug,
            );
            return !!swapped;
          });
          await c.getByRole('link', { name: swapped!.title, exact: true }).first().waitFor();
          await ctx.shot('lc-coach-swapped');
          await c.getByRole('button', { name: `Restore — ${swapped!.title}` }).click();
        } else {
          ctx.log(`no easier problem left for ${slot.slug}: Skip instead of Another`);
          await c.getByRole('button', { name: `Skip today — ${slot.title}` }).click();
          await c.getByText('skipped today').first().waitFor({ timeout: 10_000 });
          await c.getByRole('button', { name: `Restore — ${slot.title}` }).click();
        }
        await until('the original back', async () =>
          same(slugs(await ctx.api.reads.getCoachToday()), slugs(t0)),
        );
        // Resolves the ledger entry (a restore with nothing to undo changes nothing).
        await ctx.mcp.writes.swapSlot(t0.day, slot.slug, { slug: slot.slug, action: 'restore' });
      },
    },
    {
      id: 'ui-home-absent',
      title: 'No roll linked: Home’s morning has no LeetCode line',
      entry: 'ui',
      proves: ['ui-home-absent'],
      async run(ctx) {
        if ((await ctx.api.reads.getSettings()).leetcodeRollId != null)
          fail('a LeetCode roll is linked — the test-sitting step should have unlinked it');
        await morning(ctx);
        await new Promise((r) => setTimeout(r, 2_000)); // a line would need the plan's read: let it land
        if (await ctx.page.getByText(/^LeetCode · /).count()) fail('a LeetCode line with no roll');
      },
    },
    {
      id: 'ui-home',
      title: 'Link a roll: Home’s morning line reads the plan and links to the card',
      entry: 'ui',
      proves: ['ui-home'],
      async run(ctx) {
        const roll = await ctx.api.writes.upsertRoll({
          name: titleOf(ctx, 'app-roll'),
          estimateMin: 45,
        });
        await ctx.api.writes.linkLeetcodeRoll(roll.id);
        await morning(ctx);
        const line = ctx.page.getByRole('link', { name: /^LeetCode · / });
        await line.waitFor({ state: 'visible', timeout: 15_000 });
        const text = (await line.textContent()) ?? '';
        if (/couldn’t load/.test(text)) fail(`the line: ${text}`);
        // The line names the plan's own numbers (recruitingHelpers.ts coachGlance).
        const t = await ctx.api.reads.getCoachToday();
        const live = t.slots.filter((x) => x.status !== 'skipped');
        const left = live.filter((x) => x.status !== 'done').length;
        const want =
          t.floor?.on && !t.floor.done
            ? 'floor day'
            : left === 0
              ? `${live.length} of ${live.length} done`
              : `${left} ${left < live.length ? 'left today' : 'today'}`;
        if (live.length && !text.includes(want)) fail(`the line "${text}" doesn’t say "${want}"`);
        const due = dueBeyond(t).length;
        if (due && !text.includes(`+${due} re-solve`))
          fail(`the line "${text}" doesn’t count ${due} due beyond the slots`);
        if ((await line.getAttribute('href')) !== '/recruiting')
          fail('the line doesn’t link to the card');
        await ctx.shot('lc-coach-home-line');
      },
    },
    {
      id: 'ui-review',
      title: 'Review form: Boundary and Peeked saved, read back after a reload and on the head',
      entry: 'ui',
      proves: ['ui-cause'],
      async run(ctx) {
        const slug = slugOf(ctx, 'review');
        const { sitting } = await ctx.api.writes.lcSittingStart(
          start(slug, titleOf(ctx, 'review')),
        );
        await finish(ctx, sitting.id, sitting.repTaskId);
        app.reviewId = sitting.id;
        await ctx.ui.goto(`/recruiting/sittings/${sitting.id}`);
        const p = ctx.page;
        await p.getByRole('button', { name: 'Boundary', exact: true }).click();
        await p.getByRole('button', { name: 'Peeked', exact: true }).click();
        await p.getByRole('button', { name: 'Save review' }).click();
        await ctx.ui.expectText('Saved.', 15_000);
        await p.reload({ waitUntil: 'load' });
        for (const name of ['Boundary', 'Peeked']) {
          const b = p.getByRole('button', { name, exact: true });
          await b.waitFor({ timeout: 15_000 });
          if ((await b.getAttribute('aria-pressed')) !== 'true')
            fail(`${name} not pressed after reload`);
        }
        await ctx.shot('lc-coach-review-cause');
      },
    },
    {
      id: 'review-head',
      title: 'The form’s Save is on the head: the cause, and help as solution',
      entry: 'api',
      proves: ['review-cause-head'],
      async run(ctx) {
        const id = app.reviewId || fail('no review sitting — the ui-review step failed');
        const head = (await ctx.api.reads.listSittings()).find((x) => x.id === id);
        const r = head?.review as { cause?: string; help?: string } | null | undefined;
        if (r?.cause !== 'boundary' || r.help !== 'solution')
          fail(`head review: ${JSON.stringify(r)}`);
      },
    },
    {
      id: 'ui-f169',
      title: 'F169: a form open before mark_peeked; the Save keeps the peek',
      entry: 'ui',
      proves: ['ui-f169'],
      async run(ctx) {
        const slug = slugOf(ctx, 'f169');
        const { sitting } = await ctx.api.writes.lcSittingStart(start(slug, titleOf(ctx, 'f169')));
        await finish(ctx, sitting.id, sitting.repTaskId);
        app.f169Id = sitting.id;
        await ctx.ui.goto(`/recruiting/sittings/${sitting.id}`);
        const p = ctx.page;
        const none = p.getByRole('button', { name: 'No help', exact: true });
        await none.waitFor({ timeout: 15_000 });
        if ((await none.getAttribute('aria-pressed')) !== 'true')
          fail('the form didn’t open on No help');
        await ctx.mcp.writes.markPeeked({ sittingId: sitting.id });
        await p.getByLabel('One-liner').fill(`devcheck ${ctx.nonce}`);
        await p.getByRole('button', { name: 'Save review' }).click();
        await ctx.ui.expectText('Saved.', 15_000);
        const head = (await ctx.api.reads.listSittings()).find((x) => x.id === sitting.id);
        const r = head?.review as { help?: string; insight?: string } | null | undefined;
        if (r?.help !== 'solution' || !r.insight)
          fail(`the Save dropped the peek: ${JSON.stringify(r)}`);
        const peeked = p.getByRole('button', { name: 'Peeked', exact: true });
        await until(
          'the form shows the peek',
          async () => (await peeked.getAttribute('aria-pressed')) === 'true',
        );
      },
    },
    {
      id: 'ui-suggested',
      title: 'A failed first submit, no Run: the suggested No trace, saved untouched, then cleared',
      entry: 'ui',
      proves: ['ui-suggested'],
      async run(ctx) {
        const slug = slugOf(ctx, 'suggest');
        const { sitting } = await ctx.api.writes.lcSittingStart(
          start(slug, titleOf(ctx, 'suggest')),
        );
        const t = Date.now();
        await ctx.api.writes.lcSittingEvents(sitting.id, [wrong(t), accepted(t + 1_000)]);
        await finish(ctx, sitting.id, sitting.repTaskId, false); // accepted above; Done with the actual
        const cause = async () => {
          const head = (await ctx.api.reads.listSittings()).find((x) => x.id === sitting.id);
          return (head?.review as { cause?: string | null } | null | undefined)?.cause ?? null;
        };
        await ctx.ui.goto(`/recruiting/sittings/${sitting.id}`);
        const p = ctx.page;
        const chip = p.getByRole('button', { name: 'No trace', exact: true });
        await chip.waitFor({ timeout: 15_000 });
        if ((await chip.getAttribute('aria-pressed')) !== 'true') fail('No trace isn’t suggested');
        await p.getByText('· suggested').waitFor({ timeout: 5_000 });
        await ctx.shot('lc-coach-review-suggested');
        await p.getByRole('button', { name: 'Save review' }).click();
        await ctx.ui.expectText('Saved.', 15_000);
        if ((await cause()) !== 'no-trace') fail(`untouched Save stored ${String(await cause())}`);
        await chip.click();
        await p.getByRole('button', { name: 'Save review' }).click();
        await until('the cleared cause saved', async () => (await cause()) === null);
        await p.reload({ waitUntil: 'load' });
        await chip.waitFor({ timeout: 15_000 });
        if ((await chip.getAttribute('aria-pressed')) !== 'false')
          fail('the cleared cause came back');
        if (await p.getByText('· suggested').count())
          fail('the suggestion came back after a clear');
      },
    },
    {
      id: 'ui-unreviewed',
      title: 'The card lists the F169 sitting under No cause yet, linking to its review',
      entry: 'ui',
      proves: ['ui-unreviewed'],
      async run(ctx) {
        const id = app.f169Id || fail('no F169 sitting — the ui-f169 step failed');
        const c = await todayCard(ctx);
        // Within its own line: an off-plan sitting is also listed under "Also today".
        const line = c.getByText(/^No cause yet:/);
        await line.waitFor({ timeout: 15_000 });
        const link = line.getByRole('link', { name: titleOf(ctx, 'f169'), exact: true });
        if ((await link.getAttribute('href')) !== `/recruiting/sittings/${id}`)
          fail(`its link: ${String(await link.getAttribute('href'))}`);
      },
    },
    {
      id: 'ui-failed',
      title: 'getCoachToday fails: the card says so with Retry; Retry recovers',
      entry: 'ui',
      proves: ['ui-failed'],
      async run(ctx) {
        const i = await ctx.intercept('getCoachToday', { status: 500 });
        await ctx.ui.goto('/recruiting');
        const c = ctx.page.getByRole('region', { name: 'Today’s practice' });
        await c.getByText('Couldn’t load today’s plan.').waitFor({ timeout: 30_000 });
        await ctx.shot('lc-coach-card-failed');
        await i.release();
        await c.getByRole('button', { name: 'Retry' }).click();
        await c
          .getByText(/ · day \d of 3/)
          .first()
          .waitFor({ timeout: 15_000 });
      },
    },
    {
      id: 'ui-home-failed',
      title: 'getCoachToday fails: Home’s morning shows one line linking to the card',
      entry: 'ui',
      proves: ['ui-home-failed'],
      async run(ctx) {
        const i = await ctx.intercept('getCoachToday', { status: 500 });
        try {
          await morning(ctx);
          const line = ctx.page.getByRole('link', { name: /^LeetCode · couldn’t load/ });
          await line.waitFor({ state: 'visible', timeout: 30_000 });
          if ((await line.getAttribute('href')) !== '/recruiting')
            fail('the failed line doesn’t link to the card');
          await ctx.shot('lc-coach-home-failed');
        } finally {
          await i.release();
        }
        await ctx.api.writes.linkLeetcodeRoll(null); // the roll ui-home linked: the last step that needs it
      },
    },
    {
      id: 'ui-floor',
      title: 'Full day, then Floor day, on the card',
      entry: 'ui',
      proves: ['ui-floor'],
      async run(ctx) {
        // The floor is ledgered through the API first (coachFloorId), so cleanup turns it off whatever the UI leaves.
        const day = (await ctx.api.writes.setCoachFloor(today(), true)).day;
        if (day !== today()) fail(`the plan's day moved: ${day}`);
        const c = await todayCard(ctx);
        await c.getByText(/Floor day: just/).waitFor({ timeout: 15_000 });
        await c.getByRole('button', { name: 'Full day', exact: true }).click();
        await c.getByText(/Short on time\? Floor:/).waitFor({ timeout: 15_000 });
        if ((await ctx.api.reads.getCoachToday()).floor?.on !== false) fail('Full day left it on');
        await c.getByRole('button', { name: 'Floor day', exact: true }).click();
        await c.getByText(/Floor day: just/).waitFor({ timeout: 15_000 });
        if ((await ctx.api.reads.getCoachToday()).floor?.on !== true)
          fail('Floor day didn’t turn it on');
        await ctx.shot('lc-coach-floor-on');
        await ctx.api.writes.setCoachFloor(today(), false);
      },
    },
    {
      id: 'ui-focus',
      title: 'The focus picker: the coach’s pick, then Intervals',
      entry: 'ui',
      proves: ['ui-focus'],
      async run(ctx) {
        // Ledgered through the API first (coachFocusId), so cleanup clears whatever the UI leaves.
        await ctx.api.writes.setCoachFocus('intervals');
        const c = await todayCard(ctx);
        const pick = async (label: string) => {
          await c.getByRole('button', { name: 'Change', exact: true }).click();
          await c.getByLabel('Focus pattern').selectOption({ label });
        };
        await c.getByText('Intervals · day 1 of 3 · your pick').waitFor({ timeout: 15_000 });
        await pick('The coach’s pick');
        await until(
          'the override cleared',
          async () => (await ctx.api.reads.getCoachToday()).focus.source === 'engine',
        );
        await pick('Intervals');
        await c.getByText('Intervals · day 1 of 3 · your pick').waitFor({ timeout: 15_000 });
        await c.getByRole('button', { name: 'Change', exact: true }).click();
        await c.getByRole('button', { name: 'Cancel', exact: true }).click();
        if (await c.getByLabel('Focus pattern').count()) fail('Cancel left the picker open');
        await ctx.shot('lc-coach-focus-pick');
        await ctx.api.writes.setCoachFocus(null);
      },
    },
    noConsoleErrors,
  ],
};

// The app steps' own state: the sittings ui-review and ui-f169 saved.
const app = { reviewId: '', f169Id: '' };
// recruitingHelpers.ts dueBeyondSlots: due re-solves not already a live (unskipped) slot.
const dueBeyond = (t: DevCoachToday) =>
  t.due.filter((q) => !t.slots.some((x) => x.status !== 'skipped' && x.slug === q.slug));
async function todayCard(ctx: Ctx) {
  await ctx.ui.goto('/recruiting');
  const c = ctx.page.getByRole('region', { name: 'Today’s practice' });
  await c
    .getByText(/ · day \d of 3/)
    .first()
    .waitFor({ timeout: 15_000 });
  return c;
}
async function morning(ctx: Ctx) {
  await ctx.ui.goto('/');
  await ctx.page.getByRole('button', { name: 'Morning', exact: true }).click();
  await ctx.page.getByText('Plan today', { exact: true }).waitFor({ timeout: 15_000 });
}
async function until(what: string, ok: () => Promise<boolean>, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 500)))
    if (await ok()) return;
  fail(`timed out waiting for ${what}`);
}
