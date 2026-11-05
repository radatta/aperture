import { beforeAll, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EXERCISES } from '@aperture/shared/flux';
import { renderApp } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';
import { setFluxEngineFactory } from '../../modules/flux/engine/engine';
import { createFakeEngine } from '../../modules/flux/engine/fakeEngine';

// The Flux pages are a lazy chunk (routes.tsx): load it once here, so the first render in this file
// isn't a cold import inside a findBy's timeout.
beforeAll(() => import('./flux-pages'));

const freshApi = () => createStubClient({ seed: false, storageKey: `flux-${Math.random()}` });

async function accepted() {
  const api = freshApi();
  await api.updateSettings({ fluxDisclaimerAckAt: 1 });
  return api;
}

describe('Flux page', () => {
  it('gates every Flux screen on the disclaimer, and remembers the acceptance in Settings', async () => {
    const api = freshApi();
    const user = userEvent.setup();
    renderApp({ api, path: '/flux' });
    expect(await screen.findByText('Before you start')).toBeTruthy();
    expect(screen.queryByText('Neck Rotation')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'I understand — continue' }));
    expect(await screen.findByText('Neck Rotation')).toBeTruthy();
    expect((await api.getSettings()).fluxDisclaimerAckAt).toEqual(expect.any(Number));
  });

  it('gates a deep link to an exercise too', async () => {
    renderApp({ api: freshApi(), path: '/flux/chin-tuck' });
    expect(await screen.findByText('Before you start')).toBeTruthy();
    expect(screen.queryByText('Start camera')).toBeNull();
  });

  it('lists every exercise in its category, with the footer', async () => {
    renderApp({ api: await accepted(), path: '/flux' });
    await screen.findByText('Neck Rotation');
    for (const ex of EXERCISES) expect(screen.getByText(ex.name)).toBeTruthy();
    expect(screen.getByLabelText('Capture log')).toBeTruthy(); // only the stage hides it
    expect(screen.getByText(/Active Range of Motion/i)).toBeTruthy();
    expect(screen.getByText(/Sensorimotor/i)).toBeTruthy();
    expect(screen.getByText(/Not a medical device/)).toBeTruthy();
  });

  it('filters by condition and stage, flags a contraindication, and remembers the chips', async () => {
    const api = await accepted();
    const user = userEvent.setup();
    const { unmount } = renderApp({ api, path: '/flux' });
    await screen.findByText('Neck Rotation');
    expect(screen.queryByText('Caution')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Herniated disc' }));
    const card = screen.getByText('Neck Extension (Look Up)').closest('a') as HTMLElement;
    expect(within(card).getByText('Caution')).toBeTruthy();
    // Exercises not prescribed for a herniated disc drop out.
    expect(screen.queryByText('Upper Trapezius Stretch')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Acute' }));
    expect(screen.queryByText('Joint Position Sense (Return to Neutral)')).toBeNull();
    unmount();

    renderApp({ api, path: '/flux' });
    await screen.findByRole('button', { name: 'Herniated disc', pressed: true });
    expect(screen.getByRole('button', { name: 'Acute', pressed: true })).toBeTruthy();
  });

  it('a card is a real link to the exercise stage', async () => {
    setFluxEngineFactory(() => createFakeEngine().engine);
    const user = userEvent.setup();
    renderApp({ api: await accepted(), path: '/flux' });
    const link = (await screen.findByText('Chin Tuck (Cervical Retraction)')).closest('a');
    expect(link?.getAttribute('href')).toBe('/flux/chin-tuck');
    await user.click(link as HTMLElement);
    expect(await screen.findByRole('button', { name: 'Start camera' })).toBeTruthy();
  });

  it('points to Settings while no Roll is linked, and stops once one is', async () => {
    const api = await accepted();
    const { unmount } = renderApp({ api, path: '/flux' });
    expect(await screen.findByText(/count as a Roll/)).toBeTruthy();
    unmount();
    const roll = await api.upsertRoll({ name: 'Neck', categoryId: null, estimateMin: 15 });
    await api.updateSettings({ fluxRollId: roll.id });
    renderApp({ api, path: '/flux' });
    await screen.findByText('Neck Rotation');
    await waitFor(() => expect(screen.queryByText(/count as a Roll/)).toBeNull());
  });

  it('Settings links a Roll and can show the disclaimer again', async () => {
    const api = await accepted();
    const roll = await api.upsertRoll({ name: 'Neck', categoryId: null, estimateMin: 15 });
    const user = userEvent.setup();
    const { unmount } = renderApp({ api, path: '/settings' });
    const select = (await screen.findByLabelText('Count sessions as reps of')) as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(2));
    await user.selectOptions(select, roll.id);
    await waitFor(async () => expect((await api.getSettings()).fluxRollId).toBe(roll.id));

    await user.click(screen.getByRole('button', { name: 'Show the Flux disclaimer again' }));
    await waitFor(async () => expect((await api.getSettings()).fluxDisclaimerAckAt).toBeNull());
    unmount();
    renderApp({ api, path: '/flux' });
    expect(await screen.findByText('Before you start')).toBeTruthy();
  });

  it('shows Flux in the nav', async () => {
    renderApp({ api: await accepted(), path: '/' });
    expect((await screen.findByRole('link', { name: 'Flux' })).getAttribute('href')).toBe('/flux');
  });
});
