import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { todayKey } from '@aperture/shared';
import { renderApp } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';

beforeEach(() => {
  globalThis.localStorage?.clear();
  globalThis.sessionStorage?.clear();
});

async function openFromMorning() {
  const api = createStubClient({ seed: false, storageKey: `add-today-${Math.random()}` });
  const pset = await api.createTask({ title: 'pset 4' });
  const already = await api.createTask({ title: 'already on today' });
  await api.upsertPlan({ taskId: already.id, day: todayKey(4), plannedMinutes: 30, order: 0 });
  await api.transitionTask(already.id, 'planned');
  const user = userEvent.setup();
  renderApp({ api });
  await user.click(screen.getByRole('button', { name: 'Morning' }));
  const trigger = await screen.findByRole('button', { name: 'Add to today' });
  await user.click(trigger);
  const dialog = within(await screen.findByRole('dialog', { name: 'Add to today' }));
  return { api, user, dialog, trigger, pset };
}

describe('Home "+ Add" to today', () => {
  it('lists open tasks not already on today, and adding keeps the row as "Added"', async () => {
    const { api, user, dialog, pset } = await openFromMorning();

    expect(dialog.queryByText('already on today')).toBeNull();
    await user.click(dialog.getByRole('button', { name: 'Add pset 4 to today' }));

    expect(await dialog.findByText('Added')).toBeTruthy();
    expect(dialog.getByText('pset 4')).toBeTruthy();
    expect((await api.listPlansForDay(todayKey(4))).map((p) => p.taskId)).toContain(pset.id);
    expect((await api.getTask(pset.id))?.status).toBe('planned');
  });

  it('offers to create what you typed when nothing matches exactly', async () => {
    const { api, user, dialog } = await openFromMorning();

    await user.type(dialog.getByLabelText('Find a task'), 'pset 4');
    expect(dialog.queryByRole('button', { name: /as a new task today/ })).toBeNull(); // exact match

    await user.clear(dialog.getByLabelText('Find a task'));
    await user.type(dialog.getByLabelText('Find a task'), 'buy stamps');
    await user.click(dialog.getByRole('button', { name: /Add “buy stamps” as a new task today/ }));

    await waitFor(async () => {
      const stamps = (await api.listTasks()).find((t) => t.title === 'buy stamps');
      expect(stamps?.status).toBe('planned');
    });
    expect(await dialog.findByText('Added')).toBeTruthy();
  });

  it('returns focus to the trigger on close', async () => {
    const { user, dialog, trigger } = await openFromMorning();
    await user.click(dialog.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
