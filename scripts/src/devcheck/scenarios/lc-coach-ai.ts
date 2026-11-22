// The LeetCode coach's AI pick on dev (docs/areas/recruiting/coach.md → The AI pick): once a day Opus picks the day's
// ≤4 problems from the rules' candidates, with a "why today" per slot and an optional day note. Every run turns the
// setting off after the sweep (pipeline.ts), so no other scenario's read starts the day's one pick; the steps here
// that need it on turn it on and put it back off in their own `finally` (withAi).
//
// The cheap steps run with the setting off: off means no call, a bad argument is refused, and the card's pending,
// fallback, failed-start and day-note states and Home's lines through canned answers (ctx.intercept), plus the
// Settings switch. A day already under way on the rules (a slot change, a sitting or an attempt today) is never due,
// so nothing here makes one before ai-day, and the scenario runs before lc-sittings and lc-coach (scenarios/index.ts).
// The real pick is the slow tier — one real Opus call a day per user on dev, and the day can never be re-picked (a
// fallback stays a fallback). So when this run finds today's row already holding a pick from an earlier run, the slow
// steps read needs-you rather than fail; a fallback that happens during this run is a failure, naming its reason.
// Locally (lambdas/src/local/deps.ts) the worker runs inline with a stand-in answer: the pick lands at once, mirrors
// the rules' plan (whys = the rule reasons, no note) under the model 'local-stand-in', with no usage.
//
// Written and cleaned by id: the backdated history (catalog slugs, logCoachAttempts → `coach:attempt`), the slot
// skip (`coach-slot:…`, restored), the roll and its link (archived, unlinked), and the focus an `ok` pick may move
// (`coach-focus:<run>`, cleared). The day row's pick itself has no delete and is not ledgered (api.ts
// startCoachPick).
import { PHONE } from '../browser';
import { targetOrigin } from '../config';
import { DEV_AI_PICK_NOTICE } from '../api';
import type { DevCoachAiView, DevCoachDayAi, DevCoachSlot, DevCoachToday } from '../api';
import { needsYou, noConsoleErrors, type Ctx, type Scenario } from '../scenario';
import { inCapBand, morning, slotCapMin, todayCard, until } from './lc-coach';

// A declaration, not an arrow: `if (…) fail(…)` then narrows what follows.
function fail(msg: string): never {
  throw new Error(msg);
}
const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
// The local check's own loopback server (config.ts useLocalOrigin): the stand-in answers there, Opus on dev.
const isLocal = () => new URL(targetOrigin()).hostname === '127.0.0.1';
const MODEL = { dev: 'claude-opus-5-5', local: 'local-stand-in' };
const PICKING = 'Opus is picking today’s problems…';
const START_FAILED = 'Couldn’t start today’s AI pick — using the rules for now.';
const slugs = (t: DevCoachToday) => t.slots.map((s) => s.slug);
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
// The worker's call is ≤ 60 s inside its 90 s timeout, and a claim reads as a timeout at 120 s
// (AI_PICK_STALE_MS): the card has settled one way or the other well inside this.
const PICK_WAIT_MS = 150_000;

// Backdated synthetic history on public NeetCode 150 slugs, so the plan has re-solves due and a pick is due. Cleaned
// by id at the end of the run.
const HISTORY: [string, 'clean' | 'solved' | 'failed', number][] = [
  ['valid-palindrome', 'clean', -8],
  ['contains-duplicate', 'clean', -5],
  ['valid-anagram', 'failed', -3],
  ['two-sum', 'solved', -2],
];

// What this run read and wrote, shared across steps (a scenario's steps run in order).
const state = {
  day: '',
  prior: null as DevCoachDayAi | null, // today's row's pick before this run touched anything
  pick: null as DevCoachDayAi | null, // the one this run made, once landed
};
const day = () => state.day || fail('no plan day read — the off step failed');
const pick = () => state.pick ?? fail('no pick landed — the ai-day step failed');

// The setting on for one step, off again whatever happens (the run's baseline also turns it off).
async function withAi<T>(ctx: Ctx, run: () => Promise<T>): Promise<T> {
  await ctx.api.writes.updateSettings({ coachAiPick: true });
  try {
    return await run();
  } finally {
    await ctx.api.writes.updateSettings({ coachAiPick: false });
  }
}
const aiRow = async (ctx: Ctx) => (await ctx.api.reads.getCoachDay(day()))?.ai ?? null;
// The export isn't a consistent read: give a pick the plan already shows settled a moment to read so there too.
async function landedRow(ctx: Ctx): Promise<DevCoachDayAi> {
  for (const end = Date.now() + 15_000; ; await new Promise((r) => setTimeout(r, 500))) {
    const row = await aiRow(ctx);
    if (row && row.status !== 'pending') return row;
    if (Date.now() > end) fail(`today’s row holds no settled pick: ${JSON.stringify(row)}`);
  }
}
const view = (status: DevCoachAiView['status'], more: Partial<DevCoachAiView> = {}) => ({
  status,
  source: 'rules',
  notice: null,
  reason: null,
  note: null,
  focusChange: null,
  model: null,
  pickedAt: null,
  ...more,
});
const slotsList = (ctx: Ctx) =>
  ctx.page
    .getByRole('region', { name: 'Today’s practice' })
    .getByRole('list', { name: 'Today’s slots' });
