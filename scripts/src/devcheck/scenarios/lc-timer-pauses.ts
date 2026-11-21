// Timer pauses (docs/areas/recruiting → Timer pauses): a stretch LeetCode's own timer wasn't counting comes out of a
// sitting's minutes — derived on read from the timer reads the extension already sends, so nothing here is new on the
// wire. Driven through the JWT as lc-sittings is, with LeetCode's state shapes (debug-log 1). The fold's edges are
// exact in the stored spans, so they need no wait; the minutes need a real one (dev can't backdate the server's
// clock): one sitting paused ~3.6 min, then counting ~1.6 min — slow, run when the branch touches this file or
// --feature names it. Slugs and titles carry the run's nonce; every row is ledgered from a response.
import { PHONE } from '../browser';
import type { DevSitting, DevSittingEvent, DevSittingStart } from '../api';
import type { Ctx, Scenario } from '../scenario';
import { devUlid } from './flux-history';

const S = 1000;
const M = 60_000;
const PAUSED_FOR = 3.6 * M; // past a whole-minute round, so the minutes can't hide it
const COUNTED_AFTER = 1.6 * M;

const tag = (ctx: Ctx) => ctx.nonce.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const slugOf = (ctx: Ctx, k: string) => `devcheck-pause-${k}-${tag(ctx)}`;
const titleOf = (ctx: Ctx, k: string) => `devcheck-pause ${k} ${ctx.nonce}`;
const start = (ctx: Ctx, k: string): DevSittingStart => ({
  clientSittingId: devUlid(),
  problemSlug: slugOf(ctx, k),
  problemTitle: titleOf(ctx, k),
  difficulty: 'Easy',
  topicTags: ['Array'],
  lang: 'python3',
  startedAt: Date.now(),
  tzOffsetMinutes: 480, // the test user's day is LA's
});
const sleepUntil = async (t: number) => {
  for (let left = t - Date.now(); left > 0; left = t - Date.now())
    await new Promise((r) => setTimeout(r, Math.min(left, 30_000)));
};
// LeetCode's QD_TIMER_STATE as the extension reads it: running keeps when it started (backdated by what it already
// counted), a pause keeps what it counted. `extra` for a countdown's mode and duration, or junk.
const timer = (at: number, elapsed: number, status: 'running' | 'pause' | 'idle', extra = {}) => ({
  id: devUlid(),
  type: 'timer' as const,
  at,
  payload: {
    state: {
      mode: 'forward',
      status,
      startTimestamp: status === 'running' ? at - elapsed : null,
      pauseMs: status === 'pause' ? elapsed : null,
      ...extra,
    },
  },
});
const judgedRun = (at: number): DevSittingEvent => ({
  id: devUlid(),
  type: 'run',
  at,
  payload: {
    request: { lang: 'python3', typed_code: 'pass', data_input: '[1]' },
    result: { status_code: 10, status_msg: 'Accepted', correct_answer: true },
  },
});
const pausesOf = (s: DevSitting) => s.summary.pauses ?? [];
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
// "2m" / "1h 3m" → minutes (fmtDuration's two shapes).
const minutesIn = (text: string) => {
  const m = /^(?:(\d+)h\s*)?(?:(\d+)m)?/.exec(text.trim());
  return m && (m[1] || m[2]) ? Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) : NaN;
};

const state = {
  rollId: '',
  b: null as DevSitting | null, // the neighbour: no pause
  c: null as DevSitting | null, // the fold's edges
  a: null as DevSitting | null, // the real pause
  aPauseAt: 0,
  aElapsed: 0,
  aResumeAt: 0,
  aMinutes: 0, // So far on its page, just before Mark done
};
const head = async (ctx: Ctx, s: DevSitting | null, step: string) => {
  if (!s) throw new Error(`no sitting — the ${step} step failed`);
  return (await ctx.api.reads.getSitting(s.id)).sitting;
};
const drop = async (ctx: Ctx, s: DevSitting | null) => {
  if (s && (await head(ctx, s, 'start')).status === 'active')
    await ctx.api.writes.finishTask(s.repTaskId, 'cancelled');
};
// The sitting page's big number under a label, and the muted note under it.
const metric = async (ctx: Ctx, label: string) => {
  const dd = ctx.page.locator(`dt:has-text("${label}") + dd`);
  await dd.waitFor({ timeout: 15_000 });
  const parts = dd.locator(':scope > *');
  const value = minutesIn((await parts.first().textContent()) ?? '');
  const note = (await parts.count()) > 1 ? ((await parts.nth(1).textContent()) ?? '').trim() : '';
  return { value, note: note || null };
};
const SIZES = [
  ['440', PHONE],
  ['390', { width: 390, height: 844 }],
] as const;
async function shotsAtWidths(ctx: Ctx, name: string, check: () => Promise<void>) {
  try {
    for (const [w, size] of SIZES) {
      await ctx.page.setViewportSize(size);
      for (const theme of ['light', 'dark'] as const) {
        await ctx.ui.setTheme(theme);
        await check();
        const wide = await ctx.page.evaluate<boolean>(
          '(() => document.documentElement.scrollWidth > window.innerWidth)()',
        );
        if (wide) throw new Error(`${w} ${theme}: the page scrolls sideways`);
        await ctx.ui.settle();
        await ctx.shot(`${name}-${w}-${theme}`);
      }
    }
  } finally {
    await ctx.ui.setTheme('light');
    await ctx.page.setViewportSize(PHONE);
  }
}

