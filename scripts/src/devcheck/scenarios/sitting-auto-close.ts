// Idle close (docs/areas/recruiting → Idle close): an open sitting nothing has touched for 45 min is closed by the
// next read at its last activity + 5 min, says so on its page with Reopen, and Reopen opens it again. Dev can't
// backdate (every idle clock is the server's), so the close is a real wait: one ~50-min slow chain, run only when
// --feature or --tier all names it (slowPaths: this file — the maintainer's call, 2026-11-17). Driven through the
// JWT, as lc-sittings is; slugs and titles carry the run's nonce, every row is ledgered from a response.
import { PHONE } from '../browser';
import type { DevSitting, DevSittingStart } from '../api';
import type { Ctx, Scenario } from '../scenario';
import { devUlid } from './flux-history';

// The server's constants (packages/shared/src/sittings.ts — scripts can't import shared).
const IDLE_MS = 45 * 60_000;
const TAIL_MS = 5 * 60_000;
const SKEW_MS = 60_000; // this machine's clock against the server's, both ways
const NOTICE = 'Closed automatically: 45 min with no activity';

const tag = (ctx: Ctx) => ctx.nonce.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const slugOf = (ctx: Ctx) => `devcheck-idle-${tag(ctx)}`;
const titleOf = (ctx: Ctx) => `devcheck-idle ${ctx.nonce}`;
const start = (ctx: Ctx): DevSittingStart => ({
  clientSittingId: devUlid(),
  problemSlug: slugOf(ctx),
  problemTitle: titleOf(ctx),
  difficulty: 'Easy',
  topicTags: ['Array'],
  lang: 'python3',
  startedAt: Date.now(),
  tzOffsetMinutes: 480, // the test user's day is LA's
});
const sleepUntil = async (t: number) => {
  for (let left = t - Date.now(); left > 0; left = t - Date.now())
    await new Promise((r) => setTimeout(r, Math.min(left, 60_000)));
};
// Whole minutes, at least 1 — sittingMinutes, as the page and the Done form count them.
const minutesOf = (s: DevSitting) =>
  Math.max(1, Math.round(((s.endedAt ?? Date.now()) - s.startedAt - (s.idleMs ?? 0)) / 60_000));

const state = {
  rollId: '',
  id: '',
  rep: '',
  t0: 0, // this machine's clock just before Start
  pullBefore: 0, // around the live pull, the last activity
  pullAfter: 0,
  mcpEnd: 0, // the end MCP read, before any app read wrote it
  closed: null as DevSitting | null,
  back: null as DevSitting | null,
};
const head = async (ctx: Ctx) => {
  if (!state.id) throw new Error('no sitting — the start step failed');
  return (await ctx.api.reads.getSitting(state.id)).sitting;
};