// The card's slots in order, each the API's title and its why.
async function expectCardSlots(ctx: Ctx, slots: DevCoachSlot[]) {
  const list = slotsList(ctx);
  await list.waitFor({ timeout: 15_000 });
  const items = list.getByRole('listitem');
  if ((await items.count()) !== slots.length)
    fail(`the card lists ${await items.count()} slots, the plan ${slots.length}`);
  for (const [i, s] of slots.entries()) {
    const li = items.nth(i);
    if (!(await li.getByRole('link', { name: s.title, exact: true }).count()))
      fail(`slot ${i + 1} on the card isn’t ${s.title}`);
    const why = s.aiWhy ?? fail(`${s.slug} has no aiWhy`);
    if (!(await li.getByText(why, { exact: true }).count()))
      fail(`slot ${i + 1} doesn’t show its why: ${why}`);
  }
}
// A row from before this run: today's one pick already ran, and dev can't pick it again.
function ranBefore(prior: DevCoachDayAi): never {
  const when = prior.settledAt ? new Date(prior.settledAt).toISOString() : 'not settled';
  const how = prior.status === 'fallback' ? `fallback: ${prior.reason ?? '?'}` : prior.status;
  return needsYou(
    `today’s one pick on dev already ran (${how}, ${when}); rerun tomorrow or on the other slot`,
  );
}

