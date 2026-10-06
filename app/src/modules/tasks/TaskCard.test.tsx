import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { addDays, dayKey, hhmmOfEpoch, todayKey } from '@aperture/shared';
import { renderApp } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';

beforeEach(() => globalThis.localStorage?.clear());

function freshApi() {
  return createStubClient({ seed: false, storageKey: `taskcard-${Math.random()}` });
}

// Open a task's editor modal by clicking its title. `tab` switches lens first (Backlog tasks) — the
// Today lens is the default, where a materialized series occurrence already shows.
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

  it('a title tap focuses the dialog, not a field — no iPhone keyboard on a read', async () => {
    const api = freshApi();
    await api.createTask({ title: 'Just looking' });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });

    await openEditor(user, 'Just looking', 'Backlog');
    const dialog = screen.getByRole('dialog', { name: 'Task: Just looking' });
    await waitFor(() => expect(document.activeElement).toBe(dialog));
  });

  it('Scope still opens on the Estimate field', async () => {
    const api = freshApi();
    await api.createTask({ title: 'Needs scoping' });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });

    await user.click(await screen.findByRole('button', { name: 'Backlog' }));
    await user.click(await screen.findByRole('button', { name: 'Scope' }));
    const d = within(await screen.findByRole('dialog', { name: 'Task: Needs scoping' }));
    await waitFor(() => expect(document.activeElement).toBe(d.getByLabelText('Estimate (min)')));
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

describe('row click', () => {
  it('opens the editor from anywhere on the row, but a button does only its own thing', async () => {
    const api = freshApi();
    const t = await api.createTask({ title: 'Clickable' });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });

    await user.click(await screen.findByRole('button', { name: 'Backlog' }));
    await user.click(await screen.findByText('not scoped'));
    expect(await screen.findByRole('dialog', { name: 'Task: Clickable' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(async () => expect((await api.getTask(t.id))?.status).toBe('in_progress'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('stale planned sweep', () => {
  it('shows a task left planned on a past day in the Backlog lens', async () => {
    const api = freshApi();
    const t = await api.createTask({ title: 'Left behind' });
    await api.upsertPlan({
      taskId: t.id,
      day: addDays(todayKey(4), -1),
      plannedMinutes: 30,
      order: 1,
    });
    await api.transitionTask(t.id, 'planned');
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });

    await user.click(await screen.findByRole('button', { name: 'Backlog' }));
    expect(await screen.findByRole('button', { name: 'Left behind' })).toBeTruthy();
    expect((await api.getTask(t.id))?.status).toBe('backlog');
  });
});

describe('unsaved-changes guard', () => {
  async function openAndEdit(user: ReturnType<typeof userEvent.setup>) {
    const d = await openEditor(user, 'Editable', 'Backlog');
    const title = d.getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Changed but not saved');
    return d;
  }

  it('confirms before discarding when the Close button is used on an edited task', async () => {
    const api = freshApi();
    await api.createTask({ title: 'Editable' });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });

    const d = await openAndEdit(user);
    await user.click(d.getByRole('button', { name: 'Close' }));

    expect(await screen.findByRole('dialog', { name: /Discard unsaved changes/ })).toBeTruthy();
    expect((await api.listTasks()).map((t) => t.title)).toContain('Editable'); // nothing saved
  });

  it('confirms on a backdrop click too, and Keep editing dismisses it', async () => {
    const api = freshApi();
    await api.createTask({ title: 'Editable' });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });

    await openAndEdit(user);
    // Press and release on the dialog itself, off its box = a backdrop click (both, so a drag-out
    // wouldn't count). jsdom's box is 0×0 at the origin, so (5,5) is outside it.
    const editorDialog = screen.getByRole('dialog', { name: 'Task: Editable' });
    fireEvent.mouseDown(editorDialog, { clientX: 5, clientY: 5 });
    fireEvent.click(editorDialog, { clientX: 5, clientY: 5 });
    await screen.findByRole('dialog', { name: /Discard unsaved changes/ });

    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('dialog', { name: /Discard unsaved changes/ })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Task: Editable' })).toBeTruthy(); // still editing
  });

  it('discards and closes both dialogs when confirmed', async () => {
    const api = freshApi();
    await api.createTask({ title: 'Editable' });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });

    const d = await openAndEdit(user);
    await user.click(d.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await api.listTasks()).map((t) => t.title)).toContain('Editable'); // unchanged
  });

  it('closes directly with no prompt when nothing was edited', async () => {
    const api = freshApi();
    await api.createTask({ title: 'Editable' });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });

    const d = await openEditor(user, 'Editable', 'Backlog');
    await user.click(d.getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog', { name: /Discard unsaved changes/ })).toBeNull();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Task: Editable' })).toBeNull(),
    );
    // Focus goes back to the row's title, which the page-level modal still knows about.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Editable' })),
    );
  });
});

describe('Save keeps the modal open', () => {
  it('even when the save moves the row out of the list (Backlog → Week)', async () => {
    const api = freshApi();
    await api.createTask({ title: 'Movable' });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });

    const d = await openEditor(user, 'Movable', 'Backlog');
    fireEvent.change(d.getByLabelText('Due'), { target: { value: addDays(todayKey(4), 2) } });
    await user.click(d.getByRole('button', { name: 'Save' }));

    expect(await d.findByText('Saved')).toBeTruthy();
    // The row leaves Backlog (it's due this week now) — the modal doesn't go with it.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Movable' })).toBeNull());
    const dialog = screen.getByRole('dialog', { name: 'Task: Movable' });
    expect(within(dialog).getByLabelText<HTMLTextAreaElement>('Title').value).toBe('Movable');

    // Nothing unsaved, so Close doesn't prompt; with the row gone, focus lands on the list area.
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: /Discard unsaved changes/ })).toBeNull();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Task: Movable' })).toBeNull());
    await waitFor(() => expect(document.activeElement?.getAttribute('tabindex')).toBe('-1'));

    await user.click(screen.getByRole('button', { name: /^Week/ }));
    expect(await screen.findByRole('button', { name: 'Movable' })).toBeTruthy();
  });
});

