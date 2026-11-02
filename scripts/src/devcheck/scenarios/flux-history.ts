// Flux history on dev (docs/areas/flux D47–D51): save one set through the guarded API, then prove the History
// tab and the night home's Flux line show it. The headless browser has no camera, so the set is recorded
// the way the stage would send it, not finished on screen. Cleanup deletes it by its ledger id (api.ts
// records it before the call) — never through the UI, which can't tell this set from another.
import { randomInt } from 'node:crypto';
import { laDay, type Scenario } from '../scenario';

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
      id: 'night-line',
      entry: 'ui',
      kind: 'nominal',
      what: 'The night home says "Flux · … chin tuck"',
    },
    {
      id: 'on-screen',
      entry: 'ui',
      kind: 'nominal',
      what: 'Finishing a set on screen saves it',
      needsYou:
        'the harness has no recorded pose clip to feed Chromium’s fake camera — the set is recorded the way the stage would send it',
    },
  ],
  steps: [
    {
      id: 'record',
      entry: 'api',
      proves: ['record'],
      title: 'recordFluxSet as the test user — a finished set and one stopped early — read back',
      async run(ctx) {
        // The app's day, not the calendar's: before the user's day start (4am) a set belongs to yesterday,
        // and History and the night line both read the app's today.
        const { dayStartHour } = await ctx.api.reads.getSettings();
        const day = laDay(new Date(Date.now() - dayStartHour * 3_600_000));
        const record = async (count: number, stoppedEarly: boolean, completedAt: number) => {
          const id = devUlid(completedAt);
          await ctx.api.writes.recordFluxSet({
            id,
            day,
            exerciseId: 'chin-tuck',
            kind: 'holdAtTarget',
            side: null,
            condition: null,
            count,
            avgPeakDeg: null,
            avgErrorDeg: null,
            rom: { pitch: 9, yaw: 2, roll: 2 },
            calibrated: true,
            delegate: 'CPU',
            durationSec: 150,
            completedAt,
            repTaskId: null,
            stoppedEarly,
            planned: 6,
          });
          if (!(await ctx.api.reads.getFluxSet(id))) throw new Error(`the server has no set ${id}`);
        };
        const now = Date.now();
        await record(6, false, now - 1000);
        await record(2, true, now); // stopped after two holds (D55)
      },
    },
    {
      id: 'history',
      entry: 'ui',
      proves: ['history'],
      title: 'History lists both under Today, the stopped one marked',
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
        await ctx.shot('history');
      },
    },
    {
      id: 'night-line',
      entry: 'ui',
      proves: ['night-line'],
      title: 'Night home says "Flux · … chin tuck"',
      async run(ctx) {
        await ctx.ui.goto('/');
        await ctx.page.getByRole('button', { name: 'Night', exact: true }).click();
        await ctx.ui.expectText(/^Flux · .*chin tuck/, 15_000);
        await ctx.shot('night');
      },
    },
  ],
};
