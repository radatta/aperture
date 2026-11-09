import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { addDays, todayKey } from '@aperture/shared';
import type { ApiClient } from '@aperture/shared';
import { createStubClient } from '../../data/stubClient';
import { renderApp } from '../../test/utils';

beforeEach(() => globalThis.localStorage?.clear());

const TODAY = todayKey(4);
const stub = () => createStubClient({ seed: false, storageKey: `rn-${Math.random()}` });

async function plan(
  api: ApiClient,
  title: string,
  opts: { est?: number; order: number; start?: boolean },
) {
  const task = await api.createTask({ title });
  if (opts.est != null) await api.setTaskEstimate(task.id, opts.est, null);
  await api.upsertPlan({
    taskId: task.id,
    day: TODAY,
    plannedMinutes: opts.est ?? 30,
    order: opts.order,
  });
  if (opts.start) await api.transitionTask(task.id, 'in_progress');
  return task;
}

describe('Right now card', () => {
  // Two fast taps, and the first tap's writes answering out of order: the run's [0,1,2,2].
  it('a second “Focus this” waits for the first; the server’s orders stay distinct', async () => {
    const api = stub();
    // Planned out of id order, as a real day gets: on a tie between C and D, C reads last and offers the button.
    const a = await plan(api, 'A', { est: 15, order: 0 });
    const b = await plan(api, 'B', { est: 15, order: 1 });
    const d = await plan(api, 'D', { est: 15, order: 3 });
    const c = await plan(api, 'C', { est: 15, order: 2 });
    const write = api.upsertPlan.bind(api);
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    api.upsertPlan = async (input) => {
      if (input.taskId === d.id && input.order === 2) await held; // D's move answers last
      return write(input);
    };
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(await screen.findByRole('button', { name: 'Daytime' }));
    await user.click(await screen.findByRole('button', { name: 'Focus this' }));
    const orders = async () => {
      const rows = await api.listPlansForDay(TODAY);
      return [a, b, c, d].map((t) => rows.find((r) => r.taskId === t.id)?.order);
    };
    await waitFor(async () => expect((await orders())[2]).toBe(3)); // C has moved, D hasn't
    await new Promise((r) => setTimeout(r, 50)); // the half-done order reaches the screen, if it can
    // The fast second tap: on every row still offering it, while the first tap's D is in flight.
    for (const again of screen.queryAllByRole('button', { name: 'Focus this' }))
      if (!(again as HTMLButtonElement).disabled) await user.click(again);
    release();
    await waitFor(async () => expect((await orders())[3]).not.toBe(3));
    await waitFor(() => {
      for (const b of screen.getAllByRole('button', { name: 'Focus this' }))
        expect((b as HTMLButtonElement).disabled).toBe(false);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(new Set(await orders()).size).toBe(4);
    expect(screen.getAllByText(/^[ABCD]$/)).toHaveLength(4);
  });

  it('a failed “Focus this” says so and re-enables the buttons', async () => {
    const api = stub();
    for (let i = 0; i < 4; i++) await plan(api, `Task ${i}`, { est: 30, order: i });
    const write = api.upsertPlan.bind(api);
    api.upsertPlan = () => Promise.reject(new Error('upsertPlan failed (503)'));
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(await screen.findByRole('button', { name: 'Daytime' }));
    const focus = await screen.findByRole('button', { name: 'Focus this' });
    await user.click(focus);
    await screen.findByText("Couldn't save that — try again.");
    await waitFor(() => expect((focus as HTMLButtonElement).disabled).toBe(false));
    api.upsertPlan = write;
    await user.click(focus);
    await waitFor(() => expect(screen.queryByText("Couldn't save that — try again.")).toBeNull());
  });

  it('a “Focus this” with one failed write holds the buttons until its other writes are back', async () => {
    const api = stub();
    const tasks = [];
    for (let i = 0; i < 5; i++) tasks.push(await plan(api, `Task ${i}`, { est: 30, order: i }));
    const write = api.upsertPlan.bind(api);
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    let calls = 0;
    api.upsertPlan = async (input) => {
      if (++calls === 1) throw new Error('upsertPlan failed (503)');
      await held;
      return write(input);
    };
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(await screen.findByRole('button', { name: 'Daytime' }));
    const buttons = await screen.findAllByRole('button', { name: 'Focus this' });
    await user.click(buttons.at(-1)!);
    await waitFor(() => expect(calls).toBe(3));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Couldn't save that — try again.")).toBeNull();
    for (const b of screen.getAllByRole('button', { name: 'Focus this' }))
      expect((b as HTMLButtonElement).disabled).toBe(true);
    release();
    await screen.findByText("Couldn't save that — try again.");
    await waitFor(() => {
      for (const b of screen.getAllByRole('button', { name: 'Focus this' }))
        expect((b as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('splits today’s plan into the Big 3 and Also today', async () => {
    const api = stub();
    for (let i = 0; i < 5; i++) await plan(api, `Task ${i}`, { est: 30, order: i });
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Daytime' }));

    expect(await screen.findByText('Also today')).toBeTruthy();
    for (const t of ['Task 0', 'Task 1', 'Task 2', 'Task 3', 'Task 4'])
      expect(screen.getByText(t)).toBeTruthy();
    // Nothing started yet → the gentle "pick one" prompt, never an auto-pick.
    expect(screen.getByText('Pick one to start.')).toBeTruthy();
  });

  it('Start on a Big-3 task makes it the hero with a count-up vs estimate', async () => {
    const api = stub();
    await plan(api, 'Write essay', { est: 45, order: 0 });
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Daytime' }));
    await user.click(screen.getByRole('button', { name: 'Start' }));

    expect(await screen.findByText('Write essay')).toBeTruthy();
    expect(await screen.findByText('0m of ~45m')).toBeTruthy();
  });

  it('hero elapsed includes the running timer’s active minutes', async () => {
    // Stub clock 60s in the past → the adopted session reads ~1 live minute on top of 0 accrued.
    const api = createStubClient({
      seed: false,
      now: () => Date.now() - 60_000,
      storageKey: `rn-live-${Math.random()}`,
    });
    const task = await plan(api, 'Deep work', { est: 30, order: 0, start: true });
    await api.startSession({
      taskId: task.id,
      categoryId: null,
      kind: 'work',
      label: null,
      day: TODAY,
    });
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Daytime' }));

    // '1m of ~30m' renders only in the hero (0 accrued + ~1 live minute from the adopted session).
    expect(await screen.findByText('1m of ~30m')).toBeTruthy();
  });

  it('Done on the hero with a failed stop keeps the timer and never opens the Actual form', async () => {
    const api = stub();
    const task = await plan(api, 'Deep work', { est: 30, order: 0, start: true });
    await api.startSession({
      taskId: task.id,
      categoryId: null,
      kind: 'work',
      label: null,
      day: TODAY,
    });
    api.stopSession = () => Promise.reject(new Error('stopSession failed (503)'));
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Daytime' }));
    await user.click(await screen.findByRole('button', { name: 'Done' }));
    await screen.findByText('Couldn’t stop — try again.');
    expect(screen.queryByLabelText('Actual (min)')).toBeNull();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });

  it('finishing the hero returns a “what’s next” prompt without auto-advancing', async () => {
    const api = stub();
    await plan(api, 'First thing', { est: 20, order: 0, start: true });
    await plan(api, 'Second thing', { est: 20, order: 1 });
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Daytime' }));

    await user.click(screen.getByRole('button', { name: 'Done' }));
    // Nothing tracked: the Actual starts empty (no "0" to type over) and can't be submitted empty.
    const actual = await screen.findByLabelText<HTMLInputElement>('Actual (min)');
    expect(document.activeElement).toBe(actual); // Done focuses Actual, as the task modal does
    expect(actual.value).toBe('');
    expect(screen.getByRole('button', { name: 'Mark done' }).hasAttribute('disabled')).toBe(true);
    await user.type(actual, '18');
    await user.click(screen.getByRole('button', { name: 'Mark done' }));
    await waitFor(async () =>
      expect((await api.listTasks()).find((t) => t.title === 'First thing')?.actualAccruedMin).toBe(
        18,
      ),
    );

    // Prompt returns; the next task is NOT auto-started (still a Start button, no live Done).
    expect(await screen.findByText(/nice/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
  });

  it('a timed task due today is its own “By time” tier — not a Big-3 slot, no “Make it a focus”', async () => {
    const api = stub();
    await plan(api, 'Task 0', { order: 0 });
    await api.createTask({ title: 'OA', dueDay: TODAY, dueTime: '23:58' });
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Daytime' }));
    expect(await screen.findByText('By time')).toBeTruthy();
    expect(screen.getByText('OA')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Make OA a focus/ })).toBeNull();
    expect(screen.queryByText('Nothing planned today.')).toBeNull();
  });

  it('a timed part in By time says when it ends, and its parent’s deadline as “due”', async () => {
    const api = stub();
    const p = await api.createTask({ title: 'Lab', dueDay: TODAY, dueTime: '23:59' });
    const [part] = await api.createTasks([{ title: 'analysis', parentId: p.id }]);
    await api.setTaskDue(part!.id, { dueDay: TODAY, dueTime: '23:57' });
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Daytime' }));
    expect(await screen.findByText('ends 11:57pm')).toBeTruthy();
    expect(screen.getByText('of Lab')).toBeTruthy();
    expect(screen.getByText(/^due 11:59pm/)).toBeTruthy();
  });

  it('a timed part’s second line reads parent, then ends, then due — the parent name the one that gives way', async () => {
    const api = stub();
    const p = await api.createTask({ title: 'Lab', dueDay: TODAY, dueTime: '23:59' });
    const [part] = await api.createTasks([{ title: 'analysis', parentId: p.id }]);
    await api.setTaskDue(part!.id, { dueDay: TODAY, dueTime: '23:57' });
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Daytime' }));
    const of = await screen.findByText('of Lab');
    const ends = screen.getByText('ends 11:57pm');
    const due = screen.getByText(/^due 11:59pm/);
    // One line, in that order: each piece follows the one before it as a sibling.
    expect(of.parentElement).toBe(ends.parentElement);
    expect(ends.parentElement).toBe(due.parentElement);
    const follows = (a: Element, b: Element) =>
      !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(of, ends) && follows(ends, due)).toBe(true);
    // The parent's name is the flexible piece; the tags beside it never shrink.
    expect(of.className).toMatch(/truncate/);
    expect(ends.className).toMatch(/shrink-0/);
    expect(due.className).toMatch(/shrink-0/);
  });

  it('a deadline in tomorrow’s small hours is tonight’s: “by 12:30am”', async () => {
    const api = stub();
    await api.createTask({ title: 'OA', dueDay: addDays(TODAY, 1), dueTime: '00:30' });
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Daytime' }));
    expect(await screen.findByText('By time')).toBeTruthy();
    expect(screen.getByText('by 12:30am')).toBeTruthy();
  });

  it('a day with only a timed task isn’t “nothing planned”', async () => {
    const api = stub();
    await api.createTask({ title: 'OA', dueDay: TODAY, dueTime: '23:58' });
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Daytime' }));
    expect(await screen.findByText('By time')).toBeTruthy();
    expect(screen.queryByText('Nothing planned today.')).toBeNull();
  });

  it('shows the empty state and cold-start when nothing is planned', async () => {
    const api = stub();
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Daytime' }));

    expect(await screen.findByText('Nothing planned today.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start 25-min focus' })).toBeTruthy();
  });
  it('Start on an unscoped row asks for an estimate, and a chip starts it', async () => {
    const api = stub();
    const t = await plan(api, 'Unscoped', { order: 0 });
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Daytime' }));
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    expect((await api.getTask(t.id))?.status).not.toBe('in_progress'); // asking, not started
    await user.click(screen.getByRole('button', { name: '45' }));
    await waitFor(async () =>
      expect(await api.getTask(t.id)).toMatchObject({
        status: 'in_progress',
        estimateLockedMin: 45,
      }),
    );
  });

  it('Start again leaves the chips open; Cancel gives focus back to Start', async () => {
    const api = stub();
    await plan(api, 'Unscoped', { order: 0 });
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Daytime' }));
    const start = await screen.findByRole('button', { name: 'Start' });
    await user.click(start);
    await user.click(start);
    expect(screen.getByRole('group', { name: 'Estimate for Unscoped' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Estimate for Unscoped' })).toBeNull();
    expect(document.activeElement).toBe(start);
  });

  it('Done on an unscoped hero asks for the estimate in hindsight, and finishes retro', async () => {
    const api = stub();
    const t = await plan(api, 'Unscoped', { order: 0, start: true });
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Daytime' }));
    await user.click(await screen.findByRole('button', { name: 'Done' }));
    await user.type(await screen.findByLabelText('Actual (min)'), '30');
    await user.type(screen.getByLabelText('Estimate in hindsight'), '20');
    await user.click(screen.getByRole('button', { name: 'Mark done' }));
    await waitFor(async () =>
      expect(await api.getTask(t.id)).toMatchObject({
        status: 'done',
        estimateLockedMin: 20,
        estimateSource: 'retro',
      }),
    );
  });

  it('a hero’s open Done form never carries over to the task that takes the hero', async () => {
    const api = stub();
    const off = await api.createTask({ title: 'Off plan', estimateMin: 30 });
    await api.transitionTask(off.id, 'in_progress');
    const next = await plan(api, 'Big three', { est: 20, order: 0 });
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Daytime' }));
    await user.click(await screen.findByRole('button', { name: 'Done' }));
    await user.type(await screen.findByLabelText('Actual (min)'), '40');
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(async () => expect((await api.getTask(next.id))?.status).toBe('in_progress'));
    await waitFor(() => expect(screen.queryByLabelText('Actual (min)')).toBeNull());
    expect((await api.getTask(next.id))?.actualAccruedMin).toBe(0);
  });

  it('Start on a scoped row starts at once, with no chips', async () => {
    const api = stub();
    const t = await plan(api, 'Scoped', { est: 30, order: 0 });
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Daytime' }));
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    await waitFor(async () => expect((await api.getTask(t.id))?.status).toBe('in_progress'));
    expect(screen.queryByRole('button', { name: '45' })).toBeNull();
  });
});

// A LeetCode rep with its sitting open (docs/areas/recruiting → Done): the hero links to the sitting's page and
// its Done starts on the sitting's minutes — Start to now — not the focus timer's (none ran here).
describe('Right now — a LeetCode sitting', () => {
  it('links to the open sitting and prefills Done with its minutes', async () => {
    const user = userEvent.setup();
    let shift = -37 * 60_000; // the Start happened 37 minutes ago
    const api = createStubClient({
      seed: false,
      storageKey: `rn-${Math.random()}`,
      now: () => Date.now() + shift,
    });
    const roll = await api.upsertRoll({ name: 'LeetCode', categoryId: null, estimateMin: 45 });
    await api.updateSettings({ leetcodeRollId: roll.id });
    const { sitting } = await api.lcSittingStart({
      clientSittingId: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      problemSlug: 'rotting-oranges',
      problemTitle: 'Rotting Oranges',
      lang: 'python3',
      startedAt: Date.now() + shift,
      tzOffsetMinutes: new Date().getTimezoneOffset(),
    });
    shift = 0;
    renderApp({ api, path: '/' });
    await user.click(screen.getByRole('button', { name: 'Daytime' }));
    const link = await screen.findByRole('link', { name: 'End the LeetCode sitting →' });
    expect(link.getAttribute('href')).toBe(`/recruiting/sittings/${sitting.id}`);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByLabelText<HTMLInputElement>('Actual (min)').value).toBe('37');
  });

  it('an ordinary task in progress has no link, and Done keeps its own prefill', async () => {
    const user = userEvent.setup();
    const api = stub();
    const listSittings = vi.spyOn(api, 'listSittings');
    await plan(api, 'Write the brief', { est: 30, order: 0, start: true });
    renderApp({ api, path: '/' });
    await user.click(screen.getByRole('button', { name: 'Daytime' }));
    await user.click(await screen.findByRole('button', { name: 'Done' }));
    expect(screen.getByLabelText<HTMLInputElement>('Actual (min)').value).toBe('');
    expect(screen.queryByRole('link', { name: /End the LeetCode sitting/ })).toBeNull();
    expect(listSittings).not.toHaveBeenCalled(); // no LeetCode rep → no sittings read on Home
  });
});
