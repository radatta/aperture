// The coach fixes on dev (docs/areas/recruiting/coach.md; the lane's plan → Dev-test matrix): voiding a sitting
// (set_void, SittingDetail's “Doesn’t count”), the trace comment, Claude's notes, the peek and off-roadmap fields of
// log_attempt and mark_peeked, the re-solve track's new name (`retry`), and the plan mode (Auto's hysteresis, the
// Catch-up mix, the Settings radios). Legacy (`lc#`) rows can't be made on dev — nothing writes them since PR 147 —
// so their rows are covered off dev, and the prod read-back is the user's.
//
// Order matters: everything up to the plan-mode steps writes nothing due by today (sittings are today's, which the
// plan's `before` never reads; backdated logs either re-solve past today or are deleted again in void-tidy), so
// mode-seven reads the due count other scenarios left (lc-coach's scheduler, lc-coach-ai's history) as its baseline
// and every plan-mode count is that baseline plus this run's own. Auto's state is a replay of the days before today,
// so the hysteresis is staged on backdated days: 10 failed logs on day −3 (due −2: on from there), then clean
// re-solves on day −1 that only today's count sees.
//
// Written and cleaned by id: the roll and its link, sittings (their void flag and Claude's notes live on the head
// and go with them), logged attempts (`coach:attempt`; a few deleted mid-run, resolved in the ledger). The plan-mode
// setting isn't ledgered: setup reads it, each step that moves it puts Auto back in its `finally`, and `restore`
// puts the prior value back. set_void on a legacy day is only ever sent as a refusal (dev has no legacy rows).
import { PHONE } from '../browser';
import { McpRpcError, PARAM_ERROR } from '../mcp';
import type {
  DevCoachPlanMode,
  DevCoachPlanModeView,
  DevCoachToday,
  DevSitting,
  DevSittingEvent,
  DevSittingStart,
} from '../api';
import { noConsoleErrors, type Ctx, type Scenario } from '../scenario';
import { devUlid } from './flux-history';
import { todayCard, until } from './lc-coach';

// A declaration, not an arrow: `if (…) fail(…)` then narrows what follows.
function fail(msg: string): never {
  throw new Error(msg);
}
const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const tag = (ctx: Ctx) => ctx.nonce.toLowerCase().replace(/[^a-z0-9]+/g, '-');
// Synthetic slugs off the roadmap (no real problem, no real data); a title findable on screen.
const slugOf = (ctx: Ctx, which: string) => `devcheck-cfx-${tag(ctx)}-${which}`;
const titleOf = (ctx: Ctx, which: string) => `devcheck-cfx ${ctx.nonce} ${which}`;
const expectParamError = async (what: string, call: () => Promise<unknown>) => {
  try {
    await call();
  } catch (err) {
    if (err instanceof McpRpcError && err.code === PARAM_ERROR) return;
    throw err;
  }
  fail(`${what}: expected a param error (-32602), got a result`);
};
// A tool answer the server must have refused, with its reason.
const expectRefused = (what: string, r: { text: string; isError: boolean }, why: RegExp) => {
  if (!r.isError || !why.test(r.text))
    fail(`${what}: ${r.isError ? 'refused as' : 'accepted:'} ${r.text}`);
};

// The app's copy (SittingDetail.tsx VoidControl, SittingsSection.tsx) — U+2019 apostrophes.
const VOID_BUTTON = 'Doesn’t count';
const UNVOID_BUTTON = 'Count it again';
const VOID_NOTICE = 'Doesn’t count — left out of the plan, stats and re-solves.';
// A synthetic trace docstring (packages/shared/src/traceComment.ts): names an input, then walks it.
const TRACE_CODE = [
  'class Solution:',
  '    def pairSum(self, vals, goal):',
  '        """',
  '        vals = [4, 1, 6], goal = 7',
  '        i=0: 4, need 3, seen {} -> add 4',
  '        i=1: 1, need 6, seen {4:0} -> add 1',
  '        i=2: 6, need 1, seen {4:0, 1:1} -> found [1, 2]',
  '        """',
  '        seen = {}',
].join('\n');
const PLAIN_CODE = [
  'class Solution:',
  '    def pairSum(self, vals, goal):',
  '        seen = {}',
].join('\n');
// packages/shared/src/coach.ts COACH_PARAMS.catchUp (scripts doesn't depend on shared).
const ENTER_DUE = 10;

const start = (ctx: Ctx, which: string): DevSittingStart => ({
  clientSittingId: devUlid(),
  problemSlug: slugOf(ctx, which),
  problemTitle: titleOf(ctx, which),
  difficulty: 'Easy',
  topicTags: ['Array'],
  lang: 'python3',
  startedAt: Date.now(),
  tzOffsetMinutes: 480, // the test user's day is LA's
});
// Event times strictly increasing, never ahead of the clock.
let lastAt = 0;
const at = () => (lastAt = Math.max(Date.now(), lastAt + 1));
const snapshot = (code: string): DevSittingEvent => ({
  id: devUlid(),
  type: 'snapshot',
  at: at(),
  payload: { code, lang: 11 },
});
const judged = (type: 'run' | 'submit', ok: boolean): DevSittingEvent => ({
  id: devUlid(),
  type,
  at: at(),
  payload: {
    request: { lang: 'python3', typed_code: 'print("devcheck")' },
    result:
      type === 'run'
        ? {
            status_code: 10,
            status_msg: 'Accepted',
            correct_answer: ok,
            total_correct: 1,
            total_testcases: 3,
          }
        : ok
          ? { status_code: 10, status_msg: 'Accepted', total_correct: 3, total_testcases: 3 }
          : { status_code: 11, status_msg: 'Wrong Answer', total_correct: 1, total_testcases: 3 },
  },
});

// What this run made and read, shared across steps (a scenario's steps run in order).
const state = {
  today: '',
  priorMode: undefined as DevCoachPlanMode | undefined,
  voidId: '',
  voidLog: '',
  twiceLog: '',
  twiceIds: [] as string[],
  traceId: '',
  noneId: '',
  lateId: '',
  base: -1, // the due count other scenarios left, before the plan-mode steps
  dueSlugs: [] as string[],
  logged: 0,
  resolved: new Set<string>(),
};
const T = () => state.today || fail('no plan day read — the setup step failed');
const d = (n: number) => addDays(T(), n);
const mine = () => [state.voidId, state.traceId, state.noneId, state.lateId].filter(Boolean);
const notes = (ctx: Ctx) => ({
  trace: `devcheck-cfx ${ctx.nonce}: traced in a docstring before the first Run.\nFirst submit accepted.`,
  none: `devcheck-cfx ${ctx.nonce}: no trace; the first submit failed.\nRe-solve: trace the empty input first.`,
  late: `devcheck-cfx ${ctx.nonce}: ran first, wrote the trace after.\nDropped it.`,
});

