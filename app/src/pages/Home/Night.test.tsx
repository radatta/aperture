import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { addDays, todayKey } from '@aperture/shared';
import type { ApiClient, TaskStatus } from '@aperture/shared';
import { renderApp } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';

beforeEach(() => {
  globalThis.localStorage?.clear();
  globalThis.sessionStorage?.clear();
});

const today = () => todayKey(4);

async function onToday(api: ApiClient, title: string, status: TaskStatus, order: number) {
  const t = await api.createTask({ title, estimateMin: 30 });
  await api.upsertPlan({ taskId: t.id, day: today(), plannedMinutes: 30, order });
  if (status !== 'backlog')
    await api.transitionTask(t.id, status === 'done' ? 'in_progress' : status);
  if (status === 'done') {
    await api.setTaskActual(t.id, 20);
    await api.transitionTask(t.id, 'done');
  }
  return t;
}

async function night() {
  const api = createStubClient({ seed: false, storageKey: `night-${Math.random()}` });
  const essay = await onToday(api, 'essay draft', 'planned', 0);
  const lab = await onToday(api, 'lab report', 'in_progress', 1);
  await onToday(api, 'finished thing', 'done', 2);
  const user = userEvent.setup();
  renderApp({ api });
  await user.click(screen.getByRole('button', { name: 'Night' }));
  await screen.findByText('Still open — when?');
  return { api, user, essay, lab };
}

const row = (title: string) => within(screen.getByRole('group', { name: title }));

describe('night: still open — when?', () => {
  it('asks about each unfinished task on today’s plan, not the finished ones', async () => {
    await night();
    expect(screen.getByText('Unfinished is fine. Say when.')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'essay draft' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'lab report' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'finished thing' })).toBeNull();
  });

  it('Tomorrow adds a row for tomorrow, keeps today’s, and keeps a started task started', async () => {
    const { api, user, essay, lab } = await night();

    await user.click(row('essay draft').getByRole('button', { name: 'Tomorrow' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'essay draft' })).toBeNull());
    await user.click(row('lab report').getByRole('button', { name: 'Tomorrow' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'lab report' })).toBeNull());

    const tomorrow = await api.listPlansForDay(addDays(today(), 1));
    expect(tomorrow.map((p) => p.taskId).sort()).toEqual([essay.id, lab.id].sort());
    expect(await api.listPlansForDay(today())).toHaveLength(3); // history kept
    expect((await api.getTask(essay.id))?.status).toBe('planned');
    expect((await api.getTask(lab.id))?.status).toBe('in_progress');
    expect(screen.queryByText('Still open — when?')).toBeNull(); // nothing left to ask
    const done = screen.getByText('Everything open has a when.');
    await waitFor(() => expect(document.activeElement).toBe(done.parentElement));
  });

  it('Backlog takes it off today — a started task too', async () => {
    const { api, user, lab } = await night();

    await user.click(row('lab report').getByRole('button', { name: 'Backlog' }));
    await waitFor(async () => expect((await api.getTask(lab.id))?.status).toBe('backlog'));
    const rows = await api.listPlansForDay(today());
    expect(rows.map((p) => p.taskId)).not.toContain(lab.id);
  });

  it('Leave hides it for the session without writing anything', async () => {
    const { api, user, essay } = await night();

    await user.click(row('essay draft').getByRole('button', { name: 'Leave' }));
    expect(screen.queryByRole('group', { name: 'essay draft' })).toBeNull();
    expect((await api.getTask(essay.id))?.status).toBe('planned');

    cleanup();
    renderApp({ api });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Night' }));
    await screen.findByRole('group', { name: 'lab report' });
    expect(screen.queryByRole('group', { name: 'essay draft' })).toBeNull();
  });
});

describe('night: today in review', () => {
  it('lists a finished task’s estimate vs actual, but not a split part (scored as a family)', async () => {
    const api = createStubClient({ seed: false, storageKey: `review-${Math.random()}` });
    await onToday(api, 'finished thing', 'done', 0);
    const big = await onToday(api, 'big essay', 'in_progress', 1);
    await api.splitTask(big.id, {
      finish: 'done',
      actualMin: 40,
      followUp: { title: 'big essay, part 2', estimateMin: 30 },
    });
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Night' }));
    expect(await screen.findByText('finished thing')).toBeTruthy();
    expect(screen.queryByText('big essay')).toBeNull();
  });
});
