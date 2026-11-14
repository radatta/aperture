import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { todayKey } from '@aperture/shared';
import { renderApp } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';

beforeEach(() => globalThis.localStorage?.clear());

const TODAY = todayKey(4);
const freshApi = () => createStubClient({ seed: false, storageKey: `rolls-${Math.random()}` });

describe('Rolls page', () => {
  it('shows the empty state with no rolls', async () => {
    renderApp({ api: freshApi(), path: '/rolls' });
    expect(await screen.findByText('No rolls yet.')).toBeTruthy();
  });

  it('the new-roll picker omits retired categories', async () => {
    const api = freshApi();
    const old = await api.upsertCategory({ label: 'Studying', isWork: true });
    await api.upsertCategory({ id: old.id, label: 'Studying', isWork: true, active: false });
    await api.upsertCategory({ label: 'CS 101', isWork: true });
    const user = userEvent.setup();
    renderApp({ api, path: '/rolls' });

    await user.click(await screen.findByRole('button', { name: /New roll/ }));
    const select = screen.getByLabelText('Category') as HTMLSelectElement;
    await waitFor(() =>
      expect(Array.from(select.options).map((o) => o.textContent)).toContain('CS 101'),
    );
    expect(
      Array.from(select.options)
        .map((o) => o.textContent)
        .join(),
    ).not.toMatch(/Studying/);
  });

  it('creates a roll from the collapsed form (estimate required, defaulted)', async () => {
    const api = freshApi();
    const user = userEvent.setup();
    renderApp({ api, path: '/rolls' });

    await user.click(await screen.findByRole('button', { name: /New roll/ }));
    await user.type(screen.getByLabelText('New roll'), 'LeetCode daily');
    await user.click(screen.getByRole('button', { name: 'Add roll' }));

    // The new roll's card renders (its sheet caption is unique — the name also appears as a picker chip).
    expect(await screen.findByText(/No reps yet/)).toBeTruthy();
    await waitFor(async () =>
      expect((await api.listRolls()).map((r) => r.name)).toContain('LeetCode daily'),
    );
  });

  it('picks a roll for today → a planned rep lands on today’s plan', async () => {
    const api = freshApi();
    await api.upsertRoll({ name: 'Study', categoryId: null, estimateMin: 45 });
    const user = userEvent.setup();
    renderApp({ api, path: '/rolls' });

    await user.click(await screen.findByRole('button', { name: /Pick Study for today/ }));

    await waitFor(async () => expect(await api.listPlansForDay(TODAY)).toHaveLength(1));
    const [plan] = await api.listPlansForDay(TODAY);
    const task = await api.getTask(plan!.taskId);
    expect(task?.status).toBe('planned');
    expect(task?.rollId).toBeTruthy();
    // The chip now reads as picked, not pickable.
    expect(await screen.findByRole('button', { name: /Study .* on today/ })).toBeTruthy();
  });

  it('renders a filled contact sheet from reps, then archives behind a confirm', async () => {
    const api = freshApi();
    const roll = await api.upsertRoll({ name: 'Study', categoryId: null, estimateMin: 45 });
    const { task } = await api.pickRollToday(roll.id, TODAY);
    await api.transitionTask(task.id, 'in_progress');
    await api.setTaskActual(task.id, 45);
    await api.transitionTask(task.id, 'done'); // one rep, today
    const user = userEvent.setup();
    renderApp({ api, path: '/rolls' });

    expect(await screen.findByText(/1 rep · last today/)).toBeTruthy();

    await user.click(await screen.findByLabelText('More actions for Study'));
    await user.click(screen.getByRole('menuitem', { name: /Archive roll/ }));
    // Confirm strip only — still active until confirmed.
    expect((await api.listRolls()).filter((r) => r.active)).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Archive' }));

    await waitFor(async () =>
      expect((await api.listRolls()).filter((r) => r.active)).toHaveLength(0),
    );
    expect(await screen.findByText('No rolls yet.')).toBeTruthy();
  });
});
