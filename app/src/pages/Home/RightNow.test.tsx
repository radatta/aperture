import { beforeEach, describe, expect, it } from 'vitest';
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
});
