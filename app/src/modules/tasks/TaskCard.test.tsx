import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';

beforeEach(() => globalThis.localStorage?.clear());

function freshApi() {
  return createStubClient({ seed: false, storageKey: `taskcard-${Math.random()}` });
}

// Open a task's editor modal by clicking its title. `tab` switches first (Backlog tasks) — the Plan
// tab is the default, where a materialized series occurrence already shows.
async function openEditor(
  user: ReturnType<typeof userEvent.setup>,
  title: string,
  tab?: string,
): Promise<ReturnType<typeof within>> {
  if (tab) await user.click(await screen.findByRole('button', { name: tab }));
  await user.click(await screen.findByRole('button', { name: title }));
  return within(await screen.findByRole('dialog', { name: `Task: ${title}` }));
}

describe('TaskCard', () => {
  it('has no overflow menu — the title opens the editor instead', async () => {
    const api = freshApi();
    await api.createTask({ title: 'Plain' });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });

    await user.click(await screen.findByRole('button', { name: 'Backlog' }));
    expect(screen.queryByLabelText(/More actions/)).toBeNull();
    // The title is a button that opens the dialog.
    await user.click(await screen.findByRole('button', { name: 'Plain' }));
    expect(await screen.findByRole('dialog', { name: 'Task: Plain' })).toBeTruthy();
  });

  it('shows Scope only while the task is unscoped', async () => {
    const api = freshApi();
    await api.createTask({ title: 'Unscoped' });
    await api.createTask({ title: 'Scoped', estimateMin: 30 });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });

    await user.click(await screen.findByRole('button', { name: 'Backlog' }));
    await screen.findByRole('button', { name: 'Scoped' });
    // Only the unscoped task carries a Scope button.
    const scopeButtons = screen.getAllByRole('button', { name: 'Scope' });
    expect(scopeButtons).toHaveLength(1);
  });
});

describe('deleting a task', () => {
  it('asks first — the Delete action only opens a confirm, and focus lands on it', async () => {
    const api = freshApi();
    await api.createTask({ title: 'Doomed' });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });

    const d = await openEditor(user, 'Doomed', 'Backlog');
    await user.click(d.getByRole('button', { name: /Delete task/ }));

    // Still present — nothing deleted yet.
    expect((await api.listTasks()).map((t) => t.title)).toContain('Doomed');
    expect(d.getByRole('alertdialog', { name: /Delete Doomed/ })).toBeTruthy();
    // Focus moved to the confirm's Delete button (its autoFocus).
    const confirm = d.getByRole('button', { name: 'Delete' });
    await waitFor(() => expect(document.activeElement).toBe(confirm));
  });

  it('deletes on confirm, disabling the button while the delete is in flight', async () => {
    const api = freshApi();
    await api.createTask({ title: 'Doomed' });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });

    // Gate the delete so we can observe the pending state. Bind the original off the prototype BEFORE
    // spying (stub methods live on the prototype — spreading api would drop them).
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = api.deleteTask.bind(api);
    vi.spyOn(api, 'deleteTask').mockImplementation((id) => gate.then(() => original(id)));

    const d = await openEditor(user, 'Doomed', 'Backlog');
    await user.click(d.getByRole('button', { name: /Delete task/ }));
    const confirm = d.getByRole('button', { name: 'Delete' });
    await user.click(confirm);

    expect(confirm.hasAttribute('disabled')).toBe(true); // in flight
    release();
    await waitFor(async () =>
      expect((await api.listTasks()).map((t) => t.title)).not.toContain('Doomed'),
    );
  });

  it('keeps the task when the confirm is cancelled', async () => {
    const api = freshApi();
    await api.createTask({ title: 'Doomed' });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });

    const d = await openEditor(user, 'Doomed', 'Backlog');
    await user.click(d.getByRole('button', { name: /Delete task/ }));
    await user.click(d.getByRole('button', { name: 'Cancel' }));

    expect(d.queryByRole('alertdialog')).toBeNull();
    expect((await api.listTasks()).map((t) => t.title)).toContain('Doomed');
  });

  it('warns that a calendar event will be removed too', async () => {
    const api = createStubClient({ seed: true, storageKey: `taskcard-cal-${Math.random()}` });
    const t = await api.createTask({ title: 'On the calendar' });
    await api.insertCalendarEvent({
      taskId: t.id,
      accountSub: 'seed-personal',
      calendarId: 'you@gmail.com',
      title: 'On the calendar',
      startMs: 1000,
      endMs: 2000,
    });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });

    const d = await openEditor(user, 'On the calendar', 'Backlog');
    await user.click(d.getByRole('button', { name: /Delete task/ }));
    expect(d.getByText(/calendar event will be removed/)).toBeTruthy();
  });

  it('is hidden on a recurring occurrence — Drop, not Delete', async () => {
    const api = freshApi();
    await api.upsertSeries({
      title: 'Daily standup',
      categoryId: null,
      defaultEstimateMin: 15,
      rule: { kind: 'daily' },
      anchorDate: '2020-01-01', // due every day, including today → materializes on the Plan tab
    });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' }); // Plan is the default tab; useDay(today) materializes it

    const d = await openEditor(user, 'Daily standup');
    expect(d.getByRole('button', { name: /Drop task/ })).toBeTruthy();
    expect(d.queryByRole('button', { name: /Delete task/ })).toBeNull();
  });
});
