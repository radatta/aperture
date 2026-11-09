// LeetCode sittings (docs/areas/recruiting), PR A1: the server half the extension will call — Start opens a
// sitting as a rep of the linked roll, events fold into it, Done or Drop on the rep ends it — and the
// Recruiting page and Settings reading it back. Driven through the JWT: the device token writes into the
// user's own dev partition, not the test user's, so its gate is proven off dev (lambdas index.test.ts).
// Slugs and titles carry the run's nonce; every row this scenario makes is ledgered from a response.
import { noConsoleErrors, type Ctx, type Scenario } from '../scenario';
import type { DevSittingEvent, DevSittingStart } from '../api';
import { McpRpcError, PARAM_ERROR } from '../mcp';
import { devUlid } from './flux-history';

const tag = (ctx: Ctx) => ctx.nonce.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const slugOf = (ctx: Ctx, which: string) => `devcheck-lc-${tag(ctx)}-${which}`;
const titleOf = (ctx: Ctx, which: string) => `devcheck-lc ${ctx.nonce} ${which}`;
const start = (ctx: Ctx, which: string, over: Partial<DevSittingStart> = {}): DevSittingStart => ({
  clientSittingId: devUlid(),
  problemSlug: slugOf(ctx, which),
  problemTitle: titleOf(ctx, which),
  difficulty: 'Medium',
  topicTags: ['Array'],
  lang: 'python3',
  startedAt: Date.now(),
  tzOffsetMinutes: 480, // the test user's day is LA's
  problem: { titleSlug: slugOf(ctx, which), difficulty: 'Medium' },
  ...over,
});
const snap = (code: string, at: number): DevSittingEvent => ({
  id: devUlid(),
  type: 'snapshot',
  at,
  payload: { code, lang: 11 },
});
const judged = (
  type: 'run' | 'submit',
  status: number,
  msg: string,
  at: number,
  ok: number,
  all: number,
): DevSittingEvent => ({
  id: devUlid(),
  type,
  at,
  payload: {
    request: { lang: 'python3', typed_code: 'print("devcheck")' },
    result: { status_code: status, status_msg: msg, total_correct: ok, total_testcases: all },
  },
});
// The server's refusal, as call() throws it: `<method> → HTTP 400: {"error":"…"}`.
async function refused(what: string, p: Promise<unknown>, match: RegExp): Promise<void> {
  try {
    await p;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/HTTP 400/.test(msg) || !match.test(msg))
      throw new Error(`${what}: refused oddly — ${msg}`, { cause: err });
    return;
  }
  throw new Error(`${what}: not refused`);
}

// What later steps build on, set by the steps that make it.
const state = { rollId: '', a: '', aRep: '', aClient: '', aStartedAt: 0, c: '' };
async function sittingA(ctx: Ctx) {
  if (!state.a) throw new Error('no sitting A — the start step failed');
  return ctx.api.reads.getSitting(state.a);
}

