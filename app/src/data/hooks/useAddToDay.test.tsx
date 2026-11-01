import { beforeEach, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { addDays, todayKey } from '@aperture/shared';
import type { ApiClient } from '@aperture/shared';
import { ApiContext } from '../api-context';
import { createStubClient } from '../stubClient';
import { useAddToDay } from './useAddToDay';

beforeEach(() => globalThis.localStorage?.clear());

function setup(day?: string) {
  const api = createStubClient({ seed: false, storageKey: `add-to-day-${Math.random()}` });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ApiContext value={api}>{children}</ApiContext>
    </QueryClientProvider>
  );
  const hook = renderHook(() => useAddToDay(day), { wrapper });
  return { api, hook };
}

// Settings load async; `day` defaults off them, so wait until the hook reports the real today.
async function ready(hook: ReturnType<typeof setup>['hook'], day = todayKey(4)) {
  await waitFor(() => expect(hook.result.current.day).toBe(day));
}

const plansFor = (api: ApiClient, day: string) => api.listPlansForDay(day);

describe('useAddToDay', () => {
  it('plans a backlog task: one row, then planned', async () => {
    const { api, hook } = setup();
    await ready(hook);
    const t = await api.createTask({ title: 'pset', estimateMin: 40, bufferMin: 10 });

    let res: string | undefined;
    await act(async () => void (res = await hook.result.current.addToDay(t)));

    expect(res).toBe('added');
    const rows = await plansFor(api, todayKey(4));
    expect(rows).toMatchObject([{ taskId: t.id, plannedMinutes: 50, order: 0 }]);
    expect((await api.getTask(t.id))?.status).toBe('planned');
  });

  it('dedupes: a double tap and a repeat add leave one row', async () => {
    const { api, hook } = setup();
    await ready(hook);
    const t = await api.createTask({ title: 'pset' });

    const results: string[] = [];
    await act(async () => {
      const [a, b] = await Promise.all([
        hook.result.current.addToDay(t),
        hook.result.current.addToDay(t),
      ]);
      results.push(a, b);
    });
    await act(async () => void results.push(await hook.result.current.addToDay(t)));

    expect(results.sort()).toEqual(['added', 'already', 'already']);
    expect(await plansFor(api, todayKey(4))).toHaveLength(1);
  });

  it('adds an in-progress task without touching its status', async () => {
    const { api, hook } = setup();
    await ready(hook);
    const t = await api.createTask({ title: 'started' });
    await api.transitionTask(t.id, 'in_progress');

    await act(
      async () => void (await hook.result.current.addToDay({ ...t, status: 'in_progress' })),
    );

    expect(await plansFor(api, todayKey(4))).toHaveLength(1);
    expect((await api.getTask(t.id))?.status).toBe('in_progress');
  });

  it('plans onto another day (tomorrow) and keeps a planned task planned', async () => {
    const tomorrow = addDays(todayKey(4), 1);
    const { api, hook } = setup(tomorrow);
    await ready(hook, tomorrow);
    const t = await api.createTask({ title: 'carry over' });
    await api.upsertPlan({ taskId: t.id, day: todayKey(4), plannedMinutes: 30, order: 0 });
    await api.transitionTask(t.id, 'planned');

    await act(async () => void (await hook.result.current.addToDay({ ...t, status: 'planned' })));

    expect(await plansFor(api, tomorrow)).toMatchObject([{ taskId: t.id }]);
    expect(await plansFor(api, todayKey(4))).toHaveLength(1); // today's row stays as history
    expect((await api.getTask(t.id))?.status).toBe('planned');
  });

  it('unplan: planned → backlog, row removed; in progress only when asked', async () => {
    const { api, hook } = setup();
    await ready(hook);
    const day = todayKey(4);
    const a = await api.createTask({ title: 'a' });
    const pa = await api.upsertPlan({ taskId: a.id, day, plannedMinutes: 30, order: 0 });
    const planned = await api.transitionTask(a.id, 'planned');
    const b = await api.createTask({ title: 'b' });
    const pb = await api.upsertPlan({ taskId: b.id, day, plannedMinutes: 30, order: 1 });
    const started = await api.transitionTask(b.id, 'in_progress');

    await act(async () => void (await hook.result.current.unplan(pa, planned)));
    expect((await api.getTask(a.id))?.status).toBe('backlog');

    await act(
      async () => void (await hook.result.current.unplan(pb, started, { fromInProgress: true })),
    );
    expect((await api.getTask(b.id))?.status).toBe('backlog');
    expect(await plansFor(api, day)).toHaveLength(0);
  });

  it('a retry repairs a half-done add: row written, transition lost', async () => {
    const { api, hook } = setup();
    await ready(hook);
    const t = await api.createTask({ title: 'half' });
    await api.upsertPlan({ taskId: t.id, day: todayKey(4), plannedMinutes: 30, order: 0 });

    let res: string | undefined;
    await act(async () => void (res = await hook.result.current.addToDay(t)));

    expect(res).toBe('already');
    expect(await plansFor(api, todayKey(4))).toHaveLength(1);
    expect((await api.getTask(t.id))?.status).toBe('planned');
  });

  it('unplan keeps a task planned when it is also on tomorrow’s plan', async () => {
    const { api, hook } = setup();
    await ready(hook);
    const day = todayKey(4);
    const t = await api.createTask({ title: 'carried' });
    const row = await api.upsertPlan({ taskId: t.id, day, plannedMinutes: 30, order: 0 });
    await api.upsertPlan({ taskId: t.id, day: addDays(day, 1), plannedMinutes: 30, order: 0 });
    const planned = await api.transitionTask(t.id, 'planned');

    await act(async () => void (await hook.result.current.unplan(row, planned)));

    expect(await plansFor(api, day)).toHaveLength(0);
    expect((await api.getTask(t.id))?.status).toBe('planned');
  });

  it('unplan leaves a task planned for any later day alone (the sweep decides)', async () => {
    const { api, hook } = setup();
    await ready(hook);
    const day = todayKey(4);
    const t = await api.createTask({ title: 'later too' });
    const row = await api.upsertPlan({ taskId: t.id, day, plannedMinutes: 30, order: 0 });
    await api.upsertPlan({ taskId: t.id, day: addDays(day, 3), plannedMinutes: 30, order: 0 });
    const planned = await api.transitionTask(t.id, 'planned');

    await act(async () => void (await hook.result.current.unplan(row, planned)));

    expect((await api.getTask(t.id))?.status).toBe('planned');
  });

  it('createToday creates and plans; a failed plan still keeps the task', async () => {
    const { api, hook } = setup();
    await ready(hook);

    let out: { planned: boolean } | undefined;
    await act(async () => void (out = await hook.result.current.createToday('buy stamps')));
    expect(out?.planned).toBe(true);
    expect(await plansFor(api, todayKey(4))).toHaveLength(1);

    api.upsertPlan = () => Promise.reject(new Error('offline'));
    await act(async () => void (out = await hook.result.current.createToday('call bank')));
    expect(out?.planned).toBe(false);
    expect((await api.listTasks()).map((t) => t.title)).toContain('call bank');
  });

  it('createToday takes a full input; its estimate sets plannedMinutes', async () => {
    const { api, hook } = setup();
    await ready(hook);

    await act(
      async () =>
        void (await hook.result.current.createToday({ title: 'stamps', estimateMin: 20 })),
    );
    const [plan] = await plansFor(api, todayKey(4));
    expect(plan?.plannedMinutes).toBe(20);
  });

  it('a timed task is never added: “timed”, and nothing written — its day is its time', async () => {
    const { api, hook } = setup();
    await ready(hook);
    const t = await api.createTask({
      title: 'OA',
      dueDay: addDays(todayKey(4), 2),
      dueTime: '23:59',
    });
    let res: string | undefined;
    await act(async () => void (res = await hook.result.current.addToDay(t)));
    expect(res).toBe('timed');
    expect(await plansFor(api, todayKey(4))).toEqual([]);
    expect((await api.getTask(t.id))?.status).toBe('backlog');
  });

  it('createToday with a timed input: created, not planned, and says it’s timed', async () => {
    const { api, hook } = setup();
    await ready(hook);
    let out: { task: { id: string }; planned: boolean; timed: boolean } | undefined;
    await act(
      async () =>
        void (out = await hook.result.current.createToday({
          title: 'submit',
          dueDay: addDays(todayKey(4), 1),
          dueTime: '16:00',
        })),
    );
    expect(out).toMatchObject({ planned: false, timed: true });
    expect(await api.getTask(out!.task.id)).toBeTruthy();
    expect(await plansFor(api, todayKey(4))).toEqual([]);
  });
});
