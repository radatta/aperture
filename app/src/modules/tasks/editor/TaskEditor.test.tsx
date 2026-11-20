import { describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { todayKey } from '@aperture/shared';
import type { ApiClient, Task } from '@aperture/shared';
import { renderWithProviders } from '../../../test/utils';
import { createStubClient } from '../../../data/stubClient';
import { TaskDetailsForm } from './TaskDetailsForm';
import { usePomodoro } from '../../pomodoro/pomodoro-context';
import { editState } from './editState';
import type { EditSlots } from './editState';
import { TaskEditor } from './TaskEditor';
import type { TaskEditorIntent } from './TaskEditor';

function api(): ApiClient {
  return createStubClient({ seed: false, storageKey: `editor-${Math.random()}` });
}

// What the modal reads: each form's slot, folded.
const slots = (): EditSlots => ({
  details: 'clean',
  reveal: 'clean',
  finish: 'clean',
  changed: vi.fn(),
});

function renderEditor(client: ApiClient, task: Task, intent: TaskEditorIntent = 'view') {
  const onFinished = vi.fn();
  const edits = slots();
  renderWithProviders(
    <TaskEditor
      task={task}
      intent={intent}
      edits={edits}
      onFinished={onFinished}
      onRequestClose={vi.fn()}
      onLeaveReveal={(go) => go()}
    />,
    { api: client },
  );
  return { onFinished, edits, user: userEvent.setup() };
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
  reflection: null,
  seriesId: null,
  rollId: null,
  estimateMin: null,
  bufferMin: null,
  estimateLockedMin: null,
  parentId: null,
  place: null,
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
  it('a series deadline occurrence shows its “Planned today” — its time is only a deadline (recurring D8)', async () => {
    const client = api();
    await client.upsertSeries({
      title: 'Pre-lab',
      categoryId: null,
      defaultEstimateMin: 45,
      rule: { kind: 'daily' },
      anchorDate: todayKey(4),
      dueOffsetDays: 1,
      dueTime: '14:00',
    });
    await client.getDay(todayKey(4));
    const [row] = await client.listPlansForDay(todayKey(4));
    renderEditor(client, (await client.getTask(row!.taskId))!);
    expect(await screen.findByText('Planned today')).toBeTruthy();
  });

  it('a timed task with an old row today shows no “Planned today” — its day is its time', async () => {
    const client = api();
    const t = await client.createTask({ title: 'pset', estimateMin: 40 });
    await client.upsertPlan({ taskId: t.id, day: todayKey(4), plannedMinutes: 40, order: 0 });
    renderEditor(client, t);
    expect(await screen.findByText('Planned today')).toBeTruthy();
    cleanup();
    const timed = await client.setTaskDue(t.id, { dueDay: todayKey(4), dueTime: '23:58' });
    const plansRead = vi.spyOn(client, 'listPlansForDay');
    renderEditor(client, timed);
    // The row is there to read: wait for it to be read, then for the render after.
    await waitFor(() => expect(plansRead).toHaveReturned());
    await act(async () => {
      await plansRead.mock.results[0]!.value;
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByText('Planned today')).toBeNull();
  });

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
    const { onFinished, user } = renderEditor(client, t);

    const field = screen.getByLabelText('Title');
    await user.clear(field);
    await user.type(field, 'New name');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(setTitle).toHaveBeenCalledWith(t.id, 'New name'); // trimmed
    await waitFor(async () => expect((await client.getTask(t.id))?.title).toBe('New name'));
    // Save keeps the modal open and says so.
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Title').value).toBe('New name');
    expect(onFinished).not.toHaveBeenCalled();
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
    const { onFinished, user } = renderEditor(client, t);

    fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-10-01' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(setDue).toHaveBeenCalledWith(t.id, { dueDay: '2026-10-01', dueTime: null });
    expect(setEst).not.toHaveBeenCalled(); // estimate untouched
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Due').value).toBe('2026-10-01');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.getAttribute('aria-disabled')).toBe('true'); // nothing left to save
    expect(onFinished).not.toHaveBeenCalled();

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
    const { edits, user } = renderEditor(client, t);

    const field = screen.getByLabelText('Title');
    await user.type(field, ' one');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    // Mid-save the form says so, not "dirty" (a "Discard" now would be a lie)…
    await waitFor(() => expect(editState(edits)).toBe('saving'));
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

  it('a due time the field reports with seconds (Safari) saves as HH:MM, first try', async () => {
    const client = api();
    const t = await client.createTask({ title: 'Timed' });
    const setDue = vi.spyOn(client, 'setTaskDue');
    const { user } = renderEditor(client, t);
    fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-10-30' } });
    fireEvent.change(screen.getByLabelText('Due time'), { target: { value: '03:00:00' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(setDue).toHaveBeenCalledWith(t.id, { dueDay: '2026-10-30', dueTime: '03:00' });
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect((await client.getTask(t.id))?.dueTime).toBe('03:00');
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
    const edits = slots();
    function Host() {
      const [live, setLive] = useState(t);
      push = setLive;
      return <TaskDetailsForm task={live} edits={edits} />;
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
    await waitFor(() => expect(editState(edits)).toBe('clean'));
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

  it('a mixed note (something applied, something kept) offers the send too', async () => {
    const client = createStubClient({ seed: true, storageKey: `editor-${Math.random()}` });
    const t = await client.createTask({ title: 'Mine', dueDay: '2026-10-09', dueTime: '17:00' });
    renderEditor(client, {
      ...t,
      title: 'Mine, renamed',
      gcalPulled: {
        at: Date.now(),
        note: 'Moved to Oct 9 5pm in Google Calendar · Kept your title',
      },
    });
    expect(await screen.findByRole('button', { name: 'Send to Google' })).toBeTruthy();
  });

  it('a failed send is said, never a dead button', async () => {
    const client = createStubClient({ seed: true, storageKey: `editor-${Math.random()}` });
    const t = await client.createTask({ title: 'Mine', dueDay: '2026-10-09', dueTime: '17:00' });
    const note = { at: Date.now(), note: 'Kept your title — renamed in Google Calendar too' };
    vi.spyOn(client, 'syncCalendarEvent').mockRejectedValueOnce(new Error('offline'));
    const { user } = renderEditor(client, { ...t, title: 'Mine, renamed', gcalPulled: note });
    await user.click(await screen.findByRole('button', { name: 'Send to Google' }));
    expect(await screen.findByText(/Couldn’t reach the calendar sync/)).toBeTruthy();
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
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Couldn’t add it to your calendar: Auto-sync places it',
    );
    expect(screen.getByLabelText('Start')).toBeTruthy();
  });

  it('a cleared Start can’t be sent — said, never a NaN block', async () => {
    const client = createStubClient({ seed: true, storageKey: `editor-${Math.random()}` });
    const t = await client.createTask({ title: 'Picked', dueDay: '2026-10-01' });
    const insert = vi.spyOn(client, 'insertCalendarEvent');
    const { user } = renderEditor(client, t);
    await user.click(await screen.findByRole('button', { name: 'Add to calendar…' }));
    const add = await screen.findByRole('button', { name: 'Add to calendar' });
    expect(add.hasAttribute('disabled')).toBe(false);
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '' } });
    expect(add.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Pick a start time and a length first.')).toBeTruthy();
    // A start with seconds (Safari's time field) is taken as HH:MM.
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '10:30:00' } });
    expect(screen.getByLabelText<HTMLInputElement>('Start').value).toBe('10:30');
    expect(add.hasAttribute('disabled')).toBe(false);
    // A cleared length is a zero-length block: the same.
    fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '' } });
    expect(add.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Pick a start time and a length first.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '30' } });
    expect(screen.queryByText('Pick a start time and a length first.')).toBeNull();
    await user.click(add);
    await waitFor(() => expect(insert).toHaveBeenCalledTimes(1));
    const sent = insert.mock.calls[0]![0];
    expect(sent.endMs - sent.startMs).toBe(30 * 60_000);
    expect(Number.isFinite(sent.startMs)).toBe(true);
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
    const { onFinished, user } = renderEditor(client, t);

    fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-10-01' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/Couldn’t save/)).toBeTruthy();
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Due').value).toBe('2026-10-01');
    expect(onFinished).not.toHaveBeenCalled();
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
    await client.setTaskActual(t.id, 30);
    t = await client.transitionTask(t.id, 'done');
    renderEditor(client, t);
    expect(screen.queryByLabelText('Estimate (min)')).toBeNull();
    expect(screen.getByText('Details')).toBeTruthy();
  });

  it('a done split needs an actual, then closes; the task becomes Part 1 under a new parent', async () => {
    const client = api();
    let t = await client.createTask({ title: 'Pset', estimateMin: 45 });
    t = await client.transitionTask(t.id, 'in_progress');
    const { onFinished, user } = renderEditor(client, t);
    await user.click(screen.getByRole('button', { name: /^Split/ }));
    expect(
      screen.getByRole('button', { name: 'Done with this part' }).getAttribute('aria-pressed'),
    ).toBe('true');
    const submit = screen.getByRole('button', { name: 'Split' });
    expect(submit.hasAttribute('disabled')).toBe(true); // nothing tracked → the actual starts empty
    await user.type(screen.getByLabelText("This part's actual (min)"), '20');
    expect(screen.getByLabelText<HTMLInputElement>("Deliverable's title").value).toBe('Pset');
    expect(screen.getByLabelText<HTMLInputElement>("This part's title").value).toBe('Part 1');
    expect(screen.getByLabelText<HTMLInputElement>("Next part's title").value).toBe('Part 2');
    expect(screen.getByLabelText<HTMLInputElement>("Next part's estimate (min)").value).toBe('45'); // 45 − 0
    expect(
      screen.getByText(/latest plan day, else the backlog · Both parts: 1h 5m · was 45m/),
    ).toBeTruthy();
    expect(screen.getByText(/“Pset” keeps the due date/)).toBeTruthy();
    await user.click(submit);
    // The task as the split returned it: the modal closes from that, not the list's refetch.
    await waitFor(() =>
      expect(onFinished).toHaveBeenCalledWith(
        expect.objectContaining({ id: t.id, status: 'done' }),
        true,
      ),
    );
    const all = await client.listTasks();
    const parent = all.find((x) => x.title === 'Pset' && x.id !== t.id)!;
    expect(all.find((x) => x.title === 'Part 2')).toMatchObject({
      parentId: parent.id,
      estimateMin: 45,
    });
    expect(await client.getTask(t.id)).toMatchObject({
      title: 'Part 1',
      parentId: parent.id,
      status: 'done',
      actualAccruedMin: 20,
    });
  });

  it('a done split stops this task’s running timer first; the follow-up starts at zero', async () => {
    // The stub's clock sits 7 minutes behind while the timer starts; a heartbeat at real time banks the gap
    // (and keeps the timer fresh enough to adopt), so the split's Actual prefills with 7.
    let behindMs = 7 * 60_000;
    const client = createStubClient({
      seed: false,
      storageKey: `editor-${Math.random()}`,
      now: () => Date.now() - behindMs,
    });
    let t = await client.createTask({ title: 'Pset', estimateMin: 45 });
    t = await client.transitionTask(t.id, 'in_progress');
    const session = await client.startSession({
      taskId: t.id,
      categoryId: null,
      kind: 'work',
      day: '2026-08-04',
    });
    behindMs = 0;
    await client.heartbeatSession(session.id);
    const order: string[] = [];
    const stopSession = client.stopSession.bind(client);
    const splitTask = client.splitTask.bind(client);
    vi.spyOn(client, 'stopSession').mockImplementation((...a) => {
      order.push('stop');
      return stopSession(...a);
    });
    vi.spyOn(client, 'splitTask').mockImplementation((...a) => {
      order.push('split');
      return splitTask(...a);
    });
    // Mounted once the engine has adopted the timer, as the real app has long before a modal opens.
    function WhenAdopted() {
      const { timers } = usePomodoro();
      return timers.length ? (
        <TaskEditor
          task={t}
          intent="view"
          edits={slots()}
          onFinished={onFinished}
          onRequestClose={vi.fn()}
          onLeaveReveal={(go) => go()}
        />
      ) : null;
    }
    const onFinished = vi.fn();
    renderWithProviders(<WhenAdopted />, { api: client });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Split/ }));
    const actual = screen.getByLabelText<HTMLInputElement>("This part's actual (min)");
    expect(actual.value).toBe('7'); // the live timer, not the task's persisted 0
    await user.clear(actual);
    await user.type(actual, '20');
    await user.click(screen.getByRole('button', { name: 'Split' }));
    await waitFor(() =>
      expect(onFinished).toHaveBeenCalledWith(
        expect.objectContaining({ id: t.id, status: 'done' }),
        true,
      ),
    );
    expect(order).toEqual(['stop', 'split']);
    expect(await client.listRunningSessions()).toEqual([]);
    const stopped = (await client.listSessionsForDay('2026-08-04')).find(
      (s) => s.id === session.id,
    );
    expect(stopped?.status).toBe('completed');
    expect(stopped?.activeMinutes).toBeCloseTo(7, 0);
    expect(await client.getTask(t.id)).toMatchObject({ status: 'done', actualAccruedMin: 20 });
    const all = await client.listTasks();
    expect(all.find((x) => x.title === 'Part 2')).toMatchObject({ actualAccruedMin: 0 });
  });

  it('a keep split stays open, stores the typed titles, and returns focus to Split…', async () => {
    // A frame before React's commit (as a browser can run one, after the split's await): focus still
    // returns once the form has gone.
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    const client = api();
    let t = await client.createTask({ title: 'Essay', estimateMin: 60 });
    t = await client.transitionTask(t.id, 'in_progress');
    const { onFinished, user } = renderEditor(client, t);
    await user.click(screen.getByRole('button', { name: /^Split/ }));
    await user.click(screen.getByRole('button', { name: 'Keep going' }));
    // Keep's defaults never invent scope: what's left is shared between the parts.
    const thisEstimate = screen.getByLabelText<HTMLInputElement>("This part's estimate (min)");
    expect(thisEstimate.value).toBe('30');
    expect(screen.getByLabelText<HTMLInputElement>("Next part's estimate (min)").value).toBe('30');
    await user.clear(thisEstimate);
    await user.type(thisEstimate, '40');
    // Every title is editable before anything is created — what's typed is what's stored.
    const retitle = async (label: string, text: string) => {
      await user.clear(screen.getByLabelText(label));
      await user.type(screen.getByLabelText(label), text);
    };
    await retitle("Deliverable's title", 'Essay final');
    await retitle("This part's title", 'outline');
    await retitle("Next part's title", 'draft');
    await user.click(screen.getByRole('button', { name: 'Split' }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Split…'));
    expect(onFinished).not.toHaveBeenCalled();
    const all = await client.listTasks();
    const parent = all.find((x) => x.title === 'Essay final')!;
    expect(await client.getTask(t.id)).toMatchObject({
      title: 'outline',
      status: 'in_progress',
      estimateMin: 40,
      parentId: parent.id,
    });
    expect(all.find((x) => x.title === 'draft')?.parentId).toBe(parent.id);
    expect(all.some((x) => x.title === 'Part 1')).toBe(false);
  });

  it('split titles typed but not split count as unsaved; Cancel clears it', async () => {
    const client = api();
    let t = await client.createTask({ title: 'Essay', estimateMin: 60 });
    t = await client.transitionTask(t.id, 'in_progress');
    const { edits, user } = renderEditor(client, t);
    await user.click(screen.getByRole('button', { name: /^Split/ }));
    // The mode toggle alone isn't an edit (it re-defaults the rest's estimate).
    await user.click(screen.getByRole('button', { name: 'Keep going' }));
    expect(editState(edits)).toBe('clean');
    await user.type(screen.getByLabelText("This part's title"), ' 2');
    expect(editState(edits)).toBe('dirty');
    await user.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!); // the split's
    expect(editState(edits)).toBe('clean');
  });

  it('a split on its way reads as saving, not unsaved — an exit waits for it', async () => {
    const client = api();
    let t = await client.createTask({ title: 'Essay', estimateMin: 60 });
    t = await client.transitionTask(t.id, 'in_progress');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = client.splitTask.bind(client);
    vi.spyOn(client, 'splitTask').mockImplementation((id, input) =>
      gate.then(() => original(id, input)),
    );
    const { edits, user } = renderEditor(client, t);
    await user.click(screen.getByRole('button', { name: /^Split/ }));
    await user.click(screen.getByRole('button', { name: 'Keep going' }));
    await user.type(screen.getByLabelText("This part's title"), ' 2');
    await user.click(screen.getByRole('button', { name: 'Split' }));
    expect(editState(edits)).toBe('saving');
    await act(async () => release());
    await waitFor(() => expect(screen.queryByLabelText("This part's title")).toBeNull());
    expect(editState(edits)).toBe('clean');
  });

  it('a done split of an unscoped task asks for its estimate and sends it; a scoped one is not asked', async () => {
    const client = api();
    let t = await client.createTask({ title: 'Unscoped' });
    t = await client.transitionTask(t.id, 'in_progress');
    const user = userEvent.setup();
    const split = vi.spyOn(client, 'splitTask');
    renderEditor(client, t);
    await user.click(screen.getByRole('button', { name: /^Split/ }));
    await user.type(screen.getByLabelText("This part's actual (min)"), '20');
    const go = screen.getByRole<HTMLButtonElement>('button', { name: 'Split' });
    expect(go.disabled).toBe(true);
    await user.type(screen.getByLabelText("This part's estimate in hindsight"), '0');
    expect(screen.getByText('Whole minutes, at least 1.')).toBeTruthy();
    expect(go.disabled).toBe(true);
    await user.clear(screen.getByLabelText("This part's estimate in hindsight"));
    await user.type(screen.getByLabelText("This part's estimate in hindsight"), '15');
    expect(go.disabled).toBe(false);
    await user.click(go);
    await waitFor(() => expect(split).toHaveBeenCalled());
    expect(split.mock.calls[0]![1]).toMatchObject({
      finish: 'done',
      actualMin: 20,
      estimateMin: 15,
    });
    expect(await client.getTask(t.id)).toMatchObject({
      estimateLockedMin: 15,
      estimateSource: 'retro',
    });
  });

  it('a done split of a scoped task has no estimate field, and 0 actual blocks it', async () => {
    const client = api();
    let t = await client.createTask({ title: 'Scoped', estimateMin: 30 });
    t = await client.transitionTask(t.id, 'in_progress');
    const user = userEvent.setup();
    renderEditor(client, t);
    await user.click(screen.getByRole('button', { name: /^Split/ }));
    expect(screen.queryByLabelText("This part's estimate in hindsight")).toBeNull();
    await user.type(screen.getByLabelText("This part's actual (min)"), '0');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Split' }).disabled).toBe(true);
  });

  it('switching a done split to Keep going and back keeps what was typed', async () => {
    const client = api();
    let t = await client.createTask({ title: 'Unscoped' });
    t = await client.transitionTask(t.id, 'in_progress');
    const user = userEvent.setup();
    renderEditor(client, t);
    await user.click(screen.getByRole('button', { name: /^Split/ }));
    await user.type(screen.getByLabelText("This part's actual (min)"), '20');
    await user.type(screen.getByLabelText("This part's estimate in hindsight"), '15');
    await user.click(screen.getByRole('button', { name: 'Keep going' }));
    expect(screen.getByLabelText<HTMLInputElement>("This part's estimate (min)").value).toBe('15');
    expect(screen.queryByLabelText("This part's actual (min)")).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Done with this part' }));
    expect(screen.getByLabelText<HTMLInputElement>("This part's actual (min)").value).toBe('20');
    expect(screen.getByLabelText<HTMLInputElement>("This part's estimate in hindsight").value).toBe(
      '15',
    );
  });

  it('a negative typed in Keep going, on a scoped task, does not block a done split it no longer shows', async () => {
    const client = api();
    let t = await client.createTask({ title: 'Scoped', estimateMin: 30 });
    t = await client.transitionTask(t.id, 'in_progress');
    const user = userEvent.setup();
    renderEditor(client, t);
    await user.click(screen.getByRole('button', { name: /^Split/ }));
    await user.click(screen.getByRole('button', { name: 'Keep going' }));
    const est = screen.getByLabelText("This part's estimate (min)");
    await user.clear(est);
    await user.type(est, '-5');
    await user.click(screen.getByRole('button', { name: 'Done with this part' }));
    await user.type(screen.getByLabelText("This part's actual (min)"), '20');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Split' }).disabled).toBe(false);
  });

  it('Keep going refuses a 0 or fractional estimate on either part; Scope refuses them too', async () => {
    const client = api();
    let t = await client.createTask({ title: 'Scoped', estimateMin: 30 });
    t = await client.transitionTask(t.id, 'in_progress');
    const user = userEvent.setup();
    renderEditor(client, t);
    const save = () => screen.getByRole('button', { name: 'Save' });
    const scope = screen.getByLabelText('Estimate (min)');
    await user.clear(scope);
    await user.type(scope, '0');
    expect(save().getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('Whole minutes, at least 1.')).toBeTruthy();
    await user.clear(scope);
    await user.type(scope, '45');
    expect(save().getAttribute('aria-disabled')).toBe('false');
    await user.click(screen.getByRole('button', { name: /^Split/ }));
    await user.click(screen.getByRole('button', { name: 'Keep going' }));
    const split = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Split' });
    const here = screen.getByLabelText("This part's estimate (min)");
    await user.clear(here);
    await user.type(here, '1.5');
    expect(split().disabled).toBe(true);
    await user.clear(here);
    await user.type(here, '10');
    const next = screen.getByLabelText("Next part's estimate (min)");
    await user.clear(next);
    await user.type(next, '0');
    expect(split().disabled).toBe(true);
    await user.clear(next);
    expect(split().disabled).toBe(false); // none is still fine: it arrives unscoped
  });

  it('a negative actual hidden by Keep going does not block the split', async () => {
    const client = api();
    let t = await client.createTask({ title: 'Scoped', estimateMin: 30 });
    t = await client.transitionTask(t.id, 'in_progress');
    const user = userEvent.setup();
    renderEditor(client, t);
    await user.click(screen.getByRole('button', { name: /^Split/ }));
    await user.type(screen.getByLabelText("This part's actual (min)"), '-5');
    await user.click(screen.getByRole('button', { name: 'Keep going' }));
    expect(screen.queryByText('Whole minutes, at least 1.')).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Split' }).disabled).toBe(false);
  });

  it('a done split of an errand takes an actual of 0, as it always did', async () => {
    const client = api();
    await client.upsertPlace({ name: 'Corner Shop', slug: 'corner' });
    let t = await client.createTask({ title: 'stamps', place: 'corner' });
    t = await client.transitionTask(t.id, 'in_progress');
    const user = userEvent.setup();
    renderEditor(client, t);
    await user.click(screen.getByRole('button', { name: /^Split/ }));
    await user.type(screen.getByLabelText("This part's actual (min)"), '0');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Split' }).disabled).toBe(false);
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

  it('a done part is measured on its own: its delta bar shows', async () => {
    const client = api();
    let t = await client.createTask({ title: 'Report', estimateMin: 60 });
    t = await client.transitionTask(t.id, 'in_progress');
    const { original } = await client.splitTask(t.id, {
      finish: 'done',
      title: 'Report, part 1',
      actualMin: 90,
      followUp: { title: 'Report, rest', estimateMin: 30 },
    });
    renderEditor(client, original);
    expect(await screen.findByRole('img', { name: /actual against/ })).toBeTruthy();
    expect(screen.getByText(/calibration is measured against that/)).toBeTruthy();
  });

  it('a backfilled ticket says so beside its delta; an unmarked done task does not', async () => {
    const client = api();
    const t = await client.createTask({ title: 'Old ticket', estimateMin: 30 });
    const [r] = await client.backfillTasks([
      { id: t.id, actualMin: 45, completedDay: todayKey(4) },
    ]);
    renderEditor(client, r!.task);
    expect(await screen.findByText('Backfilled · not scored')).toBeTruthy();
    expect(screen.getByRole('img', { name: /actual against/ })).toBeTruthy();
    cleanup();
    renderEditor(client, { ...r!.task, backfilled: false });
    expect(await screen.findByRole('img', { name: /actual against/ })).toBeTruthy();
    expect(screen.queryByText('Backfilled · not scored')).toBeNull();
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

  it('splitting an unstarted task offers no Done and makes a parent with two backlog parts', async () => {
    const client = api();
    const t = await client.createTask({ title: 'Reading', estimateMin: 60 });
    const { user } = renderEditor(client, t);
    await user.click(screen.getByRole('button', { name: /^Split/ }));
    expect(screen.queryByRole('button', { name: 'Done with this part' })).toBeNull();
    expect(screen.getByText(/each part gets its own estimate/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Split' }));
    await waitFor(async () => {
      const all = await client.listTasks();
      const parent = all.find((x) => x.title === 'Reading' && x.id !== t.id);
      expect(all.find((x) => x.title === 'Part 2')).toMatchObject({
        status: 'backlog',
        parentId: parent?.id,
      });
    });
  });

  describe('parent + parts', () => {
    async function withParts(client: ApiClient, statuses: ('done' | 'open')[]) {
      const p = await client.createTask({ title: 'P2', dueDay: '2026-10-13', dueTime: '23:59' });
      const parts: Task[] = [];
      for (const [i, st] of statuses.entries()) {
        const part = await client.createTask({
          title: `Part ${i + 1}`,
          estimateMin: 30,
          parentId: p.id,
        });
        if (st === 'done') {
          await client.transitionTask(part.id, 'in_progress');
          await client.setTaskActual(part.id, 35);
          await client.transitionTask(part.id, 'done');
        }
        parts.push(part);
      }
      return { p: (await client.getTask(p.id))!, parts };
    }

    it('a parent shows its parts and a read-only sum; no Split, no estimate fields, no picker', async () => {
      const client = api();
      const { p } = await withParts(client, ['done', 'open']);
      renderEditor(client, p);
      expect(await screen.findByText('Parts · 1/2')).toBeTruthy();
      expect(screen.getByText(/1h — the sum of its parts/)).toBeTruthy();
      expect(screen.queryByLabelText('Estimate (min)')).toBeNull();
      expect(screen.queryByLabelText('Buffer (min)')).toBeNull();
      expect(screen.queryByRole('button', { name: /^Split/ })).toBeNull();
      expect(
        screen.getByText('Connect Google Calendar in Settings to put its deadline there.'),
      ).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Add to calendar/ })).toBeNull();
      expect(screen.getByText(/Open · 1 of 2 parts/)).toBeTruthy();
    });

    it('Mark done on a parent with an open part is refused inline, naming it; the modal stays', async () => {
      const client = api();
      const { p } = await withParts(client, ['done', 'open']);
      const { onFinished, user } = renderEditor(client, p);
      const scrolled = vi.fn();
      Element.prototype.scrollIntoView = scrolled; // jsdom has none
      try {
        await user.click(await screen.findByRole('button', { name: 'Mark done' }));
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toMatch(
          /Part 2 isn’t finished — complete, drop or delete it first/,
        );
        // It lands below a phone's fold, so it's brought into view — and again on the next refusal.
        await waitFor(() => expect(scrolled.mock.contexts).toContain(alert));
        const before = scrolled.mock.calls.length;
        await user.click(screen.getByRole('button', { name: 'Mark done' }));
        await waitFor(() => expect(scrolled.mock.calls.length).toBeGreaterThan(before));
      } finally {
        delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      }
      expect(onFinished).not.toHaveBeenCalled();
      expect((await client.getTask(p.id))?.status).toBe('backlog');
    });

    it('once every part is done it nudges, and one tap marks it done (no actual to type)', async () => {
      const client = api();
      const { p } = await withParts(client, ['done', 'done']);
      const { onFinished, user } = renderEditor(client, p);
      expect(await screen.findByText('All parts done — mark it submitted?')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Mark done' }));
      await waitFor(() =>
        expect(onFinished).toHaveBeenCalledWith(
          expect.objectContaining({ id: p.id, status: 'done' }),
          true,
        ),
      );
      expect(await client.getTask(p.id)).toMatchObject({ status: 'done', actualAccruedMin: 70 });
    });

    it('every part dropped: no Mark done — it says to drop the parent instead', async () => {
      const client = api();
      const { p, parts } = await withParts(client, ['open']);
      await client.transitionTask(parts[0]!.id, 'cancelled');
      renderEditor(client, (await client.getTask(p.id))!);
      expect(await screen.findByText(/Every part was dropped — drop this too/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Mark done' })).toBeNull();
      expect(screen.getByText(/Open · 0 of 0 parts/)).toBeTruthy();
    });

    it('Add parts… puts focus in the form, never on <body> (its button gives way to it)', async () => {
      const client = api();
      const { p } = await withParts(client, ['open']);
      const { user } = renderEditor(client, p);
      expect(await screen.findByText(/Open · 0 of 1 part$/)).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Add parts…' }));
      expect(document.activeElement).toBe(screen.getByLabelText(/Add parts — one per line/));
    });

    it('Delete names how many parts go with it', async () => {
      const client = api();
      const { p } = await withParts(client, ['open', 'open', 'open']);
      const { user } = renderEditor(client, p);
      await user.click(await screen.findByRole('button', { name: /^Delete task/ }));
      expect(screen.getByText(/Delete “P2” and its 3 parts\?/)).toBeTruthy();
    });

    it('a timed parent’s Calendar section is its due marker: linked → Remove; unlinked → Add', async () => {
      const client = createStubClient({ seed: true, storageKey: `editor-${Math.random()}` });
      const { p } = await withParts(client, ['open']);
      expect(p.gcalEventId).toBeTruthy(); // Break down made its block the marker
      renderEditor(client, p);
      expect(await screen.findByText('Due marker on Google Calendar')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
      cleanup();

      const removed = await client.deleteCalendarEvent(p.id);
      const { user } = renderEditor(client, removed);
      expect(await screen.findByText('No due marker on your calendar.')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Add due marker' }));
      await waitFor(async () => expect((await client.getTask(p.id))!.gcalEventId).toBeTruthy());
    });

    it('an untimed parent says to set a due time for its marker; no picker', async () => {
      const client = api();
      const p = await client.createTask({ title: 'P2', dueDay: '2026-10-13' });
      await client.createTask({ title: 'read', parentId: p.id });
      renderEditor(client, (await client.getTask(p.id))!);
      expect(
        await screen.findByText('Set a due time to put its deadline on your calendar.'),
      ).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Add to calendar/ })).toBeNull();
    });

    it('a part set to end after its parent is due gets a quiet note, as you type', async () => {
      const client = api();
      const { parts } = await withParts(client, ['open']);
      renderEditor(client, parts[0]!);
      const ends = await screen.findByLabelText('Ends');
      expect(screen.queryByText(/Ends after P2 is due/)).toBeNull();
      await screen.findByRole('button', { name: 'P2' }); // the parent has loaded
      fireEvent.change(ends, { target: { value: '2026-10-14' } });
      expect(screen.getByText('Ends after P2 is due.')).toBeTruthy();
      fireEvent.change(ends, { target: { value: '2026-10-12' } });
      expect(screen.queryByText(/Ends after P2 is due/)).toBeNull();
    });

    it('a dropped part’s header reads “Dropped · part of P2”, not a count', async () => {
      const client = api();
      const { parts } = await withParts(client, ['open', 'open']);
      const dropped = await client.transitionTask(parts[1]!.id, 'cancelled');
      renderEditor(client, dropped);
      expect(await screen.findByRole('button', { name: 'P2' })).toBeTruthy();
      expect(screen.getByText(/^Dropped · part of/)).toBeTruthy();
      expect(screen.queryByText(/Part \d of/)).toBeNull();
      // Nothing to say about the calendar on a dropped part with no event: no bare heading.
      expect(screen.getByText('Calendar').closest('section')!.className).toMatch(/\bhidden\b/);
    });

    it('a part reads its time as Ends, and its header names the parent and its deadline', async () => {
      const client = api();
      const { parts } = await withParts(client, ['open', 'open']);
      renderEditor(client, parts[1]!);
      expect(await screen.findByRole('button', { name: 'P2' })).toBeTruthy();
      expect(screen.getByText(/Part 2 of 2 of/)).toBeTruthy();
      expect(screen.getByLabelText('Ends')).toBeTruthy();
      expect(screen.getByLabelText('Ends at')).toBeTruthy();
      expect(screen.queryByLabelText('Due')).toBeNull();
    });

    it('focus returns to Add parts… once the parts land, even with a frame before React’s commit', async () => {
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        cb(0);
        return 0;
      });
      const client = api();
      const t = await client.createTask({ title: 'Lab' });
      const { user } = renderEditor(client, t);
      await user.click(screen.getByRole('button', { name: 'Break down…' }));
      await user.type(screen.getByLabelText(/Add parts/), 'run it | ~45');
      await user.click(screen.getByRole('button', { name: 'Add parts' }));
      await waitFor(() => expect(document.activeElement?.textContent).toBe('Add parts…'));
    });

    it('Break down… turns a plain task into a parent, its estimate prefilling the first part', async () => {
      const client = api();
      const t = await client.createTask({ title: 'Lab', estimateMin: 60 });
      const { user } = renderEditor(client, t);
      await user.click(screen.getByRole('button', { name: 'Break down…' }));
      const box = screen.getByLabelText<HTMLTextAreaElement>(/Add parts/);
      expect(box.value).toBe('Lab | ~60');
      await user.clear(box);
      await user.type(box, 'run it | ~45{Enter}write it up | ~30');
      expect(screen.getByText(/2 parts · est 1h 15m/)).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Add parts' }));
      await waitFor(async () =>
        expect((await client.listTasks()).filter((x) => x.parentId === t.id)).toHaveLength(2),
      );
      expect((await client.getTask(t.id))?.estimateMin).toBeNull(); // the sum now
    });

    it('typed part lines count as unsaved; the untouched prefill doesn’t, and Cancel clears it', async () => {
      const client = api();
      const t = await client.createTask({ title: 'Lab', estimateMin: 60 });
      const { edits, user } = renderEditor(client, t);
      await user.click(screen.getByRole('button', { name: 'Break down…' }));
      expect(screen.getByLabelText<HTMLTextAreaElement>(/Add parts/).value).toBe('Lab | ~60');
      expect(editState(edits)).toBe('clean');
      await user.type(screen.getByLabelText(/Add parts/), '{Enter}write it up | ~30');
      expect(editState(edits)).toBe('dirty');
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(editState(edits)).toBe('clean');
    });

    it('part lines on their way read as saving, not unsaved — an exit waits for them', async () => {
      const client = api();
      const t = await client.createTask({ title: 'Lab' });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const original = client.createTasks.bind(client);
      vi.spyOn(client, 'createTasks').mockImplementation((inputs) =>
        gate.then(() => original(inputs)),
      );
      const { edits, user } = renderEditor(client, t);
      await user.click(screen.getByRole('button', { name: 'Break down…' }));
      await user.type(screen.getByLabelText(/Add parts/), 'run it | ~45');
      await user.click(screen.getByRole('button', { name: 'Add parts' }));
      expect(editState(edits)).toBe('saving');
      await act(async () => release());
      await waitFor(() => expect(screen.queryByLabelText(/Add parts/)).toBeNull());
      expect(editState(edits)).toBe('clean');
    });

    it('a part line can’t carry a category or a deadline — those are the parent’s', async () => {
      const client = api();
      const t = await client.createTask({ title: 'Lab' });
      const { user } = renderEditor(client, t);
      await user.click(screen.getByRole('button', { name: 'Break down…' }));
      const box = screen.getByLabelText(/Add parts/);
      await user.type(box, 'run it | ~45 due:2026-10-10');
      expect(screen.getByText(/the deadline is the parent’s/)).toBeTruthy();
      // No part count while a line is wrong.
      expect(screen.queryByText(/1 part/)).toBeNull();
      // In plain words — never the bulk-add grammar (#, due:) a part has no use for.
      for (const [line, says] of [
        ['run it | soon', /“soon” isn’t something a part takes — use ~minutes/],
        ['run it | #School', /a part takes its parent’s category/],
        ['run it | due:2026-13-40', /the deadline is the parent’s/],
      ] as const) {
        await user.clear(box);
        await user.type(box, line);
        const said = screen.getByText(says);
        expect(said.parentElement!.textContent).not.toMatch(/due:|#/);
      }
      expect(screen.getByRole('button', { name: 'Add parts' }).hasAttribute('disabled')).toBe(true);
      await user.clear(box);
      await user.type(box, 'run it | ~45');
      expect(screen.getByText(/1 part · est 45m/)).toBeTruthy();
    });

    it('a started task offers Split, not Break down (its logged time would have nowhere to go)', async () => {
      const client = api();
      let t = await client.createTask({ title: 'Started', estimateMin: 30 });
      t = await client.transitionTask(t.id, 'in_progress');
      renderEditor(client, t);
      expect(screen.getByRole('button', { name: /^Split/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Break down…' })).toBeNull();
    });

    it('a roll rep offers neither Split nor Break down — it’s one rep of a repeating thing', async () => {
      const client = api();
      const roll = await client.upsertRoll({ name: 'LeetCode', categoryId: null, estimateMin: 30 });
      const { task: rep } = await client.pickRollToday(roll.id, '2026-08-04');
      renderEditor(client, rep);
      expect(screen.getByRole('button', { name: /Drop task/ })).toBeTruthy(); // the row rendered
      expect(screen.queryByRole('button', { name: /^Split/ })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Break down…' })).toBeNull();
    });

    it('a recurring occurrence offers neither Split nor Break down', async () => {
      const client = api();
      await client.upsertSeries({
        title: 'Daily standup',
        categoryId: null,
        defaultEstimateMin: 15,
        rule: { kind: 'daily' },
        anchorDate: '2026-08-01',
      });
      await client.getDay('2026-08-04');
      const occurrence = (await client.listTasks()).find((t) => t.seriesId)!;
      renderEditor(client, occurrence);
      expect(screen.getByRole('button', { name: /Drop task/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /^Split/ })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Break down…' })).toBeNull();
    });
  });

  it('locks Due but keeps Category editable on a finished task', async () => {
    const client = api();
    let t = await client.createTask({ title: 'Done', estimateMin: 30 });
    t = await client.transitionTask(t.id, 'in_progress');
    await client.setTaskActual(t.id, 30);
    t = await client.transitionTask(t.id, 'done');
    renderEditor(client, t);
    expect(screen.queryByLabelText('Due')).toBeNull(); // read-only once finished
    expect(screen.getByLabelText('Category')).toBeTruthy(); // recategorizing a done task still matters
  });

  describe('category suggestion', () => {
    // Synthetic history: two categories, twelve tasks each, with their own vocabulary.
    const GARDEN = [
      'water the tomato beds',
      'prune the rose hedge',
      'spread mulch on the border',
      'sow carrot seeds',
      'stake the bean poles',
      'weed the herb patch',
      'repot the fern',
      'trim the lawn edge',
      'turn the compost heap',
      'plant tulip bulbs',
      'net the berry bushes',
      'rake the fallen leaves',
    ];
    const KITCHEN = [
      'descale the kettle',
      'sharpen the chef knife',
      'clean the oven racks',
      'restock the pantry shelf',
      'season the cast skillet',
      'defrost the freezer drawer',
      'wipe the range hood',
      'sort the spice rack',
      'replace the sink filter',
      'scrub the cutting board',
      'organise the baking tins',
      'degrease the stove top',
    ];
    async function seeded() {
      const client = api();
      const garden = await client.upsertCategory({ label: 'Garden', isWork: false });
      const kitchen = await client.upsertCategory({ label: 'Kitchen', isWork: false });
      for (const title of GARDEN) await client.createTask({ title, categoryId: garden.id });
      for (const title of KITCHEN) await client.createTask({ title, categoryId: kitchen.id });
      return { client, garden, kitchen };
    }
    const chip = () => screen.queryByRole('button', { name: /^Use suggested category/ });

    it('offers a confident category as a tap-only chip; tapping fills the select and Save persists it', async () => {
      const { client, garden } = await seeded();
      const t = await client.createTask({ title: 'mulch the tomato beds' });
      const { user } = renderEditor(client, t);

      const select = (await screen.findByLabelText('Category')) as HTMLSelectElement;
      const suggested = await screen.findByRole('button', {
        name: 'Use suggested category Garden',
      });
      expect(suggested.textContent).toBe('Garden?');
      expect(select.value).toBe(''); // never pre-selected
      expect(screen.getByRole('button', { name: 'Save' }).getAttribute('aria-disabled')).toBe(
        'true',
      );
      expect((await client.getTask(t.id))?.categoryId).toBeNull();

      await user.click(suggested);
      expect(select.value).toBe(garden.id);
      expect(chip()).toBeNull(); // gone once the field has a value
      expect(screen.getByRole('button', { name: 'Save' }).getAttribute('aria-disabled')).toBe(
        'false',
      );
      expect((await client.getTask(t.id))?.categoryId).toBeNull(); // the tap wrote nothing

      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(async () => expect((await client.getTask(t.id))?.categoryId).toBe(garden.id));
    });

    it('keeps focus on the field when the chip goes by keyboard, and leaves a tap alone', async () => {
      const { client, garden } = await seeded();
      const t = await client.createTask({ title: 'mulch the tomato beds' });
      const { user } = renderEditor(client, t);
      const select = (await screen.findByLabelText('Category')) as HTMLSelectElement;

      (await screen.findByRole('button', { name: /^Use suggested category/ })).focus();
      await user.keyboard('{Enter}');
      expect(select.value).toBe(garden.id);
      expect(document.activeElement).toBe(select);
      cleanup();

      const other = await client.createTask({ title: 'mulch the rose beds' });
      const { user: tapper } = renderEditor(client, other);
      const again = (await screen.findByLabelText('Category')) as HTMLSelectElement;
      await tapper.click(await screen.findByRole('button', { name: /^Use suggested category/ }));
      expect(again.value).toBe(garden.id);
      expect(document.activeElement).not.toBe(again); // focusing would open the iOS picker
    });

    it('no chip when the task is categorised, when nothing in its title is known, or on a part', async () => {
      const { client, garden } = await seeded();
      const filed = await client.createTask({
        title: 'mulch the tomato beds',
        categoryId: garden.id,
      });
      renderEditor(client, filed);
      await screen.findByLabelText('Category');
      expect(chip()).toBeNull();
      cleanup();

      const stranger = await client.createTask({ title: 'quarterly filing' });
      renderEditor(client, stranger);
      const select = (await screen.findByLabelText('Category')) as HTMLSelectElement;
      // The neighbour is untouched: every category is still on offer (once the roster has loaded).
      await waitFor(() =>
        expect(Array.from(select.options).map((o) => o.textContent)).toEqual(
          expect.arrayContaining(['Garden', 'Kitchen']),
        ),
      );
      expect(chip()).toBeNull();
      cleanup();

      const parent = await client.createTask({ title: 'tend the plot', categoryId: garden.id });
      const [part] = await client.createTasks([
        { title: 'mulch the tomato beds', parentId: parent.id },
      ]);
      renderEditor(client, part!);
      await screen.findByLabelText('Category');
      expect(chip()).toBeNull();
    });

    it('follows the title as typed, and clears when the history is too thin', async () => {
      const { client } = await seeded();
      const t = await client.createTask({ title: 'quarterly filing' });
      const { user } = renderEditor(client, t);
      await screen.findByLabelText('Category');
      expect(chip()).toBeNull();
      await user.clear(screen.getByLabelText('Title'));
      await user.type(screen.getByLabelText('Title'), 'descale the oven');
      expect(
        await screen.findByRole('button', { name: 'Use suggested category Kitchen' }),
      ).toBeTruthy();
    });
  });

  it("keeps the task's own retired category as '(retired)' and hides other retired ones", async () => {
    const client = api();
    const hw = await client.upsertCategory({ label: 'Homework', isWork: true });
    const st = await client.upsertCategory({ label: 'Studying', isWork: true });
    await client.upsertCategory({ label: 'MATH 200', isWork: true });
    for (const c of [hw, st])
      await client.upsertCategory({ id: c.id, label: c.label, isWork: true, active: false });
    const t = await client.createTask({ title: 'pset', categoryId: hw.id });
    renderEditor(client, t);

    const select = (await screen.findByLabelText('Category')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(hw.id));
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toContain('Homework (retired)');
    expect(labels).toContain('MATH 200');
    expect(labels).not.toContain('Studying');
    expect(labels).not.toContain('Studying (retired)');
    // The retired option is the saved value, so the form opens clean.
    expect(screen.getByRole('button', { name: 'Save' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('hides Split on a finished task', async () => {
    const client = api();
    let t = await client.createTask({ title: 'Done', estimateMin: 30 });
    t = await client.transitionTask(t.id, 'in_progress');
    await client.setTaskActual(t.id, 30);
    t = await client.transitionTask(t.id, 'done');
    renderEditor(client, t);
    expect(screen.queryByRole('button', { name: /Split/ })).toBeNull();
  });

  it('drops a scopeable task through a confirm and closes', async () => {
    const client = api();
    const t = await client.createTask({ title: 'Droppable' });
    const { onFinished, user } = renderEditor(client, t);

    await user.click(screen.getByRole('button', { name: /Drop task/ }));
    await user.click(screen.getByRole('button', { name: 'Drop' }));

    await waitFor(async () => expect((await client.getTask(t.id))?.status).toBe('cancelled'));
    expect(onFinished).toHaveBeenCalledWith(
      expect.objectContaining({ id: t.id, status: 'cancelled' }),
      true,
    );
  });

  it('a second Mark done tap during the actual’s write sends nothing', async () => {
    const client = api();
    let t = await client.createTask({ title: 'Read', estimateMin: 30 });
    t = await client.transitionTask(t.id, 'in_progress');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = client.setTaskActual.bind(client);
    vi.spyOn(client, 'setTaskActual').mockImplementation((id, min) =>
      gate.then(() => original(id, min)),
    );
    const transition = vi.spyOn(client, 'transitionTask');
    const { onFinished, user } = renderEditor(client, t, 'finish');
    await user.type(screen.getByLabelText('Actual (min)'), '30');
    await user.click(screen.getByRole('button', { name: 'Mark done' }));
    await user.click(screen.getByRole('button', { name: 'Mark done' }));
    await act(async () => release());
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(transition).toHaveBeenCalledTimes(1);
    expect(onFinished).toHaveBeenCalledWith(
      expect.objectContaining({ id: t.id, status: 'done' }),
      true,
    );
  });

  it('a failed Mark done is said inline; the button works again', async () => {
    const client = api();
    let t = await client.createTask({ title: 'Read', estimateMin: 30 });
    t = await client.transitionTask(t.id, 'in_progress');
    vi.spyOn(client, 'transitionTask').mockRejectedValueOnce(new Error('offline'));
    const { onFinished, user } = renderEditor(client, t, 'finish');
    await user.type(screen.getByLabelText('Actual (min)'), '30');
    await user.click(screen.getByRole('button', { name: 'Mark done' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Couldn’t mark it done — try again.',
    );
    expect(onFinished).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Mark done' }).getAttribute('aria-disabled')).toBe(
        'false',
      ),
    );
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
      const { onFinished, edits, user } = renderEditor(client, t);

      await user.click(screen.getByRole('button', { name: 'Add notes…' }));
      const field = screen.getByLabelText('Notes');
      expect(document.activeElement).toBe(field);
      await user.type(field, '  ch. 4 q1-8  ');
      expect(editState(edits)).toBe('dirty'); // Close/Esc/backdrop now confirm
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(setNotes).toHaveBeenCalledWith(t.id, 'ch. 4 q1-8');
      await waitFor(async () => expect((await client.getTask(t.id))?.notes).toBe('ch. 4 q1-8'));
      // Stays open, back on the rendered note, clean.
      expect(await screen.findByText('Saved')).toBeTruthy();
      expect(screen.queryByLabelText('Notes')).toBeNull();
      expect(screen.getByText('ch. 4 q1-8')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Edit notes' })).toBeTruthy();
      expect(editState(edits)).toBe('clean');
      expect(onFinished).not.toHaveBeenCalled();
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
      await client.setTaskActual(t.id, 30);
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

  describe('reflection', () => {
    async function doneTask(client: ApiClient, reflection?: string): Promise<Task> {
      const t = await client.createTask({ title: 'Pset', estimateMin: 30 });
      await client.transitionTask(t.id, 'in_progress');
      await client.setTaskActual(t.id, 40, reflection ?? null);
      return client.transitionTask(t.id, 'done');
    }

    it('a done task shows its reflection with Edit; Save writes it and stays open', async () => {
      const client = api();
      const t = await doneTask(client, 'Should have **outlined** first');
      const setReflection = vi.spyOn(client, 'setTaskReflection');
      const { onFinished, edits, user } = renderEditor(client, t);
      expect(screen.getByText('outlined').tagName).toBe('STRONG'); // rendered, same subset as notes

      await user.click(screen.getByRole('button', { name: 'Edit reflection' }));
      const field = screen.getByLabelText('Reflection');
      expect(document.activeElement).toBe(field);
      await user.clear(field);
      await user.type(field, '  Outline first next time  ');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(setReflection).toHaveBeenCalledWith(t.id, 'Outline first next time');
      await waitFor(async () =>
        expect((await client.getTask(t.id))?.reflection).toBe('Outline first next time'),
      );
      expect(await screen.findByText('Saved')).toBeTruthy();
      expect(screen.queryByLabelText('Reflection')).toBeNull(); // back on the rendered view
      expect(screen.getByText('Outline first next time')).toBeTruthy();
      expect(editState(edits)).toBe('clean');
      expect(onFinished).not.toHaveBeenCalled();
    });

    it('clearing the reflection saves null', async () => {
      const client = api();
      const t = await doneTask(client, 'drop me');
      const setReflection = vi.spyOn(client, 'setTaskReflection');
      const { user } = renderEditor(client, t);
      await user.click(screen.getByRole('button', { name: 'Edit reflection' }));
      await user.clear(screen.getByLabelText('Reflection'));
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(setReflection).toHaveBeenCalledWith(t.id, null);
      expect(await screen.findByRole('button', { name: 'Add a reflection…' })).toBeTruthy();
    });

    it('an unsaved reflection edit trips the dirty guard; other edits leave it alone', async () => {
      const client = api();
      const t = await doneTask(client, 'keep');
      const setReflection = vi.spyOn(client, 'setTaskReflection');
      const { edits, user } = renderEditor(client, t);
      await user.click(screen.getByRole('button', { name: 'Edit reflection' }));
      expect(editState(edits)).toBe('clean'); // opening the editor alone changes nothing
      await user.type(screen.getByLabelText('Reflection'), ' more');
      expect(editState(edits)).toBe('dirty');
      await user.clear(screen.getByLabelText('Reflection'));
      await user.type(screen.getByLabelText('Reflection'), 'keep');
      expect(editState(edits)).toBe('clean');

      const title = screen.getByLabelText('Title');
      await user.type(title, '!');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByText('Saved')).toBeTruthy();
      expect(setReflection).not.toHaveBeenCalled();
    });

    it('a reflection typed in the finish intent’s Done form makes leaving ask first', async () => {
      const client = api();
      let t = await client.createTask({ title: 'Pset', estimateMin: 30 });
      t = await client.transitionTask(t.id, 'in_progress');
      const { edits, user } = renderEditor(client, t, 'finish');
      expect(editState(edits)).toBe('clean');
      await user.type(screen.getByLabelText(/^Reflection/), 'ran long');
      expect(editState(edits)).toBe('dirty'); // Esc / backdrop / Cancel now confirm
      // In progress, the details form shows no second Reflection field — the Done form holds it.
      expect(screen.getAllByLabelText(/^Reflection/)).toHaveLength(1);
    });

    it('an open task without a reflection shows no Reflection block; a done one offers to add', async () => {
      const client = api();
      renderEditor(client, await client.createTask({ title: 'Open' }));
      expect(screen.queryByText('Reflection')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Add a reflection…' })).toBeNull();
      cleanup();
      renderEditor(client, await doneTask(client));
      expect(screen.getByRole('button', { name: 'Add a reflection…' })).toBeTruthy();
    });

    it('over the cap the reflection disables Save, without truncating', async () => {
      const client = api();
      const { user } = renderEditor(client, await doneTask(client));
      await user.click(screen.getByRole('button', { name: 'Add a reflection…' }));
      const field = screen.getByLabelText('Reflection');
      fireEvent.change(field, { target: { value: 'x'.repeat(1001) } });
      expect(screen.getByText(/1,001 \/ 1,000/)).toBeTruthy();
      expect((field as HTMLTextAreaElement).value).toHaveLength(1001);
      expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    });
  });
});

describe('the task’s place', () => {
  it('puts a task on a store’s list and takes it off again, keeping the modal open', async () => {
    const client = api();
    await client.upsertPlace({ name: 'Market' });
    const t = await client.createTask({ title: 'milk' });
    const user = userEvent.setup();
    renderWithProviders(<TaskDetailsForm task={t} />, { api: client });
    const select = await screen.findByLabelText<HTMLSelectElement>('Place');
    expect(select.value).toBe('');
    await user.selectOptions(select, 'market');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await client.getTask(t.id))!.place).toBe('market'));
    expect(await screen.findByText('Saved')).toBeTruthy();

    await user.selectOptions(select, '');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await client.getTask(t.id))!.place).toBeNull());
  });

  it('is locked on a finished task — its place is history, like its estimate', async () => {
    const client = api();
    await client.upsertPlace({ name: 'Market' });
    let t = await client.createTask({ title: 'milk', place: 'market' });
    t = await client.transitionTask(t.id, 'in_progress');
    t = await client.transitionTask(t.id, 'done');
    renderEditor(client, t);
    // Plain text, like the other finished fields — never a select that looks editable.
    expect(await screen.findByText('@Market')).toBeTruthy();
    expect(screen.queryByLabelText('Place')).toBeNull();
    expect(screen.getByText('Done')).toBeTruthy(); // the header keeps the status once it's finished
  });

  it('a finished task off every list reads "No place"', async () => {
    const client = api();
    await client.upsertPlace({ name: 'Market' });
    let t = await client.createTask({ title: 'pset', estimateMin: 30 });
    t = await client.transitionTask(t.id, 'in_progress');
    await client.setTaskActual(t.id, 30);
    t = await client.transitionTask(t.id, 'done');
    renderEditor(client, t);
    expect(await screen.findByText('No place')).toBeTruthy();
    expect(screen.queryByLabelText('Place')).toBeNull();
  });

  it('a part has no picker — it follows its parent’s place, and says so', async () => {
    const client = api();
    await client.upsertPlace({ name: 'Market' });
    const p = await client.createTask({ title: 'party', place: 'market' });
    const [part] = await client.createTasks([{ title: 'cups', parentId: p.id }]);
    renderEditor(client, part!);
    expect(await screen.findByText('On @Market — a part follows its parent’s place.')).toBeTruthy();
    expect(screen.queryByLabelText('Place')).toBeNull();
  });

  it('the header says Places for a waiting errand, not Backlog', async () => {
    const client = api();
    await client.upsertPlace({ name: 'Market' });
    const t = await client.createTask({ title: 'milk', place: 'market' });
    renderEditor(client, t);
    expect(await screen.findByText('Places')).toBeTruthy();
    expect(screen.queryByText('Backlog')).toBeNull();
  });

  it('has no picker when there are no places and the task has none', async () => {
    const client = api();
    const t = await client.createTask({ title: 'pset' });
    renderWithProviders(<TaskDetailsForm task={t} />, { api: client });
    await screen.findByLabelText('Category');
    await waitFor(() => expect(screen.queryByLabelText('Place')).toBeNull());
  });
});
