// Flux history on dev (docs/areas/flux D47–D51): save one set through the guarded API, then prove the History
// tab and the night home's Flux line show it. The headless browser has no camera, so the set is recorded
// the way the stage would send it, not finished on screen. Cleanup deletes it by its ledger id (api.ts
// records it before the call) — never through the UI, which can't tell this set from another.
import { randomInt } from 'node:crypto';
import type { Scenario } from '../scenario';

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
  steps: [
    {
      id: 'record',
      title: 'recordFluxSet as the test user, read back',
      async run(ctx) {
        const setId = devUlid();
        await ctx.api.writes.recordFluxSet({
          id: setId,
          day: ctx.dates.today,
          exerciseId: 'chin-tuck',
          kind: 'holdAtTarget',
          side: null,
          condition: null,
          count: 10,
          avgPeakDeg: null,
          avgErrorDeg: null,
          rom: { pitch: 9, yaw: 2, roll: 2 },
          calibrated: true,
          delegate: 'CPU',
          durationSec: 150,
          completedAt: Date.now(),
          repTaskId: null,
        });
        if (!(await ctx.api.reads.getFluxSet(setId))) throw new Error('the server has no such set');
      },
    },
    {
      id: 'history',
      title: 'History lists it under Today',
      async run(ctx) {
        await ctx.ui.goto('/flux/history');
        // A test user who never opened Flux sees the disclaimer gate first — accepting it is a Settings write
        // the app makes (the user's own one-tap gate), logged here.
        const gate = ctx.page.getByRole('button', { name: /I understand/ });
        if (await gate.isVisible()) {
          ctx.log('accepting the Flux disclaimer for the test user');
          await gate.click();
        }
        await ctx.ui.expectText('Today', 15_000);
        await ctx.ui.expectText(EXERCISE, 15_000);
        await ctx.shot('history');
      },
    },
    {
      id: 'night-line',
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
