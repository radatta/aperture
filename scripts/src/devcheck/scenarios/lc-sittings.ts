// LeetCode sittings (docs/areas/recruiting), PR A1: the server half the extension will call — Start opens a
// sitting as a rep of the linked roll, events fold into it, Done or Drop on the rep ends it — and the
// Recruiting page and Settings reading it back. Driven through the JWT: the device token writes into the
// user's own dev partition, not the test user's, so its gate is proven off dev (lambdas index.test.ts).
// Slugs and titles carry the run's nonce; every row this scenario makes is ledgered from a response.
import { noConsoleErrors, type Ctx, type Scenario } from '../scenario';
import type { DevSittingEvent, DevSittingStart } from '../api';
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
const state = { rollId: '', a: '', aRep: '', aClient: '' };
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
      what: 'Dropping the rep abandons its sitting',
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
      what: 'Settings shows the linked LeetCode roll',
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
      id: 'cap',
      entry: 'api',
      kind: 'edge',
      what: 'A sitting past 3,000 events — any type, repeats included — refuses more with nothing written',
      offDev: {
        file: 'packages/shared/src/sittings.test.ts',
        test: 'reserves a call in the budget, refusing one that would pass a cap',
        why: 'dev can’t take it: 3,000 writes would run into dev’s write cap; the contract suite drives the same guard with submit details alone',
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
        });
        const rep = await ctx.api.reads.getTask(sitting.repTaskId);
        if (rep?.status !== 'in_progress' || rep.title !== `LeetCode · ${titleOf(ctx, 'a')}`)
          throw new Error(`rep: ${JSON.stringify(rep)}`);
        const plans = await ctx.api.reads.listPlansForDay(sitting.day);
        if (!plans.some((p) => p.taskId === rep.id))
          throw new Error('the rep isn’t on the sitting’s day');
        if ((await sittingA(ctx)).problem?.slug !== slugOf(ctx, 'a'))
          throw new Error('no problem stored');
        const again = await ctx.api.writes.lcSittingStart({ ...input });
        const same = await ctx.api.writes.lcSittingStart(start(ctx, 'a'));
        for (const r of [again, same])
          if (!r.resumed || r.sitting.id !== sitting.id)
            throw new Error(`resume: ${JSON.stringify(r)}`);
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
      id: 'invalid',
      entry: 'api',
      proves: ['events-invalid'],
      title:
        'Oversized, 51, badly-keyed and unknown-sitting events are all refused; the live row is unchanged',
      async run(ctx) {
        const t = Date.now();
        const w = ctx.api.writes;
        await refused(
          'oversized',
          w.lcSittingEvents(state.a, [snap('x'.repeat(70 * 1024), t)]),
          /too large/,
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
      proves: ['end-done', 'end-drop'],
      title:
        'Done on A’s rep ends it and refuses later events; B starts, and dropping its rep abandons it',
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
        const { sitting: b } = await ctx.api.writes.lcSittingStart(start(ctx, 'b'));
        if (b.repTaskId === state.aRep) throw new Error('B reused A’s finished rep');
        await ctx.api.writes.finishTask(b.repTaskId, 'cancelled');
        const after = (await ctx.api.reads.getSitting(b.id)).sitting;
        if (after.status !== 'abandoned') throw new Error(`B after Drop: ${after.status}`);
      },
    },
    {
      id: 'double-start',
      entry: 'api',
      proves: ['double-start', 'prep-target', 'delete-sitting'],
      title:
        'Start C twice at once (one sitting, one rep); tag it; delete it — its rep stays, then drops',
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
        if (reps.length !== 1) throw new Error(`${reps.length} reps for C`);
        const id = x.sitting.id;
        const tagged = await ctx.api.writes.setSittingPrepTarget(id, '  devcheck-target ');
        const blank = await ctx.api.writes.setSittingPrepTarget(id, '   ');
        if (
          (tagged as { prepTarget?: string }).prepTarget !== 'devcheck-target' ||
          (blank as { prepTarget?: string }).prepTarget !== 'General'
        )
          throw new Error('the prep target didn’t normalize');
        await ctx.api.writes.deleteSitting(id);
        if ((await ctx.api.reads.listSittings()).some((s) => s.id === id))
          throw new Error('the deleted sitting is still listed');
        await refused('read after delete', ctx.api.reads.getSitting(id), /Not found/);
        const rep = await ctx.api.reads.getTask(x.sitting.repTaskId);
        if (!rep) throw new Error('deleting the sitting took its rep');
        await ctx.api.writes.finishTask(rep.id, 'cancelled'); // free the roll for the steps after
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
        'After a reload, A reads “accepted on submit 2” and B “dropped”; Settings shows the linked roll',
      async run(ctx) {
        await ctx.ui.goto('/recruiting');
        await ctx.page.reload();
        const rowA = ctx.page
          .getByText(titleOf(ctx, 'a'))
          .locator('xpath=ancestor::div[contains(@class,"justify-between")][1]');
        await rowA.getByText('accepted on submit 2').waitFor({ timeout: 15_000 });
        const rowB = ctx.page
          .getByText(titleOf(ctx, 'b'))
          .locator('xpath=ancestor::div[contains(@class,"justify-between")][1]');
        await rowB.getByText(/dropped/).waitFor({ timeout: 5_000 });
        if (await ctx.page.getByRole('region', { name: 'Now' }).count())
          throw new Error('an ended sitting is still pinned as open');
        await ctx.shot('sittings-ended');
        await ctx.ui.goto('/settings#leetcode');
        const select = ctx.page.getByLabel('Sittings are reps of');
        await select.waitFor({ timeout: 15_000 });
        if ((await select.inputValue()) !== state.rollId)
          throw new Error(`Settings shows ${await select.inputValue()}, not the linked roll`);
        await select.scrollIntoViewIfNeeded();
        await ctx.shot('settings-leetcode');
      },
    },
    {
      id: 'unlink',
      entry: 'api',
      title: 'Unlink the roll so no later scenario meets it (cleanup archives it)',
      async run(ctx) {
        await ctx.api.writes.linkLeetcodeRoll(null);
      },
    },
    noConsoleErrors,
  ],
};