export const lcSittings: Scenario = {
  id: 'lc-sittings',
  title: 'A LeetCode sitting opens as a rep, folds its runs and submits, and ends with the rep',
  tiers: ['full'],
  slowPaths: [
    'app/src/pages/Recruiting/**',
    'app/src/data/hooks/useSittings.ts',
    'app/src/pages/Settings/index.tsx',
    'packages/shared/src/sittings.ts',
    'scripts/src/devcheck/scenarios/lc-sittings.ts',
  ],
  rows: [
    // PR B: Claude watches live (live_sitting, lambdas/src/mcp/leetcodeTools.ts).
    {
      id: 'live-listed',
      entry: 'mcp',
      kind: 'nominal',
      what: 'MCP offers live_sitting',
    },
    {
      id: 'live-idle',
      entry: 'mcp',
      kind: 'nominal',
      what: 'With nothing open, live_sitting says so',
    },
    {
      id: 'live-active',
      entry: 'mcp',
      kind: 'nominal',
      what: 'During a sitting, live_sitting returns its newest code in full, the snapshot version, the problem, the newest Submit’s verdict and the counts',
    },
    {
      id: 'live-counted',
      entry: 'api',
      kind: 'nominal',
      what: 'The sitting read shows the pull counted (Claude watched live)',
    },
    {
      id: 'live-repeat',
      entry: 'mcp',
      kind: 'edge',
      what: 'A second pull with sinceVersion at the current version says the code is unchanged, and counts again',
    },
    {
      id: 'live-bad-arg',
      entry: 'mcp',
      kind: 'edge',
      what: 'A sinceVersion that isn’t a whole number is a param error, and nothing is counted',
    },
    {
      id: 'live-after-done',
      entry: 'mcp',
      kind: 'edge',
      what: 'After Done on the rep, live_sitting is inactive and names that sitting as the last one, done',
    },
    {
      id: 'live-stale',
      entry: 'mcp',
      kind: 'edge',
      what: 'A sitting left open past its window reads inactive, with nothing written',
      offDev: {
        file: 'lambdas/src/backend.sittings.test.ts',
        test: 'nothing open — none ever, the gate on an ended one, or past the window — writes nothing',
        why: 'dev can’t wait a day; the same pull path is proven on dev by live-active and live-after-done',
      },
    },
    {
      id: 'live-big-code',
      entry: 'mcp',
      kind: 'edge',
      what: 'Code at the 64 KB snapshot cap comes back whole through MCP',
    },
    {
      id: 'live-race',
      entry: 'mcp',
      kind: 'edge',
      what: 'Pulls racing a run’s ingest all count, the run still folds, and its failing case comes back',
    },
    {
      id: 'live-real',
      entry: 'mcp',
      kind: 'nominal',
      what: 'In a real sitting on prod, Claude (the Aperture project) answers “what am I working on?” from live_sitting',
      needsYou:
        'needs the Safari extension (PR A2) on prod and the claude.ai connector reconnected — your first real sitting after both',
    },
    {
      id: 'start-unlinked',
      entry: 'api',
      kind: 'edge',
      what: 'Start with no LeetCode roll linked is refused and writes nothing',
    },
    {
      id: 'start-spawn',
      entry: 'api',
      kind: 'nominal',
      what: 'Start spawns a rep in progress, titled after the problem, on today’s plan, with the problem stored',
    },
    {
      id: 'start-resume',
      entry: 'api',
      kind: 'edge',
      what: 'A repeated Start, or one on the same open problem, resumes the sitting',
    },
    {
      id: 'start-other-refused',
      entry: 'api',
      kind: 'edge',
      what: 'Start on another problem while one is open is refused',
    },
    {
      id: 'events-fold',
      entry: 'api',
      kind: 'nominal',
      what: 'Snapshots version the live code; a run and a wrong-then-accepted submit fold into the metrics',
    },
    {
      id: 'events-repeat',
      entry: 'api',
      kind: 'edge',
      what: 'Sending the same events again counts them as duplicates, nothing double-counted',
    },
    {
      id: 'events-invalid',
      entry: 'api',
      kind: 'edge',
      what: 'Oversized, too many, badly-keyed or unknown-sitting events are refused with nothing written',
    },
    {
      id: 'replay',
      entry: 'api',
      kind: 'nominal',
      what: 'A replay chunk is stored raw, kept out of the sitting read, and folds into its facts',
    },
    {
      id: 'end-done',
      entry: 'api',
      kind: 'nominal',
      what: 'Done on the rep ends the sitting; events after it are refused',
    },
    {
      id: 'end-drop',
      entry: 'api',
      kind: 'edge',
      what: 'Dropping a rep abandons its sitting',
    },
    {
      id: 'ui-open',
      entry: 'ui',
      kind: 'nominal',
      what: 'The Recruiting page pins the open sitting with its running clock',
    },
    {
      id: 'ui-ended',
      entry: 'ui',
      kind: 'nominal',
      what: 'After a reload, ended sittings read by day with their outcome (accepted on submit 2, dropped)',
    },
    {
      id: 'ui-neighbour',
      entry: 'ui',
      kind: 'edge',
      what: 'The Stories tab beside Sittings still opens',
    },
    {
      id: 'settings-select',
      entry: 'ui',
      kind: 'nominal',
      what: 'Settings shows the linked LeetCode roll; picking No Roll and back saves each',
    },
    {
      id: 'device-token',
      entry: 'api',
      kind: 'nominal',
      what: 'The extension’s device token starts a sitting as its user, and opens nothing else',
      offDev: {
        file: 'lambdas/src/index.test.ts',
        test: 'the device token starts a sitting as DEVICE_USER_ID',
        why: 'dev can’t produce it for the test user: the device token writes into its own user’s partition',
      },
    },
    {
      id: 'raw-expiry',
      entry: 'api',
      kind: 'nominal',
      what: 'Only the raw bulk (snapshots, replay, submit details) is stamped to expire',
      offDev: {
        file: 'lambdas/src/backend.sittings.test.ts',
        test: 'stamps expiresAt on the raw bulk only, on prod',
        why: 'dev can’t show it: expiresAt is a table attribute no API read returns',
      },
    },
    {
      id: 'double-start',
      entry: 'api',
      kind: 'edge',
      what: 'A double-fired Start makes one sitting and one rep',
    },
    {
      id: 'prep-target',
      entry: 'api',
      kind: 'nominal',
      what: 'A sitting’s prep target saves trimmed, and blank goes back to General',
    },
    {
      id: 'delete-sitting',
      entry: 'api',
      kind: 'edge',
      what: 'Deleting a sitting removes it and its reads, and leaves its rep',
    },
    {
      id: 'event-clock',
      entry: 'api',
      kind: 'edge',
      what: 'An event timed days off the sitting’s clock is refused',
    },
    {
      id: 'start-archived',
      entry: 'api',
      kind: 'edge',
      what: 'A linked roll that’s been archived reads as unlinked',
    },
    {
      id: 'stale-window',
      entry: 'api',
      kind: 'edge',
      what: 'A sitting left open past its window ends at the next Start, which reuses its rep',
      offDev: {
        file: 'packages/shared/src/sittings.test.ts',
        test: 'abandons one past its window and reuses its still-open rep',
        why: 'dev can’t wait a day; the planner is pure, and this unit test runs it past the window',
      },
    },
    {
      id: 'half-made',
      entry: 'api',
      kind: 'edge',
      what: 'A Start that died half-way finishes on its retry, and blocks another problem only while it could still be in flight',
      offDev: {
        file: 'lambdas/src/backend.sittings.test.ts',
        test: 'a half-made Start finishes on its retry, and never blocks another problem',
        why: 'dev can’t make a Start die between its head and its rep without a test-only switch',
      },
    },
    {
      id: 'parallel-starts',
      entry: 'api',
      kind: 'edge',
      what: 'Parallel Starts on different problems open one sitting; the other is refused as still open',
    },
    {
      id: 'delete-cascade',
      entry: 'api',
      kind: 'edge',
      what: 'Deleting a rep removes its sitting — runs, submits and all',
    },
    {
      id: 'attempt-cap',
      entry: 'api',
      kind: 'edge',
      what: 'Start attempts — refused ones too — stop at the day’s cap',
      offDev: {
        file: 'lambdas/src/backend.sittings.test.ts',
        test: 'counts every Start attempt — refused ones too — and stops at the day’s cap',
        why: 'dev can’t take 400 Starts without locking the test user out for the day',
      },
    },
    {
      id: 'cap',
      entry: 'api',
      kind: 'edge',
      what: 'A sitting past 3,000 events — any type, repeats included — refuses more with nothing written',
      offDev: {
        file: 'packages/shared/src/sittings.test.ts',
        test: 'reserves a call in the budget, refusing one that would pass a cap',
        why: 'dev can’t take it: 3,000 writes would run into dev’s write cap; the guard is this pure reservation',
      },
    },
    {
      id: 'mcp-legacy-gone',
      entry: 'mcp',
      kind: 'edge',
      what: 'MCP no longer offers list_leetcode_attempts',
    },
    {
      id: 'window',
      entry: 'api',
      kind: 'edge',
      what: 'Events a day after Start are refused',
      offDev: {
        file: 'packages/shared/src/sittings.test.ts',
        test: 'refuses an ended sitting, one past its window, and an event off its clock',
        why: 'dev can’t wait a day: the guard is pure, and the contract suite runs it with an advanced clock',
      },
    },
  ],
  steps: [
    {
      id: 'live-idle',
      entry: 'mcp',
      proves: ['live-listed', 'live-idle'],
      title: 'MCP lists live_sitting; with nothing open it says inactive',
      async run(ctx) {
        if (!(await ctx.mcp.reads.toolsList()).includes('live_sitting'))
          throw new Error('live_sitting isn’t listed');
        const out = await ctx.mcp.reads.liveSitting();
        if (out.active) throw new Error(`active with nothing open: ${JSON.stringify(out.sitting)}`);
        if (out.lastSitting?.problem.slug.includes(tag(ctx)))
          throw new Error('lastSitting is one of this run’s, before any Start');
      },
    },
    {
      id: 'unlinked',
      entry: 'api',
      proves: ['start-unlinked'],
      title: 'Unlink any LeetCode roll, then Start — refused, no sitting',
      async run(ctx) {
        await ctx.api.writes.linkLeetcodeRoll(null);
        await refused(
          'unlinked start',
          ctx.api.writes.lcSittingStart(start(ctx, 'none')),
          /LeetCode roll/,
        );
        const mine = (await ctx.api.reads.listSittings()).filter(
          (x) => x.problemSlug === slugOf(ctx, 'none'),
        );
        if (mine.length) throw new Error('the refused Start left a sitting');
      },
    },
    {
      id: 'start',
      entry: 'api',
      proves: ['start-spawn', 'start-resume', 'start-other-refused'],
      title: 'Link a fresh roll; Start A spawns its rep; repeats resume; Start B is refused',
      async run(ctx) {
        const roll = await ctx.api.writes.upsertRoll({
          name: titleOf(ctx, 'roll'),
          estimateMin: 45,
        });
        state.rollId = roll.id;
        await ctx.api.writes.linkLeetcodeRoll(roll.id);
        const input = start(ctx, 'a');
        const { sitting, resumed } = await ctx.api.writes.lcSittingStart(input);
        if (resumed || sitting.status !== 'active')
          throw new Error(`start: ${JSON.stringify(sitting)}`);
        Object.assign(state, {
          a: sitting.id,
          aRep: sitting.repTaskId,
          aClient: input.clientSittingId,
          aStartedAt: input.startedAt,
        });
        const rep = await ctx.api.reads.getTask(sitting.repTaskId);
        if (rep?.status !== 'in_progress' || rep.title !== `LeetCode · ${titleOf(ctx, 'a')}`)
          throw new Error(`rep: ${JSON.stringify(rep)}`);
        const plans = await ctx.api.reads.listPlansForDay(sitting.day);
        if (!plans.some((p) => p.taskId === rep.id))
          throw new Error('the rep isn’t on the sitting’s day');
        if ((await sittingA(ctx)).problem?.slug !== slugOf(ctx, 'a'))
          throw new Error('no problem stored');
        const again = await ctx.api.writes.lcSittingStart({
          ...input,
          problemTitle: 'devcheck hijack',
        });
        const same = await ctx.api.writes.lcSittingStart(
          start(ctx, 'a', { problemTitle: 'hijack 2' }),
        );
        for (const r of [again, same])
          if (!r.resumed || r.sitting.id !== sitting.id)
            throw new Error(`resume: ${JSON.stringify(r)}`);
        // A repeat shapes the rep from the stored sitting: a different title in the request renames nothing.
        if ((await ctx.api.reads.getTask(rep.id))?.title !== `LeetCode · ${titleOf(ctx, 'a')}`)
          throw new Error('a repeated Start renamed the rep');
        await refused(
          'start B while A is open',
          ctx.api.writes.lcSittingStart(start(ctx, 'b')),
          /still open/,
        );
      },
    },
    {
      id: 'events',
      entry: 'api',
      proves: ['events-fold', 'events-repeat'],
      title:
        'Two snapshots and an older one, a run, a wrong submit, an accepted one; then all again',
      async run(ctx) {
        const t = Date.now();
        const batch = [
          snap('class Solution: pass', t + 1000),
          snap('class Solution:\n    def solve(self): ...', t + 3000),
          snap('stale', t + 2000),
          judged('run', 15, 'Runtime Error', t + 4000, 0, 3),
          judged('submit', 11, 'Wrong Answer', t + 5000, 88, 307),
          judged('submit', 10, 'Accepted', t + 6000, 307, 307),
        ];
        const first = await ctx.api.writes.lcSittingEvents(state.a, batch);
        if (first.accepted !== 6 || first.version !== 3 || first.status !== 'active')
          throw new Error(`first: ${JSON.stringify(first)}`);
        const again = await ctx.api.writes.lcSittingEvents(state.a, batch);
        if (again.accepted !== 0 || again.duplicates !== 6)
          throw new Error(`again: ${JSON.stringify(again)}`);
        const { sitting, live, events } = await sittingA(ctx);
        const s = sitting.summary;
        if (
          s.runs !== 1 ||
          s.submits !== 2 ||
          s.runsBeforeFirstSubmit !== 1 ||
          s.firstSubmit?.verdict !== 'wrong_answer' ||
          s.firstSubmit.passed !== 88 ||
          s.lastSubmit?.verdict !== 'accepted' ||
          s.submitsBeforeAccepted !== 1
        )
          throw new Error(`summary: ${JSON.stringify(s)}`);
        if (live?.version !== 3 || live.code !== 'class Solution:\n    def solve(self): ...')
          throw new Error(`live: ${JSON.stringify(live)}`);
        if (events.length !== 6) throw new Error(`${events.length} events stored, not 6`);
      },
    },
    {
      id: 'live-active',
      entry: 'mcp',
      proves: ['live-active'],
      title:
        'live_sitting during A: its newest code, version 3, the problem, the accepted submit, the counts',
      async run(ctx) {
        const out = await ctx.mcp.reads.liveSitting();
        if (
          !out.active ||
          out.sitting?.id !== state.a ||
          out.sitting.problem.slug !== slugOf(ctx, 'a') ||
          out.sitting.liveReads !== 1 ||
          out.code?.version !== 3 ||
          out.code.text !== 'class Solution:\n    def solve(self): ...' ||
          out.runCount !== 1 ||
          out.submitCount !== 2 ||
          out.lastSubmit?.verdict !== 'accepted' ||
          'unchangedSinceVersion' in out
        )
          throw new Error(`live: ${JSON.stringify({ ...out, code: out.code?.version })}`);
      },
    },
    {
      id: 'live-counted',
      entry: 'api',
      proves: ['live-counted'],
      title: 'The sitting read shows the one pull',
      async run(ctx) {
        const { liveReads } = await sittingA(ctx);
        if (liveReads !== 1) throw new Error(`liveReads ${liveReads}, not 1`);
      },
    },
    {
      id: 'live-repeat',
      entry: 'mcp',
      proves: ['live-repeat', 'live-bad-arg'],
      title:
        'A pull with sinceVersion 3 says unchanged and counts; sinceVersion "3" is refused, uncounted',
      async run(ctx) {
        const out = await ctx.mcp.reads.liveSitting({ sinceVersion: 3 });
        if (out.unchangedSinceVersion !== true || out.sitting?.liveReads !== 2)
          throw new Error(
            `repeat: ${JSON.stringify({ u: out.unchangedSinceVersion, n: out.sitting?.liveReads })}`,
          );
        try {
          await ctx.mcp.reads.liveSitting({ sinceVersion: '3' });
          throw new Error('sinceVersion "3" was taken');
        } catch (err) {
          if (!(err instanceof McpRpcError) || err.code !== PARAM_ERROR) throw err;
        }
        const { liveReads } = await sittingA(ctx);
        if (liveReads !== 2) throw new Error(`the refused pull counted: liveReads ${liveReads}`);
      },
    },
    {
      id: 'invalid',
      entry: 'api',
      proves: ['events-invalid', 'event-clock'],
      title:
        'Off-clock, oversized, 51, badly-keyed and unknown-sitting events are all refused; the live row is unchanged',
      async run(ctx) {
        const t = Date.now();
        const w = ctx.api.writes;
        await refused(
          'oversized',
          w.lcSittingEvents(state.a, [snap('x'.repeat(70 * 1024), t)]),
          /too large/,
        );
        await refused(
          'an event three days off the sitting’s clock',
          w.lcSittingEvents(state.a, [snap('a', state.aStartedAt + 3 * 24 * 3600_000)]),
          /off the sitting/,
        );
        const many = Array.from({ length: 51 }, (_, i) => snap('a', t + i));
        await refused('51 events', w.lcSittingEvents(state.a, many), /At most 50/);
        await refused(
          'bad id',
          w.lcSittingEvents(state.a, [{ ...snap('a', t), id: 'nope' }]),
          /valid id/,
        );
        await refused(
          'unknown sitting',
          w.lcSittingEventsToUnknown(devUlid(), [snap('a', t)]),
          /Not found/,
        );
        const { live } = await sittingA(ctx);
        if (live?.version !== 3)
          throw new Error(`a refused call moved the live row: v${live?.version}`);
      },
    },
    {
      id: 'live-big',
      entry: 'mcp',
      proves: ['live-big-code'],
      title: 'A snapshot near the 64 KB cap comes back whole from live_sitting',
      async run(ctx) {
        const big = `# devcheck\n${'x'.repeat(63 * 1024)}`;
        await ctx.api.writes.lcSittingEvents(state.a, [snap(big, Date.now())]);
        const out = await ctx.mcp.reads.liveSitting();
        if (out.code?.text !== big || out.code.version !== 4 || out.sitting?.liveReads !== 3)
          throw new Error(
            `big: ${out.code?.text?.length} chars, v${out.code?.version}, ${out.sitting?.liveReads} pulls`,
          );
      },
    },
    {
      id: 'live-race',
      entry: 'mcp',
      proves: ['live-race'],
      title:
        'Five pulls at once with a run’s ingest: all five count, the run folds, its case comes back',
      async run(ctx) {
        const run: DevSittingEvent = {
          id: devUlid(),
          type: 'run',
          at: Date.now(),
          payload: {
            request: { lang: 'python3', typed_code: 'print("devcheck")', data_input: '[2,7]\n9' },
            result: {
              status_code: 11,
              status_msg: 'Wrong Answer',
              total_correct: 0,
              total_testcases: 1,
              code_answer: ['[0,0]'],
              expected_code_answer: ['[0,1]'],
            },
          },
        };
        await Promise.all([
          ...Array.from({ length: 5 }, () => ctx.mcp.reads.liveSitting()),
          ctx.api.writes.lcSittingEvents(state.a, [run]),
        ]);
        const out = await ctx.mcp.reads.liveSitting();
        const d = out.lastRun?.detail;
        if (
          out.sitting?.liveReads !== 9 ||
          out.runCount !== 2 ||
          out.lastRun?.verdict !== 'wrong_answer' ||
          d?.input !== '[2,7]\n9' ||
          d.expected !== '[0,1]' ||
          d.output !== '[0,0]'
        )
          throw new Error(
            `race: ${JSON.stringify({ n: out.sitting?.liveReads, runs: out.runCount, last: out.lastRun })}`,
          );
      },
    },
    {
      id: 'replay',
      entry: 'api',
      proves: ['replay'],
      title: 'One replay chunk: listed raw, absent from the sitting read, folded into the facts',
      async run(ctx) {
        const t = Date.now();
        const raw = JSON.stringify([
          { type: 7, timestamp: t },
          { type: 3, val: true, timestamp: t + 500 },
          { type: 7, timestamp: t + 40_000 },
        ]);
        await ctx.api.writes.lcSittingEvents(state.a, [
          {
            id: devUlid(),
            type: 'replay',
            at: t + 40_000,
            clientSessionId: 'devcheck',
            events: raw,
          },
        ]);
        const { live, events } = await sittingA(ctx);
        if (events.some((e) => e.type === ('replay' as string)))
          throw new Error('the replay is in the sitting read');
        if (
          !live ||
          live.facts.edits < 2 ||
          live.facts.longestStallMs < 39_000 ||
          live.facts.focus.length < 1
        )
          throw new Error(`facts: ${JSON.stringify(live?.facts)}`);
        const chunks = await ctx.api.reads.listSittingReplay(state.a);
        if (!chunks.some((c) => c.events === raw)) throw new Error('the chunk isn’t listed raw');
      },
    },
    {
      id: 'ui-open',
      entry: 'ui',
      cost: 'slow',
      proves: ['ui-open', 'ui-neighbour'],
      title: 'Recruiting pins sitting A as in progress; the Stories tab opens beside it',
      async run(ctx) {
        await ctx.ui.goto('/recruiting');
        const open = ctx.page.getByRole('region', { name: 'Now' });
        await open.getByText(titleOf(ctx, 'a')).waitFor({ timeout: 15_000 });
        await open.getByText(/In progress/).waitFor({ timeout: 5_000 });
        await ctx.shot('sittings-open');
        await ctx.page.getByRole('link', { name: 'Stories' }).click();
        await ctx.page.waitForURL(/\/recruiting\/stories$/, { timeout: 10_000 });
        await ctx.page.getByRole('link', { name: 'Sittings' }).click();
        await open.getByText(titleOf(ctx, 'a')).waitFor({ timeout: 15_000 });
      },
    },
    {
      id: 'end',
      entry: 'api',
      proves: ['end-done'],
      title: 'Done on A’s rep ends it, and events after it are refused',
      async run(ctx) {
        await ctx.api.writes.setTaskActual(state.aRep, 40);
        await ctx.api.writes.finishTask(state.aRep, 'done');
        const a = (await sittingA(ctx)).sitting;
        if (a.status !== 'done' || a.endedAt === null)
          throw new Error(`A after Done: ${JSON.stringify(a)}`);
        await refused(
          'events after Done',
          ctx.api.writes.lcSittingEvents(state.a, [snap('late', Date.now())]),
          /ended/,
        );
      },
    },
    {
      id: 'live-after-done',
      entry: 'mcp',
      proves: ['live-after-done'],
      title: 'After Done, live_sitting is inactive and names A as the last sitting, done',
      async run(ctx) {
        const out = await ctx.mcp.reads.liveSitting();
        if (out.active || out.lastSitting?.id !== state.a || out.lastSitting.status !== 'done')
          throw new Error(`after Done: ${JSON.stringify(out)}`);
        if (out.lastSitting.liveReads !== 9)
          throw new Error(`an inactive pull counted: ${out.lastSitting.liveReads}`);
      },
    },
    {
      id: 'double-start',
      entry: 'api',
      proves: ['double-start', 'prep-target', 'end-drop'],
      title:
        'Start C twice at once (one sitting, one rep, one plan row); tag it; dropping its rep abandons it',
      async run(ctx) {
        const input = start(ctx, 'c');
        const [x, y] = await Promise.all([
          ctx.api.writes.lcSittingStart(input),
          ctx.api.writes.lcSittingStart({ ...input }),
        ]);
        if (x.sitting.id !== y.sitting.id || [x.resumed, y.resumed].filter(Boolean).length !== 1)
          throw new Error(`two answers: ${JSON.stringify([x.resumed, y.resumed])}`);
        const reps = (await ctx.api.reads.listTasks()).filter(
          (t) => t.title === `LeetCode · ${titleOf(ctx, 'c')}`,
        );
        if (reps.length !== 1 || reps[0]!.status !== 'in_progress')
          throw new Error(`reps for C: ${JSON.stringify(reps)}`);
        const plans = await ctx.api.reads.listPlansForDay(x.sitting.day);
        if (plans.filter((p) => p.taskId === reps[0]!.id).length !== 1)
          throw new Error('C’s rep isn’t on its day exactly once');
        const id = x.sitting.id;
        state.c = id;
        const tagged = await ctx.api.writes.setSittingPrepTarget(id, '  devcheck-target ');
        const blank = await ctx.api.writes.setSittingPrepTarget(id, '   ');
        if (tagged.prepTarget !== 'devcheck-target' || blank.prepTarget !== 'General')
          throw new Error('the prep target didn’t normalize');
        await ctx.api.writes.finishTask(reps[0]!.id, 'cancelled');
        const after = (await ctx.api.reads.getSitting(id)).sitting;
        if (after.status !== 'abandoned') throw new Error(`C after Drop: ${after.status}`);
      },
    },
    {
      id: 'mcp-legacy-gone',
      entry: 'mcp',
      proves: ['mcp-legacy-gone'],
      title: 'MCP’s tool list has no list_leetcode_attempts',
      async run(ctx) {
        if ((await ctx.mcp.reads.toolsList()).includes('list_leetcode_attempts'))
          throw new Error('list_leetcode_attempts is still offered');
      },
    },
    {
      id: 'ui-ended',
      entry: 'ui',
      cost: 'slow',
      proves: ['ui-ended', 'settings-select'],
      title:
        'After a reload, A reads “accepted on submit 2” and C “dropped”; Settings shows the linked roll',
      async run(ctx) {
        await ctx.ui.goto('/recruiting');
        await ctx.page.reload();
        const rowA = ctx.page
          .getByText(titleOf(ctx, 'a'))
          .locator('xpath=ancestor::div[contains(@class,"justify-between")][1]');
        await rowA.getByText('accepted on submit 2').waitFor({ timeout: 15_000 });
        const rowC = ctx.page
          .getByText(titleOf(ctx, 'c'))
          .locator('xpath=ancestor::div[contains(@class,"justify-between")][1]');
        await rowC.getByText(/dropped/).waitFor({ timeout: 5_000 });
        if (await ctx.page.getByRole('region', { name: 'Now' }).count())
          throw new Error('an ended sitting is still pinned as open');
        await ctx.shot('sittings-ended');
        await ctx.ui.goto('/settings#leetcode');
        const select = ctx.page.getByLabel('Sittings are reps of');
        await select.waitFor({ timeout: 15_000 });
        // The select reads empty (and disabled) until the Rolls load — wait for it to settle on the link.
        for (let i = 0; ; i++) {
          const shown = await select.inputValue();
          if (shown === state.rollId) break;
          if (i >= 40) throw new Error(`Settings shows “${shown}”, not the linked roll`);
          await new Promise((r) => setTimeout(r, 250));
        }
        await select.scrollIntoViewIfNeeded();
        await ctx.shot('settings-leetcode');
        // Unlink and relink through the select itself, each landing on the server.
        const until = async (want: string | null) => {
          for (let i = 0; (await ctx.api.reads.getSettings()).leetcodeRollId !== want; i++) {
            if (i >= 40) throw new Error(`the select never saved ${want}`);
            await new Promise((r) => setTimeout(r, 250));
          }
        };
        await select.selectOption({ label: 'No Roll' });
        await until(null);
        await ctx.page
          .getByText(/With no Roll, the extension’s Start is refused/)
          .waitFor({ timeout: 5_000 });
        await ctx.shot('settings-leetcode-none');
        await select.selectOption({ label: titleOf(ctx, 'roll') });
        await until(state.rollId);
      },
    },
    {
      id: 'deletes',
      entry: 'api',
      proves: ['delete-sitting', 'delete-cascade'],
      title:
        'Delete C’s sitting (its rep stays); delete A’s rep (its sitting, with its submits, goes with it)',
      async run(ctx) {
        const c = (await ctx.api.reads.getSitting(state.c)).sitting;
        await ctx.api.writes.deleteSitting(state.c);
        if ((await ctx.api.reads.listSittings()).some((s) => s.id === state.c))
          throw new Error('the deleted sitting is still listed');
        await refused('read after delete', ctx.api.reads.getSitting(state.c), /Not found/);
        if (!(await ctx.api.reads.getTask(c.repTaskId)))
          throw new Error('deleting the sitting took its rep');
        await ctx.api.writes.deleteTask(state.aRep);
        if ((await ctx.api.reads.listSittings()).some((s) => s.id === state.a))
          throw new Error('deleting A’s rep left its sitting');
      },
    },
    {
      id: 'parallel',
      entry: 'api',
      proves: ['parallel-starts'],
      title:
        'Start E and F at once: one opens, the other is refused as still open; drop the winner',
      async run(ctx) {
        const results = await Promise.allSettled([
          ctx.api.writes.lcSittingStart(start(ctx, 'e')),
          ctx.api.writes.lcSittingStart(start(ctx, 'f')),
        ]);
        const won = results.filter((r) => r.status === 'fulfilled');
        const lost = results.filter((r) => r.status === 'rejected');
        if (won.length !== 1 || lost.length !== 1)
          throw new Error(`${won.length} opened, ${lost.length} refused`);
        const why = String((lost[0] as PromiseRejectedResult).reason);
        if (!/HTTP 400/.test(why) || !/still open/.test(why))
          throw new Error(`refused oddly: ${why}`);
        const { sitting } = (won[0] as PromiseFulfilledResult<{ sitting: { repTaskId: string } }>)
          .value;
        await ctx.api.writes.finishTask(sitting.repTaskId, 'cancelled');
      },
    },
    {
      id: 'archived',
      entry: 'api',
      proves: ['start-archived'],
      title:
        'Archive the linked roll: Start reads it as unlinked; then unlink for the scenarios after',
      async run(ctx) {
        await ctx.api.writes.setRollActive(state.rollId, false);
        await refused(
          'start on an archived roll',
          ctx.api.writes.lcSittingStart(start(ctx, 'd')),
          /LeetCode roll/,
        );
        await ctx.api.writes.linkLeetcodeRoll(null);
      },
    },
    noConsoleErrors,
  ],
};
