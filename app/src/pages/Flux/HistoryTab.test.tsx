import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { addDays, todayKey, ulid, type RecordFluxSetInput } from '@aperture/shared';
import { renderApp } from '../../test/utils';
import { createStubClient, STUB_FAIL_FLUX_SAVE_KEY } from '../../data/stubClient';
import { FLUX_OUTBOX_KEY } from '../../modules/flux/fluxOutbox';

// /flux/history over the stub (D50, D53): rows by day, the per-kind number, Right/Left, the trend, delete.

const today = todayKey(4);
const set = (over: Partial<RecordFluxSetInput> = {}): RecordFluxSetInput => ({
  id: ulid(),
  day: today,
  exerciseId: 'cervical-rotation',
  kind: 'romReps',
  side: null,
  condition: null,
  count: 20,
  avgPeakDeg: 50,
  avgErrorDeg: null,
  rom: { pitch: 4, yaw: 100, roll: 5 },
  calibrated: true,
  delegate: 'GPU',
  durationSec: 250,
  completedAt: Date.now(),
  repTaskId: null,
  ...over,
});

async function history(sets: RecordFluxSetInput[], opts: { ack?: boolean } = {}) {
  const api = createStubClient({ seed: false, storageKey: `flux-history-${Math.random()}` });
  if (opts.ack !== false) await api.updateSettings({ fluxDisclaimerAckAt: 1 });
  for (const s of sets) await api.recordFluxSet(s);
  const user = userEvent.setup();
  renderApp({ api, path: '/flux/history' });
  return { api, user };
}

describe('Flux History tab', () => {
  it('lists sets by day with each kind’s number and Right/Left sides', async () => {
    const t = Date.now();
    await history([
      set({ completedAt: t - 1000 }),
      set({
        exerciseId: 'upper-trap-stretch',
        kind: 'holdAtTarget',
        side: 'a',
        count: 2,
        avgPeakDeg: null,
        completedAt: t - 900,
      }),
      set({
        exerciseId: 'scalene-stretch',
        kind: 'holdAtTarget',
        side: 'a',
        count: 2,
        avgPeakDeg: null,
        completedAt: t - 800,
      }),
      set({
        exerciseId: 'joint-position-sense',
        kind: 'reposition',
        count: 5,
        avgPeakDeg: null,
        avgErrorDeg: 3.14,
        completedAt: t - 700,
      }),
      set({ day: addDays(today, -1), completedAt: t - 86_400_000, avgPeakDeg: 47 }),
    ]);
    expect(await screen.findByRole('heading', { name: 'Today' })).toBeTruthy();
    expect(screen.getAllByText(/20 reps · avg 50°/)).toHaveLength(1);
    expect(screen.getByText(/20 reps · avg 47°/)).toBeTruthy(); // yesterday's row
    expect(screen.getByText(/5 trials · 3\.1° error/)).toBeTruthy();
    // Side A goes right on upper trap, but scalene's Side A tilts left (D48).
    const trap = screen.getByText('Upper Trapezius Stretch').closest('li')!;
    expect(within(trap).getByText('Right')).toBeTruthy();
    const scalene = screen.getByText('Scalene Stretch').closest('li')!;
    expect(within(scalene).getByText('Left')).toBeTruthy();
  });

  it('an exercise chip filters the list and shows its trend from three sets up', async () => {
    const t = Date.now();
    const { user } = await history([
      set({ day: addDays(today, -4), completedAt: t - 4e8, avgPeakDeg: 44 }),
      set({ day: addDays(today, -2), completedAt: t - 2e8, avgPeakDeg: 48 }),
      set({ completedAt: t - 1000, avgPeakDeg: 53 }),
      set({
        exerciseId: 'chin-tuck',
        kind: 'holdAtTarget',
        count: 10,
        avgPeakDeg: null,
        completedAt: t - 500,
      }),
    ]);
    await user.click(await screen.findByRole('button', { name: 'rotation' }));
    expect(screen.queryByText('Chin Tuck (Cervical Retraction)')).toBeNull();
    // The stat tile: the latest number and the change since the first set shown.
    expect(screen.getByText('53°').parentElement?.textContent).toMatch(/53°\+9° since/);
    expect(screen.getByRole('img', { name: /rotation · avg peak, 3 sets/ })).toBeTruthy();
    expect(screen.getByText(/each session’s own neutral/)).toBeTruthy();
    // Chin tuck has one set: no trend.
    await user.click(screen.getByRole('button', { name: 'chin tuck' }));
    expect(screen.queryByRole('img')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText('Chin Tuck (Cervical Retraction)')).toBeTruthy();
  });

  it('delete asks first, then removes the set (a soft-delete) and leaves the rest', async () => {
    const t = Date.now();
    const keep = set({ completedAt: t - 1000 });
    const gone = set({
      exerciseId: 'chin-tuck',
      kind: 'holdAtTarget',
      count: 10,
      avgPeakDeg: null,
      completedAt: t - 500,
    });
    const { api, user } = await history([keep, gone]);
    await user.click(
      await screen.findByRole('button', { name: 'Delete Chin Tuck (Cervical Retraction) set' }),
    );
    const confirm = screen.getByRole('alertdialog', { name: /Delete this Chin Tuck/ });
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Chin Tuck (Cervical Retraction)')).toBeTruthy();
    await user.click(
      screen.getByRole('button', { name: 'Delete Chin Tuck (Cervical Retraction) set' }),
    );
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    await waitFor(() => expect(screen.queryByText('Chin Tuck (Cervical Retraction)')).toBeNull());
    expect((await api.listFluxSets()).map((s) => s.id)).toEqual([keep.id]);
    expect((await api.exportData()).fluxSets.map((s) => s.id)).toEqual([keep.id]);
  });

  it('shows sets still waiting in the outbox', async () => {
    localStorage.setItem(STUB_FAIL_FLUX_SAVE_KEY, '1');
    localStorage.setItem(FLUX_OUTBOX_KEY, JSON.stringify([{ input: set(), at: 1, error: null }]));
    await history([]);
    expect(await screen.findByText('1 set not saved yet')).toBeTruthy();
    localStorage.removeItem(STUB_FAIL_FLUX_SAVE_KEY);
  });

  it('shows the last 90 days, and Show all reaches further back', async () => {
    const { user } = await history([
      set({
        day: addDays(today, -120),
        completedAt: Date.now() - 120 * 86_400_000,
        avgPeakDeg: 41,
      }),
    ]);
    expect(await screen.findByText('No sets in the last 90 days.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show all' }));
    expect(await screen.findByText(/20 reps · avg 41°/)).toBeTruthy();
  });

  it('an empty history points back to the library', async () => {
    await history([]);
    expect(await screen.findByText('No sets in the last 90 days.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Pick an exercise' }).getAttribute('href')).toBe(
      '/flux',
    );
  });

  it('is behind the disclaimer gate like the rest of Flux', async () => {
    await history([set()], { ack: false });
    expect(await screen.findByRole('button', { name: /I understand/ })).toBeTruthy();
    expect(screen.queryByText(/20 reps/)).toBeNull();
  });

  it('the tabs move between Library and History', async () => {
    const { user } = await history([]);
    const nav = await screen.findByRole('navigation', { name: 'Flux sections' });
    expect(within(nav).getByRole('link', { name: 'History' }).getAttribute('aria-current')).toBe(
      'page',
    );
    await user.click(within(nav).getByRole('link', { name: 'Library' }));
    expect(await screen.findByText('Chin Tuck (Cervical Retraction)')).toBeTruthy();
  });
});
