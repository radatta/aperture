import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { addDays, todayKey } from '@aperture/shared';
import { createStubClient } from '../../data/stubClient';
import { renderApp } from '../../test/utils';

beforeEach(() => globalThis.localStorage?.clear());

const TODAY = todayKey(4);
const freshApi = () => createStubClient({ seed: false, storageKey: `rollpick-${Math.random()}` });

describe('Rolls ↔ daytime home', () => {
  it('picking a roll in the morning drops a rep onto the plan and into Right-now', async () => {
    const api = freshApi();
    await api.upsertRoll({ name: 'LeetCode daily', categoryId: null, estimateMin: 30 });
    const user = userEvent.setup();
    renderApp({ api });

    await user.click(screen.getByRole('button', { name: 'Morning' }));
    await user.click(await screen.findByRole('button', { name: /Pick LeetCode daily for today/ }));

    // The pick creates a planned rep on today's plan...
    await waitFor(async () => expect(await api.listPlansForDay(TODAY)).toHaveLength(1));

    // ...and it shows up in the daytime Right-now (it's an ordinary planned task now).
    await user.click(screen.getByRole('button', { name: 'Daytime' }));
    expect(await screen.findByText('LeetCode daily')).toBeTruthy();
  });

  it('completing a picked roll fills its contact sheet — the loop closes', async () => {
    const api = freshApi();
    const roll = await api.upsertRoll({
      name: 'LeetCode daily',
      categoryId: null,
      estimateMin: 30,
    });
    await api.pickRollToday(roll.id, TODAY); // pre-picked; the test drives the loop's tail
    const user = userEvent.setup();
    renderApp({ api });

    await user.click(screen.getByRole('button', { name: 'Daytime' }));
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    await user.click(await screen.findByRole('button', { name: 'Done' }));
    await user.type(await screen.findByLabelText('Actual (min)'), '25');
    await user.click(await screen.findByRole('button', { name: 'Mark done' }));

    // Over on the Rolls page, today's cell is now a rep.
    await user.click(screen.getByRole('link', { name: 'Rolls' }));
    expect(await screen.findByText(/1 rep · last today/)).toBeTruthy();
  });

  it('a roll whose open rep is timed refuses the pick, saying why', async () => {
    const api = freshApi();
    const roll = await api.upsertRoll({ name: 'Mock OA', categoryId: null, estimateMin: 30 });
    const { task } = await api.pickRollToday(roll.id, addDays(TODAY, -1));
    await api.setTaskDue(task.id, { dueDay: addDays(TODAY, 2), dueTime: '17:00' });
    const user = userEvent.setup();
    renderApp({ api });

    await user.click(screen.getByRole('button', { name: 'Morning' }));
    await user.click(await screen.findByRole('button', { name: /Pick Mock OA for today/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/change its time/);
    expect(await api.listPlansForDay(TODAY)).toEqual([]);
  });

  it('a timed rep on today reads “on today’s plan”, and tapping it does nothing', async () => {
    const api = freshApi();
    const roll = await api.upsertRoll({ name: 'Mock OA', categoryId: null, estimateMin: 30 });
    const { task } = await api.pickRollToday(roll.id, addDays(TODAY, -1));
    await api.setTaskDue(task.id, { dueDay: TODAY, dueTime: '23:58' });
    const user = userEvent.setup();
    renderApp({ api });

    await user.click(screen.getByRole('button', { name: 'Morning' }));
    await user.click(await screen.findByRole('button', { name: /Mock OA — on today's plan/ }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the refusal stays on screen after the pick’s refetch settles', async () => {
    const api = freshApi();
    const roll = await api.upsertRoll({ name: 'Mock OA', categoryId: null, estimateMin: 30 });
    const { task } = await api.pickRollToday(roll.id, addDays(TODAY, -1));
    await api.setTaskDue(task.id, { dueDay: addDays(TODAY, 2), dueTime: '17:00' });
    const list = vi.spyOn(api, 'listTasks');
    const user = userEvent.setup();
    renderApp({ api });

    await user.click(screen.getByRole('button', { name: 'Morning' }));
    const chip = await screen.findByRole('button', { name: /Pick Mock OA for today/ });
    const reads = list.mock.calls.length;
    await user.click(chip);
    await screen.findByRole('alert');
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(reads)); // the invalidate's refetch
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByRole('alert').textContent).toMatch(/change its time/);
  });
});
