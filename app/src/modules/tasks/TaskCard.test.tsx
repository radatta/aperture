import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
    const kept = await api.createTask({ title: 'Kept mine' });
    vi.spyOn(api, 'listTasks').mockResolvedValue([
      {
        ...fresh,
        gcalPulled: { at: Date.now(), note: 'Moved to Oct 9 5pm in Google Calendar' },
      },
      { ...stale, gcalPulled: { at: Date.now() - 8 * 86_400_000, note: 'x' } },
      {
        ...kept,
        gcalPulled: { at: Date.now(), note: 'Kept your time — moved in Google Calendar too' },
      },
    ]);
    renderApp({ api, path: '/tasks' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Backlog' }));
    expect(await screen.findByText('updated from Google')).toBeTruthy();
    expect(screen.getAllByText('updated from Google')).toHaveLength(1);
    expect(screen.getAllByText('kept over Google')).toHaveLength(1);
  });
});

describe('parent + parts', () => {
  const rowOf = (title: string) =>
    screen.getByRole('button', { name: title }).closest('.rounded-2xl') as HTMLElement;

  async function seeded(doneBoth: boolean) {
    const api = freshApi();
    const p = await api.createTask({
      title: 'P2',
      dueDay: addDays(todayKey(4), 2),
      dueTime: '23:59',
    });
    const a = await api.createTask({ title: 'read', estimateMin: 45, parentId: p.id });
    const b = await api.createTask({ title: 'draft', estimateMin: 60, parentId: p.id });
    for (const t of doneBoth ? [a, b] : [a]) {
      await api.transitionTask(t.id, 'in_progress');
      await api.transitionTask(t.id, 'done');
    }
    return { api, p, a, b };
  }

  it('a parent card shows progress and the parts’ sum, nests its parts, and never offers Start', async () => {
    const { api } = await seeded(false);
    renderApp({ api, path: '/tasks?lens=week' });
    const row = await waitFor(() => rowOf('P2'));
    expect(within(row).getByText(/1\/2 · est 1h 45m/)).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Start' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Mark done' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Add P2 to today' })).toBeNull();
    // Its parts are inside its card, not rows of their own; the open one can go on today.
    expect(within(row).getByRole('button', { name: 'read' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Add draft to today' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Week · 1' })).toBeTruthy();
  });

  it('opening another task from inside the editor asks first when there are unsaved edits — never carries them over', async () => {
    const { api, b } = await seeded(false);
    renderApp({ api, path: '/tasks?lens=week' });
    const user = userEvent.setup();
    const row = await waitFor(() => rowOf('P2'));
    await user.click(within(row).getByRole('button', { name: 'draft' }));
    let d = within(await screen.findByRole('dialog', { name: 'Task: draft' }));
    await user.clear(d.getByLabelText('Title'));
    await user.type(d.getByLabelText('Title'), 'draft 2');

    // The parent's name in the header: asked first; Keep editing stays, edits intact.
    await user.click(d.getByRole('button', { name: 'P2' }));
    let confirm = within(await screen.findByRole('dialog', { name: 'Discard unsaved changes?' }));
    await user.click(confirm.getByRole('button', { name: 'Keep editing' }));
    d = within(screen.getByRole('dialog', { name: 'Task: draft' }));
    expect(d.getByLabelText<HTMLInputElement>('Title').value).toBe('draft 2');

    // Discard opens the parent, showing the parent's own title — the part's edit went nowhere.
    await user.click(d.getByRole('button', { name: 'P2' }));
    confirm = within(await screen.findByRole('dialog', { name: 'Discard unsaved changes?' }));
    await user.click(confirm.getByRole('button', { name: 'Discard' }));
    d = within(await screen.findByRole('dialog', { name: 'Task: P2' }));
    expect(d.getByLabelText<HTMLInputElement>('Title').value).toBe('P2');
    expect((await api.getTask(b.id))!.title).toBe('draft');

    // With nothing unsaved, a part's row opens straight away.
    await user.click(d.getByRole('button', { name: 'read' }));
    d = within(await screen.findByRole('dialog', { name: 'Task: read' }));
    expect(d.getByLabelText<HTMLInputElement>('Title').value).toBe('read');
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).toBeNull();
  });

  // The list never refreshes from here on (its cached copy stays): a finish must close from what the
  // write returned, never by waiting on the refetch — eventually consistent, and not retried.
  const holdList = (api: ReturnType<typeof freshApi>) =>
    vi.spyOn(api, 'listTasks').mockImplementation(() => new Promise(() => {}));

  // Holds the next status change until released.
  function gateTransition(api: ReturnType<typeof freshApi>) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = api.transitionTask.bind(api);
    vi.spyOn(api, 'transitionTask').mockImplementation((id, to) =>
      gate.then(() => original(id, to)),
    );
    return () => act(async () => release());
  }

  // A save whose result the test decides: true lands it, false fails it. Only the first title write
  // is held; a retry goes straight through.
  function gateTitle(api: ReturnType<typeof freshApi>) {
    let release!: (ok: boolean) => void;
    const gate = new Promise<boolean>((r) => (release = r));
    const original = api.setTaskTitle.bind(api);
    let gated = true;
    vi.spyOn(api, 'setTaskTitle').mockImplementation(async (id, title) => {
      if (gated) {
        gated = false;
        if (!(await gate)) throw new Error('offline');
      }
      return original(id, title);
    });
    return (ok: boolean) => act(async () => release(ok));
  }

  async function editDraftAndSave(user: ReturnType<typeof userEvent.setup>) {
    const row = await waitFor(() => rowOf('P2'));
    await user.click(within(row).getByRole('button', { name: 'draft' }));
    const d = within(await screen.findByRole('dialog', { name: 'Task: draft' }));
    await user.clear(d.getByLabelText('Title'));
    await user.type(d.getByLabelText('Title'), 'draft 2');
    await user.click(d.getByRole('button', { name: 'Save' }));
    return d;
  }

  it('a switch asked for mid-save waits; a failed save keeps the edit, the message and the task', async () => {
    const { api, b } = await seeded(false);
    const release = gateTitle(api);
    renderApp({ api, path: '/tasks?lens=week' });
    const user = userEvent.setup();
    const d = await editDraftAndSave(user);

    await user.click(d.getByRole('button', { name: 'P2' }));
    expect(screen.getByRole('dialog', { name: 'Task: draft' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).toBeNull();

    await release(false);
    expect(await d.findByText('Couldn’t save — try again.')).toBeTruthy();
    expect(d.getByLabelText<HTMLInputElement>('Title').value).toBe('draft 2');
    expect(screen.getByRole('dialog', { name: 'Task: draft' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Task: P2' })).toBeNull();
    expect((await api.getTask(b.id))!.title).toBe('draft');
  });

  it('a switch asked for mid-save goes once the save lands', async () => {
    const { api, b } = await seeded(false);
    const release = gateTitle(api);
    renderApp({ api, path: '/tasks?lens=week' });
    const user = userEvent.setup();
    const d = await editDraftAndSave(user);
    await user.click(d.getByRole('button', { name: 'P2' }));
    await release(true);
    expect(await screen.findByRole('dialog', { name: 'Task: P2' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).toBeNull();
    expect((await api.getTask(b.id))!.title).toBe('draft 2');
  });

  it('Close mid-save closes once the save lands, and stays (with the failure) if it doesn’t', async () => {
    for (const ok of [false, true]) {
      const { api } = await seeded(false);
      const release = gateTitle(api);
      const { unmount } = renderApp({ api, path: '/tasks?lens=week' });
      const user = userEvent.setup();
      const d = await editDraftAndSave(user);
      await user.click(d.getByRole('button', { name: 'Close' }));
      expect(screen.getByRole('dialog', { name: 'Task: draft' })).toBeTruthy();
      await release(ok);
      if (ok)
        await waitFor(() =>
          expect(screen.queryByRole('dialog', { name: 'Task: draft' })).toBeNull(),
        );
      else {
        expect(await d.findByText('Couldn’t save — try again.')).toBeTruthy();
        expect(screen.getByRole('dialog', { name: 'Task: draft' })).toBeTruthy();
        // The held Close was dropped, not kept: a retry that lands leaves the modal open (Save stays).
        await user.click(d.getByRole('button', { name: 'Save' }));
        expect(await d.findByText('Saved')).toBeTruthy();
        expect(screen.getByRole('dialog', { name: 'Task: draft 2' })).toBeTruthy();
      }
      unmount();
    }
  });

  it('after a switch the new task gets focus, and Close returns it to the row that opened the modal', async () => {
    const { api } = await seeded(false);
    renderApp({ api, path: '/tasks?lens=week' });
    const user = userEvent.setup();
    const row = await waitFor(() => rowOf('P2'));
    const opener = within(row).getByRole('button', { name: 'draft' });
    await user.click(opener);
    const d = within(await screen.findByRole('dialog', { name: 'Task: draft' }));
    await user.click(d.getByRole('button', { name: 'P2' }));
    const parent = await screen.findByRole('dialog', { name: 'Task: P2' });
    expect(document.activeElement).toBe(parent);
    await user.click(within(parent).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('after Discard on a switch, the new task is focused only once the confirm has closed', async () => {
    const { api } = await seeded(false);
    renderApp({ api, path: '/tasks?lens=week' });
    const user = userEvent.setup();
    const row = await waitFor(() => rowOf('P2'));
    await user.click(within(row).getByRole('button', { name: 'draft' }));
    const taskDialog = await screen.findByRole('dialog', { name: 'Task: draft' });
    const d = within(taskDialog);
    await user.type(d.getByLabelText('Title'), ' 2');
    await user.click(d.getByRole('button', { name: 'P2' }));
    const confirm = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' });
    // jsdom has no top layer or inertness, so what's checkable is the order: focused while the
    // confirm is still open, the dialog beneath would be inert and the focus lost.
    const seen: boolean[] = [];
    taskDialog.addEventListener('focus', () => seen.push((confirm as HTMLDialogElement).open));
    await user.click(within(confirm).getByRole('button', { name: 'Discard' }));
    expect(await screen.findByRole('dialog', { name: 'Task: P2' })).toBe(taskDialog);
    expect(seen).toEqual([false]);
    expect(document.activeElement).toBe(taskDialog);
  });

  it('the Mark done box’s Cancel asks about unsaved edits, like Close', async () => {
    const { api, b } = await seeded(false);
    await api.transitionTask(b.id, 'in_progress');
    renderApp({ api, path: '/tasks?lens=week' });
    const user = userEvent.setup();
    const row = await waitFor(() => rowOf('P2'));
    await user.click(within(row).getByRole('button', { name: 'draft' }));
    const d = within(await screen.findByRole('dialog', { name: 'Task: draft' }));
    await user.type(d.getByLabelText('Title'), ' 2');
    await user.click(d.getByRole('button', { name: 'Cancel' }));
    const confirm = within(await screen.findByRole('dialog', { name: 'Discard unsaved changes?' }));
    await user.click(confirm.getByRole('button', { name: 'Keep editing' }));
    expect(d.getByLabelText<HTMLInputElement>('Title').value).toBe('draft 2');
  });

  it('Mark done with an unsaved title asks; Keep editing stays on the done task, and Save still works', async () => {
    const { api, p } = await seeded(true);
    renderApp({ api, path: '/tasks?lens=week' });
    const user = userEvent.setup();
    const row = await waitFor(() => rowOf('P2'));
    await user.click(within(row).getByRole('button', { name: 'P2' }));
    const d = within(await screen.findByRole('dialog', { name: 'Task: P2' }));
    await user.type(d.getByLabelText('Title'), ' final');
    holdList(api); // the confirm comes from the write's own answer, not a refetch
    await user.click(d.getByRole('button', { name: 'Mark done' }));
    const confirm = within(await screen.findByRole('dialog', { name: 'Discard unsaved changes?' }));
    expect((await api.getTask(p.id))!.status).toBe('done');
    await user.click(confirm.getByRole('button', { name: 'Keep editing' }));
    expect(d.getByLabelText<HTMLInputElement>('Title').value).toBe('P2 final');
    // The editor is the done task's: usable, and nothing left to finish twice.
    expect(d.getByLabelText('Title').closest('[inert]')).toBeNull();
    expect(d.queryByRole('button', { name: 'Mark done' })).toBeNull();
    vi.mocked(api.listTasks).mockRestore();
    await user.click(d.getByRole('button', { name: 'Save' }));
    expect(await d.findByText('Saved')).toBeTruthy();
    expect(await api.getTask(p.id)).toMatchObject({ title: 'P2 final', status: 'done' });
    expect(screen.getByRole('dialog', { name: 'Task: P2 final' })).toBeTruthy();
  });

  it('Mark done with only a due change unsaved closes without asking — a done task’s due is locked', async () => {
    const { api } = await seeded(true);
    renderApp({ api, path: '/tasks?lens=week' });
    const user = userEvent.setup();
    const row = await waitFor(() => rowOf('P2'));
    await user.click(within(row).getByRole('button', { name: 'P2' }));
    const d = within(await screen.findByRole('dialog', { name: 'Task: P2' }));
    fireEvent.change(d.getByLabelText('Due'), { target: { value: addDays(todayKey(4), 3) } });
    expect(d.getByText('Unsaved changes')).toBeTruthy();
    await user.click(d.getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Task: P2' })).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).toBeNull();
  });

  it('Mark done during a save waits for it; a failed save keeps the edit and the message', async () => {
    const { api, p } = await seeded(true);
    const release = gateTitle(api);
    renderApp({ api, path: '/tasks?lens=week' });
    const user = userEvent.setup();
    const row = await waitFor(() => rowOf('P2'));
    await user.click(within(row).getByRole('button', { name: 'P2' }));
    const d = within(await screen.findByRole('dialog', { name: 'Task: P2' }));
    await user.type(d.getByLabelText('Title'), ' final');
    await user.click(d.getByRole('button', { name: 'Save' }));
    await user.click(d.getByRole('button', { name: 'Mark done' }));
    await waitFor(async () => expect((await api.getTask(p.id))!.status).toBe('done'));
    expect(screen.getByRole('dialog', { name: 'Task: P2' })).toBeTruthy();
    await release(false);
    expect(await d.findByText('Couldn’t save — try again.')).toBeTruthy();
    expect(d.getByLabelText<HTMLInputElement>('Title').value).toBe('P2 final');
    expect(screen.getByRole('dialog', { name: 'Task: P2' })).toBeTruthy();
  });

  it('a done split closes without asking — its typed actual went with the split', async () => {
    const { api, b } = await seeded(false);
    await api.transitionTask(b.id, 'in_progress');
    renderApp({ api, path: '/tasks?lens=week' });
    const user = userEvent.setup();
    const row = await waitFor(() => rowOf('P2'));
    await user.click(within(row).getByRole('button', { name: 'draft' }));
    const d = within(await screen.findByRole('dialog', { name: 'Task: draft' }));
    await user.click(d.getByRole('button', { name: /^Split/ }));
    await user.type(d.getByLabelText("This part's actual (min)"), '20');
    holdList(api);
    await user.click(d.getByRole('button', { name: 'Split' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Task:/ })).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).toBeNull();
    expect((await api.getTask(b.id))!.status).toBe('done');
  });

  it('a finish closes from the write’s own answer, never waiting on the list', async () => {
    const { api, b } = await seeded(false);
    await api.transitionTask(b.id, 'in_progress');
    renderApp({ api, path: '/tasks?lens=week' });
    const user = userEvent.setup();
    const row = await waitFor(() => rowOf('P2'));
    await user.click(within(row).getByRole('button', { name: 'draft' }));
    const d = within(await screen.findByRole('dialog', { name: 'Task: draft' }));
    holdList(api);
    const transition = vi.spyOn(api, 'transitionTask');
    await user.type(d.getByLabelText('Actual (min)'), '30');
    await user.click(d.getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Task: draft' })).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).toBeNull();
    expect(transition).toHaveBeenCalledTimes(1);
    expect((await api.getTask(b.id))!.status).toBe('done');
  });

  it('a Drop closes from the write’s own answer, never waiting on the list', async () => {
    const api = freshApi();
    const t = await api.createTask({ title: 'Droppable' });
    renderApp({ api, path: '/tasks?lens=backlog' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Droppable' }));
    const d = within(await screen.findByRole('dialog', { name: 'Task: Droppable' }));
    holdList(api);
    await user.click(d.getByRole('button', { name: /Drop task/ }));
    await user.click(d.getByRole('button', { name: 'Drop' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Task: Droppable' })).toBeNull(),
    );
    expect((await api.getTask(t.id))!.status).toBe('cancelled');
  });

  it('a failed Drop or Delete is said inline, and the modal stays', async () => {
    const api = freshApi();
    const t = await api.createTask({ title: 'Keeper' });
    vi.spyOn(api, 'transitionTask').mockRejectedValueOnce(new Error('offline'));
    vi.spyOn(api, 'deleteTask').mockRejectedValueOnce(new Error('offline'));
    renderApp({ api, path: '/tasks?lens=backlog' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Keeper' }));
    const d = within(await screen.findByRole('dialog', { name: 'Task: Keeper' }));
    await user.click(d.getByRole('button', { name: /Drop task/ }));
    await user.click(d.getByRole('button', { name: 'Drop' }));
    expect((await d.findByRole('alert')).textContent).toBe('Couldn’t drop it — try again.');
    await user.click(d.getByRole('button', { name: 'Cancel' }));
    await user.click(d.getByRole('button', { name: /Delete task/ }));
    await user.click(d.getByRole('button', { name: 'Delete' }));
    expect((await d.findByRole('alert')).textContent).toBe('Couldn’t delete it — try again.');
    expect(screen.getByRole('dialog', { name: 'Task: Keeper' })).toBeTruthy();
    expect((await api.getTask(t.id))!.status).toBe('backlog');
  });

  it('a finish that lands after Close makes no close later — reopening the task stays open', async () => {
    const { api, b } = await seeded(false);
    await api.transitionTask(b.id, 'in_progress');
    renderApp({ api, path: '/tasks?lens=week' });
    const user = userEvent.setup();
    const row = await waitFor(() => rowOf('P2'));
    await user.click(within(row).getByRole('button', { name: 'draft' }));
    const d = within(await screen.findByRole('dialog', { name: 'Task: draft' }));
    const release = gateTransition(api);
    await user.type(d.getByLabelText('Actual (min)'), '30');
    await user.click(d.getByRole('button', { name: 'Mark done' }));
    await user.click(d.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Task: draft' })).toBeNull());
    // The list shows the finish only after the task is open again.
    let showList!: () => void;
    const listed = new Promise<void>((r) => (showList = r));
    const list = api.listTasks.bind(api);
    vi.spyOn(api, 'listTasks').mockImplementation(() => listed.then(list));
    await release();
    await waitFor(async () => expect((await api.getTask(b.id))!.status).toBe('done'));
    const card = rowOf('P2');
    await user.click(within(card).getByRole('button', { name: 'draft' }));
    expect(await screen.findByRole('dialog', { name: 'Task: draft' })).toBeTruthy();
    await act(async () => showList());
    await waitFor(() => expect(within(card).getByText(/2\/2/)).toBeTruthy());
    expect(screen.getByRole('dialog', { name: 'Task: draft' })).toBeTruthy();
  });

  // Opens draft (in progress) from P2's card on the Week lens, with its actual typed.
  async function openDraftToFinish(user: ReturnType<typeof userEvent.setup>) {
    const card = await waitFor(() => rowOf('P2'));
    await user.click(within(card).getByRole('button', { name: 'draft' }));
    const d = within(await screen.findByRole('dialog', { name: 'Task: draft' }));
    await user.type(d.getByLabelText('Actual (min)'), '30');
    return { card, d };
  }

  it('a finish that lands after a switch closes nothing — not the task switched to, nor the finished one reopened', async () => {
    const { api, b } = await seeded(false);
    await api.transitionTask(b.id, 'in_progress');
    renderApp({ api, path: '/tasks?lens=week' });
    const user = userEvent.setup();
    const { card, d } = await openDraftToFinish(user);
    const release = gateTransition(api);
    await user.click(d.getByRole('button', { name: 'Mark done' }));
    await user.click(d.getByRole('button', { name: 'P2' }));
    const p = within(await screen.findByRole('dialog', { name: 'Task: P2' }));
    await release();
    // The list has caught up (the card counts both parts done): any close would have come by now.
    await waitFor(() => expect(within(card).getByText(/2\/2/)).toBeTruthy());
    expect(screen.getByRole('dialog', { name: 'Task: P2' })).toBeTruthy();
    await user.click(p.getByRole('button', { name: 'draft' }));
    expect(await screen.findByRole('dialog', { name: 'Task: draft' })).toBeTruthy();
  });

  it('a finish that lands once the task is open again — reopened, or switched back to — closes nothing', async () => {
    for (const back of ['reopen', 'switch'] as const) {
      const { api, b } = await seeded(false);
      await api.transitionTask(b.id, 'in_progress');
      const { unmount } = renderApp({ api, path: '/tasks?lens=week' });
      const user = userEvent.setup();
      const { card, d } = await openDraftToFinish(user);
      const release = gateTransition(api);
      await user.click(d.getByRole('button', { name: 'Mark done' }));
      if (back === 'reopen') {
        await user.click(d.getByRole('button', { name: 'Close' }));
        await waitFor(() =>
          expect(screen.queryByRole('dialog', { name: 'Task: draft' })).toBeNull(),
        );
        await user.click(within(card).getByRole('button', { name: 'draft' }));
      } else {
        await user.click(d.getByRole('button', { name: 'P2' }));
        const p = within(await screen.findByRole('dialog', { name: 'Task: P2' }));
        await user.click(p.getByRole('button', { name: 'draft' }));
      }
      const reopened = within(await screen.findByRole('dialog', { name: 'Task: draft' }));
      // The list stays stale: what shows Done is the write's own answer, kept for the reopened task.
      const listed = vi.spyOn(api, 'listTasks');
      holdList(api);
      await release();
      expect(await reopened.findByText(/^Done/)).toBeTruthy();
      expect(reopened.queryByRole('button', { name: 'Mark done' })).toBeNull();
      expect(screen.getByRole('dialog', { name: 'Task: draft' })).toBeTruthy();
      listed.mockRestore();
      unmount();
    }
  });

  it('a done split closes even with a section swap held for it', async () => {
    const { api, b } = await seeded(false);
    await api.transitionTask(b.id, 'in_progress');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const split = api.splitTask.bind(api);
    vi.spyOn(api, 'splitTask').mockImplementation((id, input) => gate.then(() => split(id, input)));
    renderApp({ api, path: '/tasks?lens=week' });
    const user = userEvent.setup();
    const card = await waitFor(() => rowOf('P2'));
    await user.click(within(card).getByRole('button', { name: 'draft' }));
    const d = within(await screen.findByRole('dialog', { name: 'Task: draft' }));
    await user.click(d.getByRole('button', { name: /^Split/ }));
    await user.type(d.getByLabelText("This part's actual (min)"), '20');
    await user.click(d.getByRole('button', { name: 'Split' }));
    await user.click(d.getByRole('button', { name: 'Delete task…' })); // held for the split
    await act(async () => release());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Task:/ })).toBeNull());
    expect((await api.getTask(b.id))!.status).toBe('done');
  });

  it('the parent’s Mark done takes one tap: a second sends nothing', async () => {
    const { api } = await seeded(true);
    const transition = vi.spyOn(api, 'transitionTask');
    renderApp({ api, path: '/tasks?lens=week' });
    const user = userEvent.setup();
    await user.click(within(await waitFor(() => rowOf('P2'))).getByRole('button', { name: 'P2' }));
    const d = within(await screen.findByRole('dialog', { name: 'Task: P2' }));
    const mark = d.getByRole('button', { name: 'Mark done' });
    fireEvent.click(mark);
    fireEvent.click(mark);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Task: P2' })).toBeNull());
    expect(transition).toHaveBeenCalledTimes(1);
  });

  it('a Close held for a done split, with unsaved details, asks once the split lands', async () => {
    const { api, b } = await seeded(false);
    await api.transitionTask(b.id, 'in_progress');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const split = api.splitTask.bind(api);
    vi.spyOn(api, 'splitTask').mockImplementation((id, input) => gate.then(() => split(id, input)));
    renderApp({ api, path: '/tasks?lens=week' });
    const user = userEvent.setup();
    const card = await waitFor(() => rowOf('P2'));
    await user.click(within(card).getByRole('button', { name: 'draft' }));
    const d = within(await screen.findByRole('dialog', { name: 'Task: draft' }));
    await user.type(d.getByLabelText('Title'), ' 2');
    await user.click(d.getByRole('button', { name: /^Split/ }));
    await user.type(d.getByLabelText("This part's actual (min)"), '20');
    await user.click(d.getByRole('button', { name: 'Split' }));
    await user.click(d.getByRole('button', { name: 'Close' })); // held for the split
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).toBeNull();
    await act(async () => release());
    const confirm = within(await screen.findByRole('dialog', { name: 'Discard unsaved changes?' }));
    await user.click(confirm.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Task:/ })).toBeNull());
  });

  it('a Delete says it went while the list catches up', async () => {
    const api = freshApi();
    await api.createTask({ title: 'Gone' });
    renderApp({ api, path: '/tasks?lens=backlog' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Gone' }));
    const d = within(await screen.findByRole('dialog', { name: 'Task: Gone' }));
    holdList(api);
    await user.click(d.getByRole('button', { name: /Delete task/ }));
    await user.click(d.getByRole('button', { name: 'Delete' }));
    expect(await d.findByText('Deleted.')).toBeTruthy();
    expect(d.queryByRole('button', { name: 'Cancel' })).toBeNull(); // nothing to cancel back to
  });

  it('a section button with unsent Add parts text asks first; details edits never do', async () => {
    const api = freshApi();
    const t = await api.createTask({ title: 'Lab', estimateMin: 60 });
    renderApp({ api, path: '/tasks?lens=backlog' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Lab' }));
    const d = within(await screen.findByRole('dialog', { name: 'Task: Lab' }));
    await user.click(d.getByRole('button', { name: 'Break down…' }));
    await user.type(d.getByLabelText(/Add parts/), '{Enter}write up | ~30');

    await user.click(d.getByRole('button', { name: 'Delete task…' }));
    let confirm = within(await screen.findByRole('dialog', { name: 'Discard unsaved changes?' }));
    expect(
      confirm.getByText('What you typed hasn’t been added yet. Switching sections loses it.'),
    ).toBeTruthy();
    await user.click(confirm.getByRole('button', { name: 'Keep editing' }));
    expect(d.getByLabelText<HTMLTextAreaElement>(/Add parts/).value).toBe(
      'Lab | ~60\nwrite up | ~30',
    );

    await user.click(d.getByRole('button', { name: 'Delete task…' }));
    confirm = within(await screen.findByRole('dialog', { name: 'Discard unsaved changes?' }));
    await user.click(confirm.getByRole('button', { name: 'Discard' }));
    expect(await d.findByRole('alertdialog', { name: 'Delete Lab?' })).toBeTruthy();
    expect(d.queryByLabelText(/Add parts/)).toBeNull();
    await user.click(d.getByRole('button', { name: 'Cancel' }));

    // The details form stays mounted across a swap: its edits don't prompt.
    await user.type(d.getByLabelText('Title'), ' 2');
    await user.click(d.getByRole('button', { name: 'Break down…' }));
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).toBeNull();
    expect(d.getByLabelText(/Add parts/)).toBeTruthy();
    expect((await api.getTask(t.id))!.title).toBe('Lab');
  });

  it('an exit right after a keystroke still asks — the guard reads the edit, not a report a frame late', async () => {
    const api = freshApi();
    await api.createTask({ title: 'Plain' });
    renderApp({ api, path: '/tasks?lens=backlog' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Plain' }));
    const d = within(await screen.findByRole('dialog', { name: 'Task: Plain' }));
    const field = d.getByLabelText<HTMLTextAreaElement>('Title');
    // Outside act(), which would drain every scheduled render and effect — the lag under test.
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const was = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        field,
        'Changed',
      );
      field.dispatchEvent(new Event('input', { bubbles: true }));
      // One microtask: React renders the keystroke (a discrete update) and nothing else runs. With
      // no await the keystroke itself hasn't rendered, so this is load-bearing.
      await Promise.resolve();
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = was;
    }
    fireEvent.click(d.getByRole('button', { name: 'Close' }));
    expect(await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })).toBeTruthy();
  });

  it('after a switch, Close finds the opener’s row again if it re-rendered', async () => {
    const api = freshApi();
    const alpha = await api.upsertCategory({ label: 'Alpha', isWork: true });
    await api.upsertCategory({ label: 'Beta', isWork: true });
    const p = await api.createTask({ title: 'P', categoryId: alpha.id });
    await api.createTask({ title: 'read', parentId: p.id });
    await api.createTask({ title: 'draft', parentId: p.id });
    renderApp({ api, path: '/tasks?lens=backlog' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'draft' }));
    let d = within(await screen.findByRole('dialog', { name: 'Task: draft' }));
    await user.click(d.getByRole('button', { name: 'P' }));
    d = within(await screen.findByRole('dialog', { name: 'Task: P' }));
    await user.selectOptions(d.getByLabelText('Category'), 'Beta');
    await user.click(d.getByRole('button', { name: 'Save' }));
    expect(await d.findByText('Saved')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: /Beta · 1/ })).toBeTruthy());
    await user.click(d.getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'draft' })),
    );
  });

  it('drops through the guard: unsaved edits are asked about, Discard closes', async () => {
    const api = freshApi();
    const t = await api.createTask({ title: 'Droppable' });
    renderApp({ api, path: '/tasks?lens=backlog' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Droppable' }));
    const d = within(await screen.findByRole('dialog', { name: 'Task: Droppable' }));
    await user.type(d.getByLabelText('Title'), ' 2');
    await user.click(d.getByRole('button', { name: /Drop task/ }));
    await user.click(d.getByRole('button', { name: 'Drop' }));
    const confirm = within(await screen.findByRole('dialog', { name: 'Discard unsaved changes?' }));
    expect((await api.getTask(t.id))!.status).toBe('cancelled');
    await user.click(confirm.getByRole('button', { name: 'Discard' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Task: Droppable' })).toBeNull(),
    );
    expect((await api.getTask(t.id))!.title).toBe('Droppable');
  });

  it('a linked parent’s card reads “due marker”, not “on calendar”', async () => {
    const { api, p } = await seeded(false);
    const all = await api.listTasks();
    vi.spyOn(api, 'listTasks').mockResolvedValue(
      all.map((t) => (t.id === p.id ? { ...t, gcalEventId: 'evt' } : t)),
    );
    renderApp({ api, path: '/tasks?lens=week' });
    const row = await waitFor(() => rowOf('P2'));
    expect(within(row).getByText('due marker')).toBeTruthy();
    expect(within(row).queryByText('on calendar')).toBeNull();
  });

  it('“unscoped” counts open parts only — a done one’s estimate can’t be set any more', async () => {
    const { api, p } = await seeded(false);
    const c = await api.createTask({ title: 'cite', parentId: p.id });
    await api.transitionTask(c.id, 'in_progress');
    await api.transitionTask(c.id, 'done');
    const { unmount } = renderApp({ api, path: '/tasks?lens=week' });
    const row = await waitFor(() => rowOf('P2'));
    expect(within(row).getByText(/2\/3 · est 1h 45m/)).toBeTruthy();
    expect(within(row).queryByText(/unscoped/)).toBeNull();
    unmount();
    await api.createTask({ title: 'proofread', parentId: p.id }); // an open one still asks for a size
    renderApp({ api, path: '/tasks?lens=week' });
    expect(within(await waitFor(() => rowOf('P2'))).getByText(/1 unscoped/)).toBeTruthy();
  });

  it('once every part is done the card offers one-tap Mark done', async () => {
    const { api, p } = await seeded(true);
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=week' });
    const row = await waitFor(() => rowOf('P2'));
    await user.click(within(row).getByRole('button', { name: 'Mark done' }));
    await waitFor(async () => expect((await api.getTask(p.id))?.status).toBe('done'));
    // The card leaves Week; focus lands on the list, never <body>.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'P2' })).toBeNull());
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });

  it('+ Today on a part row turns it into "today" and puts focus on the part’s title', async () => {
    const { api } = await seeded(false);
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=week' });
    const row = await waitFor(() => rowOf('P2'));
    await user.click(within(row).getByRole('button', { name: 'Add draft to today' }));
    expect(await within(row).findByText('today')).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(within(row).getByRole('button', { name: 'draft' })),
    );
  });

  it('a part on Today says what it’s part of and answers to the parent’s deadline', async () => {
    const { api, b } = await seeded(false);
    await api.upsertPlan({ taskId: b.id, day: todayKey(4), plannedMinutes: 60, order: 0 });
    await api.transitionTask(b.id, 'planned');
    await api.setTaskDue(b.id, { dueDay: addDays(todayKey(4), 1), dueTime: '15:00' });
    renderApp({ api, path: '/tasks' });
    const row = await waitFor(() => rowOf('draft'));
    expect(within(row).getByText(/of P2 · due/)).toBeTruthy();
    expect(within(row).getByText(/ends tomorrow 3pm/)).toBeTruthy();
  });
});
