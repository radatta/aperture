import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiClient, Task } from '@aperture/shared';
import { renderWithProviders } from '../../../test/utils';
import { createStubClient } from '../../../data/stubClient';
import { TaskEditor } from './TaskEditor';
import type { TaskEditorIntent } from './TaskEditor';

function api(): ApiClient {
  return createStubClient({ seed: false, storageKey: `editor-${Math.random()}` });
}

function renderEditor(client: ApiClient, task: Task, intent: TaskEditorIntent = 'view') {
  const onClose = vi.fn();
  const onDirtyChange = vi.fn();
  renderWithProviders(
    <TaskEditor
      task={task}
      intent={intent}
      onClose={onClose}
      onRequestClose={vi.fn()}
      onDirtyChange={onDirtyChange}
    />,
    { api: client },
  );
  return { onClose, onDirtyChange, user: userEvent.setup() };
}

// A synthetic task for pure-render assertions that don't touch the store.
const mkTask = (over: Partial<Task>): Task => ({
  id: 't',
  userId: 'local',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  title: 'x',
  status: 'backlog',
  categoryId: null,
  dueDay: null,
  dueTime: null,
  notes: null,
  seriesId: null,
  rollId: null,
  estimateMin: null,
  bufferMin: null,
  estimateLockedMin: null,
  actualAccruedMin: 0,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  gcalAccountId: null,
  gcalCalendarId: null,
  gcalEventId: null,
  gcalSyncError: null,
  ...over,
});

