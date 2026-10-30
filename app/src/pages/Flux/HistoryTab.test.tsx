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
  stoppedEarly: false,
  planned: 10,
  ...over,
});

async function history(sets: RecordFluxSetInput[], opts: { ack?: boolean; path?: string } = {}) {
  const api = createStubClient({ seed: false, storageKey: `flux-history-${Math.random()}` });
  if (opts.ack !== false) await api.updateSettings({ fluxDisclaimerAckAt: 1 });
  for (const s of sets) await api.recordFluxSet(s);
  const user = userEvent.setup();
  renderApp({ api, path: opts.path ?? '/flux/history' });
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
    // Delete names carry the day and time, so a list of buttons tells same-exercise rows apart.
    const names = screen
      .getAllByRole('button', { name: /^Delete Neck Rotation set from / })
      .map((b) => b.getAttribute('aria-label'));
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/from [A-Z][a-z]{2} \d{1,2}, \d/);
    expect(new Set(names).size).toBe(2);
    expect(
      screen.getByRole('button', { name: /^Delete Upper Trapezius Stretch \(Right\) set from / }),
    ).toBeTruthy();
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
      await screen.findByRole('button', {
        name: /^Delete Chin Tuck \(Cervical Retraction\) set from /,
      }),
    );
    const confirm = screen.getByRole('alertdialog', { name: /Delete this Chin Tuck/ });
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Chin Tuck (Cervical Retraction)')).toBeTruthy();
    await user.click(
      screen.getByRole('button', { name: /^Delete Chin Tuck \(Cervical Retraction\) set from / }),
    );
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    await waitFor(() => expect(screen.queryByText('Chin Tuck (Cervical Retraction)')).toBeNull());
    expect((await api.listFluxSets()).map((s) => s.id)).toEqual([keep.id]);
    expect((await api.exportData()).fluxSets.map((s) => s.id)).toEqual([keep.id]);
  });

  it('Cancel and Escape on the delete confirm hand focus back to the row’s Delete', async () => {
    const { user } = await history([set()]);
    const trigger = () => screen.getByRole('button', { name: /^Delete Neck Rotation set from / });
    await user.click(
      await screen.findByRole('button', { name: /^Delete Neck Rotation set from / }),
    );
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }),
    );
    expect(document.activeElement).toBe(trigger());
    await user.click(trigger());
    expect(document.activeElement?.textContent).toBe('Delete'); // the confirm's own Delete
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('a deleted row hands focus to the next row’s Delete, and its chip’s filter goes with it', async () => {
    const t = Date.now();
    const a = set({ completedAt: t - 3000 });
    const b = set({ completedAt: t - 2000 });
    const tuck = set({
      exerciseId: 'chin-tuck',
      kind: 'holdAtTarget',
      count: 10,
      avgPeakDeg: null,
      completedAt: t - 1000,
    });
    const { api, user } = await history([a, b, tuck]);
    const deletes = await screen.findAllByRole('button', { name: /^Delete .* set from / });
    expect(deletes).toHaveLength(3);
    await user.click(deletes[1]!); // the newer rotation row
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /^Delete .* set from / })).toHaveLength(2),
    );
    expect(document.activeElement).toBe(deletes[2]); // the next row's, still the same node
    // Filter to chin tuck, delete its only set: the chip goes, and the list is back to everything.
    await user.click(screen.getByRole('button', { name: 'chin tuck' }));
    await user.click(screen.getByRole('button', { name: /^Delete Chin Tuck/ }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'chin tuck' })).toBeNull());
    expect(screen.getAllByText(/20 reps · avg 50°/)).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'All' })); // still in view
    // A chin tuck set arriving later (another device; here, the next fetch) doesn't switch the old
    // filter back on.
    await api.recordFluxSet({ ...tuck, id: ulid(), completedAt: t - 500 });
    await user.click(screen.getByRole('button', { name: 'Show all' }));
    expect(await screen.findByRole('button', { name: 'chin tuck' })).toHaveProperty(
      'ariaPressed',
      'false',
    );
    expect(screen.getAllByText(/20 reps · avg 50°/)).toHaveLength(1);
  });

  it('a slow delete still repairs focus the page’s rescue parked on the heading', async () => {
    const t = Date.now();
    const { api, user } = await history([
      set({ completedAt: t - 2000 }),
      set({ completedAt: t - 1000 }),
    ]);
    let release: () => void = () => undefined;
    const del = api.deleteFluxSet.bind(api);
    api.deleteFluxSet = async (id) => {
      await new Promise<void>((r) => (release = r));
      return del(id);
    };
    const [first, second] = await screen.findAllByRole('button', { name: /^Delete .* set from / });
    await user.click(first!);
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    screen.getByRole('heading', { name: 'Flux' }).focus(); // the rescue, while the delete is out
    release();
    await waitFor(() => expect(document.activeElement).toBe(second));
  });

  it('a deleted row skips a neighbour whose own confirm is open', async () => {
    const t = Date.now();
    await history([
      set({ completedAt: t - 3000 }),
      set({ completedAt: t - 2000 }),
      set({ completedAt: t - 1000 }),
    ]);
    const user = userEvent.setup();
    const [first, second, third] = await screen.findAllByRole('button', {
      name: /^Delete .* set from /,
    });
    await user.click(second!); // its confirm stays open
    await user.click(first!);
    const confirms = screen.getAllByRole('alertdialog');
    await user.click(within(confirms[0]!).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getAllByRole('alertdialog')).toHaveLength(1));
    expect(document.activeElement).toBe(third); // not the open confirm's Delete
  });

  it('Show all never claims there are no sets while the wider window loads', async () => {
    const api = createStubClient({ seed: false, storageKey: `flux-history-${Math.random()}` });
    await api.updateSettings({ fluxDisclaimerAckAt: 1 });
    await api.recordFluxSet(
      set({ day: addDays(today, -120), completedAt: Date.now() - 120 * 86_400_000 }),
    );
    let release: () => void = () => undefined;
    const list = api.listFluxSets.bind(api);
    api.listFluxSets = async (filter) => {
      if (!filter?.from) await new Promise<void>((r) => (release = r));
      return list(filter);
    };
    const user = userEvent.setup();
    renderApp({ api, path: '/flux/history' });
    await user.click(await screen.findByRole('button', { name: 'Show all' }));
    expect(screen.queryByText('No saved sets yet.')).toBeNull();
    expect(screen.queryByText('No sets in the last 90 days.')).toBeNull();
    release();
    expect(await screen.findByText(/20 reps · avg 50°/)).toBeTruthy();
  });

  it('a stopped set says what it was going for, and still counts in the trend (D55)', async () => {
    const t = Date.now();
    const { user } = await history([
      set({ day: addDays(today, -4), completedAt: t - 4e8, avgPeakDeg: 44 }),
      set({ day: addDays(today, -2), completedAt: t - 2e8, avgPeakDeg: 46 }),
      set({ completedAt: t - 2000, count: 2, planned: 10, stoppedEarly: true, avgPeakDeg: 48 }),
      set({
        exerciseId: 'gaze-stability',
        kind: 'oscillation',
        count: 12,
        planned: null,
        stoppedEarly: true,
        avgPeakDeg: 18,
        completedAt: t - 1000,
      }),
    ]);
    expect(await screen.findByText(/2 of 10 reps · avg 48° · stopped early/)).toBeTruthy();
    expect(screen.getByText(/12 cycles · stopped early/)).toBeTruthy();
    expect(screen.getByText(/20 reps · avg 46°/).textContent).not.toMatch(/stopped/);
    await user.click(screen.getByRole('button', { name: 'rotation' }));
    expect(screen.getByRole('img', { name: /rotation · avg peak, 3 sets/ })).toBeTruthy();
  });

  it('a hold count never trends — only an angle does', async () => {
    const t = Date.now();
    const hold = (d: number) =>
      set({
        day: addDays(today, -d),
        exerciseId: 'chin-tuck',
        kind: 'holdAtTarget',
        count: 10,
        avgPeakDeg: null,
        completedAt: t - d * 86_400_000 - 1000,
      });
    const { user } = await history([hold(4), hold(2), hold(0)]);
    await user.click(await screen.findByRole('button', { name: 'chin tuck' }));
    expect(screen.getAllByText(/10 holds/)).toHaveLength(3);
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('shows sets still waiting in the outbox', async () => {
    localStorage.setItem(STUB_FAIL_FLUX_SAVE_KEY, '1');
    localStorage.setItem(FLUX_OUTBOX_KEY, JSON.stringify([{ input: set(), at: 1, error: null }]));
    await history([]);
    expect(await screen.findByText('1 set not saved yet')).toBeTruthy();
    localStorage.removeItem(STUB_FAIL_FLUX_SAVE_KEY);
  });

  it('Discard’s question lands on Keep, and Escape hands focus back to Discard', async () => {
    localStorage.setItem(STUB_FAIL_FLUX_SAVE_KEY, '1');
    localStorage.setItem(FLUX_OUTBOX_KEY, JSON.stringify([{ input: set(), at: 1, error: null }]));
    const { user } = await history([]);
    await screen.findByText('1 set not saved yet');
    const discard = screen.getByRole('button', { name: 'Discard' });
    await user.click(discard);
    const confirm = screen.getByRole('alertdialog', { name: 'Discard 1 set?' });
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Keep' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Discard' }));
    expect(localStorage.getItem(FLUX_OUTBOX_KEY)).not.toBeNull();
    localStorage.removeItem(STUB_FAIL_FLUX_SAVE_KEY);
  });

  it('the Library tab shows unsaved sets too', async () => {
    localStorage.setItem(STUB_FAIL_FLUX_SAVE_KEY, '1');
    localStorage.setItem(FLUX_OUTBOX_KEY, JSON.stringify([{ input: set(), at: 1, error: null }]));
    await history([], { path: '/flux' });
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
    const toggle = screen.getByRole('button', { name: 'Show all' });
    await user.click(toggle);
    expect(await screen.findByText(/20 reps · avg 41°/)).toBeTruthy();
    // One button that flips back, so focus never falls off it.
    expect(toggle.textContent).toBe('Last 90 days');
    expect(document.activeElement).toBe(toggle);
    await user.click(toggle);
    expect(await screen.findByText('No sets in the last 90 days.')).toBeTruthy();
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