describe('focus after the row re-renders', () => {
  it('finds the title again when a save moves the row to another group', async () => {
    const api = freshApi();
    const a = await api.upsertCategory({ label: 'Alpha', isWork: true });
    await api.upsertCategory({ label: 'Beta', isWork: true });
    await api.createTask({ title: 'Mover', categoryId: a.id });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=backlog' }); // Backlog groups by category; Week is flat

    await user.click(await screen.findByRole('button', { name: 'Mover' }));
    const d = within(await screen.findByRole('dialog', { name: 'Task: Mover' }));
    await user.selectOptions(d.getByLabelText('Category'), 'Beta');
    await user.click(d.getByRole('button', { name: 'Save' }));
    expect(await d.findByText('Saved')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: /Beta · 1/ })).toBeTruthy());

    await user.click(d.getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Mover' })),
    );
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
    // The modal closes itself once the task leaves the list, and focus lands on the list area — the
    // row it came from is gone — never <body>.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Task: Doomed' })).toBeNull());
    await waitFor(() => expect(document.activeElement?.getAttribute('tabindex')).toBe('-1'));
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
      anchorDate: '2020-01-01', // due every day, including today → materializes on the Today lens
    });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' }); // Today is the default lens; useDay(today) materializes it

    const d = await openEditor(user, 'Daily standup');
    expect(d.getByRole('button', { name: /Drop task/ })).toBeTruthy();
    expect(d.queryByRole('button', { name: /Delete task/ })).toBeNull();
  });
});

describe('due-time urgency', () => {
  // Deadlines relative to the real clock: the row colour is a function of (dueDay+dueTime, now).
  async function timed(api: ReturnType<typeof freshApi>, title: string, inMin: number) {
    const at = Math.floor((Date.now() + inMin * 60_000) / 60_000) * 60_000;
    return api.createTask({ title, dueDay: dayKey(at, 0), dueTime: hhmmOfEpoch(at) });
  }
  const rowOf = (title: string) =>
    screen.getByRole('button', { name: title }).closest('.rounded-2xl') as HTMLElement;

  it('gold edge inside 6h, gold fill inside the hour, red once past; untimed stays plain', async () => {
    const api = freshApi();
    await timed(api, 'Later', 9 * 60);
    await timed(api, 'Soon', 3 * 60);
    await timed(api, 'Imminent', 30);
    await timed(api, 'Past', -120);
    await api.createTask({ title: 'Untimed', dueDay: todayKey(4) });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });
    await user.click(await screen.findByRole('button', { name: 'Week' })); // all due within the week
    await screen.findByRole('button', { name: 'Past' });

    expect(rowOf('Later').className).not.toMatch(/border-(gold|danger)/);
    expect(rowOf('Untimed').className).not.toMatch(/border-(gold|danger)/);
    expect(rowOf('Soon').className).toMatch(/border-gold!/);
    expect(rowOf('Soon').className).not.toMatch(/fill/);
    expect(rowOf('Imminent').className).toMatch(/border-gold!.*due-imminent-fill/);
    expect(rowOf('Past').className).toMatch(/border-danger!.*due-past-fill/);
    // The same signal for a screen reader, beside the time label.
    expect(within(rowOf('Imminent')).getByText(/due within the hour/)).toBeTruthy();
    expect(within(rowOf('Past')).getByText(/past due/)).toBeTruthy();
  });

  it('a finished task is never coloured, even past its time', async () => {
    const api = freshApi();
    const t = await timed(api, 'Finished late', -60);
    await api.transitionTask(t.id, 'in_progress');
    await api.transitionTask(t.id, 'done');
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });
    await user.click(await screen.findByRole('button', { name: 'Done' }));
    expect(rowOf('Finished late').className).not.toMatch(/border-(gold|danger)/);
  });

  it('shows a failed calendar sync on the row', async () => {
    const api = freshApi();
    const t = await api.createTask({ title: 'Sync broke' });
    vi.spyOn(api, 'listTasks').mockResolvedValue([{ ...t, gcalSyncError: 'invalid_grant' }]);
    renderApp({ api, path: '/tasks' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Backlog' }));
    expect(await screen.findByText('calendar sync failed')).toBeTruthy();
  });

  it('marks a task Google changed today, and not one it changed before the rollover', async () => {
    const api = freshApi();
    const fresh = await api.createTask({ title: 'Moved in Google' });
    const stale = await api.createTask({ title: 'Moved last week' });
    vi.spyOn(api, 'listTasks').mockResolvedValue([
      {
        ...fresh,
        gcalPulledAt: Date.now(),
        gcalPulledNote: 'Moved to Oct 9 5pm in Google Calendar',
      },
      { ...stale, gcalPulledAt: Date.now() - 8 * 86_400_000, gcalPulledNote: 'x' },
    ]);
    renderApp({ api, path: '/tasks' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Backlog' }));
    expect(await screen.findByText('updated from Google')).toBeTruthy();
    expect(screen.getAllByText('updated from Google')).toHaveLength(1);
  });
});