export const sittingAutoClose: Scenario = {
  id: 'sitting-auto-close',
  title:
    'An idle LeetCode sitting closes itself at its last activity + 5 min, says so, and reopens',
  tiers: ['full'],
  slowPaths: ['scripts/src/devcheck/scenarios/sitting-auto-close.ts'],
  rows: [
    {
      id: 'fresh-untouched',
      entry: 'api',
      kind: 'nominal',
      what: 'A sitting with recent activity stays open through the list and its detail',
    },
    {
      id: 'pull-keeps-alive',
      entry: 'mcp',
      kind: 'nominal',
      what: 'A live_sitting pull counts as activity: 47 min after Start, 44 after the pull, it is still open',
    },
    {
      id: 'idle-closes',
      entry: 'api',
      kind: 'nominal',
      what: '45 min after the last activity the app’s next read closes it, closedBy idle, ending 5 min after that activity; its rep stays in progress',
    },
    {
      id: 'idle-mcp',
      entry: 'mcp',
      kind: 'nominal',
      what: 'get_sitting, list_sittings and live_sitting read it closed by idle at the pull + 5 min, read before any app read (that MCP reads write nothing is proven off dev: leetcodeTools.test.ts asserts the table unchanged)',
    },
    {
      id: 'rep-minutes',
      entry: 'ui',
      kind: 'nominal',
      what: 'The rep’s Done form on the sitting’s page starts on the minutes up to the close, not the time since',
    },
    {
      id: 'label-and-button',
      entry: 'ui',
      kind: 'nominal',
      what: '“Closed automatically: 45 min with no activity” with Reopen, on screen at 440, 390 and desktop, light and dark',
    },
    {
      id: 'list-and-home',
      entry: 'ui',
      kind: 'nominal',
      what: 'Its list row reads “closed automatically”, not “dropped”, and Home links the rep to it',
    },
    {
      id: 'reopen',
      entry: 'ui',
      kind: 'nominal',
      what: 'Reopen opens it again: End sitting is back, its idle gap leaves its minutes, and it holds the Start gate (live_sitting reads it active)',
    },
    {
      id: 'reopen-repeat',
      entry: 'api',
      kind: 'edge',
      what: 'A second reopen of the open sitting changes nothing',
    },
    {
      id: 'reopen-blocked',
      entry: 'api',
      kind: 'edge',
      what: 'Reopen is refused while another sitting is open, or once its rep finished or moved on',
      offDev: {
        file: 'packages/shared/src/sittings.test.ts',
        test: 'refuses a reopen unless closed by idle, in its window, its rep live and nothing else open',
        why: 'a second idle sitting is a second 46-min wait; the refusal is this pure check, which the contract suite (“reopen restores it, refuses while another is open, and is idempotent”) runs on the stub and the Lambda',
      },
    },
    {
      id: 'return-event',
      entry: 'api',
      kind: 'nominal',
      what: 'An extension event stamped after the close, the same app day, reopens it; one stamped before lands without reopening',
      offDev: {
        file: 'packages/shared/src/sittings.test.ts',
        test: 'an event stamped after the end comes back; one before it is a straggler',
        why: 'a second idle wait; the contract suite (“an event after an idle close reopens it; a straggler lands without reopening”) runs the ingest path on the stub and the Lambda',
      },
    },
    {
      id: 'return-start',
      entry: 'api',
      kind: 'nominal',
      what: 'A Start on the same problem the same app day reopens it; the next day starts a new sitting on the rep',
      offDev: {
        file: 'packages/shared/src/sittings.test.ts',
        test: 'a Start on its problem the same app day reopens it; another day, it attaches the rep',
        why: 'a second idle wait, and the next day; the contract suite (“a Start on the same problem the same day reopens it; the next day starts a new one”) runs Start on the stub and the Lambda',
      },
    },
    {
      id: 'done-after-idle',
      entry: 'api',
      kind: 'edge',
      what: 'Done on the rep after an idle close keeps its end and reads done; Drop leaves it abandoned',
      offDev: {
        file: 'packages/shared/src/sittings.test.ts',
        test: 'an idle close abandons it at its end, and Done after reads done with the end kept',
        why: 'this run’s one idle sitting is spent on Reopen; the contract suite (“Done after an idle close keeps its end and reads done; Drop leaves it abandoned”) runs it on the stub and the Lambda',
      },
    },
    {
      id: 'close-race',
      entry: 'api',
      kind: 'edge',
      what: 'Reads at once close it once, at the same end',
      offDev: {
        file: 'lambdas/src/backend.sittings.test.ts',
        test: 'reads at once close it once, at the same end, and log one close',
        why: 'dev can’t time parallel reads onto the same moment; the test runs the real backend over the table',
      },
    },
    {
      id: 'reopen-race',
      entry: 'api',
      kind: 'edge',
      what: 'A reopen racing a Start on another problem leaves one sitting open',
      offDev: {
        file: 'lambdas/src/backend.sittings.test.ts',
        test: 'a reopen racing a Start on another problem leaves one sitting open, holding the gate',
        why: 'dev can’t time the race; the test runs both on the real backend over the table',
      },
    },
    {
      id: 'extension-return',
      entry: 'extension',
      kind: 'nominal',
      what: 'In Safari, a keystroke on the problem after 45 min away reopens the sitting',
      needsYou:
        'needs the Safari extension and a real 45-min pause on the Mac — your next real sitting after merge',
    },
  ],
  steps: [
    {
      id: 'start',
      entry: 'api',
      proves: ['fresh-untouched'],
      title: 'Link a fresh roll, Start, send a snapshot; the list and the detail read it open',
      async run(ctx) {
        const roll = await ctx.api.writes.upsertRoll({
          name: `${titleOf(ctx)} roll`,
          estimateMin: 45,
        });
        state.rollId = roll.id;
        await ctx.api.writes.linkLeetcodeRoll(roll.id);
        state.t0 = Date.now();
        const { sitting } = await ctx.api.writes.lcSittingStart(start(ctx));
        Object.assign(state, { id: sitting.id, rep: sitting.repTaskId });
        await ctx.api.writes.lcSittingEvents(sitting.id, [
          { id: devUlid(), type: 'snapshot', at: Date.now(), payload: { code: 'pass', lang: 11 } },
        ]);
        const row = (await ctx.api.reads.listSittings()).find((x) => x.id === sitting.id);
        const one = await head(ctx);
        if (row?.status !== 'active' || one.status !== 'active' || one.closedBy)
          throw new Error(`fresh sitting not open: ${JSON.stringify({ row, one })}`);
      },
    },
    {
      id: 'pull',
      entry: 'mcp',
      cost: 'slow',
      proves: ['pull-keeps-alive'],
      title: 'Two minutes on, Claude pulls it live',
      async run(ctx) {
        await sleepUntil(state.t0 + 2 * 60_000);
        state.pullBefore = Date.now();
        const out = await ctx.mcp.reads.liveSitting();
        state.pullAfter = Date.now();
        if (!out.active || out.sitting?.id !== state.id)
          throw new Error(`live_sitting: ${JSON.stringify(out)}`);
      },
    },
    {
      id: 'kept-alive',
      entry: 'api',
      cost: 'slow',
      proves: ['pull-keeps-alive', 'fresh-untouched'],
      title: '44 min after the pull (over 45 after Start), the list and detail still read it open',
      async run(ctx) {
        await sleepUntil(state.pullBefore + IDLE_MS - SKEW_MS);
        if (Date.now() - state.t0 <= IDLE_MS + SKEW_MS)
          throw new Error('the check came too soon to prove the pull kept it open');
        const row = (await ctx.api.reads.listSittings()).find((x) => x.id === state.id);
        const one = await head(ctx);
        if (row?.status !== 'active' || one.status !== 'active')
          throw new Error(`closed though the pull was 44 min ago: ${JSON.stringify(one)}`);
      },
    },
    {
      id: 'idle-mcp',
      entry: 'mcp',
      cost: 'slow',
      proves: ['idle-mcp'],
      title:
        'Past 45 min since the pull, get_sitting, list_sittings and live_sitting read it closed by idle at the pull + 5 min',
      async run(ctx) {
        await sleepUntil(state.pullAfter + IDLE_MS + SKEW_MS);
        const one = (await ctx.mcp.reads.getSitting({ id: state.id })).sitting;
        const end = one?.endedAt ? Date.parse(one.endedAt) : NaN;
        const lo = state.pullBefore + TAIL_MS - SKEW_MS;
        const hi = state.pullAfter + TAIL_MS + SKEW_MS;
        if (one?.closedBy !== 'idle' || one.status !== 'abandoned' || !(end >= lo && end <= hi))
          throw new Error(`get_sitting: ${JSON.stringify(one)} (end ${lo}–${hi})`);
        state.mcpEnd = end;
        const row = (await ctx.mcp.reads.listSittings({ limit: 10 })).sittings.find(
          (x) => x.id === state.id,
        );
        if (row?.closedBy !== 'idle') throw new Error(`list_sittings: ${JSON.stringify(row)}`);
        const live = await ctx.mcp.reads.liveSitting();
        if (
          live.active ||
          live.lastSitting?.id !== state.id ||
          live.lastSitting.closedBy !== 'idle'
        )
          throw new Error(`live_sitting: ${JSON.stringify(live)}`);
      },
    },
    {
      id: 'idle-closes',
      entry: 'api',
      cost: 'slow',
      proves: ['idle-closes'],
      title:
        'The app’s read writes the same close: closedBy idle at the end MCP read; its rep stays in progress',
      async run(ctx) {
        if (!state.mcpEnd) throw new Error('no end read — the idle-mcp step failed');
        const row = (await ctx.api.reads.listSittings()).find((x) => x.id === state.id);
        if (row?.status !== 'abandoned' || row.closedBy !== 'idle' || row.endedAt !== state.mcpEnd)
          throw new Error(`not closed at ${state.mcpEnd}: ${JSON.stringify(row)}`);
        state.closed = row;
        const rep = await ctx.api.reads.getTask(state.rep);
        if (rep?.status !== 'in_progress') throw new Error(`rep: ${JSON.stringify(rep)}`);
        const later = await head(ctx);
        if (later.endedAt !== row.endedAt) throw new Error('a later read moved the end');
        // MCP's minutes were the stored head's too.
        const one = (await ctx.mcp.reads.getSitting({ id: state.id })).sitting;
        if (one?.minutes !== minutesOf(row))
          throw new Error(`get_sitting minutes: ${one?.minutes}`);
      },
    },
    {
      id: 'ui-closed',
      entry: 'ui',
      cost: 'slow',
      proves: ['label-and-button', 'rep-minutes', 'list-and-home'],
      title:
        'The sitting’s page says it closed, with Reopen, at 440, 390 and desktop; Done starts on its minutes',
      async run(ctx) {
        if (!state.closed) throw new Error('not closed — the idle-closes step failed');
        const minutes = String(minutesOf(state.closed));
        await ctx.ui.goto(`/recruiting/sittings/${state.id}`);
        const notice = ctx.page.getByText(NOTICE);
        const reopen = ctx.page.getByRole('button', { name: 'Reopen' });
        const sizes = [
          ['440', PHONE],
          ['390', { width: 390, height: 844 }],
          ['desktop', { width: 1512, height: 860 }],
        ] as const;
        try {
          for (const [name, size] of sizes) {
            await ctx.page.setViewportSize(size);
            for (const theme of ['light', 'dark'] as const) {
              await ctx.ui.setTheme(theme);
              await notice.waitFor({ timeout: 15_000 });
              await reopen.waitFor({ timeout: 5_000 });
              const box = await reopen.boundingBox();
              if (!box || box.x < 0 || box.x + box.width > size.width)
                throw new Error(`${name} ${theme}: Reopen is off screen`);
              const wide = await ctx.page.evaluate<boolean>(
                '(() => document.documentElement.scrollWidth > window.innerWidth)()',
              );
              if (wide) throw new Error(`${name} ${theme}: the page scrolls sideways`);
              await ctx.ui.settle();
              await ctx.shot(`closed-${name}-${theme}`);
            }
          }
        } finally {
          await ctx.ui.setTheme('light');
          await ctx.page.setViewportSize(PHONE);
        }
        await ctx.page.getByRole('button', { name: 'Mark rep done' }).click();
        const actual = ctx.page.getByLabel('Actual (min)');
        if ((await actual.inputValue()) !== minutes)
          throw new Error(
            `Done starts on ${await actual.inputValue()}, not the sitting’s ${minutes}`,
          );
        await ctx.shot('closed-done-form');
        await ctx.page.getByRole('button', { name: 'Cancel' }).click();

        await ctx.ui.goto('/recruiting');
        const row = ctx.page.getByRole('region', { name: 'All sittings' }).getByRole('link', {
          name: new RegExp(titleOf(ctx).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        });
        await row.waitFor({ timeout: 15_000 });
        const text = (await row.textContent()) ?? '';
        if (!/closed automatically/.test(text) || /dropped/.test(text))
          throw new Error(`list row: ${text}`);
        await ctx.ui.goto('/');
        const link = ctx.page.getByRole('link', {
          name: 'LeetCode sitting closed automatically →',
        });
        await link.first().waitFor({ timeout: 15_000 });
        if (!(await link.first().getAttribute('href'))?.endsWith(state.id))
          throw new Error('Home’s link goes elsewhere');
        await ctx.shot('closed-home');
      },
    },
    {
      id: 'reopen',
      entry: 'ui',
      cost: 'slow',
      proves: ['reopen'],
      title:
        'Reopen: End sitting is back, the gap leaves its minutes, live_sitting reads it active',
      async run(ctx) {
        if (!state.closed?.endedAt) throw new Error('not closed — the idle-closes step failed');
        await ctx.ui.goto(`/recruiting/sittings/${state.id}`);
        const before = Date.now();
        await ctx.page.getByRole('button', { name: 'Reopen' }).click();
        await ctx.page.getByRole('button', { name: 'End sitting' }).waitFor({ timeout: 15_000 });
        await ctx.page.getByText(NOTICE).waitFor({ state: 'hidden', timeout: 5_000 });
        await ctx.shot('reopened');
        const back = await head(ctx);
        const gap = back.idleMs ?? 0;
        const want = before - state.closed.endedAt;
        if (
          back.status !== 'active' ||
          back.closedBy ||
          back.endedAt !== null ||
          Math.abs(gap - want) > 2 * SKEW_MS
        )
          throw new Error(`reopened: ${JSON.stringify(back)} (gap ≈ ${want})`);
        state.back = back;
        const live = await ctx.mcp.reads.liveSitting();
        if (!live.active || live.sitting?.id !== state.id)
          throw new Error(`live_sitting after reopen: ${JSON.stringify(live)}`);
      },
    },
    {
      id: 'reopen-repeat',
      entry: 'api',
      cost: 'slow',
      proves: ['reopen-repeat'],
      title: 'A second reopen of the open sitting changes nothing',
      async run(ctx) {
        if (!state.back) throw new Error('not reopened — the reopen step failed');
        const again = await ctx.api.writes.reopenSitting(state.id);
        if (
          again.status !== 'active' ||
          again.reopenedAt !== state.back.reopenedAt ||
          again.idleMs !== state.back.idleMs
        )
          throw new Error(`second reopen: ${JSON.stringify(again)}`);
      },
    },
    {
      id: 'end',
      entry: 'api',
      title: 'Drop the rep (ending the sitting) and unlink the roll, for the scenarios after',
      async run(ctx) {
        if (state.rep) await ctx.api.writes.finishTask(state.rep, 'cancelled');
        await ctx.api.writes.linkLeetcodeRoll(null);
        if (state.id && (await head(ctx)).status === 'active')
          throw new Error('still open after Drop');
      },
    },
  ],
};
