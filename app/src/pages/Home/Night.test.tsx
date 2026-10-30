import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { addDays, todayKey, ulid } from '@aperture/shared';
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
  it('bars every measured task — each part, and a parent as its rollup; unestimated is plain', async () => {
    const api = createStubClient({ seed: false, storageKey: `review-${Math.random()}` });
    await onToday(api, 'finished thing', 'done', 0);
    const big = await onToday(api, 'big essay', 'in_progress', 1);
    const { parent, followUp } = await api.splitTask(big.id, {
      finish: 'done',
      title: 'outline',
      actualMin: 40,
      followUp: { title: 'write it', estimateMin: 30 },
    });
    await api.transitionTask(followUp.id, 'in_progress');
    await api.setTaskActual(followUp.id, 25);
    await api.transitionTask(followUp.id, 'done');
    const skipped = await api.createTask({ title: 'skipped', parentId: parent.id });
    await api.transitionTask(skipped.id, 'cancelled'); // dropped: not one of the rollup's parts
    await api.transitionTask(parent.id, 'done');
    const loose = await api.createTask({ title: 'quick errand' }); // never estimated
    await api.transitionTask(loose.id, 'in_progress');
    await api.setTaskActual(loose.id, 10);
    await api.transitionTask(loose.id, 'done');
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Night' }));
    expect(await screen.findByText('finished thing')).toBeTruthy();
    // finished thing, both parts, and the parent's rollup (its lock vs what its parts took).
    expect(screen.getAllByRole('img', { name: /actual against/ })).toHaveLength(4);
    expect(screen.getByText('big essay · 2 parts')).toBeTruthy();
    expect(screen.getByText('quick errand')).toBeTruthy();
    expect(screen.getByText('no estimate')).toBeTruthy();
  });
});

describe('night: the Flux line (D51)', () => {
  const fluxSet = (api: ApiClient, exerciseId: string, day: string, completedAt: number) =>
    api.recordFluxSet({
      id: ulid(),
      day,
      exerciseId,
      kind: exerciseId === 'cervical-rotation' ? 'romReps' : 'holdAtTarget',
      side: exerciseId === 'upper-trap-stretch' ? 'a' : null,
      condition: null,
      count: 10,
      avgPeakDeg: null,
      avgErrorDeg: null,
      rom: { pitch: 1, yaw: 1, roll: 1 },
      calibrated: true,
      delegate: 'GPU',
      durationSec: 100,
      completedAt,
      repTaskId: null,
    });

  it('says what Flux did today, links to History, and stays off Morning', async () => {
    const api = createStubClient({ seed: false, storageKey: `night-flux-${Math.random()}` });
    const t = Date.now();
    await fluxSet(api, 'cervical-rotation', today(), t - 3000);
    await fluxSet(api, 'cervical-rotation', today(), t - 2000);
    await fluxSet(api, 'upper-trap-stretch', today(), t - 1000);
    await fluxSet(api, 'chin-tuck', addDays(today(), -1), t - 86_400_000); // yesterday's doesn't count
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Night' }));
    const line = await screen.findByText('Flux · 2 sets rotation, 1 upper trap');
    expect(line.closest('a')?.getAttribute('href')).toBe('/flux/history');
    await user.click(screen.getByRole('button', { name: 'Morning' }));
    await waitFor(() => expect(screen.queryByText(/^Flux ·/)).toBeNull());
  });

  it('is absent on a day with no sets', async () => {
    await night();
    expect(screen.queryByText(/^Flux ·/)).toBeNull();
  });
});
