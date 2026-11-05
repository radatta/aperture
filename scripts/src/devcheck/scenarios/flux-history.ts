// Flux history on dev (docs/areas/flux D47–D51): save one set through the guarded API, then prove the History
// tab and the night home's Flux line show it. The headless browser has no camera, so the set is recorded
// the way the stage would send it, not finished on screen. Cleanup deletes it by its ledger id (api.ts
// records it before the call). The one UI delete (chip-order) takes a ledgered set, found by its own text,
// so the sweep's delete of it is a no-op. The Library
// tab's unlinked-Roll note rides along: the one Flux line dev can prove without a camera.
import { randomInt } from 'node:crypto';
import { DEV_ORIGIN, assertDevOrigin } from '../config';
import { laDay, noConsoleErrors, type Ctx, type Scenario } from '../scenario';

// A ULID like the app mints (the server refuses anything else): 10 time chars, 16 random, Crockford base32.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function devUlid(now = Date.now()): string {
  let time = '';
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time;
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[randomInt(32)];
  return time + rand;
}

const EXERCISE = 'Chin Tuck (Cervical Retraction)';
// The stage hides the capture bar, which ui.goto waits for; here the stepper is the page being up.
const openStage = async (ctx: Ctx, id: string) => {
  const url = `${DEV_ORIGIN}/flux/${id}`;
  assertDevOrigin(url);
  await ctx.page.goto(url, { waitUntil: 'domcontentloaded' });
};
const stepperOf = (ctx: Ctx) => ctx.page.getByRole('group', { name: 'Sets this session' });
const expectSets = (ctx: Ctx, n: number) =>
  stepperOf(ctx).getByText(`${n} sets`, { exact: true }).waitFor({ timeout: 15_000 });

