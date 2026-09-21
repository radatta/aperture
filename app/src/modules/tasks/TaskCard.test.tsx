import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';

beforeEach(() => globalThis.localStorage?.clear());

function freshApi() {
  return createStubClient({ seed: false, storageKey: `taskcard-${Math.random()}` });
}

// Open a backlog task's overflow menu. Default tab is Plan, so switch to Backlog first.
async function openMenu(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(await screen.findByRole('button', { name: 'Backlog' }));
  await user.click(await screen.findByLabelText(`More actions for ${title}`));
}

describe('deleting a task', () => {
  it('asks first — the menu item only opens a confirm, and focus lands on it', async () => {
    const api = freshApi();
    await api.createTask({ title: 'Doomed' });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });

    await openMenu(user, 'Doomed');
    await user.click(screen.getByRole('menuitem', { name: /Delete task/ }));

    // Still present — nothing deleted yet.
    expect((await api.listTasks()).map((t) => t.title)).toContain('Doomed');
    const dialog = screen.getByRole('alertdialog', { name: /Delete Doomed/ });
    expect(dialog).toBeTruthy();
    // Focus moved to the confirm's Delete button (relies on the Menu focus-handoff fix).
    const confirm = screen.getByRole('button', { name: 'Delete' });
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

    await openMenu(user, 'Doomed');
    await user.click(screen.getByRole('menuitem', { name: /Delete task/ }));
    const confirm = screen.getByRole('button', { name: 'Delete' });
    await user.click(confirm);

    expect(confirm.hasAttribute('disabled')).toBe(true); // in flight
    release();
    await waitFor(async () => expect((await api.listTasks()).map((t) => t.title)).not.toContain('Doomed'));
  });

  it('keeps the task when the confirm is cancelled', async () => {
    const api = freshApi();
    await api.createTask({ title: 'Doomed' });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });

    await openMenu(user, 'Doomed');
    await user.click(screen.getByRole('menuitem', { name: /Delete task/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
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

    await openMenu(user, 'On the calendar');
    await user.click(screen.getByRole('menuitem', { name: /Delete task/ }));
    expect(screen.getByText(/calendar event will be removed/)).toBeTruthy();
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

    await user.click(await screen.findByLabelText('More actions for Daily standup'));
    expect(screen.getByRole('menuitem', { name: 'Drop task' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /Delete task/ })).toBeNull();
  });
});
