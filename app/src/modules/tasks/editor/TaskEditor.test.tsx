import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import type { ApiClient, Task } from '@aperture/shared';
import { renderWithProviders } from '../../../test/utils';
import { createStubClient } from '../../../data/stubClient';
import { TaskDetailsForm } from './TaskDetailsForm';
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
  splitFromId: null,
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
    const failed = { ...t, gcalSyncError: 'Couldn’t add the calendar event (invalid_grant)' };
    const sync = vi.spyOn(client, 'syncCalendarEvent');
    const { user } = renderEditor(client, failed);
    expect(screen.getByRole('alert').textContent).toMatch(
      /Couldn’t add the calendar event \(invalid_grant\)/,
    );
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(sync).toHaveBeenCalledWith(t.id);
  });

  it('a change under the open editor (a calendar pull) refills untouched fields — never goes dirty', async () => {
    const client = api();
    const t = await client.createTask({ title: 'Open', dueDay: '2026-10-09', dueTime: '16:00' });
    let push: (next: Task) => void = () => {};
    const dirty = vi.fn();
    function Host() {
      const [live, setLive] = useState(t);
      push = setLive;
      return <TaskDetailsForm task={live} onDirtyChange={dirty} />;
    }
    renderWithProviders(<Host />, { api: client });
    const user = userEvent.setup();
    const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
    // Mid-edit of the title: that draft stays; the untouched due time follows the pull.
    await user.clear(field('Title'));
    await user.type(field('Title'), 'my draft');
    act(() => push({ ...t, title: 'From Google', dueTime: '18:00', updatedAt: t.updatedAt + 1 }));
    expect(field('Due time').value).toBe('18:00');
    expect(field('Title').value).toBe('my draft');
    // Back to untouched (the draft cleared to what it was filled from) → the next pull refills it, clean.
    await user.clear(field('Title'));
    await user.type(field('Title'), 'From Google');
    act(() => push({ ...t, title: 'Again', dueTime: '19:00', updatedAt: t.updatedAt + 2 }));
    expect(field('Title').value).toBe('Again');
    expect(field('Due time').value).toBe('19:00');
    await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false));
  });

  it('an open, untouched notes draft follows a change made elsewhere', async () => {
    const client = api();
    const t = await client.createTask({ title: 'Notes', notes: 'old note' });
    let push: (next: Task) => void = () => {};
    function Host() {
      const [live, setLive] = useState(t);
      push = setLive;
      return <TaskDetailsForm task={live} />;
    }
    renderWithProviders(<Host />, { api: client });
    // An open, untouched notes draft follows the change (so a Save can't write the old note back).
    fireEvent.click(screen.getByRole('button', { name: 'Edit notes' }));
    act(() => push({ ...t, notes: 'new note', updatedAt: t.updatedAt + 1 }));
    expect((screen.getByLabelText('Notes') as HTMLTextAreaElement).value).toBe('new note');
  });

  it('due day + time refill as a pair: a draft time is never put on Google’s day', async () => {
    const client = api();
    const t = await client.createTask({ title: 'Pair', dueDay: '2026-10-09', dueTime: '16:00' });
    let push: (next: Task) => void = () => {};
    function Host() {
      const [live, setLive] = useState(t);
      push = setLive;
      return <TaskDetailsForm task={live} />;
    }
    renderWithProviders(<Host />, { api: client });
    const time = screen.getByLabelText('Due time') as HTMLInputElement;
    fireEvent.change(time, { target: { value: '09:00' } });
    act(() => push({ ...t, dueDay: '2026-10-12', dueTime: '18:00', updatedAt: t.updatedAt + 1 }));
    expect(time.value).toBe('09:00');
    expect((screen.getByLabelText('Due') as HTMLInputElement).value).toBe('2026-10-09');
  });

  it('says what Google changed, today only', async () => {
    const client = api();
    const t = await client.createTask({ title: 'Pulled', dueDay: '2026-10-09', dueTime: '17:00' });
    const note = 'Moved to Oct 9 5pm in Google Calendar';
    renderEditor(client, { ...t, gcalPulled: { at: Date.now(), note } });
    expect(screen.getAllByRole('status').some((el) => el.textContent === note)).toBe(true);
  });

  it('a kept-out Google change offers one tap to send Aperture’s value — gone once nothing is unsent', async () => {
    const client = createStubClient({ seed: true, storageKey: `editor-${Math.random()}` });
    const t = await client.createTask({ title: 'Mine', dueDay: '2026-10-09', dueTime: '17:00' });
    const kept = {
      ...t,
      title: 'Mine, renamed', // never reached Google
      gcalPulled: { at: Date.now(), note: 'Kept your title — renamed in Google Calendar too' },
    };
    const sync = vi.spyOn(client, 'syncCalendarEvent');
    const { user } = renderEditor(client, kept);
    await user.click(await screen.findByRole('button', { name: 'Send to Google' }));
    expect(sync).toHaveBeenCalledWith(t.id);
  });

  it('no send button when nothing is unsent', async () => {
    const client = createStubClient({ seed: true, storageKey: `editor-${Math.random()}` });
    const t = await client.createTask({ title: 'Mine', dueDay: '2026-10-09', dueTime: '17:00' });
    const note = { at: Date.now(), note: 'Kept your title — renamed in Google Calendar too' };
    renderEditor(client, { ...t, gcalPulled: note }); // in step with its event
    await screen.findByText(note.note);
    expect(screen.queryByRole('button', { name: 'Send to Google' })).toBeNull();
  });

  it('no send button on a done task (it never pushes)', async () => {
    const client = createStubClient({ seed: true, storageKey: `editor-${Math.random()}` });
    const t = await client.createTask({ title: 'Mine', dueDay: '2026-10-09', dueTime: '17:00' });
    const note = { at: Date.now(), note: 'Kept your title — renamed in Google Calendar too' };
    renderEditor(client, { ...t, status: 'done', title: 'Mine, renamed', gcalPulled: note });
    await screen.findByText(note.note);
    expect(screen.queryByRole('button', { name: 'Send to Google' })).toBeNull();
  });

  it('an old Google change is not repeated after the rollover', () => {
    const client = api();
    renderEditor(client, mkTask({ gcalPulled: { at: Date.now() - 2 * 86_400_000, note: 'old' } }));
    expect(screen.queryByText('old')).toBeNull();
  });

  it('a timed task with no event (timed while sync was off) offers a one-tap add', async () => {
    const client = api();
    await client.updateSettings({
      calendarWriteDefault: { accountSub: 'a', calendarId: 'me@example.com' },
      autoCalendar: false,
    });
    const t = await client.createTask({
      title: 'Late add',
      dueDay: '2026-10-01',
      dueTime: '16:00',
    });
    expect(t.gcalEventId).toBeNull();
    await client.updateSettings({ autoCalendar: true });
    const sync = vi.spyOn(client, 'syncCalendarEvent');
    const { user } = renderEditor(client, t);
    expect(await screen.findByText('Not on your calendar.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add to calendar' }));
    expect(sync).toHaveBeenCalledWith(t.id);
  });

  it('a refused calendar add is said inline and keeps the picker open', async () => {
    const client = createStubClient({ seed: true, storageKey: `editor-${Math.random()}` });
    const t = await client.createTask({ title: 'Picked', dueDay: '2026-10-01' });
    vi.spyOn(client, 'insertCalendarEvent').mockRejectedValue(new Error('Auto-sync places it'));
    const { user } = renderEditor(client, t);
    await user.click(await screen.findByRole('button', { name: 'Add to calendar…' }));
    await user.click(await screen.findByRole('button', { name: 'Add to calendar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Auto-sync places it');
    expect(screen.getByLabelText('Start')).toBeTruthy();
  });

  it('says so when the calendar retry itself fails', async () => {
    const client = api();
    const t = await client.createTask({ title: 'Offline', dueDay: '2026-10-01', dueTime: '16:00' });
    vi.spyOn(client, 'syncCalendarEvent').mockRejectedValue(new Error('offline'));
    const { user } = renderEditor(client, {
      ...t,
      gcalSyncError: 'Couldn’t add the calendar event (x)',
    });
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/Couldn’t reach the calendar sync/)).toBeTruthy();
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

  it('keeps the estimate editable once work has started, with the lock copy', async () => {
    const client = api();
    let t = await client.createTask({ title: 'Started', estimateMin: 45 });
    t = await client.transitionTask(t.id, 'in_progress'); // freezes estimateLockedMin = 45
    const { user } = renderEditor(client, t);
    expect(screen.getByText(/Started at 45m/)).toBeTruthy();
    const field = screen.getByLabelText('Estimate (min)');
    await user.clear(field);
    await user.type(field, '90');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () =>
      expect(await client.getTask(t.id)).toMatchObject({ estimateMin: 90, estimateLockedMin: 45 }),
    );
  });

  it('shows the estimate read-only on a finished task', async () => {
    const client = api();
    let t = await client.createTask({ title: 'Finished', estimateMin: 30 });
    t = await client.transitionTask(t.id, 'in_progress');
    t = await client.transitionTask(t.id, 'done');
    renderEditor(client, t);
    expect(screen.queryByLabelText('Estimate (min)')).toBeNull();
    expect(screen.getByText('Details')).toBeTruthy();
  });

  it('a done split needs an actual, then closes and links the rest', async () => {
    const client = api();
    let t = await client.createTask({ title: 'Pset', estimateMin: 45 });
    t = await client.transitionTask(t.id, 'in_progress');
    const { onClose, user } = renderEditor(client, t);
    await user.click(screen.getByRole('button', { name: /^Split/ }));
    expect(
      screen.getByRole('button', { name: 'Done with this part' }).getAttribute('aria-pressed'),
    ).toBe('true');
    const submit = screen.getByRole('button', { name: 'Split' });
    expect(submit.hasAttribute('disabled')).toBe(true); // nothing tracked → the actual starts empty
    await user.type(screen.getByLabelText("This part's actual (min)"), '20');
    expect(screen.getByLabelText<HTMLInputElement>("New task's title").value).toBe('Pset (cont.)');
    expect(screen.getByLabelText<HTMLInputElement>("New task's estimate (min)").value).toBe('45'); // 45 − 0
    expect(
      screen.getByText(/latest plan day, else the backlog · Both parts: 1h 5m · was 45m/),
    ).toBeTruthy();
    await user.click(submit);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const rest = (await client.listTasks()).find((x) => x.title === 'Pset (cont.)');
    expect(rest).toMatchObject({ splitFromId: t.id, estimateMin: 45 });
    expect(await client.getTask(t.id)).toMatchObject({ status: 'done', actualAccruedMin: 20 });
  });

  it('a keep split stays open, shows "Split into", and returns focus to Split…', async () => {
    const client = api();
    let t = await client.createTask({ title: 'Essay', estimateMin: 60 });
    t = await client.transitionTask(t.id, 'in_progress');
    const { onClose, user } = renderEditor(client, t);
    await user.click(screen.getByRole('button', { name: /^Split/ }));
    await user.click(screen.getByRole('button', { name: 'Keep going' }));
    // Keep's defaults never invent scope: what's left is shared between the parts.
    const thisEstimate = screen.getByLabelText<HTMLInputElement>("This part's estimate (min)");
    expect(thisEstimate.value).toBe('30');
    expect(screen.getByLabelText<HTMLInputElement>("New task's estimate (min)").value).toBe('30');
    await user.clear(thisEstimate);
    await user.type(thisEstimate, '40');
    await user.click(screen.getByRole('button', { name: 'Split' }));
    expect(await screen.findByText('Essay (cont.)')).toBeTruthy(); // the "Split into" row
    expect(screen.getByText('Split into')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Split…'));
    expect(await client.getTask(t.id)).toMatchObject({ status: 'in_progress', estimateMin: 40 });
  });

  it('rejects negative minutes inline, and Cancel returns focus to Split…', async () => {
    const client = api();
    let t = await client.createTask({ title: 'Lab', estimateMin: 30 });
    t = await client.transitionTask(t.id, 'in_progress');
    const { user } = renderEditor(client, t);
    await user.click(screen.getByRole('button', { name: /^Split/ }));
    await user.type(screen.getByLabelText("This part's actual (min)"), '-5');
    expect(screen.getByText(/can't be negative/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Split' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!); // the split's
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Split…'));
  });

  it('a done split family member shows no delta bar and says it is not measured alone', async () => {
    const client = api();
    let t = await client.createTask({ title: 'Report', estimateMin: 60 });
    t = await client.transitionTask(t.id, 'in_progress');
    const { original } = await client.splitTask(t.id, {
      finish: 'done',
      actualMin: 50,
      followUp: { title: 'Report, rest', estimateMin: 30 },
    });
    renderEditor(client, original);
    expect(await screen.findByText('Report, rest')).toBeTruthy(); // the "Split into" row (list loaded)
    expect(screen.getByText(/isn’t measured on its own/)).toBeTruthy();
    expect(screen.queryByText(/over|under/i)).toBeNull(); // no DeltaBar verdict
  });

  it('reseeds untouched fields when the task changes elsewhere (a split), keeping edits in progress', async () => {
    const client = api();
    const t = await client.createTask({ title: 'Old name', estimateMin: 60 });
    let push: (next: Task) => void = () => {};
    function Harness() {
      const [task, setTask] = useState(t);
      push = setTask;
      return <TaskDetailsForm task={task} />;
    }
    const user = userEvent.setup();
    renderWithProviders(<Harness />, { api: client });
    await user.type(screen.getByLabelText('Buffer (min)'), '5'); // an edit in progress
    act(() => push({ ...t, title: 'New name', estimateMin: 30, updatedAt: t.updatedAt + 1 }));
    expect(screen.getByLabelText<HTMLTextAreaElement>('Title').value).toBe('New name');
    expect(screen.getByLabelText<HTMLInputElement>('Estimate (min)').value).toBe('30');
    expect(screen.getByLabelText<HTMLInputElement>('Buffer (min)').value).toBe('5');
  });

  it('a task started then rolled back says its rest stays in the split family', async () => {
    const client = api();
    let t = await client.createTask({ title: 'Rolled', estimateMin: 60 });
    await client.transitionTask(t.id, 'in_progress');
    t = await client.transitionTask(t.id, 'backlog'); // keeps its lock
    const { user } = renderEditor(client, t);
    await user.click(screen.getByRole('button', { name: /^Split/ }));
    expect(screen.queryByRole('button', { name: 'Done with this part' })).toBeNull();
    expect(screen.getByText(/rest stays part of this task’s split family/)).toBeTruthy();
  });

  it('splitting an unstarted task offers no Done and makes an independent task', async () => {
    const client = api();
    const t = await client.createTask({ title: 'Reading', estimateMin: 60 });
    const { user } = renderEditor(client, t);
    await user.click(screen.getByRole('button', { name: /^Split/ }));
    expect(screen.queryByRole('button', { name: 'Done with this part' })).toBeNull();
    expect(screen.getByText(/Not started yet/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Split' }));
    await waitFor(async () =>
      expect((await client.listTasks()).find((x) => x.title === 'Reading (cont.)')).toMatchObject({
        status: 'backlog',
        splitFromId: null,
      }),
    );
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