async function startSitting(ctx: Ctx, which: string): Promise<DevSitting> {
  return (await ctx.api.writes.lcSittingStart(start(ctx, which))).sitting;
}
// Done on its rep (the actual first), which ends the sitting.
async function done(ctx: Ctx, s: DevSitting, minutes: number) {
  await ctx.api.writes.setTaskActual(s.repTaskId, minutes);
  await ctx.api.writes.finishTask(s.repTaskId, 'done');
}
const record = async (ctx: Ctx, slug: string) =>
  (await ctx.api.reads.listProblemRecords()).find((r) => r.slug === slug) ?? null;
const sittingOf = async (ctx: Ctx, id: string) => (await ctx.api.reads.getSitting(id)).sitting;
const pm = (t: DevCoachToday): DevCoachPlanModeView =>
  t.planMode ?? fail('the plan has no planMode — is dev on the coach-fixes build?');
const dueList = (t: DevCoachToday) => t.due.map((q) => `${q.slug}@${q.dueDay}`).join(', ');
const kinds = (t: DevCoachToday) => {
  const n = { 'carry-over': 0, new: 0, 're-solve': 0, stretch: 0 };
  for (const s of t.slots) n[s.kind] += 1;
  return n;
};
const logFailed = (ctx: Ctx, slugs: string[], day: string) =>
  ctx.api.writes.logCoachAttempts(
    slugs.map((slug) => ({ slug, day, outcome: 'failed', minutes: 10 })),
  );
// Clean re-solves on day −1 until today's due count is `target`: this run's own due problems first, then any other
// due one (logged here, ledgered and deleted at cleanup). Day −1 only moves today's count; earlier days stay ≥ 10.
async function bringTo(ctx: Ctx, target: number): Promise<DevCoachToday> {
  const t = await ctx.api.reads.getCoachToday();
  const need = pm(t).due - target;
  if (need < 0) fail(`${pm(t).due} due, under the ${target} wanted`);
  const due = t.due.map((q) => q.slug).filter((s) => !state.resolved.has(s));
  const own = due.filter((s) => state.dueSlugs.includes(s));
  const pick = [...own, ...due.filter((s) => !state.dueSlugs.includes(s))].slice(0, need);
  if (pick.length < need)
    fail(`only ${pick.length} due problems to re-solve, ${need} needed: ${dueList(t)}`);
  if (pick.length) {
    await ctx.api.writes.logCoachAttempts(
      pick.map((slug) => ({ slug, day: d(-1), outcome: 'clean', minutes: 15 })),
    );
    for (const s of pick) state.resolved.add(s);
  }
  const others = pick.filter((s) => !state.dueSlugs.includes(s));
  if (others.length) ctx.log(`re-solved other scenarios’ due problems too: ${others.join(', ')}`);
  return ctx.api.reads.getCoachToday();
}
const legacyWhy =
  'nothing writes lc# rows since PR 147, so no API can seed the dev test user, and a dev-only seed would be a test-only switch in shipped code';

