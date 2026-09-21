import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { todayKey } from '@aperture/shared';
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
    await api.startSession({ taskId: task.id, categoryId: null, kind: 'work', label: null, day: TODAY });
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Daytime' }));

    // '1m of ~30m' renders only in the hero (0 accrued + ~1 live minute from the adopted session).
    expect(await screen.findByText('1m of ~30m')).toBeTruthy();
  });

  it('finishing the hero returns a “what’s next” prompt without auto-advancing', async () => {
    const api = stub();
    await plan(api, 'First thing', { est: 20, order: 0, start: true });
    await plan(api, 'Second thing', { est: 20, order: 1 });
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Daytime' }));

    await user.click(screen.getByRole('button', { name: 'Done' }));
    await user.click(await screen.findByRole('button', { name: 'Mark done' }));

    // Prompt returns; the next task is NOT auto-started (still a Start button, no live Done).
    expect(await screen.findByText(/nice/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
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