describe('TaskEditor', () => {
  it('shows the full title in an editable field', async () => {
    const client = api();
    const t = await client.createTask({
      title: 'A very long task title that would truncate to one line inside a card row',
    });
    renderEditor(client, t);
    expect(screen.getByDisplayValue(t.title)).toBeTruthy(); // the Title textarea, unclipped
  });

  it('renames the task through Save', async () => {
    const client = api();
    const t = await client.createTask({ title: 'Old name' });
    const setTitle = vi.spyOn(client, 'setTaskTitle');
    const { onClose, user } = renderEditor(client, t);

    const field = screen.getByLabelText('Title');
    await user.clear(field);
    await user.type(field, 'New name');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(setTitle).toHaveBeenCalledWith(t.id, 'New name'); // trimmed
    await waitFor(async () => expect((await client.getTask(t.id))?.title).toBe('New name'));
    // Save keeps the modal open and says so.
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Title').value).toBe('New name');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('disables Save when the title is blank', async () => {
    const client = api();
    const t = await client.createTask({ title: 'Has a name' });
    const { user } = renderEditor(client, t);
    await user.clear(screen.getByLabelText('Title'));
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
  });

  it('saves only the changed field and stays open', async () => {
    const client = api();
    const t = await client.createTask({ title: 'Edit me', estimateMin: 30 });
    const setDue = vi.spyOn(client, 'setTaskDue');
    const setEst = vi.spyOn(client, 'setTaskEstimate');
    const { onClose, user } = renderEditor(client, t);

    fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-10-01' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(setDue).toHaveBeenCalledWith(t.id, { dueDay: '2026-10-01', dueTime: null });
    expect(setEst).not.toHaveBeenCalled(); // estimate untouched
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Due').value).toBe('2026-10-01');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.getAttribute('aria-disabled')).toBe('true'); // nothing left to save
    expect(onClose).not.toHaveBeenCalled();

    // The next edit replaces "Saved" with "Unsaved changes".
    fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-10-02' } });
    expect(screen.queryByText('Saved')).toBeNull();
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(save.getAttribute('aria-disabled')).toBe('false');
  });

  it('never overwrites typing done while a slow save is in flight', async () => {
    const client = api();
    const t = await client.createTask({ title: 'Slow' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = client.setTaskTitle.bind(client);
    vi.spyOn(client, 'setTaskTitle').mockImplementation((id, title) =>
      gate.then(() => original(id, title)),
    );
    const { onDirtyChange, user } = renderEditor(client, t);

    const field = screen.getByLabelText('Title');
    await user.type(field, ' one');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    // Mid-save the form doesn't claim unsaved edits (a "Discard" now would be a lie)…
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    await user.type(field, ' two'); // …but typing is still allowed, and must survive the save.
    release();

    expect(await screen.findByText('Unsaved changes')).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Title').value).toBe('Slow one two');
    expect((await client.getTask(t.id))?.title).toBe('Slow one');
  });

  it('due time: disabled without a day, saved with it in one write, cleared with the day', async () => {
    const client = api();
    const t = await client.createTask({ title: 'Timed' });
    const setDue = vi.spyOn(client, 'setTaskDue');
    const { user } = renderEditor(client, t);
    const time = () => screen.getByLabelText<HTMLInputElement>('Due time');
    expect(time().disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-10-01' } });
    expect(time().disabled).toBe(false);
    fireEvent.change(time(), { target: { value: '16:00' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(setDue).toHaveBeenCalledTimes(1);
    expect(setDue).toHaveBeenCalledWith(t.id, { dueDay: '2026-10-01', dueTime: '16:00' });
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect((await client.getTask(t.id))?.dueTime).toBe('16:00');

    fireEvent.change(screen.getByLabelText('Due'), { target: { value: '' } });
    expect(time().value).toBe('');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await client.getTask(t.id)).toMatchObject({ dueDay: null, dueTime: null });
  });

  it('a failed calendar sync is said in the editor, with a retry', async () => {
    const client = api();
    const t = await client.createTask({ title: 'Synced', dueDay: '2026-10-01', dueTime: '16:00' });
    const failed = { ...t, gcalSyncError: 'invalid_grant' };
    const sync = vi.spyOn(client, 'syncCalendarEvent');
    const { user } = renderEditor(client, failed);
    expect(screen.getByRole('alert').textContent).toMatch(/Calendar sync failed: invalid_grant/);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(sync).toHaveBeenCalledWith(t.id);
  });

  it('keeps the edits and says so when a save fails', async () => {
    const client = api();
    const t = await client.createTask({ title: 'Flaky' });
    vi.spyOn(client, 'setTaskDue').mockRejectedValue(new Error('offline'));
    const { onClose, user } = renderEditor(client, t);

    fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-10-01' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/Couldn’t save/)).toBeTruthy();
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Due').value).toBe('2026-10-01');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('makes estimate read-only once work has started, with the lock copy', async () => {
    const client = api();
    let t = await client.createTask({ title: 'Started', estimateMin: 45 });
    t = await client.transitionTask(t.id, 'in_progress'); // freezes estimateLockedMin = 45
    renderEditor(client, t);
    expect(screen.queryByLabelText('Estimate (min)')).toBeNull();
    expect(screen.getByText(/Frozen at 45m/)).toBeTruthy();
  });

  it('locks Due but keeps Category editable on a finished task', async () => {
    const client = api();
    let t = await client.createTask({ title: 'Done', estimateMin: 30 });
    t = await client.transitionTask(t.id, 'in_progress');
    t = await client.transitionTask(t.id, 'done');
    renderEditor(client, t);
    expect(screen.queryByLabelText('Due')).toBeNull(); // read-only once finished
    expect(screen.getByLabelText('Category')).toBeTruthy(); // recategorizing a done task still matters
  });

  it("keeps the task's own retired category as '(retired)' and hides other retired ones", async () => {
    const client = api();
    const hw = await client.upsertCategory({ label: 'Homework', isWork: true });
    const st = await client.upsertCategory({ label: 'Studying', isWork: true });
    await client.upsertCategory({ label: 'CSEN 146', isWork: true });
    for (const c of [hw, st])
      await client.upsertCategory({ id: c.id, label: c.label, isWork: true, active: false });
    const t = await client.createTask({ title: 'pset', categoryId: hw.id });
    renderEditor(client, t);

    const select = (await screen.findByLabelText('Category')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(hw.id));
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toContain('Homework (retired)');
    expect(labels).toContain('CSEN 146');
    expect(labels).not.toContain('Studying');
    expect(labels).not.toContain('Studying (retired)');
    // The retired option is the saved value, so the form opens clean.
    expect(screen.getByRole('button', { name: 'Save' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('hides Split on a finished task', async () => {
    const client = api();
    let t = await client.createTask({ title: 'Done', estimateMin: 30 });
    t = await client.transitionTask(t.id, 'in_progress');
    t = await client.transitionTask(t.id, 'done');
    renderEditor(client, t);
    expect(screen.queryByRole('button', { name: /Split/ })).toBeNull();
  });

  it('drops a scopeable task through a confirm and closes', async () => {
    const client = api();
    const t = await client.createTask({ title: 'Droppable' });
    const { onClose, user } = renderEditor(client, t);

    await user.click(screen.getByRole('button', { name: /Drop task/ }));
    await user.click(screen.getByRole('button', { name: 'Drop' }));

    await waitFor(async () => expect((await client.getTask(t.id))?.status).toBe('cancelled'));
    expect(onClose).toHaveBeenCalled();
  });

  it('offers Drop but not Delete on a recurring occurrence', () => {
    const client = api();
    renderEditor(client, mkTask({ seriesId: 'series-1' }));
    expect(screen.getByRole('button', { name: /Drop task/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Delete task/ })).toBeNull();
  });

  it('keeps reveals exclusive — opening Delete collapses Split', async () => {
    const client = api();
    const t = await client.createTask({ title: 'Exclusive' });
    const { user } = renderEditor(client, t);

    await user.click(screen.getByRole('button', { name: /^Split/ })); // the "Split…" trigger (only one pre-reveal)
    expect(screen.getByRole('button', { name: 'Split' })).toBeTruthy(); // the form's submit
    await user.click(screen.getByRole('button', { name: /Delete task/ }));
    expect(screen.queryByRole('button', { name: 'Split' })).toBeNull(); // split reveal gone
    expect(screen.getByRole('alertdialog', { name: /Delete/ })).toBeTruthy();
  });

  it('gates the calendar action on a due day', async () => {
    const client = api();
    const undated = await client.createTask({ title: 'No due' });
    renderEditor(client, undated);
    expect(screen.getByText(/Set a due day/)).toBeTruthy();

    const client2 = api();
    let dated = await client2.createTask({ title: 'Has due' });
    dated = await client2.setTaskDueDay(dated.id, '2026-10-01');
    renderEditor(client2, dated);
    expect(screen.getByRole('button', { name: /Add to calendar/ })).toBeTruthy();
  });

  describe('notes', () => {
    it('renders saved notes as light markdown, with links opening a new tab', async () => {
      const client = api();
      const t = await client.createTask({
        title: 'Noted',
        notes:
          '**Bold** start\n- one\n- two\n\n[brief](https://example.com/b) [x](javascript:alert(1))',
      });
      renderEditor(client, t);
      expect(screen.getByText('Bold').tagName).toBe('STRONG');
      expect(screen.getAllByRole('listitem')).toHaveLength(2);
      const link = screen.getByRole('link', { name: 'brief' });
      expect(link.getAttribute('href')).toBe('https://example.com/b');
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(screen.getAllByRole('link')).toHaveLength(1); // the javascript: link stays text
      expect(screen.getByText(/\[x\]\(javascript:alert\(1\)\)/)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Edit notes' })).toBeTruthy();
    });

    it('offers "Add notes…" when empty, including a legacy row with no notes field', async () => {
      const legacy = mkTask({});
      delete (legacy as { notes?: unknown }).notes;
      renderEditor(api(), legacy);
      expect(screen.getByRole('button', { name: 'Add notes…' })).toBeTruthy();
      expect(screen.queryByLabelText('Notes')).toBeNull();
    });

    it('adds notes through Save, trimmed, and marks the form dirty while editing', async () => {
      const client = api();
      const t = await client.createTask({ title: 'Plain' });
      const setNotes = vi.spyOn(client, 'setTaskNotes');
      const { onClose, onDirtyChange, user } = renderEditor(client, t);

      await user.click(screen.getByRole('button', { name: 'Add notes…' }));
      const field = screen.getByLabelText('Notes');
      expect(document.activeElement).toBe(field);
      await user.type(field, '  ch. 4 q1-8  ');
      expect(onDirtyChange).toHaveBeenLastCalledWith(true); // Close/Esc/backdrop now confirm
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(setNotes).toHaveBeenCalledWith(t.id, 'ch. 4 q1-8');
      await waitFor(async () => expect((await client.getTask(t.id))?.notes).toBe('ch. 4 q1-8'));
      // Stays open, back on the rendered note, clean.
      expect(await screen.findByText('Saved')).toBeTruthy();
      expect(screen.queryByLabelText('Notes')).toBeNull();
      expect(screen.getByText('ch. 4 q1-8')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Edit notes' })).toBeTruthy();
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('leaves notes alone when only another field changed', async () => {
      const client = api();
      const t = await client.createTask({ title: 'Has notes', notes: 'keep' });
      const setNotes = vi.spyOn(client, 'setTaskNotes');
      const first = renderEditor(client, t);
      fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-10-01' } });
      await first.user.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByText('Saved')).toBeTruthy();
      expect(setNotes).not.toHaveBeenCalled();
    });

    it('saves a cleared note as null', async () => {
      const client = api();
      const t = await client.createTask({ title: 'Has notes', notes: 'drop me' });
      const setNotes = vi.spyOn(client, 'setTaskNotes');
      const { user } = renderEditor(client, t);
      await user.click(screen.getByRole('button', { name: 'Edit notes' }));
      await user.clear(screen.getByLabelText('Notes'));
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(setNotes).toHaveBeenCalledWith(t.id, null);
    });

    it('stays editable on a finished task', async () => {
      const client = api();
      let t = await client.createTask({ title: 'Done', estimateMin: 30 });
      t = await client.transitionTask(t.id, 'in_progress');
      t = await client.transitionTask(t.id, 'done');
      renderEditor(client, t);
      expect(screen.getByRole('button', { name: 'Add notes…' })).toBeTruthy();
    });

    it('shows the counter near the cap and disables Save over it, without truncating', async () => {
      const client = api();
      const t = await client.createTask({ title: 'Long' });
      const { user } = renderEditor(client, t);
      await user.click(screen.getByRole('button', { name: 'Add notes…' }));
      const field = screen.getByLabelText('Notes');

      fireEvent.change(field, { target: { value: 'x'.repeat(4400) } });
      expect(screen.queryByText(/\/ 5,000/)).toBeNull(); // quiet until close to the cap

      fireEvent.change(field, { target: { value: 'x'.repeat(5000) } });
      expect(screen.getByText('5,000 / 5,000')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false);

      fireEvent.change(field, { target: { value: 'x'.repeat(5100) } });
      expect(screen.getByText(/5,100 \/ 5,000/)).toBeTruthy();
      expect(field.getAttribute('aria-invalid')).toBe('true');
      expect((field as HTMLTextAreaElement).value).toHaveLength(5100); // never silently truncated
      expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    });
  });
});