export const lcCoachAi: Scenario = {
  id: 'lc-coach-ai',
  title: 'The LeetCode coach’s AI pick: Opus picks today’s problems, once',
  tiers: ['full'],
  // The real pick (one Opus call a day, can't be redone) runs when a branch touches the pick or this scenario.
  slowPaths: [
    'packages/shared/src/coachAi.ts',
    'lambdas/src/coach/**',
    'lambdas/src/coachWorker.ts',
    'lambdas/src/anthropic/coachPickPrompt.ts',
    'packages/shared/src/coach.ts',
    'lambdas/src/anthropic/liveAnthropic.ts',
    'app/src/data/hooks/useCoach.ts',
    'app/src/pages/Recruiting/TodayCard.tsx',
    'scripts/src/devcheck/scenarios/lc-coach-ai.ts',
  ],
  rows: [
    {
      id: 'off-no-call',
      entry: 'api',
      kind: 'edge',
      what: 'With the AI pick off, the plan has no AI view and a start writes nothing to the day',
    },
    {
      id: 'bad-args',
      entry: 'api',
      kind: 'edge',
      what: 'startCoachPick with an argument is refused (400), nothing written',
    },
    {
      id: 'ui-pending',
      entry: 'ui',
      kind: 'nominal',
      what: 'While the pick runs the card says “Opus is picking today’s problems…” and lists no slots',
    },
    {
      id: 'home-picking',
      entry: 'ui',
      kind: 'nominal',
      what: 'While the pick runs Home’s morning line says “LeetCode · picking today’s problems…”',
    },
    {
      id: 'ui-fallback',
      entry: 'ui',
      kind: 'edge',
      what: 'A failed pick says so on the card — “AI pick unavailable today, using the rules” — over the rules’ slots',
    },
    {
      id: 'start-failed',
      entry: 'ui',
      kind: 'edge',
      what: 'A start that fails shows the rules’ slots with “Couldn’t start today’s AI pick — using the rules for now.” and Retry; Home’s line reads the rules’ plan, not “picking”; Retry lands the pick',
    },
    {
      id: 'focus-note',
      entry: 'ui',
      kind: 'nominal',
      what: 'A pick’s day note shows above the slots, its focus move says “Opus moved the focus from … to … — why”, the focus line ends “· Opus’s pick”, and a slot’s why replaces its rule reason',
    },
    {
      id: 'settings-switch',
      entry: 'ui',
      kind: 'nominal',
      what: 'Settings › LeetCode “AI pick: Opus chooses today’s problems” turns on and off, and each survives a reload',
    },
    {
      id: 'ai-day',
      entry: 'ui',
      kind: 'nominal',
      what: 'The day’s first open of the card starts the pick: “Opus is picking…”, then the picked slots, each with its why (390 px, light and dark)',
    },
    {
      id: 'ai-day-stored',
      entry: 'api',
      kind: 'nominal',
      what: 'The day row holds the pick: ok, the model, its tokens, 4 unique problems each with a why — the plan’s slots in that order; the whys and note keep the coach’s wording (never “overdue”, no missed days or streaks)',
    },
    {
      id: 'ai-cap',
      entry: 'api',
      kind: 'nominal',
      what: 'Each pick’s cap is absent (the table’s) or whole minutes within 0.5–1.5× of it, and its slot shows that cap (the model usually sends none; a moved cap’s path is proven off dev, ai-cap-repair)',
    },
    {
      id: 'ai-cap-swap',
      entry: 'mcp',
      kind: 'edge',
      what: 'swap_slot on a picked slot: the problem swapped in takes the table’s cap; Restore brings back the slot’s cap as it was (the pick’s own when it set one — usually none, logged; the pick’s own cap through a swap and Restore is proven off dev in coachAi.test.ts)',
    },
    {
      id: 'once',
      entry: 'api',
      kind: 'edge',
      what: 'More reads and a second start change nothing: one pick a day',
    },
    {
      id: 'mcp-notes',
      entry: 'mcp',
      kind: 'nominal',
      what: '“what’s today?” — leetcode_today answers the AI’s slots, each with its why, and the day note (or none)',
    },
    {
      id: 'reload',
      entry: 'ui',
      kind: 'edge',
      what: 'The picked slots survive a reload, in the same order with the same whys',
    },
    {
      id: 'swap-after',
      entry: 'ui',
      kind: 'edge',
      what: 'Skip then Restore on one picked slot; the other slots and their whys don’t move',
    },
    // --- Off dev: dev can't make Anthropic fail or the model answer a non-candidate, and a test-only switch in
    // shipped code is forbidden. ---
    {
      id: 'ai-cap-repair',
      entry: 'api',
      kind: 'edge',
      what: 'A pick’s cap outside its band: that slot takes the table, the pick stays ok, the repair is logged',
      offDev: {
        file: 'lambdas/src/coach/pick.test.ts',
        test: 'a cap in its range is kept; one outside it takes the table, the pick still ok, the repair logged',
        why: 'the real model can’t be made to answer an out-of-band cap without a test-only switch',
      },
    },
    {
      id: 'fallback-server',
      entry: 'api',
      kind: 'edge',
      what: 'An Anthropic error settles the day on the rules, with the notice',
      offDev: {
        file: 'lambdas/src/coach/pick.test.ts',
        test: 'an API error falls back to the rules, with the notice',
        why: 'dev can’t make the real Anthropic call fail on demand without a test-only switch',
      },
    },
    {
      id: 'guardrail-reject',
      entry: 'api',
      kind: 'edge',
      what: 'An answer naming a problem that isn’t a candidate is refused by the guardrails',
      offDev: {
        file: 'packages/shared/src/coachAi.test.ts',
        test: 'rejects a pick that is not a candidate',
        why: 'the real model can’t be made to answer a non-candidate; the guardrail is a pure fold',
      },
    },
    {
      id: 'guardrail-reject-server',
      entry: 'api',
      kind: 'edge',
      what: 'The worker settles a non-candidate answer on the rules, naming the guardrail',
      offDev: {
        file: 'lambdas/src/coach/pick.test.ts',
        test: 'a non-candidate id falls to the rules, naming the guardrail',
        why: 'the real model can’t be made to answer a non-candidate without a test-only switch',
      },
    },
    {
      id: 'mcp-fallback',
      entry: 'mcp',
      kind: 'edge',
      what: 'leetcode_today on a failed pick says so once, over the rules’ slots',
      offDev: {
        file: 'lambdas/src/mcp/coachTools.test.ts',
        test: 'a failed pick says so, once, over the rules’ slots',
        why: 'dev can’t make the day’s pick fail without a test-only switch, and the day can’t be re-picked',
      },
    },
    {
      id: 'mcp-pending',
      entry: 'mcp',
      kind: 'edge',
      what: 'leetcode_today waits ~8 s for a pick still running, then answers pending with no slots',
      offDev: {
        file: 'lambdas/src/mcp/coachTools.test.ts',
        test: 'waits ~8 s for a pick still running, then answers pending with no slots',
        why: 'a real pick can’t be held open past the tool’s wait on dev, and the day can’t be re-picked',
      },
    },
    {
      id: 'new-user',
      entry: 'api',
      kind: 'edge',
      what: 'A user with no history gets no pick and no notice',
      offDev: {
        file: 'lambdas/src/coach/pick.test.ts',
        test: 'a new user: no pick, no notice',
        why: 'the dev test user’s history is whatever earlier runs and other scenarios left; a run can’t make the account empty',
      },
    },
    {
      id: 'two-readers',
      entry: 'api',
      kind: 'edge',
      what: 'Two readers at once make one claim, one invoke, one call',
      offDev: {
        file: 'lambdas/src/coach/pick.test.ts',
        test: 'two readers at once: one claim, one invoke, one call even when the event is redelivered',
        why: 'dev can’t time two claims into the same instant, and each try spends the day’s one pick',
      },
    },
    {
      id: 'stale-claim',
      entry: 'api',
      kind: 'edge',
      what: 'A claim that never lands reads as a timeout with the notice, and is never retried',
      offDev: {
        file: 'lambdas/src/coach/pick.test.ts',
        test: 'a claim that never lands reads as a timeout, with the notice, and is never retried',
        why: 'dev’s worker can’t be stopped mid-pick without a test-only switch',
      },
    },
    {
      id: 'switch-off-mid-pick',
      entry: 'api',
      kind: 'edge',
      what: 'The switch turned off after the claim: the worker makes no call and the day falls back',
      offDev: {
        file: 'lambdas/src/coach/pick.test.ts',
        test: 'the switch turned off after the claim: no call, a fallback',
        why: 'dev can’t place a settings write between the claim and the worker’s start',
      },
    },
    {
      id: 'claim-after-change',
      entry: 'api',
      kind: 'edge',
      what: 'A slot change that reached the day first means no claim: the rules stay',
      offDev: {
        file: 'packages/shared/src/coachAi.test.ts',
        test: 'won’t claim a day a slot change reached first',
        why: 'dev can’t time a slot change between the plan read and the claim',
      },
    },
  ],
  steps: [
    {
      id: 'off',
      title: 'The AI pick off: no AI view, and a start writes nothing',
      entry: 'api',
      proves: ['off-no-call'],
      async run(ctx) {
        if ((await ctx.api.reads.getSettings()).coachAiPick !== false)
          fail('the AI pick reads on — the run’s baseline should have turned it off');
        const t = await ctx.api.reads.getCoachToday();
        state.day = t.day;
        if (t.ai != null)
          fail(`the plan has an AI view with the pick off: ${JSON.stringify(t.ai)}`);
        state.prior = await aiRow(ctx);
        const started = await ctx.api.writes.startCoachPick({ off: true });
        if (started.ai != null) fail(`a start with the pick off: ${JSON.stringify(started.ai)}`);
        const after = await aiRow(ctx);
        if (JSON.stringify(after) !== JSON.stringify(state.prior))
          fail(`a start with the pick off changed the day: ${JSON.stringify(after)}`);
        ctx.log(
          state.prior
            ? `today’s row already holds a pick from an earlier run (${state.prior.status})`
            : 'no pick on today’s row yet',
        );
      },
    },
    {
      id: 'bad-args',
      title: 'startCoachPick with an argument is refused',
      entry: 'api',
      proves: ['bad-args'],
      async run(ctx) {
        // The pick is off here, so even a regression that took the argument writes nothing.
        const got = await ctx.api.writes.rpcRaw(
          'startCoachPick',
          JSON.stringify({ args: [day()] }),
          'jwt',
        );
        const error = (got.body as { error?: unknown } | null)?.error;
        if (got.status !== 400 || !/takes at most 0 arguments/.test(String(error)))
          fail(`startCoachPick(day): HTTP ${got.status} ${JSON.stringify(got.body)}`);
        if (JSON.stringify(await aiRow(ctx)) !== JSON.stringify(state.prior))
          fail('a refused start changed the day’s pick');
      },
    },
    {
      id: 'ui-pending',
      title: 'A pick still running (canned): the card says Opus is picking, Home says so too',
      entry: 'ui',
      proves: ['ui-pending', 'home-picking'],
      async run(ctx) {
        // The model's timing can't be held on dev: the plan's answer is the harness's (ai-day proves the real one).
        const real = await ctx.api.reads.getCoachToday();
        const roll = await ctx.api.writes.upsertRoll({
          name: `devcheck-coach-ai ${ctx.nonce} roll`,
          estimateMin: 45,
        });
        await ctx.api.writes.linkLeetcodeRoll(roll.id); // Home reads the plan only with a roll linked
        const canned = await ctx.intercept('getCoachToday', {
          status: 200,
          body: { ...real, ai: view('pending') },
        });
        try {
          const c = await todayCard(ctx);
          await c.getByText(PICKING).waitFor({ timeout: 15_000 });
          if (await slotsList(ctx).count()) fail('the card lists slots while the pick runs');
          await ctx.shot('lc-coach-ai-pending');
          await morning(ctx);
          const line = ctx.page.getByRole('link', { name: /^LeetCode · / });
          await line.waitFor({ state: 'visible', timeout: 15_000 });
          const text = (await line.textContent()) ?? '';
          if (!text.includes('LeetCode · picking today’s problems…'))
            fail(`Home’s line while the pick runs: ${text}`);
          await ctx.shot('lc-coach-ai-home-picking');
          if (!canned.hits()) fail('the canned plan was never read');
        } finally {
          await canned.release();
          await ctx.api.writes.linkLeetcodeRoll(null);
        }
      },
    },
    {
      id: 'ui-fallback',
      title: 'A failed pick (canned): the card says so over the rules’ slots',
      entry: 'ui',
      proves: ['ui-fallback'],
      async run(ctx) {
        const real = await ctx.api.reads.getCoachToday();
        if (!real.slots.length) fail('the plan has no slots to show under the notice');
        const canned = await ctx.intercept('getCoachToday', {
          status: 200,
          body: {
            ...real,
            ai: view('fallback', { notice: DEV_AI_PICK_NOTICE, reason: 'api' }),
          },
        });
        try {
          const c = await todayCard(ctx);
          const notice = c.getByRole('status').filter({ hasText: DEV_AI_PICK_NOTICE });
          await notice.waitFor({ timeout: 15_000 });
          if ((await notice.textContent())?.trim() !== DEV_AI_PICK_NOTICE)
            fail(`the notice reads “${await notice.textContent()}”`);
          await slotsList(ctx).waitFor({ timeout: 15_000 });
          for (const s of real.slots)
            if (!(await c.getByText(s.reason, { exact: true }).count()))
              fail(`no rule reason for ${s.slug} under the notice`);
          if (await c.getByText(PICKING).count()) fail('a fallback still says Opus is picking');
          await ctx.shot('lc-coach-ai-fallback');
        } finally {
          await canned.release();
        }
      },
    },
    {
      id: 'start-failed',
      title:
        'A start that fails (canned): the rules with Retry on the card, the rules’ line on Home; Retry lands a pick',
      entry: 'ui',
      proves: ['start-failed'],
      async run(ctx) {
        // Canned both ways: a Retry let through would spend the day's one real pick before ai-day's first open
        // starts it. The setting stays off, so a start a canned route missed still writes nothing.
        const real = await ctx.api.reads.getCoachToday();
        if (!real.slots.length) fail('the plan has no slots to show under the failed start');
        const picked = {
          ...real,
          ai: view('ok', { source: 'ai', model: MODEL.dev, pickedAt: Date.now() }),
          slots: real.slots.map((s) => ({ ...s, aiWhy: `devcheck canned why: ${s.title}` })),
        };
        const roll = await ctx.api.writes.upsertRoll({
          name: `devcheck-coach-ai ${ctx.nonce} start roll`,
          estimateMin: 45,
        });
        await ctx.api.writes.linkLeetcodeRoll(roll.id);
        let plan = await ctx.intercept('getCoachToday', {
          status: 200,
          body: { ...real, ai: view('due') },
        });
        let start = await ctx.intercept('startCoachPick', { status: 500 });
        try {
          // Home first: its own first read is due, its start fails, and the line falls back to the rules' plan.
          await morning(ctx);
          const line = ctx.page.getByRole('link', { name: /^LeetCode · / });
          await line.waitFor({ state: 'visible', timeout: 15_000 });
          await until(
            'Home’s line after the failed start',
            async () => start.hits() > 0 && !((await line.textContent()) ?? '').includes('picking'),
          );
          const live = real.slots.filter((x) => x.status !== 'skipped');
          const left = live.filter((x) => x.status !== 'done').length;
          const want =
            real.floor?.on && !real.floor.done
              ? 'floor day'
              : left === 0
                ? `${live.length} of ${live.length} done`
                : `${left} ${left < live.length ? 'left today' : 'today'}`;
          const text = (await line.textContent()) ?? '';
          if (live.length && !text.includes(want))
            fail(`Home’s line after a failed start: “${text}”, want the rules’ “${want}”`);
          await ctx.shot('lc-coach-ai-home-start-failed');

          const c = await todayCard(ctx);
          await c.getByText(START_FAILED).waitFor({ timeout: 15_000 });
          const retry = c.getByRole('button', { name: 'Retry', exact: true });
          await retry.waitFor({ timeout: 5_000 });
          await slotsList(ctx).waitFor({ timeout: 15_000 });
          for (const s of real.slots)
            if (!(await c.getByText(s.reason, { exact: true }).count()))
              fail(`no rule reason for ${s.slug} under the failed start`);
          if (await c.getByText(PICKING).count()) fail('a failed start still says Opus is picking');
          await ctx.shot('lc-coach-ai-start-failed');

          // Retry: both routes switch to a landed pick before the tap — the new ones first (a later route answers
          // first), so no call passes through in between.
          const okStart = await ctx.intercept('startCoachPick', { status: 200, body: picked });
          const okPlan = await ctx.intercept('getCoachToday', { status: 200, body: picked });
          await start.release();
          await plan.release();
          [start, plan] = [okStart, okPlan];
          await retry.click();
          await until('Retry’s start', async () => okStart.hits() > 0);
          await c.getByText(picked.slots[0]!.aiWhy, { exact: true }).waitFor({ timeout: 15_000 });
          if (await c.getByText(START_FAILED).count()) fail('the failed-start line outlived Retry');
        } finally {
          await start.release();
          await plan.release();
          await ctx.api.writes.linkLeetcodeRoll(null);
        }
      },
    },
    {
      id: 'focus-note',
      title: 'A landed pick (canned): the day note, the focus move, Opus’s focus, a slot’s why',
      entry: 'ui',
      proves: ['focus-note'],
      async run(ctx) {
        // The model's note and focus move can't be asked for: the answer is the harness's (ai-day shows the real
        // one's, when it makes them). Pattern names: packages/shared/src/neetcode150.ts PATTERN_NAMES.
        const real = await ctx.api.reads.getCoachToday();
        const first = real.slots[0] ?? fail('the plan has no slots');
        const note = `devcheck canned day note ${ctx.nonce}`;
        const why = `devcheck canned why ${ctx.nonce}`;
        const moved = 'devcheck canned focus why';
        const canned = await ctx.intercept('getCoachToday', {
          status: 200,
          body: {
            ...real,
            focus: {
              ...real.focus,
              pattern: 'sliding-window',
              day: 1,
              source: 'ai',
              why: 'Sliding Window: Opus’s pick since today',
            },
            ai: view('ok', {
              source: 'ai',
              note,
              focusChange: { from: 'two-pointers', to: 'sliding-window', why: moved },
              model: MODEL.dev,
              pickedAt: Date.now(),
            }),
            slots: real.slots.map((s, i) => ({ ...s, aiWhy: i === 0 ? why : null })),
          },
        });
        try {
          const c = await todayCard(ctx);
          const noteLine = c.getByText(note, { exact: true });
          await noteLine.waitFor({ timeout: 15_000 });
          const list = slotsList(ctx);
          await list.waitFor({ timeout: 15_000 });
          const [n, l] = [await noteLine.boundingBox(), await list.boundingBox()];
          if (!n || !l || n.y >= l.y) fail('the day note isn’t above the slots');
          await c
            .getByText(`Opus moved the focus from Two Pointers to Sliding Window — ${moved}`, {
              exact: true,
            })
            .waitFor({ timeout: 5_000 });
          await c
            .getByText(/^Sliding Window · day 1 of 3 · Opus’s pick$/)
            .waitFor({ timeout: 5_000 });
          const li = list.getByRole('listitem').first();
          if (!(await li.getByText(why, { exact: true }).count()))
            fail('slot 1 doesn’t show its why');
          if (first.reason !== why && (await li.getByText(first.reason, { exact: true }).count()))
            fail('slot 1 shows its rule reason beside the why');
          await ctx.shot('lc-coach-ai-focus-note');
        } finally {
          await canned.release();
        }
      },
    },
    {
      id: 'settings-switch',
      title: 'Settings › LeetCode: the AI pick on, reload, off, reload',
      entry: 'ui',
      proves: ['settings-switch'],
      async run(ctx) {
        // On for a moment with today possibly due: nothing on Settings reads the plan, and this guard proves it — a
        // start here would spend the day's one pick before ai-day.
        const guard = await ctx.intercept('startCoachPick', { status: 500 });
        const saved = async () => (await ctx.api.reads.getSettings()).coachAiPick;
        try {
          await ctx.ui.goto('/settings');
          const box = ctx.page.getByRole('checkbox', {
            name: /^AI pick: Opus chooses today’s problems/,
          });
          await box.waitFor({ timeout: 15_000 });
          if (await box.isChecked()) fail('the switch reads on — the run’s baseline turned it off');
          await box.click();
          await until('the switch saved on', async () => (await saved()) === true);
          await ctx.page.reload({ waitUntil: 'load' });
          await box.waitFor({ timeout: 15_000 });
          if (!(await box.isChecked())) fail('on didn’t survive a reload');
          await ctx.shot('lc-coach-ai-setting-on');
          await box.click();
          await until('the switch saved off', async () => (await saved()) === false);
          await ctx.page.reload({ waitUntil: 'load' });
          await box.waitFor({ timeout: 15_000 });
          if (await box.isChecked()) fail('off didn’t survive a reload');
          if (guard.hits()) fail('the Settings page started a pick');
        } finally {
          await guard.release();
          await ctx.api.writes.updateSettings({ coachAiPick: false });
        }
      },
    },

    // --- The real pick: one Opus call a day on dev (slow). Every step after ai-day reads what it made. ---
    {
      id: 'ai-day',
      title:
        'History before today, the pick on: the card starts it, says Opus is picking, then shows the picks',
      entry: 'ui',
      cost: 'slow',
      proves: ['ai-day'],
      async run(ctx) {
        if (state.prior) ranBefore(state.prior);
        await ctx.api.writes.logCoachAttempts(
          HISTORY.map(([slug, outcome, n]) => ({
            slug,
            outcome,
            day: addDays(day(), n),
            minutes: 20,
          })),
        );
        // The card starts the pick itself (useCoachToday), not this client: its focus is recorded first.
        ctx.api.writes.recordCoachPickFocus();
        await withAi(ctx, async () => {
          const t = await ctx.api.reads.getCoachToday();
          if (t.ai?.status !== 'due') {
            // Under way on the rules today (a slot change, a sitting, an attempt) is never due: name what is.
            const sat = (await ctx.api.reads.listSittings()).filter((x) => x.day === day());
            const tried = (await ctx.api.reads.listCoachAttempts()).filter((x) => x.day === day());
            const changes = (await ctx.api.reads.getCoachDay(day()))?.changes?.length ?? 0;
            fail(
              `the plan isn’t due a pick with it on and history before today: ai ${JSON.stringify(t.ai)}; today ${sat.length} sitting(s), ${tried.length} attempt(s), ${changes} slot change(s) — under way on the rules, or no coach worker on this stack`,
            );
          }
          await ctx.ui.goto('/recruiting');
          const c = ctx.page.getByRole('region', { name: 'Today’s practice' });
          const picking = c.getByText(PICKING);
          // Opus takes seconds on dev; the local stand-in lands inside the start's own answer, so the line may
          // flash by between two polls there.
          if (isLocal())
            await picking
              .waitFor({ timeout: 5_000 })
              .catch(() => ctx.log('local: the line flashed by'));
          else await picking.waitFor({ timeout: 30_000 });
          await slotsList(ctx).waitFor({ timeout: PICK_WAIT_MS });
          const now = await ctx.api.reads.getCoachToday();
          if (now.ai?.status === 'fallback') {
            const row = await aiRow(ctx);
            fail(
              `the pick fell back during this run: ${now.ai.reason ?? '?'} (${row?.detail ?? 'no detail'})`,
            );
          }
          if (now.ai?.status !== 'ok' || now.ai.source !== 'ai')
            fail(`the plan after the pick: ${JSON.stringify(now.ai)}`);
          await expectCardSlots(ctx, now.slots);
          if (now.ai.note && !(await c.getByText(now.ai.note, { exact: true }).count()))
            fail(`the day note isn’t on the card: ${now.ai.note}`);
          if (now.ai.focusChange && !(await c.getByText(/^Opus moved the focus from /).count()))
            fail('the pick moved the focus and the card doesn’t say so');
          if (await c.getByText(DEV_AI_PICK_NOTICE).count()) fail('an ok pick shows the notice');
          ctx.log(
            `picked ${slugs(now).join(', ')}; note ${now.ai.note ? 'yes' : 'none'}; focus ${now.ai.focusChange ? 'moved' : 'held'}`,
          );
          await ctx.page.setViewportSize({ width: 390, height: 844 });
          try {
            await ctx.ui.settle();
            await ctx.shot('lc-coach-ai-day-390'); // light, then dark (scenario.ts makeShot)
          } finally {
            await ctx.page.setViewportSize(PHONE);
          }
        });
      },
    },
    {
      id: 'ai-day-stored',
      title: 'The day row holds this run’s pick: ok, the model, its tokens, the slots in order',
      entry: 'api',
      cost: 'slow',
      proves: ['ai-day-stored', 'ai-cap'],
      async run(ctx) {
        const ai = await landedRow(ctx);
        if (ai.status !== 'ok')
          fail(`the row: ${ai.status}, ${ai.reason ?? '?'} (${ai.detail ?? ''})`);
        const want = isLocal() ? MODEL.local : MODEL.dev;
        if (ai.model !== want) fail(`model ${String(ai.model)}, want ${want}`);
        if (!isLocal() && !(ai.usage && ai.usage.input > 0 && ai.usage.output > 0))
          fail(`usage: ${JSON.stringify(ai.usage)}`);
        const picked = ai.picks.map((p) => p.slug);
        // Four, as the rules' day (the test user has far more than four candidates): a short answer is filled.
        if (picked.length !== 4 || new Set(picked).size !== picked.length)
          fail(`picks: ${picked.join(', ')}`);
        if (ai.picks.some((p) => !p.why.trim())) fail('a pick with no why');
        // The coach's wording rule (coachTools TODAY_NOTE, the pick's prompt): due, never overdue; no missed days or
        // streaks. The model's words are checked, not trusted.
        const words = [...ai.picks.map((p) => p.why), ai.note ?? '', ai.focus?.why ?? ''].join(' ');
        // Missed *days* and streaks, not the word: "missed the empty-input case" is a fair why.
        const banned = words.match(
          /\boverdue\b|\bstreaks?\b|\bmissed (?:yesterday|today|(?:a|one|two|three|\d+) days?|days?|a session|sessions)\b|\bskipped (?:a |the )?days?\b|\bdays? since\b|\bhaven'?t practi[sc]ed\b/i,
        );
        if (banned) fail(`the wording rule: “${banned[0]}” in ${JSON.stringify(words)}`);
        const t = await withAi(ctx, () => ctx.api.reads.getCoachToday());
        if (!same(slugs(t), picked))
          fail(`slots ${slugs(t).join(',')} vs picks ${picked.join(',')}`);
        for (const [i, s] of t.slots.entries())
          if (s.aiWhy !== ai.picks[i]!.why) fail(`${s.slug}: aiWhy ${String(s.aiWhy)}`);
        // Each pick's cap: absent (the table's) or whole minutes within its band; the slot shows it.
        for (const [i, s] of t.slots.entries()) {
          const cap = ai.picks[i]!.capMin;
          const table = slotCapMin(s.kind, s.difficulty);
          if (cap !== undefined && !inCapBand(cap, s.kind, s.difficulty))
            fail(`${s.slug}: stored cap ${cap} outside its band`);
          if (s.capMin !== (cap ?? table))
            fail(`${s.slug}: slot cap ${s.capMin}, pick ${String(cap)}`);
        }
        if (t.ai?.model !== ai.model || t.ai.pickedAt !== ai.settledAt)
          fail(`the view: ${JSON.stringify(t.ai)}`);
        state.pick = ai;
        ctx.log(`model ${ai.model}; usage ${JSON.stringify(ai.usage)}; ${picked.length} picks`);
      },
    },
    {
      id: 'once',
      title: 'Two more reads and a second start: the same pick, the same tokens',
      entry: 'api',
      cost: 'slow',
      proves: ['once'],
      async run(ctx) {
        const a = pick();
        const views = await withAi(ctx, async () => [
          await ctx.api.reads.getCoachToday(),
          await ctx.api.reads.getCoachToday(),
          await ctx.api.writes.startCoachPick(),
        ]);
        const b = await landedRow(ctx);
        const keep = (x: DevCoachDayAi) =>
          JSON.stringify([x.claimId, x.claimedAt, x.startedAt, x.settledAt, x.usage, x.picks]);
        if (keep(a) !== keep(b)) fail(`the row moved: ${keep(a)} → ${keep(b)}`);
        for (const v of views) {
          if (v.ai?.status !== 'ok' || v.ai.pickedAt !== a.settledAt)
            fail(`a repeat read: ${JSON.stringify(v.ai)}`);
          if (
            !same(
              slugs(v),
              a.picks.map((p) => p.slug),
            )
          )
            fail(`a repeat read’s slots moved`);
        }
      },
    },
    {
      id: 'mcp-notes',
      title: 'leetcode_today answers the AI’s slots with their whys, and the note',
      entry: 'mcp',
      cost: 'slow',
      proves: ['mcp-notes'],
      async run(ctx) {
        const a = pick();
        const t = (await withAi(ctx, () => ctx.mcp.reads.leetcodeToday())) as DevCoachToday & {
          slots: (DevCoachSlot & { why?: string | null })[];
        };
        if (t.ai?.status !== 'ok' || t.ai.source !== 'ai' || t.ai.model !== a.model)
          fail(`leetcode_today’s ai: ${JSON.stringify(t.ai)}`);
        if (t.ai.note !== null && typeof t.ai.note !== 'string')
          fail(`the note: ${JSON.stringify(t.ai.note)}`);
        if (
          !same(
            slugs(t),
            a.picks.map((p) => p.slug),
          )
        )
          fail(`leetcode_today ${slugs(t).join(',')} vs the pick`);
        for (const s of t.slots)
          if (typeof s.why !== 'string' || !s.why.trim()) fail(`${s.slug} has no why`);
      },
    },
    {
      id: 'reload',
      title: 'The picked slots survive a reload, in order, with their whys',
      entry: 'ui',
      cost: 'slow',
      proves: ['reload'],
      async run(ctx) {
        await withAi(ctx, async () => {
          const t = await ctx.api.reads.getCoachToday();
          await todayCard(ctx);
          await expectCardSlots(ctx, t.slots);
          await ctx.page.reload({ waitUntil: 'load' });
          await expectCardSlots(ctx, t.slots);
          if (!same(slugs(await ctx.api.reads.getCoachToday()), slugs(t)))
            fail('the plan’s slots moved across a reload');
        });
      },
    },
    {
      id: 'ai-cap-swap',
      title: 'swap_slot on a picked slot: the swapped-in problem takes the table; Restore',
      entry: 'mcp',
      cost: 'slow',
      proves: ['ai-cap-swap'],
      async run(ctx) {
        await withAi(ctx, async () => {
          // The API's view: leetcode_today sends the pick's line as `why`, never `aiWhy`.
          const t0 = await ctx.api.reads.getCoachToday();
          const slot =
            t0.slots.find((s) => s.status === 'open' && !s.swappedFrom && s.aiWhy) ??
            fail('no open picked slot to swap');
          const pickCap = state.pick?.picks.find((p) => p.slug === slot.slug)?.capMin;
          const sw = await ctx.mcp.writes.swapSlot(t0.day, slot.slug, {
            slug: slot.slug,
            action: 'swap',
          });
          const swappedIn =
            sw.slots.find((s) => s.swappedFrom === slot.slug && s.slug !== slot.slug) ??
            fail(`no swapped slot: ${slugs(sw).join(',')}`);
          if (swappedIn.capMin !== slotCapMin(swappedIn.kind, swappedIn.difficulty))
            fail(`swapped-in cap: ${JSON.stringify(swappedIn)}`);
          const back = await ctx.mcp.writes.swapSlot(t0.day, slot.slug, {
            slug: swappedIn.slug,
            action: 'restore',
          });
          if (!same(slugs(back), slugs(t0))) fail(`restore: ${slugs(back).join(',')}`);
          if (back.slots.find((s) => s.slug === slot.slug)?.capMin !== slot.capMin)
            fail('the restored pick lost its cap');
          // With no cap of the pick's own, Restore brings back the table's: the pick's own goes unexercised.
          ctx.log(
            pickCap === undefined
              ? 'the pick set no cap of its own: Restore checked against the table only'
              : `Restore brought back the pick’s own cap ${pickCap}`,
          );
        });
      },
    },
    {
      id: 'swap-after',
      title: 'Skip then Restore on one picked slot, through the card; the others hold',
      entry: 'ui',
      cost: 'slow',
      proves: ['swap-after'],
      async run(ctx) {
        await withAi(ctx, async () => {
          const t0 = await ctx.api.reads.getCoachToday();
          const slot =
            t0.slots.find((s) => s.status === 'open' && !s.swappedFrom) ??
            fail('no open picked slot to skip');
          const others = (t: DevCoachToday) =>
            JSON.stringify(
              t.slots.filter((s) => s.slug !== slot.slug).map((s) => [s.slug, s.status, s.aiWhy]),
            );
          const statusOf = async () =>
            (await ctx.api.reads.getCoachToday()).slots.find((s) => s.slug === slot.slug)?.status;
          // The card's change has no id of its own: a ledgered skip on the same slot first records it, so cleanup
          // restores the slot whatever the card leaves (as lc-coach's ui-swap).
          await ctx.mcp.writes.swapSlot(t0.day, slot.slug, { slug: slot.slug, action: 'skip' });
          const c = await todayCard(ctx);
          await c.getByRole('button', { name: `Restore — ${slot.title}` }).click();
          await until('the slot reopened', async () => (await statusOf()) === 'open');
          await c.getByRole('button', { name: `Skip today — ${slot.title}` }).click();
          await until('the card’s skip', async () => (await statusOf()) === 'skipped');
          await c.getByText('skipped today').first().waitFor({ timeout: 10_000 });
          const skipped = await ctx.api.reads.getCoachToday();
          if (others(skipped) !== others(t0)) fail('a skip moved the other slots');
          for (const s of t0.slots.filter((x) => x.slug !== slot.slug))
            if (!(await c.getByText(s.aiWhy ?? '', { exact: true }).count()))
              fail(`${s.slug}’s why left the card after the skip`);
          await ctx.shot('lc-coach-ai-skipped');
          await c.getByRole('button', { name: `Restore — ${slot.title}` }).click();
          await until('the card’s restore', async () => (await statusOf()) === 'open');
          const back = await ctx.api.reads.getCoachToday();
          if (!same(slugs(back), slugs(t0)) || others(back) !== others(t0))
            fail(`after Restore: ${slugs(back).join(',')}`);
          if (back.slots.find((s) => s.slug === slot.slug)?.aiWhy !== slot.aiWhy)
            fail('the restored slot lost its why');
          await expectCardSlots(ctx, back.slots);
          // Resolves the ledger entry (a restore with nothing to undo changes nothing).
          await ctx.mcp.writes.swapSlot(t0.day, slot.slug, { slug: slot.slug, action: 'restore' });
        });
        // A focus the pick moved holds past the setting: clear it (resolving coach-focus:<run>) so lc-sittings and
        // lc-coach, after this scenario, start from the engine's.
        if ((await ctx.api.reads.getCoachFocusRow())?.source === 'ai')
          await ctx.api.writes.setCoachFocus(null);
      },
    },
    noConsoleErrors,
  ],
};
