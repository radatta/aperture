import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';

beforeEach(() => globalThis.localStorage?.clear());

async function twoCats() {
  const api = createStubClient({ seed: false, storageKey: `settings-${Math.random()}` });
  const hw = await api.upsertCategory({ label: 'Homework', isWork: true });
  await api.upsertCategory({ label: 'Courses', isWork: true });
  return { api, hw };
}

const renameFields = () =>
  screen.getAllByLabelText(/^Rename /).map((el) => (el as HTMLInputElement).value);

describe('categories: retire / restore', () => {
  it('asks before retiring, then sorts the row after active ones, and restores', async () => {
    const { api, hw } = await twoCats();
    const user = userEvent.setup();
    renderApp({ api, path: '/settings' });

    await user.click(await screen.findByLabelText('More actions for Homework'));
    await user.click(screen.getByRole('menuitem', { name: 'Retire…' }));
    expect((await api.listCategories()).find((c) => c.id === hw.id)?.active).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Retire' }));
    await waitFor(async () =>
      expect((await api.listCategories()).find((c) => c.id === hw.id)?.active).toBe(false),
    );
    // The confirm collapsed; focus goes back to the row's menu trigger, not <body>.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('More actions for Homework')),
    );
    expect(await screen.findByText('Retired')).toBeTruthy();
    expect(renameFields()).toEqual(['Courses', 'Homework']);
    expect(screen.queryByLabelText('Move Homework up')).toBeNull(); // arrows are for active rows

    await user.click(screen.getByLabelText('More actions for Homework'));
    await user.click(screen.getByRole('menuitem', { name: 'Restore' }));
    await waitFor(async () =>
      expect((await api.listCategories()).find((c) => c.id === hw.id)?.active).toBe(true),
    );
    expect(await screen.findByLabelText('Move Homework up')).toBeTruthy(); // arrows are back
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('More actions for Homework')),
    );
  });

  it('renaming a retired category keeps it retired', async () => {
    const { api, hw } = await twoCats();
    await api.upsertCategory({ id: hw.id, label: 'Homework', isWork: true, active: false });
    const user = userEvent.setup();
    renderApp({ api, path: '/settings' });

    const field = await screen.findByLabelText('Rename Homework');
    await user.clear(field);
    await user.type(field, 'Old homework');
    await user.tab();

    await waitFor(async () =>
      expect((await api.listCategories()).find((c) => c.id === hw.id)?.label).toBe('Old homework'),
    );
    expect((await api.listCategories()).find((c) => c.id === hw.id)?.active).toBe(false);
  });
});