export const lcTimerPauses: Scenario = {
  id: 'lc-timer-pauses',
  title: 'A pause on LeetCode’s timer comes out of the sitting’s minutes, everywhere they show',
  tiers: ['full'],
  order: 345, // after coach-fixes (340): it links its own roll and unlinks it for the scenarios after
  slowPaths: ['scripts/src/devcheck/scenarios/lc-timer-pauses.ts'],
  rows: [
    {
      id: 'pause-resume',
      entry: 'api',
      kind: 'nominal',
      what: 'A pause and its resume are stored as one span, to the ms; the minutes after leave it out',
    },
    {
      id: 'open-pause',
      entry: 'mcp',
      kind: 'nominal',
      what: 'While paused, the minutes hold still: 3.6 min into a pause, live_sitting reads 1 min, paused',
    },
    {
      id: 'no-reads',
      entry: 'api',
      kind: 'edge',
      what: 'A sitting with no timer reads stores no pause and reads wall clock',
    },
    {
      id: 'mcp-unseen',
      entry: 'mcp',
      kind: 'edge',
      what: 'live_sitting on it: nothing paused, not paused, the timer unseen',
    },
    {
      id: 'stale-pause',
      entry: 'api',
      kind: 'edge',
      what: 'A paused timer read before any counting read (one left from an earlier day) is no pause',
    },
    {
      id: 'run-ends-pause',
      entry: 'api',
      kind: 'edge',
      what: 'A Run while paused ends the pause there; a paused read after it adds nothing',
    },
    {
      id: 'repeat',
      entry: 'api',
      kind: 'edge',
      what: 'A timer event sent again is a duplicate and changes nothing',
    },
    {
      id: 'reset-idle',
      entry: 'api',
      kind: 'edge',
      what: 'After a reset the next pause counts; an idle read closes it and disarms, so the paused read after adds nothing',
    },
    {
      id: 'expired-countdown',
      entry: 'api',
      kind: 'edge',
      what: 'A countdown read past 0 is never a pause (time after 0 is wall clock)',
    },
    {
      id: 'invalid',
      entry: 'api',
      kind: 'edge',
      what: 'A timer payload that isn’t LeetCode’s state folds nothing; an event stamped past the sitting’s window refuses the call',
    },
    {
      id: 'mcp-live',
      entry: 'mcp',
      kind: 'nominal',
      what: 'live_sitting during the pause: paused, pausedMin, timerSeen; after the resume, not paused and minutes counting again',
    },
    {
      id: 'mcp-reads',
      entry: 'mcp',
      kind: 'nominal',
      what: 'get_sitting and list_sittings give the page’s minutes and the paused minutes, and write nothing',
    },
    {
      id: 'coach-minutes',
      entry: 'mcp',
      kind: 'nominal',
      what: 'get_problem’s try minutes (what Trends and coach_stats read) leave the pause out',
    },
    {
      id: 'ui-page',
      entry: 'ui',
      kind: 'nominal',
      what: 'The sitting page: So far holds with “paused on LeetCode · N so far”, then counts with “N paused”, at 440 and 390, light and dark',
    },
    {
      id: 'ui-done',
      entry: 'ui',
      kind: 'nominal',
      what: 'End sitting’s Done form starts on the paused-out minutes; Cancel leaves the sitting open; Mark done ends it on them',
    },
    {
      id: 'ui-reload',
      entry: 'ui',
      kind: 'edge',
      what: 'A reload reads the same minutes and note; the list row shows the same minutes',
    },
    {
      id: 'ui-neighbour',
      entry: 'ui',
      kind: 'edge',
      what: 'A sitting with no pause shows no paused line',
    },
    {
      id: 'home-hero',
      entry: 'ui',
      kind: 'nominal',
      what: 'Home’s hero rep shows the sitting’s paused-out minutes and “· paused” while paused',
      offDev: {
        file: 'app/src/pages/Home/RightNow.test.tsx',
        test: 'a hero rep whose LeetCode timer is paused: its minutes hold still and say paused',
        why: 'which task is the hero depends on the test user’s whole day, which other scenarios move; the app test drives the same card over the stub’s same shared fold',
      },
    },
    {
      id: 'max-pauses',
      entry: 'api',
      kind: 'edge',
      what: 'More than 100 pauses keep the 100 longest',
      offDev: {
        file: 'packages/shared/src/sittings.test.ts',
        test: 'keeps the longest pauses, up to the cap',
        why: 'dev can’t take 100 real pauses within a run; the pure fold is what the Lambda runs',
      },
    },
    {
      id: 'pause-idle-reopen',
      entry: 'api',
      kind: 'edge',
      what: 'A pause running into the idle close and a reopen is left out once',
      offDev: {
        file: 'packages/shared/src/sittings.test.ts',
        test: 'a pause into the idle close and its reopen is left out once (example 2)',
        why: 'the idle close is a 50-min wait; sitting-auto-close carries a pause through it on dev (its pause-through-idle row), and contractTests.ts runs the same case on the stub and the Lambda',
      },
    },
  ],
  steps: [
    {
      id: 'setup',
      entry: 'api',
      title: 'Link a fresh roll',
      async run(ctx) {
        const roll = await ctx.api.writes.upsertRoll({
          name: `${titleOf(ctx, 'roll')}`,
          estimateMin: 45,
        });
        state.rollId = roll.id;
        await ctx.api.writes.linkLeetcodeRoll(roll.id);
      },
    },
    {
      id: 'neighbour',
      entry: 'api',
      proves: ['no-reads', 'stale-pause'],
      title: 'Start a sitting with no timer reads; then a paused read before any counting one',
      async run(ctx) {
        const { sitting } = await ctx.api.writes.lcSittingStart(start(ctx, 'b'));
        state.b = sitting;
        const s = await head(ctx, sitting, 'neighbour');
        if (pausesOf(s).length || s.summary.pauseFrom != null || s.summary.timerSeen)
          throw new Error(`no reads, yet: ${JSON.stringify(s.summary)}`);
        await ctx.api.writes.lcSittingEvents(sitting.id, [timer(Date.now(), 25 * M, 'pause')]);
        const after = await head(ctx, sitting, 'neighbour');
        if (pausesOf(after).length || after.summary.pauseFrom != null || after.summary.timerSeen)
          throw new Error(`a stale pause counted: ${JSON.stringify(after.summary)}`);
      },
    },
    {
      id: 'neighbour-mcp',
      entry: 'mcp',
      proves: ['mcp-unseen'],
      title: 'live_sitting on it: nothing paused, the timer unseen',
      async run(ctx) {
        const live = await ctx.mcp.reads.liveSitting();
        const s = live.sitting;
        if (!live.active || s?.id !== state.b?.id || s?.paused || s?.pausedMin || s?.timerSeen)
          throw new Error(`live_sitting: ${JSON.stringify(s)}`);
      },
    },
    {
      id: 'neighbour-ui',
      entry: 'ui',
      proves: ['ui-neighbour'],
      title: 'Its page shows So far with no paused line',
      async run(ctx) {
        if (!state.b) throw new Error('no sitting — the neighbour step failed');
        await ctx.ui.goto(`/recruiting/sittings/${state.b.id}`);
        const m = await metric(ctx, 'So far');
        if (!(m.value >= 1) || m.note) throw new Error(`So far: ${JSON.stringify(m)}`);
        if (await ctx.page.getByText(/paused/).count())
          throw new Error('a sitting with no pause says paused');
        await ctx.shot('neighbour');
        await drop(ctx, state.b);
      },
    },
    {
      id: 'edges',
      entry: 'api',
      proves: ['run-ends-pause', 'repeat', 'reset-idle', 'expired-countdown', 'invalid'],
      title:
        'The fold’s edges, exact in the stored spans: a Run, a repeat, a reset, idle, a countdown past 0, junk',
      async run(ctx) {
        const { sitting } = await ctx.api.writes.lcSittingStart(start(ctx, 'c'));
        state.c = sitting;
        const c = (await head(ctx, sitting, 'edges')).clientStartedAt ?? sitting.startedAt;
        const send = (events: DevSittingEvent[]) =>
          ctx.api.writes.lcSittingEvents(sitting.id, events);
        const read = () => head(ctx, sitting, 'edges');
        // Left paused from before, resumed, paused at +5 s: the pause opens at +5 s.
        const paused = timer(c + 5 * S, 34 * S, 'pause');
        await send([timer(c + S, 30 * S, 'pause'), timer(c + 2 * S, 31 * S, 'running'), paused]);
        const open = await read();
        if (open.summary.pauseFrom !== c + 5 * S || pausesOf(open).length)
          throw new Error(`pause at +5 s: ${JSON.stringify(open.summary)}`);
        const again = await send([paused]);
        if (again.accepted !== 0 || !eq((await read()).summary, open.summary))
          throw new Error(`a repeat changed it: ${JSON.stringify(again)}`);
        // A Run at +8 s ends it; the paused read at +9 s adds nothing.
        await send([judgedRun(c + 8 * S), timer(c + 9 * S, 34 * S, 'pause')]);
        const ran = await read();
        if (!eq(pausesOf(ran), [[c + 5 * S, c + 8 * S]]) || ran.summary.pauseFrom != null)
          throw new Error(`the Run didn't end it: ${JSON.stringify(ran.summary)}`);
        // Resumed, reset to 0 and run, paused at +25 s; idle at +30 s closes it; the paused read after adds nothing.
        await send([
          timer(c + 12 * S, 34 * S, 'running'),
          timer(c + 20 * S, 0, 'running'),
          timer(c + 25 * S, 5 * S, 'pause'),
          timer(c + 30 * S, 0, 'idle'),
          timer(c + 31 * S, 5 * S, 'pause'),
        ]);
        const idle = await read();
        const two = [
          [c + 5 * S, c + 8 * S],
          [c + 25 * S, c + 30 * S],
        ];
        if (!eq(pausesOf(idle), two) || idle.summary.pauseFrom != null)
          throw new Error(`reset and idle: ${JSON.stringify(idle.summary)}`);
        // A 10-s countdown counting, then read paused at 0: never a pause. Then junk.
        const countdown = { mode: 'reverse', endMs: 10 * S };
        await send([
          timer(c + 40 * S, 9 * S, 'running', countdown),
          timer(c + 45 * S, 10 * S, 'pause', countdown),
          { id: devUlid(), type: 'timer', at: c + 50 * S, payload: { state: 'junk' } },
        ]);
        const end = await read();
        if (!eq(pausesOf(end), two) || end.summary.pauseFrom != null || !end.summary.timerSeen)
          throw new Error(`a countdown at 0 or junk folded: ${JSON.stringify(end.summary)}`);
        // Past the sitting's window (48 h after Start): the whole call is refused.
        const late = await send([timer(c + 49 * 3600_000, 5 * S, 'pause')]).then(
          () => 'taken',
          (err: unknown) => (err instanceof Error ? err.message : String(err)),
        );
        if (!/HTTP 400/.test(late) || !/off the sitting/.test(late))
          throw new Error(`an event 49 h after Start: ${late}`);
        if (!eq((await read()).summary, end.summary)) throw new Error('the refused call folded');
        await drop(ctx, state.c);
      },
    },
    {
      id: 'pause',
      entry: 'api',
      cost: 'slow',
      proves: ['pause-resume'],
      title: 'Start, the timer seen counting, then paused at once',
      async run(ctx) {
        const { sitting } = await ctx.api.writes.lcSittingStart(start(ctx, 'a'));
        state.a = sitting;
        const c = (await head(ctx, sitting, 'pause')).clientStartedAt ?? sitting.startedAt;
        const at = Date.now();
        state.aElapsed = at - c + 1;
        state.aPauseAt = at + 1;
        await ctx.api.writes.lcSittingEvents(sitting.id, [
          timer(at, at - c, 'running'),
          timer(state.aPauseAt, state.aElapsed, 'pause'),
        ]);
        const s = await head(ctx, sitting, 'pause');
        if (s.summary.pauseFrom !== state.aPauseAt || !s.summary.timerSeen)
          throw new Error(`not paused at ${state.aPauseAt}: ${JSON.stringify(s.summary)}`);
      },
    },
    {
      id: 'paused-mcp',
      entry: 'mcp',
      cost: 'slow',
      proves: ['open-pause', 'mcp-live'],
      title: '3.6 min into the pause, live_sitting reads 1 min, paused',
      async run(ctx) {
        if (!state.aPauseAt) throw new Error('no pause — the pause step failed');
        await sleepUntil(state.aPauseAt + PAUSED_FOR);
        const live = await ctx.mcp.reads.liveSitting();
        const s = live.sitting;
        const want = Math.round((Date.now() - state.aPauseAt) / M);
        if (
          s?.id !== state.a?.id ||
          s?.elapsedMin !== 1 ||
          !s?.paused ||
          !s?.timerSeen ||
          Math.abs((s?.pausedMin ?? -9) - want) > 1
        )
          throw new Error(`live_sitting while paused (≈${want} min): ${JSON.stringify(s)}`);
      },
    },
    {
      id: 'paused-ui',
      entry: 'ui',
      cost: 'slow',
      proves: ['ui-page'],
      title: 'Its page holds So far at 1m and says it’s paused, at 440 and 390, light and dark',
      async run(ctx) {
        if (!state.a) throw new Error('no sitting — the pause step failed');
        await ctx.ui.goto(`/recruiting/sittings/${state.a.id}`);
        await shotsAtWidths(ctx, 'paused', async () => {
          const m = await metric(ctx, 'So far');
          if (m.value !== 1 || !/^paused on LeetCode · \d+m so far$/.test(m.note ?? ''))
            throw new Error(`So far while paused: ${JSON.stringify(m)}`);
        });
      },
    },
    {
      id: 'resume',
      entry: 'api',
      cost: 'slow',
      proves: ['pause-resume'],
      title: 'Resumed: one span stored, to the ms; then 1.6 min counted',
      async run(ctx) {
        if (!state.a) throw new Error('no sitting — the pause step failed');
        state.aResumeAt = Date.now();
        await ctx.api.writes.lcSittingEvents(state.a.id, [
          timer(state.aResumeAt, state.aElapsed, 'running'),
        ]);
        const s = await head(ctx, state.a, 'pause');
        if (!eq(pausesOf(s), [[state.aPauseAt, state.aResumeAt]]) || s.summary.pauseFrom != null)
          throw new Error(`resumed: ${JSON.stringify(s.summary)}`);
        await sleepUntil(state.aResumeAt + COUNTED_AFTER);
      },
    },
    {
      id: 'counting-mcp',
      entry: 'mcp',
      cost: 'slow',
      proves: ['mcp-live'],
      title: 'live_sitting after the resume: not paused, the minutes counting again, the pause out',
      async run(ctx) {
        if (!state.aResumeAt) throw new Error('not resumed — the resume step failed');
        const s = (await ctx.mcp.reads.liveSitting()).sitting;
        const pausedMs = state.aResumeAt - state.aPauseAt;
        const want = Math.max(1, Math.round((Date.now() - state.a!.startedAt - pausedMs) / M));
        if (s?.paused || Math.abs((s?.elapsedMin ?? -9) - want) > 1)
          throw new Error(`live_sitting after resume (≈${want}): ${JSON.stringify(s)}`);
        if (Math.abs((s?.pausedMin ?? -9) - Math.round(pausedMs / M)) > 0)
          throw new Error(`pausedMin ${s?.pausedMin}, the pause ${pausedMs} ms`);
      },
    },
    {
      id: 'done-ui',
      entry: 'ui',
      cost: 'slow',
      proves: ['ui-page', 'ui-done', 'ui-reload'],
      title:
        'Its page: So far without the pause, “N paused”; Done starts there; Cancel keeps it open; reload; Mark done',
      async run(ctx) {
        if (!state.a || !state.aResumeAt) throw new Error('not resumed — the resume step failed');
        const a = state.a;
        const pausedMin = Math.round((state.aResumeAt - state.aPauseAt) / M);
        const note = `${pausedMin}m paused`;
        await ctx.ui.goto(`/recruiting/sittings/${a.id}`);
        let soFar = NaN;
        await shotsAtWidths(ctx, 'counting', async () => {
          const m = await metric(ctx, 'So far');
          if (m.note !== note) throw new Error(`So far: ${JSON.stringify(m)}, not “${note}”`);
          soFar = m.value;
        });
        const wall = Math.round((Date.now() - a.startedAt) / M);
        if (!(soFar >= 1 && soFar <= wall - pausedMin + 1))
          throw new Error(`So far ${soFar}m, the wall ${wall}m less ${pausedMin}m paused`);
        // Reload: the same note and minutes; the list row too.
        await ctx.page.reload();
        const back = await metric(ctx, 'So far');
        if (back.note !== note || Math.abs(back.value - soFar) > 1)
          throw new Error(`after reload: ${JSON.stringify(back)}`);
        await ctx.ui.goto('/recruiting');
        const row = ctx.page.getByRole('region', { name: 'All sittings' }).getByRole('link', {
          name: new RegExp(titleOf(ctx, 'a').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        });
        await row.waitFor({ timeout: 15_000 });
        const text = (await row.textContent()) ?? '';
        if (![soFar, soFar + 1].some((n) => text.includes(`${n}m`)))
          throw new Error(`list row: ${text} (So far ${soFar}m)`);
        // Done starts on the paused-out minutes; Cancel leaves it open.
        await ctx.ui.goto(`/recruiting/sittings/${a.id}`);
        const end = ctx.page.getByRole('button', { name: 'End sitting' });
        const actual = ctx.page.getByLabel('Actual (min)');
        await end.click();
        const first = Number(await actual.inputValue());
        const now = (await metric(ctx, 'So far')).value;
        if (first !== now) throw new Error(`Done starts on ${first}, So far reads ${now}`);
        await ctx.shot('done-form');
        await ctx.page.getByRole('button', { name: 'Cancel' }).click();
        if ((await head(ctx, a, 'pause')).status !== 'active')
          throw new Error('Cancel ended the sitting');
        await end.click();
        state.aMinutes = Number(await actual.inputValue());
        await ctx.page.getByRole('button', { name: 'Mark done' }).click();
        // Done ends the sitting through the rep's hook, a beat after the page closes the form (as lc-sittings waits).
        for (let i = 0; (await head(ctx, a, 'pause')).status !== 'done'; i++) {
          if (i >= 40) throw new Error('Mark done never ended the sitting');
          await new Promise((r) => setTimeout(r, 250));
        }
        await end.waitFor({ state: 'hidden', timeout: 15_000 });
        await ctx.page.getByText(note).waitFor({ timeout: 5_000 }); // ended: Took, still the paused line
        await ctx.shot('done');
      },
    },
    {
      id: 'reads-mcp',
      entry: 'mcp',
      cost: 'slow',
      proves: ['mcp-reads', 'coach-minutes'],
      title:
        'get_sitting, list_sittings and get_problem give the same minutes and paused minutes, writing nothing',
      async run(ctx) {
        if (!state.aMinutes) throw new Error('not done — the done-ui step failed');
        const a = state.a!;
        const pausedMin = Math.round((state.aResumeAt - state.aPauseAt) / M);
        const before = await head(ctx, a, 'pause');
        const one = (await ctx.mcp.reads.getSitting({ id: a.id })).sitting;
        if (one?.minutes !== state.aMinutes || one?.pausedMin !== pausedMin)
          throw new Error(
            `get_sitting: ${JSON.stringify(one)} (Done ${state.aMinutes}, ${pausedMin} paused)`,
          );
        const row = (await ctx.mcp.reads.listSittings({ limit: 10 })).sittings.find(
          (x) => x.id === a.id,
        );
        if (row?.minutes !== state.aMinutes || row?.pausedMin !== pausedMin)
          throw new Error(`list_sittings: ${JSON.stringify(row)}`);
        const p = await ctx.mcp.reads.getProblem({ slug: slugOf(ctx, 'a') });
        const tryMin = p.tries?.find((t) => t.sittingIds.includes(a.id))?.minutes;
        if (tryMin !== state.aMinutes) throw new Error(`get_problem try minutes: ${tryMin}`);
        if (!eq(await head(ctx, a, 'pause'), before)) throw new Error('an MCP read wrote');
      },
    },
    {
      id: 'end',
      entry: 'api',
      title: 'Drop whatever is left open and unlink the roll, for the scenarios after',
      async run(ctx) {
        for (const s of [state.b, state.c, state.a]) if (s) await drop(ctx, s).catch(() => {});
        await ctx.api.writes.linkLeetcodeRoll(null);
      },
    },
  ],
};
