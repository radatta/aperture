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
  renderWithProviders(
    <TaskEditor
      task={task}
      intent={intent}
      onClose={onClose}
      onRequestClose={vi.fn()}
      onDirtyChange={vi.fn()}
    />,
    { api: client },
  );
  return { onClose, user: userEvent.setup() };
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
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('disables Save when the title is blank', async () => {
    const client = api();
    const t = await client.createTask({ title: 'Has a name' });
    const { user } = renderEditor(client, t);
    await user.clear(screen.getByLabelText('Title'));
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
  });

  it('saves only the changed field and closes', async () => {
    const client = api();
    const t = await client.createTask({ title: 'Edit me', estimateMin: 30 });
    const setDue = vi.spyOn(client, 'setTaskDueDay');
    const setEst = vi.spyOn(client, 'setTaskEstimate');
    const { onClose, user } = renderEditor(client, t);

    fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-10-01' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(setDue).toHaveBeenCalledWith(t.id, '2026-10-01');
    expect(setEst).not.toHaveBeenCalled(); // estimate untouched
    await waitFor(() => expect(onClose).toHaveBeenCalled());
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
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
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
});