export const coachFixes: Scenario = {
  id: 'coach-fixes',
  title: 'The coach fixes: void, trace comment, Claude’s notes, peeks, the retry track, plan mode',
  tiers: ['full'],
  rows: [
    // --- F190: void a sitting ---
    {
      id: 'void-mcp',
      entry: 'mcp',
      kind: 'nominal',
      what: '“That one was a test” — set_void on a counted sitting: it leaves get_problem, coach_stats and leetcode_today, nextDue falls back to the logged try, and list_sittings reads it unreviewed (a void alone is no review)',
    },
    {
      id: 'unvoid-mcp',
      entry: 'mcp',
      kind: 'edge',
      what: 'set_void with void: false brings it back where it was; a repeat is harmless',
    },
    {
      id: 'void-ui',
      entry: 'ui',
      kind: 'nominal',
      what: 'SittingDetail “Doesn’t count”: the notice shows and survives a reload, the Today card drops it and the sittings list marks it (no reviewed dot); “Count it again” brings it back',
    },
    {
      id: 'void-suggestions',
      entry: 'ui',
      kind: 'edge',
      what: 'A sitting with no review keeps the form’s suggested help and cause after Doesn’t count',
      offDev: {
        file: 'app/src/pages/Recruiting/SittingDetail.test.tsx',
        test: 'a sitting with no review keeps its suggested help and cause after Doesn’t count',
        why: 'same path as void-ui (proven on dev): the form reads the stored review the void writes; dev’s void sitting is a clean accept, which suggests nothing, so the suggestion is pinned by the jsdom test on a failed first submit',
      },
    },
    {
      id: 'void-schedule',
      entry: 'api',
      kind: 'edge',
      what: 'Two accepted test sittings after a logged solve on D0 push the re-solve to D+7; voided, it falls back to D0+3',
    },
    {
      id: 'void-refused',
      entry: 'mcp',
      kind: 'edge',
      what: 'set_void on an unknown sitting id, a target with both a sitting and a day, or one with neither is refused, nothing written',
    },
    {
      id: 'void-legacy-none',
      entry: 'mcp',
      kind: 'edge',
      what: 'set_void on a day with no legacy rows is refused and writes nothing — alone, or beside a sitting in the same call',
    },
    // --- F192: the coach tools ---
    {
      id: 'log-solution',
      entry: 'mcp',
      kind: 'nominal',
      what: '“I read the solution, then got it accepted” — one log_attempt with help: solution, outcome: solved lands on the retry track, due the next day, ever accepted',
    },
    {
      id: 'log-clean-help-refused',
      entry: 'mcp',
      kind: 'edge',
      what: 'log_attempt clean with help: solution is refused, nothing written',
    },
    {
      id: 'peek-accepted',
      entry: 'mcp',
      kind: 'nominal',
      what: 'mark_peeked {slug, day, accepted: true} with no sitting keeps the accept on the retry track; a repeat is the same attempt',
    },
    {
      id: 'off-catalog',
      entry: 'mcp',
      kind: 'nominal',
      what: 'An off-roadmap title and difficulty, through log_attempt and mark_peeked, survive a later untitled log',
    },
    // --- F193: the track is `retry` ---
    {
      id: 'track-retry',
      entry: 'mcp',
      kind: 'nominal',
      what: 'The re-solve track reads retry in nextDue, leetcode_today and list_problems; track: "peeked" reads as retry; a bad track is a param error',
    },
    {
      id: 'track-retry-ui',
      entry: 'ui',
      kind: 'nominal',
      what: 'The Today card’s queue row for a failed problem reads “· retry”',
    },
    // --- F191: plan mode ---
    {
      id: 'auto-catch-up',
      entry: 'api',
      kind: 'nominal',
      what: 'Auto: 10 backdated failed logs → Catch-up; getCoachToday and leetcode_today say “Catch-up: N due · auto”',
    },
    {
      id: 'auto-hysteresis',
      entry: 'api',
      kind: 'edge',
      what: 'Clean re-solves bring it to 7 → still Catch-up; to 4 → Balanced',
    },
    {
      id: 'auto-seven',
      entry: 'api',
      kind: 'edge',
      what: '7 due with no earlier 10 → Balanced',
    },
    {
      id: 'catch-up-mix',
      entry: 'api',
      kind: 'nominal',
      what: 'The Catch-up mix: the carry-over kept, one new, re-solves fill the rest (past two), no stretch',
    },
    {
      id: 'balanced-forced',
      entry: 'api',
      kind: 'nominal',
      what: 'Balanced forced with 10+ due: the usual mix (one re-solve beside the carry-over, new and stretch), no “· auto”; the floor and off-plan unchanged',
    },
    {
      id: 'plan-mode-ui',
      entry: 'ui',
      kind: 'nominal',
      what: 'Settings › Plan mode: Catch-up, Balanced and Auto each save and survive a reload; the Today card’s line follows each; 390 px',
    },
    {
      id: 'plan-mode-invalid',
      entry: 'api',
      kind: 'edge',
      what: 'An invalid plan mode is refused (400), the setting unchanged',
    },
    {
      id: 'ai-pick-mix',
      entry: 'mcp',
      kind: 'edge',
      what: 'The AI pick stays within the Catch-up mix',
      offDev: {
        file: 'packages/shared/src/coachAi.test.ts',
        test: 'a catch-up pick keeps the mix: one new at most, no fewer re-solves than the rules',
        why: 'a dev row would spend the day’s one real Opus call on a pure decision, and the model can’t be made to break the mix',
      },
    },
    // --- F195: the trace comment ---
    {
      id: 'trace-comment',
      entry: 'mcp',
      kind: 'nominal',
      what: 'A trace comment in a snapshot before the first Run: live_sitting, get_sitting and the summary read traced',
    },
    {
      id: 'trace-none',
      entry: 'api',
      kind: 'edge',
      what: 'No comment → none once judged; a comment only after the first Run → none',
    },
    // --- Claude's notes ---
    {
      id: 'notes-batch',
      entry: 'mcp',
      kind: 'nominal',
      what: 'set_claude_notes in one call on an accepted, an unaccepted and an abandoned sitting; get_sitting and get_problem read them back',
    },
    {
      id: 'notes-idle',
      entry: 'mcp',
      kind: 'edge',
      what: 'An idle-closed sitting takes notes: set_claude_notes writes the idle close first, as the app would',
      offDev: {
        file: 'lambdas/src/mcp/coachFixesTools.test.ts',
        test: 'an idle-closed sitting takes notes: the write closes it as the app would, then saves',
        why: 'dev would need a 45-minute idle wait (sitting-auto-close’s slow tier); the write path is notes-batch’s, proven on dev, after closeIdle',
      },
    },
    {
      id: 'notes-ui',
      entry: 'ui',
      kind: 'nominal',
      what: 'SittingDetail shows “Claude’s notes” under the review; a review Save keeps them',
    },
    {
      id: 'notes-catchup',
      entry: 'mcp',
      kind: 'nominal',
      what: 'leetcode_today.unnoted lists the ended sittings without notes (not the void ones), and they leave it once the batch saves',
    },
    {
      id: 'notes-refused',
      entry: 'mcp',
      kind: 'edge',
      what: 'Notes over 800 characters, on an open sitting, or on an unknown id are refused; the batch writes nothing',
    },
    // --- F189: legacy history (read path) — nothing can seed lc# rows on dev ---
    {
      id: 'legacy-fold',
      entry: 'api',
      kind: 'nominal',
      what: 'Legacy rows fold into the records, stats and the day’s plan, marked by source',
      offDev: {
        file: 'packages/shared/src/coachFixes.test.ts',
        test: 'legacy tries show in the records with their source, and tombstoned rows are skipped',
        why: legacyWhy,
      },
    },
    {
      id: 'legacy-same-day',
      entry: 'api',
      kind: 'edge',
      what: 'A legacy group and a logged attempt the same day count once',
      offDev: {
        file: 'packages/shared/src/coachFixes.test.ts',
        test: 'a legacy group and a logged attempt on the same day count once: the capture judges the first try',
        why: legacyWhy,
      },
    },
    {
      id: 'legacy-void',
      entry: 'mcp',
      kind: 'edge',
      what: 'set_void on a legacy (day, slug) leaves it out; void: false brings it back',
      offDev: {
        file: 'lambdas/src/mcp/coachFixesTools.test.ts',
        test: 'voids a sitting and a legacy day in one call, and un-voids them',
        why: legacyWhy,
      },
    },
    {
      id: 'legacy-void-store',
      entry: 'api',
      kind: 'edge',
      what: 'Every legacy group counts until a stored void: true drops it; void: false brings it back',
      offDev: {
        file: 'packages/shared/src/coachFixes.test.ts',
        test: 'every legacy group counts until a stored void: true drops it; void: false brings it back',
        why: legacyWhy,
      },
    },
    {
      id: 'legacy-void-logged',
      entry: 'api',
      kind: 'edge',
      what: 'A voided legacy day leaves a logged attempt on it counting: a void touches legacy pieces only',
      offDev: {
        file: 'packages/shared/src/coachFixes.test.ts',
        test: 'a voided legacy day leaves a logged attempt on it counting',
        why: legacyWhy,
      },
    },
    {
      id: 'legacy-prod',
      entry: 'mcp',
      kind: 'nominal',
      what: 'The prod legacy rows read back: one get_problem on a slug with legacy rows shows them folded',
      needsYou:
        'read-only on prod after the merge (the real lc# rows are only there); the dev test user has none',
    },
  ],
  steps: [
    {
      id: 'setup',
      title: 'Read today; Auto on; link a roll for the sittings',
      entry: 'api',
      async run(ctx) {
        state.today = (await ctx.api.reads.getCoachToday()).day;
        state.priorMode = (await ctx.api.reads.getSettings()).coachPlanMode;
        if ((state.priorMode ?? 'auto') !== 'auto')
          await ctx.api.writes.updateSettings({ coachPlanMode: 'auto' });
        const roll = await ctx.api.writes.upsertRoll({
          name: titleOf(ctx, 'roll'),
          estimateMin: 45,
        });
        await ctx.api.writes.linkLeetcodeRoll(roll.id);
      },
    },

    // --- Void ---
    {
      id: 'void-setup',
      title: 'A logged solve on day −5, then an accepted sitting today on the same problem',
      entry: 'api',
      async run(ctx) {
        const slug = slugOf(ctx, 'void');
        const [log] = await ctx.api.writes.logCoachAttempts([
          { slug, day: d(-5), outcome: 'clean', minutes: 20 },
        ]);
        state.voidLog = log?.id ?? fail('logCoachAttempts stored nothing');
        const s = await startSitting(ctx, 'void');
        state.voidId = s.id;
        await ctx.api.writes.lcSittingEvents(s.id, [judged('submit', true)]);
        await done(ctx, s, 15);
        const r = await record(ctx, slug);
        if (r?.schedule?.dueDay !== d(7) || !r.sittingIds.includes(s.id))
          fail(`the record before any void: ${JSON.stringify(r)}`);
      },
    },
    {
      id: 'void-mcp',
      title: 'set_void on the sitting, then void: false, then again',
      entry: 'mcp',
      proves: ['void-mcp', 'unvoid-mcp'],
      async run(ctx) {
        const id = state.voidId;
        const slug = slugOf(ctx, 'void');
        const counted = async () => {
          const p = await ctx.mcp.reads.getProblem({ slug });
          const t = await ctx.mcp.reads.leetcodeToday();
          return {
            attempts: p.record?.attempts ?? 0,
            inTries: (p.tries ?? []).some((x) => x.sittingIds.includes(id)),
            // On today's view: off the plan, or a slot's sitting when the problem was due and the plan took it
            // (a run alone, with no other scenario's due problems ahead of it).
            shown:
              t.offPlan.some((o) => o.sittingId === id) || t.slots.some((x) => x.sittingId === id),
            unnoted: (t.unnoted ?? []).some((u) => u.sittingId === id),
            stats: (await ctx.mcp.reads.coachStats()).attempts,
          };
        };
        const before = await counted();
        if (before.attempts !== 2 || !before.inTries || !before.shown || !before.unnoted)
          fail(`before the void: ${JSON.stringify(before)}`);

        const out = await ctx.mcp.writes.setVoid([{ sittingId: id, void: true }]);
        const v = out.sittings[0];
        if (out.sittings.length !== 1 || v?.sittingId !== id || v.void !== true)
          fail(`set_void: ${JSON.stringify(out)}`);
        // The sitting's clean re-solve no longer counts: the log alone schedules it, due D0+3.
        if (v.nextDue?.dueDay !== d(-2) || v.nextDue.track !== 'clean')
          fail(`nextDue after the void: ${JSON.stringify(v.nextDue)}, want ${d(-2)} clean`);
        // A review that only voids is no review.
        const row = (await ctx.mcp.reads.listSittings({ limit: 50 })).sittings.find(
          (x) => x.id === id,
        );
        if (!row || row.reviewed) fail(`list_sittings after the void: ${JSON.stringify(row)}`);
        const after = await counted();
        if (
          after.attempts !== 1 ||
          after.inTries ||
          after.shown ||
          after.unnoted ||
          after.stats !== before.stats - 1
        )
          fail(`after the void: ${JSON.stringify(after)} (before ${JSON.stringify(before)})`);

        const back = await ctx.mcp.writes.setVoid([{ sittingId: id, void: false }]);
        const b = back.sittings[0];
        if (b?.void !== false || b.nextDue?.dueDay !== d(7))
          fail(`void: false: ${JSON.stringify(back)}`);
        const again = await ctx.mcp.writes.setVoid([{ sittingId: id, void: false }]);
        if (JSON.stringify(again.sittings) !== JSON.stringify(back.sittings))
          fail(`a repeat answered differently: ${JSON.stringify(again)}`);
        const restored = await counted();
        if (JSON.stringify(restored) !== JSON.stringify(before))
          fail(`after void: false: ${JSON.stringify(restored)}, before ${JSON.stringify(before)}`);
      },
    },
    {
      id: 'void-ui',
      title: 'SittingDetail: Doesn’t count, reload, the card and the list; Count it again',
      entry: 'ui',
      proves: ['void-ui'],
      async run(ctx) {
        const id = state.voidId;
        const p = ctx.page;
        const isVoid = async () => (await sittingOf(ctx, id)).review?.test === true;
        const link = `a[href$="/recruiting/sittings/${id}"]`;
        const listRow = () => p.getByRole('region', { name: 'All sittings' }).locator(link);
        const notice = p.getByText(VOID_NOTICE);
        await ctx.ui.goto(`/recruiting/sittings/${id}`);
        const voidBtn = p.getByRole('button', { name: VOID_BUTTON, exact: true });
        await voidBtn.waitFor({ timeout: 15_000 });
        if (await notice.count()) fail('a counted sitting shows the notice');
        await voidBtn.click();
        await notice.waitFor({ timeout: 10_000 });
        await until('the void saved', isVoid);
        await p.reload({ waitUntil: 'load' });
        await notice.waitFor({ timeout: 15_000 });
        await p.getByRole('button', { name: UNVOID_BUTTON, exact: true }).waitFor();
        await ctx.shot('coach-fixes-void');

        // The card (off plan, unreviewed) no longer links it; the sittings list marks it.
        const c = await todayCard(ctx);
        if (await c.locator(link).count()) fail('the Today card still links the void sitting');
        await listRow().waitFor({ timeout: 15_000 });
        if (!((await listRow().textContent()) ?? '').includes(VOID_BUTTON))
          fail('the sittings list doesn’t mark it “Doesn’t count”');
        if (await listRow().getByRole('img', { name: 'reviewed' }).count())
          fail('the sittings list shows a reviewed dot on a void-only review');
        await ctx.shot('coach-fixes-void-card');

        await ctx.ui.goto(`/recruiting/sittings/${id}`);
        await p.getByRole('button', { name: UNVOID_BUTTON, exact: true }).click();
        await voidBtn.waitFor({ timeout: 10_000 });
        await notice.waitFor({ state: 'hidden', timeout: 10_000 });
        await until('the un-void saved', async () => !(await isVoid()));
        const c2 = await todayCard(ctx);
        await c2.locator(link).first().waitFor({ timeout: 15_000 });
        await listRow().waitFor({ timeout: 15_000 });
        if (((await listRow().textContent()) ?? '').includes(VOID_BUTTON))
          fail('the sittings list still marks it after Count it again');
      },
    },
    {
      id: 'void-refused',
      title: 'set_void refuses an unknown id, a target with both, a target with neither',
      entry: 'mcp',
      proves: ['void-refused'],
      async run(ctx) {
        const id = state.voidId;
        expectRefused(
          'an unknown sitting',
          await ctx.mcp.writes.setVoidRefused([{ sittingId: devUlid(), void: true }]),
          /No sitting/,
        );
        await expectParamError('a target with both', () =>
          ctx.mcp.writes.setVoidRefused([
            { sittingId: id, day: d(-5), slug: slugOf(ctx, 'void'), void: true },
          ]),
        );
        await expectParamError('a target with neither', () =>
          ctx.mcp.writes.setVoidRefused([{ void: true }]),
        );
        if ((await sittingOf(ctx, id)).review?.test === true)
          fail('a refused set_void voided the sitting');
      },
    },
    {
      id: 'void-legacy-none',
      title:
        'set_void on a day with no legacy rows, alone and beside a sitting: refused, nothing written',
      entry: 'mcp',
      proves: ['void-legacy-none'],
      async run(ctx) {
        const id = state.voidId;
        const slug = slugOf(ctx, 'void');
        const before = await ctx.api.reads.listCoachVoids();
        const legacy = { day: d(-5), slug, void: true };
        expectRefused(
          'a legacy day with no rows',
          await ctx.mcp.writes.setVoidRefused([legacy]),
          /No legacy history/,
        );
        expectRefused(
          'a sitting beside a legacy day with no rows',
          await ctx.mcp.writes.setVoidRefused([{ sittingId: id, void: true }, legacy]),
          /No legacy history/,
        );
        if ((await sittingOf(ctx, id)).review?.test === true)
          fail('the refused batch voided the sitting beside the legacy target');
        const after = await ctx.api.reads.listCoachVoids();
        if (after.length !== before.length || after.some((v) => v.id === `${legacy.day}#${slug}`))
          fail(`a refused legacy void wrote a row: ${JSON.stringify(after)}`);
      },
    },
    {
      id: 'void-schedule',
      title: 'Two accepted sittings after a logged solve: due D+7; both voided: due D0+3',
      entry: 'api',
      proves: ['void-schedule'],
      async run(ctx) {
        const slug = slugOf(ctx, 'twice');
        const [log] = await ctx.api.writes.logCoachAttempts([
          { slug, day: d(-5), outcome: 'clean', minutes: 20 },
        ]);
        state.twiceLog = log?.id ?? fail('logCoachAttempts stored nothing');
        for (let i = 0; i < 2; i++) {
          const s = await startSitting(ctx, 'twice');
          state.twiceIds.push(s.id);
          await ctx.api.writes.lcSittingEvents(s.id, [judged('submit', true)]);
          await done(ctx, s, 15);
        }
        // Both fold into today's one attempt, a clean re-solve of the day −5 solve: step 2, a week out.
        const counted = await record(ctx, slug);
        if (
          counted?.schedule?.dueDay !== d(7) ||
          counted.schedule.track !== 'clean' ||
          !state.twiceIds.every((x) => counted.sittingIds.includes(x))
        )
          fail(`with both sittings counted: ${JSON.stringify(counted)}`);
        for (const id of state.twiceIds)
          await ctx.api.writes.patchSittingReview(id, { test: true });
        const voided = await record(ctx, slug);
        if (
          voided?.schedule?.dueDay !== d(-2) ||
          voided.schedule.track !== 'clean' ||
          state.twiceIds.some((x) => voided.sittingIds.includes(x))
        )
          fail(`with both voided: ${JSON.stringify(voided)}, want due ${d(-2)} from the log alone`);
      },
    },
    {
      id: 'void-tidy',
      title: 'Delete the two day −5 logs: nothing of this run is due before the plan-mode steps',
      entry: 'api',
      async run(ctx) {
        for (const id of [state.voidLog, state.twiceLog])
          if ((await ctx.mcp.writes.deleteAttempt(id)).deleted !== true)
            fail(`delete_attempt ${id} deleted nothing`);
      },
    },

    // --- The trace comment ---
    {
      id: 'trace-open',
      title: 'Start a sitting; a snapshot with a trace docstring',
      entry: 'api',
      async run(ctx) {
        const s = await startSitting(ctx, 'trace');
        state.traceId = s.id;
        await ctx.api.writes.lcSittingEvents(s.id, [snapshot(TRACE_CODE)]);
      },
    },
    {
      id: 'trace-live',
      title: 'live_sitting reads traced by comment; notes on the open sitting are refused',
      entry: 'mcp',
      proves: ['trace-comment', 'notes-refused'],
      async run(ctx) {
        const live = await ctx.mcp.reads.liveSitting();
        if (!live.active || live.sitting?.id !== state.traceId)
          fail('live_sitting isn’t on this run’s open sitting');
        if (live.trace !== 'traced') fail(`live_sitting trace ${String(live.trace)}`);
        // All or nothing: an ended sitting beside the open one gets nothing either.
        expectRefused(
          'notes on an open sitting',
          await ctx.mcp.writes.setClaudeNotesRefused([
            { sittingId: state.voidId, text: 'devcheck refused' },
            { sittingId: state.traceId, text: 'devcheck refused' },
          ]),
          /still open/,
        );
        for (const id of [state.voidId, state.traceId])
          if ((await sittingOf(ctx, id)).claudeNotes) fail(`a refused batch wrote notes on ${id}`);
      },
    },
    {
      id: 'trace-done',
      title: 'An accepted submit and Done: the summary keeps traced',
      entry: 'api',
      proves: ['trace-comment'],
      async run(ctx) {
        const id = state.traceId;
        await ctx.api.writes.lcSittingEvents(id, [judged('submit', true)]);
        const s = await sittingOf(ctx, id);
        await done(ctx, s, 15);
        const trace = (await sittingOf(ctx, id)).summary.commentTrace;
        if (trace !== 'traced') fail(`the summary’s commentTrace: ${String(trace)}`);
      },
    },
    {
      id: 'trace-read',
      title: 'get_sitting reads the ended sitting traced',
      entry: 'mcp',
      proves: ['trace-comment'],
      async run(ctx) {
        const r = await ctx.mcp.reads.getSitting({ id: state.traceId });
        if (r.trace !== 'traced') fail(`get_sitting trace ${String(r.trace)}`);
      },
    },
    {
      id: 'trace-none',
      title: 'No comment, then a comment only after the first Run: both none (the second dropped)',
      entry: 'api',
      proves: ['trace-none'],
      async run(ctx) {
        const none = await startSitting(ctx, 'none');
        state.noneId = none.id;
        await ctx.api.writes.lcSittingEvents(none.id, [
          snapshot(PLAIN_CODE),
          judged('submit', false),
        ]);
        await done(ctx, none, 1);
        const a = (await sittingOf(ctx, none.id)).summary.commentTrace;
        if (a !== 'none') fail(`no comment: ${String(a)}`);

        const late = await startSitting(ctx, 'late');
        state.lateId = late.id;
        await ctx.api.writes.lcSittingEvents(late.id, [judged('run', false)]);
        await ctx.api.writes.lcSittingEvents(late.id, [snapshot(TRACE_CODE)]);
        const b = (await sittingOf(ctx, late.id)).summary.commentTrace;
        if (b !== 'none') fail(`a comment after the first Run: ${String(b)}`);
        await ctx.api.writes.finishTask(late.repTaskId, 'cancelled');
        const dropped = await sittingOf(ctx, late.id);
        if (dropped.status !== 'abandoned') fail(`after Drop: ${dropped.status}`);
      },
    },

    // --- Claude's notes ---
    {
      id: 'notes-unnoted',
      title: 'leetcode_today.unnoted lists this run’s ended sittings, not the void ones',
      entry: 'mcp',
      proves: ['notes-catchup'],
      async run(ctx) {
        const listed = new Set(
          ((await ctx.mcp.reads.leetcodeToday()).unnoted ?? []).map((u) => u.sittingId),
        );
        const missing = mine().filter((id) => !listed.has(id));
        if (missing.length) fail(`unnoted lacks ${missing.join(', ')}`);
        if (state.twiceIds.some((id) => listed.has(id))) fail('unnoted lists a void sitting');
      },
    },
    {
      id: 'notes-refused',
      title: 'Notes over 800 characters, and on an unknown id: refused, nothing written',
      entry: 'mcp',
      proves: ['notes-refused'],
      async run(ctx) {
        const ok = { sittingId: state.noneId, text: 'devcheck refused' };
        expectRefused(
          'notes over 800 characters',
          await ctx.mcp.writes.setClaudeNotesRefused([
            ok,
            { sittingId: state.lateId, text: 'x'.repeat(801) },
          ]),
          /800/,
        );
        expectRefused(
          'notes on an unknown sitting',
          await ctx.mcp.writes.setClaudeNotesRefused([
            ok,
            { sittingId: devUlid(), text: 'devcheck refused' },
          ]),
          /Not found/,
        );
        for (const id of [state.noneId, state.lateId])
          if ((await ctx.mcp.reads.getSitting({ id })).claudeNotes)
            fail(`a refused batch wrote notes on ${id}`);
      },
    },
    {
      id: 'notes-batch',
      title: 'set_claude_notes on the accepted, unaccepted and abandoned sittings in one call',
      entry: 'mcp',
      proves: ['notes-batch', 'notes-catchup'],
      async run(ctx) {
        const n = notes(ctx);
        const want: [string, string][] = [
          [state.traceId, n.trace],
          [state.noneId, n.none],
          [state.lateId, n.late],
        ];
        const out = await ctx.mcp.writes.setClaudeNotes(
          want.map(([sittingId, text]) => ({ sittingId, text })),
        );
        if (
          JSON.stringify(out.saved.map((x) => [x.sittingId, x.claudeNotes])) !==
          JSON.stringify(want)
        )
          fail(`saved: ${JSON.stringify(out)}`);
        for (const [id, text] of want) {
          const r = await ctx.mcp.reads.getSitting({ id });
          if (r.claudeNotes?.text !== text)
            fail(`get_sitting ${id}: ${JSON.stringify(r.claudeNotes)}`);
        }
        const p = await ctx.mcp.reads.getProblem({ slug: slugOf(ctx, 'trace') });
        if (!(p.tries ?? []).some((x) => x.claudeNotes?.includes(n.trace)))
          fail(`get_problem’s tries lack the notes: ${JSON.stringify(p.tries)}`);
        if (p.sittings?.find((x) => x.id === state.traceId)?.claudeNotes !== n.trace)
          fail(`get_problem’s sitting lacks the notes: ${JSON.stringify(p.sittings)}`);
        const listed = new Set(
          ((await ctx.mcp.reads.leetcodeToday()).unnoted ?? []).map((u) => u.sittingId),
        );
        if (want.some(([id]) => listed.has(id))) fail('a noted sitting is still in unnoted');
        if (!listed.has(state.voidId)) fail('the un-noted sitting beside them left unnoted too');
      },
    },
    {
      id: 'notes-ui',
      title: 'SittingDetail: Claude’s notes under the review, kept by a review Save',
      entry: 'ui',
      proves: ['notes-ui'],
      async run(ctx) {
        const id = state.traceId;
        const text = notes(ctx).trace;
        const p = ctx.page;
        const heading = p.getByRole('heading', { name: 'Claude’s notes', exact: true });
        const firstLine = p.getByText(text.split('\n')[0]!).first();
        const save = p.getByRole('button', { name: 'Save review' });
        await ctx.ui.goto(`/recruiting/sittings/${id}`);
        await heading.waitFor({ timeout: 15_000 });
        await firstLine.waitFor({ timeout: 5_000 });
        const [h, s] = [await heading.boundingBox(), await save.boundingBox()];
        if (!h || !s || h.y <= s.y) fail('Claude’s notes aren’t under the review form');
        await ctx.shot('coach-fixes-notes');
        const insight = `devcheck-cfx ${ctx.nonce} one-liner`;
        await p.getByLabel('One-liner', { exact: true }).fill(insight);
        await save.click();
        await ctx.ui.expectText('Saved.', 15_000);
        await until(
          'the review saved',
          async () => (await sittingOf(ctx, id)).review?.insight === insight,
        );
        if ((await sittingOf(ctx, id)).claudeNotes?.text !== text)
          fail('a review Save changed Claude’s notes');
        await p.reload({ waitUntil: 'load' });
        await heading.waitFor({ timeout: 15_000 });
        await firstLine.waitFor({ timeout: 5_000 });
      },
    },

    // --- The coach tools: a peek in one call, the accept kept, off-roadmap fields ---
    {
      id: 'peek-solution',
      title: 'log_attempt help: solution, outcome: solved in one call; clean with help refused',
      entry: 'mcp',
      proves: ['log-solution', 'log-clean-help-refused', 'track-retry'],
      async run(ctx) {
        const slug = slugOf(ctx, 'solution');
        const out = await ctx.mcp.writes.logAttempt([
          { slug, help: 'solution', outcome: 'solved', title: titleOf(ctx, 'solution') },
        ]);
        const a = out.attempts[0];
        if (out.attempts.length !== 1 || !a) fail(`log_attempt: ${JSON.stringify(out)}`);
        if (a.outcome !== 'failed' || a.help !== 'solution')
          fail(`stored ${a.outcome} / ${String(a.help)}, want failed / solution`);
        if (a.nextDue?.dueDay !== d(1) || a.nextDue.track !== 'retry')
          fail(`nextDue ${JSON.stringify(a.nextDue)}, want ${d(1)} retry`);
        const rec = (await ctx.mcp.reads.getProblem({ slug })).record;
        if (rec?.everAccepted !== true || rec.reSolve?.track !== 'retry')
          fail(`get_problem’s record: ${JSON.stringify(rec)}`);

        const before = (await ctx.api.reads.listCoachAttempts()).length;
        try {
          await ctx.mcp.writes.logAttempt([
            { slug: slugOf(ctx, 'clean-help'), outcome: 'clean', help: 'solution' },
          ]);
          fail('clean with help: solution was accepted');
        } catch (err) {
          if (!/A clean attempt took no help/.test(String(err))) throw err;
        }
        if ((await ctx.api.reads.listCoachAttempts()).length !== before)
          fail('a refused log_attempt wrote an attempt');
      },
    },
    {
      id: 'peek-day',
      title:
        'mark_peeked {slug, day −3, accepted, title, difficulty} twice; a titled log on day −1; later untitled logs',
      entry: 'mcp',
      proves: ['peek-accepted', 'off-catalog'],
      async run(ctx) {
        const [peek, paper] = [slugOf(ctx, 'peek'), slugOf(ctx, 'paper')];
        const args = {
          slug: peek,
          day: d(-3),
          accepted: true,
          title: titleOf(ctx, 'peek'),
          difficulty: 'Medium',
        };
        const a = await ctx.mcp.writes.markPeeked(args);
        if (!a.attemptId || a.nextDue?.dueDay !== d(-2) || a.nextDue.track !== 'retry')
          fail(`mark_peeked: ${JSON.stringify(a)}`);
        const b = await ctx.mcp.writes.markPeeked(args);
        if (b.attemptId !== a.attemptId) fail('a repeated mark_peeked logged a second attempt');
        await ctx.mcp.writes.logAttempt([
          {
            slug: paper,
            outcome: 'solved',
            day: d(-1),
            title: titleOf(ctx, 'paper'),
            difficulty: 'Hard',
          },
        ]);
        // Later and untitled: a clean re-solve of the peek on day −1 (retry step 2, due +2), the paper one today.
        await ctx.mcp.writes.logAttempt([
          { slug: peek, outcome: 'clean', day: d(-1) },
          { slug: paper, outcome: 'clean' },
        ]);
        const p = await ctx.mcp.reads.getProblem({ slug: peek });
        if (p.problem.title !== titleOf(ctx, 'peek') || p.problem.difficulty !== 'Medium')
          fail(`the peeked problem after an untitled log: ${JSON.stringify(p.problem)}`);
        if (
          p.record?.everAccepted !== true ||
          p.record.reSolve?.track !== 'retry' ||
          p.record.reSolve.dueDay !== d(2)
        )
          fail(`the peeked problem’s record: ${JSON.stringify(p.record)}`);
        const q = await ctx.mcp.reads.getProblem({ slug: paper });
        if (q.problem.title !== titleOf(ctx, 'paper') || q.problem.difficulty !== 'Hard')
          fail(`the logged problem after an untitled log: ${JSON.stringify(q.problem)}`);
      },
    },
    {
      id: 'retry-track',
      title: 'list_problems by track (peeked as an alias) and leetcode_today read retry',
      entry: 'mcp',
      proves: ['track-retry'],
      async run(ctx) {
        const [peek, solution, paper] = ['peek', 'solution', 'paper'].map((w) => slugOf(ctx, w));
        const by = async (track: string) =>
          (await ctx.mcp.reads.listProblems({ track, limit: 100 })).problems.map((p) => p.slug);
        const [retry, alias, clean] = [await by('retry'), await by('peeked'), await by('clean')];
        if (!retry.includes(peek!) || !retry.includes(solution!) || retry.includes(paper!))
          fail(`track retry: ${retry.join(', ')}`);
        if (JSON.stringify([...alias].sort()) !== JSON.stringify([...retry].sort()))
          fail(`track peeked ≠ retry: ${alias.join(', ')}`);
        if (!clean.includes(paper!) || clean.includes(peek!))
          fail(`track clean: ${clean.join(', ')}`);
        await expectParamError('track: "peek"', () =>
          ctx.mcp.reads.listProblems({ track: 'peek' }),
        );
        const t = await ctx.mcp.reads.leetcodeToday();
        const q = t.next48h.find((x) => x.slug === peek);
        if (q?.track !== 'retry')
          fail(`leetcode_today’s next48h for the peek: ${JSON.stringify(q)}`);
        const odd = [...t.due, ...t.next48h].filter(
          (x) => x.track !== 'clean' && x.track !== 'retry',
        );
        if (odd.length) fail(`tracks other than clean/retry: ${JSON.stringify(odd)}`);
      },
    },
    {
      id: 'retry-ui',
      title: 'The Today card’s re-solve queue reads “· retry” on the peeked problem',
      entry: 'ui',
      proves: ['track-retry-ui'],
      async run(ctx) {
        const c = await todayCard(ctx);
        const row = c
          .getByRole('region', { name: 'Re-solves coming up' })
          .getByRole('listitem')
          .filter({ hasText: titleOf(ctx, 'peek') })
          .first();
        await row.waitFor({ timeout: 15_000 });
        const text = (await row.textContent()) ?? '';
        if (!text.includes('· retry') || text.includes('· peeked'))
          fail(`the queue row reads “${text}”`);
        await ctx.shot('coach-fixes-retry-row');
      },
    },

    // --- Plan mode. From here this run's logs are due by today on purpose (see the top). ---
    {
      id: 'mode-invalid',
      title: 'updateSettings with an unknown plan mode is refused',
      entry: 'api',
      proves: ['plan-mode-invalid'],
      async run(ctx) {
        const before = (await ctx.api.reads.getSettings()).coachPlanMode;
        const got = await ctx.api.writes.rpcRaw(
          'updateSettings',
          JSON.stringify({ args: [{ coachPlanMode: 'sometimes' }] }),
          'jwt',
        );
        if (got.status !== 400) fail(`HTTP ${got.status} ${JSON.stringify(got.body)}`);
        if ((await ctx.api.reads.getSettings()).coachPlanMode !== before)
          fail('a refused plan mode changed the setting');
      },
    },
    {
      id: 'mode-seven',
      title: 'Auto with 7 due and no earlier day at 10: Balanced',
      entry: 'api',
      proves: ['auto-seven'],
      async run(ctx) {
        const t = await ctx.api.reads.getCoachToday();
        const m = pm(t);
        if (m.setting !== 'auto') fail(`the setting reads ${m.setting} — setup set auto`);
        if (m.mode !== 'balanced')
          fail(
            `Auto reads catch-up before this run’s backdated logs (${m.due} due: ${dueList(t)}) — an earlier day reached ${ENTER_DUE}`,
          );
        if (m.due > 7)
          fail(
            `${m.due} due before this scenario (${dueList(t)}); the hysteresis rows need at most 7`,
          );
        state.base = m.due;
        state.dueSlugs = Array.from({ length: ENTER_DUE }, (_, i) => slugOf(ctx, `due-${i + 1}`));
        state.logged = 7 - m.due;
        if (state.logged) await logFailed(ctx, state.dueSlugs.slice(0, state.logged), d(-3));
        const s = pm(await ctx.api.reads.getCoachToday());
        if (s.mode !== 'balanced' || s.due !== 7 || s.line !== 'Balanced: 7 due · auto')
          fail(`7 due: ${JSON.stringify(s)}`);
        ctx.log(`baseline ${state.base} due from other scenarios; logged ${state.logged}`);
      },
    },
    {
      id: 'mode-ten',
      title:
        'Auto with 10 of this run’s failed logs due from day −2: Catch-up, re-solves fill the slots',
      entry: 'api',
      proves: ['auto-catch-up', 'catch-up-mix'],
      async run(ctx) {
        await logFailed(ctx, state.dueSlugs.slice(state.logged), d(-3));
        state.logged = ENTER_DUE;
        const t = await ctx.api.reads.getCoachToday();
        const m = pm(t);
        const n = state.base + ENTER_DUE;
        if (m.mode !== 'catch-up' || m.due !== n || m.line !== `Catch-up: ${n} due · auto`)
          fail(`${ENTER_DUE} logged: ${JSON.stringify(m)}, want Catch-up with ${n} due`);
        // No carry-over yet (day −1's attempts are all accepted): one new, then re-solves past the usual two.
        const k = kinds(t);
        if (
          k.stretch ||
          k.new > 1 ||
          k['re-solve'] !== 4 - k.new - k['carry-over'] ||
          k['re-solve'] < 3
        )
          fail(`catch-up slots: ${JSON.stringify(k)}`);
      },
    },
    {
      id: 'mode-ten-mcp',
      title: 'leetcode_today answers the same plan mode',
      entry: 'mcp',
      proves: ['auto-catch-up'],
      async run(ctx) {
        const want = pm(await ctx.api.reads.getCoachToday());
        const got = (await ctx.mcp.reads.leetcodeToday()).planMode;
        if (JSON.stringify(got) !== JSON.stringify(want) || got?.mode !== 'catch-up')
          fail(`leetcode_today planMode ${JSON.stringify(got)}, the API’s ${JSON.stringify(want)}`);
      },
    },
    {
      id: 'mode-mix',
      title:
        'A carry-over from day −1: the Catch-up mix keeps it; Balanced forced keeps the usual mix',
      entry: 'api',
      proves: ['catch-up-mix', 'balanced-forced'],
      async run(ctx) {
        const carry = slugOf(ctx, 'carry');
        const [c] = await logFailed(ctx, [carry], d(-1));
        const carryId = c?.id ?? fail('logCoachAttempts stored nothing');
        const n = state.base + ENTER_DUE + 1; // the carry-over is due too, and counted
        const cu = await ctx.api.reads.getCoachToday();
        const k = kinds(cu);
        if (pm(cu).mode !== 'catch-up' || pm(cu).due !== n)
          fail(`with the carry-over: ${JSON.stringify(pm(cu))}`);
        if (cu.slots.find((s) => s.kind === 'carry-over')?.slug !== carry)
          fail(`no carry-over slot for ${carry}: ${JSON.stringify(cu.slots)}`);
        if (k.stretch || k.new > 1 || k['re-solve'] !== 3 - k.new || cu.slots.length !== 4)
          fail(`catch-up with a carry-over: ${JSON.stringify(k)}`);
        const ours = (t: DevCoachToday) =>
          t.offPlan
            .map((o) => o.sittingId)
            .filter((id) => mine().includes(id))
            .sort()
            .join(',');

        await ctx.api.writes.updateSettings({ coachPlanMode: 'balanced' });
        try {
          const b = await ctx.api.reads.getCoachToday();
          const m = pm(b);
          if (
            m.setting !== 'balanced' ||
            m.mode !== 'balanced' ||
            m.due !== n ||
            m.line !== `Balanced: ${n} due`
          )
            fail(`forced balanced: ${JSON.stringify(m)}`);
          const kb = kinds(b);
          if (
            b.slots.find((s) => s.kind === 'carry-over')?.slug !== carry ||
            kb['re-solve'] !== 1 ||
            kb.new < 1 ||
            kb.new + kb.stretch !== 2
          )
            fail(`forced balanced slots: ${JSON.stringify(kb)}`);
          if (b.floor?.slug !== cu.floor?.slug)
            fail(`the floor moved: ${String(cu.floor?.slug)} → ${String(b.floor?.slug)}`);
          if (ours(b) !== ours(cu) || !ours(b)) fail(`off-plan moved: ${ours(cu)} → ${ours(b)}`);
        } finally {
          await ctx.api.writes.updateSettings({ coachPlanMode: 'auto' });
        }
        if ((await ctx.mcp.writes.deleteAttempt(carryId)).deleted !== true)
          fail('the carry-over’s log didn’t delete');
        const back = pm(await ctx.api.reads.getCoachToday());
        if (back.mode !== 'catch-up' || back.due !== n - 1)
          fail(`after the carry-over went: ${JSON.stringify(back)}`);
      },
    },
    {
      id: 'mode-hysteresis',
      title: 'Clean re-solves on day −1: 7 due holds Catch-up; 4 due goes Balanced',
      entry: 'api',
      proves: ['auto-hysteresis'],
      async run(ctx) {
        const seven = pm(await bringTo(ctx, 7));
        if (seven.mode !== 'catch-up' || seven.line !== 'Catch-up: 7 due · auto')
          fail(`7 due after ${ENTER_DUE}: ${JSON.stringify(seven)}`);
        const four = pm(await bringTo(ctx, 4));
        if (four.mode !== 'balanced' || four.line !== 'Balanced: 4 due · auto')
          fail(`4 due: ${JSON.stringify(four)}`);
      },
    },
    {
      id: 'mode-settings',
      title:
        'Settings › Plan mode: Catch-up, Balanced, Auto — saved, reloaded, on the Today card; 390 px',
      entry: 'ui',
      proves: ['plan-mode-ui'],
      async run(ctx) {
        const p = ctx.page;
        const saved = async () => (await ctx.api.reads.getSettings()).coachPlanMode ?? 'auto';
        // Each label is the option's name, then its hint (Settings index.tsx PLAN_MODE_OPTIONS).
        const radio = (label: string) =>
          p
            .getByRole('group', { name: 'Plan mode' })
            .getByRole('radio', { name: new RegExp(`^${label}`) });
        const options: [string, DevCoachPlanMode][] = [
          ['Catch-up', 'catch-up'],
          ['Balanced', 'balanced'],
          ['Auto', 'auto'],
        ];
        try {
          await ctx.ui.goto('/settings');
          await radio('Auto').waitFor({ timeout: 15_000 });
          await until('Auto checked as the page opens', () => radio('Auto').isChecked());
          for (const [label, value] of options) {
            await ctx.ui.goto('/settings');
            await radio(label).click();
            await until(`${label} saved`, async () => (await saved()) === value);
            await p.reload({ waitUntil: 'load' });
            await radio(label).waitFor({ timeout: 15_000 });
            await until(`${label} checked after a reload`, () => radio(label).isChecked());
            if (value === 'catch-up') {
              await p.setViewportSize({ width: 390, height: 844 });
              try {
                await ctx.ui.goto('/settings');
                await radio(label).scrollIntoViewIfNeeded();
                const wide = await p.evaluate<boolean>(
                  '(() => document.documentElement.scrollWidth > window.innerWidth)()',
                );
                if (wide) fail('Settings scrolls sideways at 390');
                await ctx.ui.settle();
                await ctx.shot('coach-fixes-plan-mode-390');
              } finally {
                await p.setViewportSize(PHONE);
              }
            }
            const want = pm(await ctx.api.reads.getCoachToday());
            if (want.setting !== value)
              fail(`the plan reads setting ${want.setting} after ${label}`);
            const line = (await todayCard(ctx)).locator('[data-testid="plan-mode"]');
            await line.waitFor({ timeout: 15_000 });
            const shown = ((await line.textContent()) ?? '').trim();
            if (shown !== want.line) fail(`the card says “${shown}”, the plan “${want.line}”`);
            if ((value === 'auto') !== shown.endsWith(' · auto'))
              fail(`${label}: the card’s line “${shown}”`);
            if (value !== 'auto' && !shown.startsWith(`${label}: `))
              fail(`${label}: the card’s line “${shown}”`);
            if (value === 'catch-up') await ctx.shot('coach-fixes-plan-mode-card');
          }
        } finally {
          await ctx.api.writes.updateSettings({ coachPlanMode: 'auto' });
        }
      },
    },
    {
      id: 'restore',
      title: 'Unlink the roll; put the plan mode back as setup found it',
      entry: 'api',
      async run(ctx) {
        await ctx.api.writes.linkLeetcodeRoll(null);
        if ((state.priorMode ?? 'auto') !== 'auto')
          await ctx.api.writes.updateSettings({ coachPlanMode: state.priorMode });
      },
    },
    noConsoleErrors,
  ],
};
