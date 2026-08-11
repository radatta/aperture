import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';

beforeEach(() => globalThis.localStorage?.clear());

function freshApi() {
  return createStubClient({ seed: false, storageKey: `habits-${Math.random()}` });
}

describe('habit creation', () => {
  it('keeps the add form collapsed until asked, then focuses it', async () => {
    const user = userEvent.setup();
    renderApp({ api: freshApi(), path: '/habits' });

    expect(screen.queryByLabelText('New habit')).toBeNull();
    await user.click(await screen.findByRole('button', { name: /New habit/ }));
    expect(document.activeElement).toBe(screen.getByLabelText('New habit'));
  });

  // The trigger unmounts while the form is open, so closing remounts it as a fresh node — without
  // an explicit handoff a keyboard user lands at the top of the document.
  it('hands focus back to the trigger on cancel, and drops the draft', async () => {
    const user = userEvent.setup();
    renderApp({ api: freshApi(), path: '/habits' });

    await user.click(await screen.findByRole('button', { name: /New habit/ }));
    await user.type(screen.getByLabelText('New habit'), 'half a thought');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    const trigger = screen.getByRole('button', { name: /New habit/ });
    expect(document.activeElement).toBe(trigger);

    await user.click(trigger);
    expect((screen.getByLabelText('New habit') as HTMLInputElement).value).toBe('');
  });

  it('creates one habit, not two, when Enter is hit twice quickly', async () => {
    const api = freshApi();
    const user = userEvent.setup();
    renderApp({ api, path: '/habits' });

    await user.click(await screen.findByRole('button', { name: /New habit/ }));
    const field = screen.getByLabelText('New habit');
    await user.type(field, 'Read 20 min');
    await user.keyboard('{Enter}{Enter}');

    await waitFor(async () => expect(await api.listHabits()).toHaveLength(1));
  });
});

describe('archiving', () => {
  it('asks before archiving, since v1 has no way back', async () => {
    const api = freshApi();
    await api.upsertHabit({ name: 'Workout', categoryId: null, cadencePerWeek: 3 });
    const user = userEvent.setup();
    renderApp({ api, path: '/habits' });

    await user.click(await screen.findByLabelText('More actions for Workout'));
    await user.click(screen.getByRole('menuitem', { name: /Archive habit/ }));

    // still active — the menu item only opens the confirm
    expect((await api.listHabits()).filter((h) => h.active)).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(async () =>
      expect((await api.listHabits()).filter((h) => h.active)).toHaveLength(0),
    );
  });
});