export const fluxHistory: Scenario = {
  id: 'flux-history',
  title: 'A saved Flux set shows in History and on the night home',
  tiers: ['full'],
  rows: [
    {
      id: 'record',
      entry: 'api',
      kind: 'nominal',
      what: 'recordFluxSet stores a finished set and one stopped early, and reads them back',
    },
    {
      id: 'history',
      entry: 'ui',
      kind: 'nominal',
      what: 'History lists both, the stopped one marked',
    },
    {
      id: 'sparkline',
      entry: 'ui',
      kind: 'nominal',
      what: 'The rotation chip’s trend draws its sparkline across the whole tile, not a 240 px drawing centred in it',
    },
    {
      id: 'night-line',
      entry: 'ui',
      kind: 'nominal',
      what: 'The night home says "Flux · … chin tuck"',
    },
    {
      id: 'library-note',
      entry: 'ui',
      kind: 'nominal',
      what: 'The Library’s note reads "link one in Settings." — the full stop flush against the link',
    },
    {
      id: 'on-screen',
      entry: 'ui',
      kind: 'nominal',
      what: 'Finishing a set on screen saves it',
      needsYou:
        'the harness has no recorded pose clip to feed Chromium’s fake camera; the set is recorded the way the stage would send it',
    },
    {
      id: 'rest-line',
      entry: 'ui',
      kind: 'nominal',
      what: 'After "Set complete" the HUD and the panel count the rest down: "Rest · 23 s · Set two next", gone when set two starts',
      needsYou:
        'a finished set needs a camera (the fake engine is stub-only); off dev: useFluxEngine.test "the rest countdown: on screen at 1 Hz, frozen by a pause, back to 30 s with the re-armed rest" and ExercisePanel.test "between sets, the done block counts the rest down: "Rest · 23 s · Set two next""',
    },
    {
      id: 'idle-after-session',
      entry: 'ui',
      kind: 'edge',
      what: 'The last set ends the session: the panel reads "Start the camera to begin." every time, never "Set complete · Again"',
      needsYou:
        'a session run to its end needs a camera; off dev: useFluxEngine.test "no state post after a self-ended session reaches the panel, until the next Start"',
    },
    {
      id: 'week-note',
      entry: 'api',
      kind: 'nominal',
      what: 'After the scenario’s sets, getFluxWeekNote is a line of at most 140 characters naming chin tuck; a second call keeps generatedAt',
    },
    {
      id: 'night-note',
      entry: 'ui',
      kind: 'nominal',
      what: 'The night home shows the week’s note under "Flux · …", in the same link',
    },
    {
      id: 'history-note',
      entry: 'ui',
      kind: 'nominal',
      what: 'History shows the week’s note above the exercise chips',
    },
    {
      id: 'note-under-two',
      entry: 'api',
      kind: 'edge',
      what: 'One set this week → no note (null); last week’s sets count only as last week',
      offDev: {
        file: 'lambdas/src/backend.fluxNote.test.ts',
        test: 'is null under two sets this week, and last week’s sets only count as last week',
        why: 'dev’s test user keeps the scenario’s sets only during a run; the week’s count can’t be held at one without deleting what another step needs, and the test drives the real backend over the real week maths',
      },
    },
    {
      id: 'note-fallback',
      entry: 'api',
      kind: 'edge',
      what: 'A model failure, a bad answer or an invented number keeps the deterministic line',
      offDev: {
        file: 'lambdas/src/backend.fluxNote.test.ts',
        test: 'keeps the deterministic line on a model failure, a bad answer, or an invented number — and stores that too',
        why: 'dev can’t drop the API key or make Haiku misbehave on demand; the test runs the real backend over the Fake gateway',
      },
    },
    {
      id: 'note-earns-its-line',
      entry: 'ios',
      kind: 'nominal',
      what: 'A real week’s note on the phone: does it earn its line, or read as a score? Cut it if so',
      needsYou: 'a week of your own sets and your read of the line — a product call, not a check',
    },
    {
      id: 'sets-remembered',
      entry: 'ui',
      kind: 'nominal',
      what: 'Start with 3 sets → leave → reopen the exercise: the stepper reads 3; another exercise still opens at 2',
    },
    {
      id: 'sets-refused',
      entry: 'api',
      kind: 'edge',
      what: 'updateSettings({ fluxSets: { "chin-tuck": 9 } }) is refused, and so is an unknown exercise',
    },
    {
      id: 'chip-order',
      entry: 'ui',
      kind: 'edge',
      what: 'Deleting an exercise’s newest set leaves the History chips in the same order',
    },
    {
      id: 'chin-tuck-neutral',
      entry: 'ui',
      kind: 'edge',
      what: 'Chin tuck: a tuck held still in the rest never flashes "Neutral reset"; rotation’s rest still does',
      offDev: {
        file: 'app/src/modules/flux/engine/core.test.ts',
        test: "chin tuck's rest never re-sets the neutral; upper trap's still does (D60)",
        why: 'needs a camera, and the decision is engine math — the test runs the real core on both exercises',
      },
    },
  ],
  steps: [
    {
      id: 'record',
      entry: 'api',
      proves: ['record'],
      title:
        'recordFluxSet as the test user — a finished chin tuck, one stopped early, three rotation sets over five days — read back',
      async run(ctx) {
        // The app's day, not the calendar's: before the user's day start (4am) a set belongs to yesterday,
        // and History and the night line both read the app's today.
        const { dayStartHour } = await ctx.api.reads.getSettings();
        const dayOf = (at: number) => laDay(new Date(at - dayStartHour * 3_600_000));
        const record = async (set: {
          exerciseId: 'chin-tuck' | 'cervical-rotation';
          count: number;
          avgPeakDeg: number | null;
          stoppedEarly: boolean;
          completedAt: number;
        }) => {
          const id = devUlid(set.completedAt);
          const rotation = set.exerciseId === 'cervical-rotation';
          await ctx.api.writes.recordFluxSet({
            id,
            day: dayOf(set.completedAt),
            exerciseId: set.exerciseId,
            kind: rotation ? 'romReps' : 'holdAtTarget',
            side: null,
            condition: null,
            count: set.count,
            avgPeakDeg: set.avgPeakDeg,
            avgErrorDeg: null,
            rom: rotation ? { pitch: 4, yaw: 100, roll: 5 } : { pitch: 9, yaw: 2, roll: 2 },
            calibrated: true,
            delegate: 'CPU',
            durationSec: 150,
            completedAt: set.completedAt,
            repTaskId: null,
            stoppedEarly: set.stoppedEarly,
            planned: rotation ? 10 : 6,
          });
          if (!(await ctx.api.reads.getFluxSet(id))) throw new Error(`the server has no set ${id}`);
        };
        const now = Date.now();
        const DAY = 86_400_000;
        const tuck = { exerciseId: 'chin-tuck', avgPeakDeg: null } as const;
        // Newest first: stopped tuck, rotation, finished tuck — so deleting the stopped one makes rotation
        // the newest exercise, the delete that reordered the chips when they sorted by recency.
        await record({ ...tuck, count: 6, stoppedEarly: false, completedAt: now - 1000 });
        await record({ ...tuck, count: 2, stoppedEarly: true, completedAt: now }); // stopped after two holds (D55)
        // Three rotation sets with an angle: the trend (and its sparkline) shows from three sets up (D50).
        const turn = { exerciseId: 'cervical-rotation', count: 10, stoppedEarly: false } as const;
        await record({ ...turn, avgPeakDeg: 44, completedAt: now - 4 * DAY });
        await record({ ...turn, avgPeakDeg: 48, completedAt: now - 2 * DAY });
        await record({ ...turn, avgPeakDeg: 53, completedAt: now - 500 });
      },
    },
    {
      id: 'week-note',
      entry: 'api',
      proves: ['week-note'],
      title:
        'getFluxWeekNote: at most 140 characters, names chin tuck, stable across a second call',
      async run(ctx) {
        const note = await ctx.api.reads.getFluxWeekNote();
        if (!note)
          throw new Error('no note after the scenario’s sets (expected at least two this week)');
        if (note.text.length > 140)
          throw new Error(`note is ${note.text.length} chars: ${note.text}`);
        if (!/chin tuck/i.test(note.text)) throw new Error(`note names no chin tuck: ${note.text}`);
        const again = await ctx.api.reads.getFluxWeekNote();
        if (again?.generatedAt !== note.generatedAt || again.text !== note.text)
          throw new Error('a second read rebuilt the note');
        ctx.log(`note: ${note.text}`);
      },
    },
    {
      id: 'history',
      entry: 'ui',
      proves: ['history', 'sparkline', 'history-note', 'chip-order'],
      title:
        'History lists both, the stopped one marked; deleting it holds the chips’ order; the rotation trend’s sparkline spans its tile',
      async run(ctx) {
        await ctx.ui.goto('/flux/history');
        // A test user who never opened Flux sees the disclaimer gate first — accepting it is a Settings write
        // the app makes (the user's own one-tap gate), logged here.
        // Settings may still be loading when the shell is up, so wait for one of the two to render first.
        const gate = ctx.page.getByRole('button', { name: /I understand/ });
        const tabs = ctx.page.getByRole('navigation', { name: 'Flux sections' });
        await gate.or(tabs).first().waitFor({ timeout: 15_000 });
        if (await gate.isVisible()) {
          ctx.log('accepting the Flux disclaimer for the test user');
          await gate.click();
        }
        await ctx.ui.expectText('Today', 15_000);
        await ctx.ui.expectText(EXERCISE, 15_000);
        await ctx.ui.expectText(/· 6 holds ·/, 15_000); // the finished one ("2 of 6 holds" doesn't match)
        await ctx.ui.expectText(/2 of 6 holds · stopped early/, 15_000);
        // The week's note sits above the chips — the same text the API handed back.
        const note = await ctx.api.reads.getFluxWeekNote();
        if (!note) throw new Error('no week note for History to show');
        const chips = ctx.page.getByRole('group', { name: 'Exercise' });
        const line = ctx.page.getByText(note.text, { exact: true });
        await line.waitFor({ state: 'visible', timeout: 15_000 });
        const lineBox = await line.boundingBox();
        const chipsBox = await chips.boundingBox();
        if (!lineBox || !chipsBox || lineBox.y >= chipsBox.y)
          throw new Error('the week note is not above the exercise chips');
        await ctx.shot('history');
        // The stopped tuck is this run's own newest set: delete it from the screen, the chips hold still.
        const before = await chips.textContent();
        const stopped = ctx.page.getByText(/2 of 6 holds · stopped early/);
        await stopped
          .locator('xpath=ancestor::*[.//button[starts-with(@aria-label, "Delete ")]][1]')
          .getByRole('button', { name: /^Delete / })
          .click();
        await ctx.page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
        await stopped.waitFor({ state: 'hidden', timeout: 15_000 });
        const after = await chips.textContent();
        if (!before?.includes('rotation') || before !== after)
          throw new Error(`the chips moved: ${before} → ${after}`);
        await ctx.shot('history-after-delete');
        // The rotation chip filters to its three sets and shows the trend tile; the sparkline measures its
        // own width (viewBox = rendered width), so the line reaches the tile's edges instead of sitting in a
        // 240 px drawing centred in it.
        await ctx.page.getByRole('button', { name: 'rotation', exact: true }).click();
        const spark = ctx.page.getByRole('img', { name: /rotation · avg peak, 3 sets/ });
        await spark.waitFor({ state: 'visible', timeout: 15_000 });
        const viewBoxW = Number((await spark.getAttribute('viewBox'))?.split(' ')[2]);
        const width = (await spark.boundingBox())?.width ?? 0;
        if (!(width > 0) || Math.abs(viewBoxW - width) > 1)
          throw new Error(`the sparkline draws ${viewBoxW} px in a ${width.toFixed(1)} px tile`);
        await ctx.shot('history-trend');
      },
    },
    {
      id: 'sets-remembered',
      entry: 'ui',
      proves: ['sets-remembered'],
      title: 'Chin tuck: + to 3 sets, Start; another exercise opens at 2, chin tuck reopens at 3',
      async run(ctx) {
        // Runs after `history`, which passed the disclaimer. The map is the test user's own: start from an
        // empty one (so a run killed mid-step can't leave this one a wrong opening count), put it back after.
        const prior = (await ctx.api.reads.getSettings()).fluxSets;
        await ctx.api.writes.updateSettings({ fluxSets: {} });
        try {
          await openStage(ctx, 'chin-tuck');
          await expectSets(ctx, 2);
          await ctx.page.getByRole('button', { name: 'More sets' }).click();
          await expectSets(ctx, 3);
          await ctx.page.getByRole('button', { name: 'Start camera' }).click();
          const deadline = Date.now() + 15_000;
          let held: number | undefined;
          while (held !== 3 && Date.now() < deadline) {
            held = (await ctx.api.reads.getSettings()).fluxSets['chin-tuck'];
            if (held !== 3) await new Promise((r) => setTimeout(r, 500));
          }
          if (held !== 3) throw new Error(`the server holds ${held} sets for chin tuck, not 3`);
          await openStage(ctx, 'cervical-rotation');
          await expectSets(ctx, 2);
          await openStage(ctx, 'chin-tuck');
          await expectSets(ctx, 3);
          await ctx.shot('sets-remembered');
        } finally {
          await ctx.api.writes.updateSettings({ fluxSets: prior });
        }
      },
    },
    {
      id: 'sets-refused',
      entry: 'api',
      proves: ['sets-refused'],
      title: 'A count of 9 and an unknown exercise are refused, and the map stays as it was',
      async run(ctx) {
        const before = JSON.stringify((await ctx.api.reads.getSettings()).fluxSets);
        const refusal = (fluxSets: Record<string, number>) =>
          ctx.api.writes.updateSettings({ fluxSets }).then(
            () => null,
            (e: unknown) => (e instanceof Error ? e.message : String(e)),
          );
        const count = await refusal({ 'chin-tuck': 9 });
        if (!count || !/whole number from 1 to 5/.test(count))
          throw new Error(`a count of 9 was not refused: ${count}`);
        const unknown = await refusal({ 'not-an-exercise': 2 });
        if (!unknown || !/Unknown Flux exercise/.test(unknown))
          throw new Error(`an unknown exercise was not refused: ${unknown}`);
        const after = JSON.stringify((await ctx.api.reads.getSettings()).fluxSets);
        if (after !== before) throw new Error(`the map changed: ${before} → ${after}`);
      },
    },
    {
      id: 'library-note',
      entry: 'ui',
      proves: ['library-note'],
      title: 'Library: "link one in Settings." with no gap before the full stop',
      async run(ctx) {
        await ctx.ui.goto('/flux');
        // The note shows only while no active Roll is linked — the test user's state, unless someone linked
        // one; a missing note says so, loudly.
        const link = ctx.page.getByRole('link', { name: 'link one in Settings', exact: true });
        await link.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {
          throw new Error(
            'the Library shows no "link one in Settings" note — an active Roll linked under Settings → Flux hides it',
          );
        });
        // The sentence as one paragraph, the full stop right after the link (getByText matches the <p>,
        // whose text ends with the stop; the link's own text doesn't). The gap PR 65 saw was the link's
        // padding, not a space — the link is plain inline text now, and the shot is the proof.
        const note = ctx.page.getByText(/daily rep — link one in Settings\.$/);
        if (!(await note.isVisible()))
          throw new Error('the note does not end in "link one in Settings."');
        await ctx.shot('library-note');
      },
    },
    {
      id: 'night-line',
      entry: 'ui',
      proves: ['night-line', 'night-note'],
      title: 'Night home says "Flux · … chin tuck", with the week’s note under it in the same link',
      async run(ctx) {
        await ctx.ui.goto('/');
        await ctx.page.getByRole('button', { name: 'Night', exact: true }).click();
        await ctx.ui.expectText(/^Flux · .*chin tuck/, 15_000);
        const note = await ctx.api.reads.getFluxWeekNote();
        if (!note) throw new Error('no week note for the night home to show');
        const link = ctx.page.getByRole('link', { name: /^Flux · .*chin tuck/ });
        await link
          .getByText(note.text, { exact: true })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await ctx.shot('night');
      },
    },
    noConsoleErrors,
  ],
};
