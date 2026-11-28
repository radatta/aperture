import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { todayKey } from '@aperture/shared';
import type { ApiClient, Task } from '@aperture/shared';
import { ApiContext } from '../api-context';
import { qk } from '../queryKeys';
import { createStubClient } from '../stubClient';
import { LOCAL_WRITE_TTL_MS } from '../taskCache';
import { useBacklog } from './useBacklog';
import { useDay } from './useDay';
import {
  useAllTasks,
  useCheckOffErrand,
  useCreateTask,
  useCreateTasks,
  useDeleteTask,
  useSetDue,
  useSetTaskPlace,
  useSetTaskTitle,
  useSplitTask,
  useTransitionTask,
} from './useTasks';

beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => vi.useRealTimers());

// A stepping server clock: every write gets a later updatedAt, as on the real server. A case that reads
// the day passes a live clock instead: getDay refuses a day after the clock's today.
function setup(before?: (api: ApiClient) => Promise<void> | void, now?: () => number) {
  let clock = 1_000_000;
  const api = createStubClient({
    seed: false,
    storageKey: `use-tasks-${Math.random()}`,
    now: now ?? (() => (clock += 1000)),
  });
  void before?.(api);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <ApiContext value={api}>{children}</ApiContext>
    </QueryClientProvider>
  );
  const hook = renderHook(
    () => ({
      list: useAllTasks(),
      backlog: useBacklog(),
      create: useCreateTask(),
      createMany: useCreateTasks(),
      title: useSetTaskTitle(),
      transition: useTransitionTask(),
      split: useSplitTask(),
      del: useDeleteTask(),
      checkOff: useCheckOffErrand(),
      setPlace: useSetTaskPlace(),
      setDue: useSetDue(),
      settled: useTransitionTask({ settled: true }),
      day: useDay(todayKey(4)),
    }),
    { wrapper },
  );
  return { api, qc, hook };
}

type Hook = ReturnType<typeof setup>['hook'];
const list = (hook: Hook) => hook.result.current.list.data ?? [];
const byId = (hook: Hook, id: string) => list(hook).find((x) => x.id === id);
// Every list read from here on never answers: what shows can only have come from the writes.
const holdList = (api: ApiClient) =>
  vi.spyOn(api, 'listTasks').mockImplementation(() => new Promise(() => {}));
// Tasks made through the api directly: read them into the list.
// (After the first load: a refetch made during it joins that read, which predates the task.)
async function reload(hook: Hook) {
  await waitFor(() => expect(hook.result.current.list.isSuccess).toBe(true));
  await run(() => hook.result.current.list.refetch());
}
// A step, then one macrotask: TanStack notifies observers on a setTimeout(0).
const run = (fn: () => Promise<unknown>) =>
  act(async () => {
    await fn();
    await new Promise((r) => setTimeout(r, 0));
  });
// The next list read answers with this (stale) snapshot; later reads are real.
const staleOnce = (api: ApiClient, snapshot: Task[]) =>
  vi.spyOn(api, 'listTasks').mockResolvedValueOnce(snapshot);

describe('the tasks list carries what writes returned', () => {
  it('a status change shows before any refetch lands', async () => {
    const { api, hook } = setup();
    const t = await api.createTask({ title: 'A' });
    await reload(hook);
    await waitFor(() => expect(byId(hook, t.id)).toBeTruthy());
    holdList(api);
    await run(() => hook.result.current.transition.mutateAsync({ id: t.id, to: 'planned' }));
    expect(byId(hook, t.id)!.status).toBe('planned');
  });

  it('a stale refetch after the write never undoes it', async () => {
    const { api, hook } = setup();
    const t = await api.createTask({ title: 'A' });
    await reload(hook);
    await waitFor(() => expect(byId(hook, t.id)).toBeTruthy());
    staleOnce(api, await api.listTasks()); // the invalidate's refetch reads from before the write
    await run(() => hook.result.current.title.mutateAsync({ id: t.id, title: 'B' }));
    await waitFor(() => expect(hook.result.current.list.isFetching).toBe(false));
    expect(byId(hook, t.id)!.title).toBe('B');
    await run(() => hook.result.current.list.refetch());
    expect(byId(hook, t.id)!.title).toBe('B');
  });

  it('a delete takes the task and its parts out, and a stale refetch doesn’t bring them back', async () => {
    const { api, qc, hook } = setup();
    const p = await api.createTask({ title: 'P' });
    const [a, b] = await api.createTasks([
      { title: 'a', parentId: p.id },
      { title: 'b', parentId: p.id },
    ]);
    await reload(hook);
    await waitFor(() => expect(byId(hook, b!.id)).toBeTruthy());
    const stale = await api.listTasks();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    staleOnce(api, stale);
    await run(() => hook.result.current.del.mutateAsync(p.id));
    await waitFor(() => expect(hook.result.current.list.isFetching).toBe(false));
    for (const id of [p.id, a!.id, b!.id]) expect(byId(hook, id)).toBeUndefined();
    const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey?.[0]);
    expect(keys).toEqual(expect.arrayContaining(['tasks', 'attachments']));
  });

  it('a split shows all three tasks: the new parent, this one finished, the follow-up', async () => {
    const { api, hook } = setup();
    let t = await api.createTask({ title: 'Essay', estimateMin: 60 });
    t = await api.transitionTask(t.id, 'in_progress');
    await reload(hook);
    await waitFor(() => expect(byId(hook, t.id)).toBeTruthy());
    holdList(api);
    let r!: Awaited<ReturnType<ApiClient['splitTask']>>;
    await run(async () => {
      r = await hook.result.current.split.mutateAsync({
        id: t.id,
        input: {
          finish: 'done',
          actualMin: 20,
          parentTitle: 'Essay',
          followUp: { title: 'rest', estimateMin: 40 },
        },
      });
    });
    expect(byId(hook, r.parent.id)).toBeTruthy();
    expect(byId(hook, t.id)!.status).toBe('done');
    expect(byId(hook, r.followUp.id)!.title).toBe('rest');
  });

  it('creates land at the top, one or many', async () => {
    const { api, hook } = setup();
    await api.createTask({ title: 'old' });
    await reload(hook);
    await waitFor(() => expect(list(hook)).toHaveLength(1));
    holdList(api);
    await run(() => hook.result.current.create.mutateAsync('new'));
    expect(list(hook)[0]!.title).toBe('new');
    await run(() => hook.result.current.createMany.mutateAsync([{ title: 'x' }, { title: 'y' }]));
    expect(list(hook).map((x) => x.title)).toEqual(
      expect.arrayContaining(['x', 'y', 'new', 'old']),
    );
    expect(list(hook)).toHaveLength(4);
  });

  it('another device’s later change wins over our write', async () => {
    const { api, hook } = setup();
    const t = await api.createTask({ title: 'A' });
    await reload(hook);
    await waitFor(() => expect(byId(hook, t.id)).toBeTruthy());
    let mine!: Task;
    await run(
      async () => (mine = await hook.result.current.title.mutateAsync({ id: t.id, title: 'mine' })),
    );
    const theirs = { ...mine, title: 'theirs', updatedAt: mine.updatedAt + 1 };
    vi.spyOn(api, 'listTasks').mockResolvedValue([theirs]);
    await run(() => hook.result.current.list.refetch());
    expect(byId(hook, t.id)!.title).toBe('theirs');
  });

  it('a write the server never shows is dropped after the TTL', async () => {
    const { api, hook } = setup();
    await waitFor(() => expect(hook.result.current.list.isSuccess).toBe(true));
    vi.spyOn(api, 'listTasks').mockResolvedValue([]); // the server never shows it
    let made!: Task;
    await run(async () => (made = await hook.result.current.create.mutateAsync('ghost')));
    await run(() => hook.result.current.list.refetch());
    expect(byId(hook, made.id)).toBeTruthy();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + LOCAL_WRITE_TTL_MS + 1);
    await run(() => hook.result.current.list.refetch());
    expect(byId(hook, made.id)).toBeUndefined();
  });

  it('a write before the list ever loaded paints no one-row list; a stale first read still shows it', async () => {
    // The first read never answers; the hook mounts against it.
    let spy!: ReturnType<typeof holdList>;
    const { api, hook } = setup((api) => {
      spy = vi.spyOn(api, 'listTasks').mockImplementationOnce(() => new Promise(() => {}));
    });
    const t = await api.createTask({ title: 'A' });
    const z = await api.createTask({ title: 'Z' });
    // The write's refetch reads from before the write.
    spy.mockResolvedValueOnce([z, t]);
    expect(hook.result.current.list.data).toBeUndefined();
    await act(
      async () => void (await hook.result.current.title.mutateAsync({ id: t.id, title: 'B' })),
    );
    // Never the written task alone: nothing yet, or the whole list (the write's refetch).
    const shown = hook.result.current.list.data;
    expect(shown === undefined || shown.length === 2).toBe(true);
    await waitFor(() => expect(hook.result.current.list.isSuccess).toBe(true));
    await waitFor(() => expect(hook.result.current.list.isFetching).toBe(false));
    expect(byId(hook, t.id)?.title).toBe('B');
    expect(list(hook)).toHaveLength(2);
  });

  it('dropping a parent drops its open parts before any refetch lands', async () => {
    const { api, hook } = setup();
    const p = await api.createTask({ title: 'P' });
    const [a] = await api.createTasks([{ title: 'a', parentId: p.id }]);
    await api.setTaskDue(a!.id, { dueDay: '2026-08-05', dueTime: '15:00' });
    await reload(hook);
    await waitFor(() => expect(byId(hook, a!.id)).toBeTruthy());
    holdList(api);
    await run(() => hook.result.current.transition.mutateAsync({ id: p.id, to: 'cancelled' }));
    expect(byId(hook, a!.id)!.status).toBe('cancelled');
  });

  it('the backlog derives from the list: it moves with the write, and never reads listBacklog', async () => {
    const { api, hook } = setup();
    const backlogRead = vi.spyOn(api, 'listBacklog');
    const t = await api.createTask({ title: 'A' });
    await reload(hook);
    await waitFor(() => expect(hook.result.current.backlog.data?.map((x) => x.id)).toEqual([t.id]));
    holdList(api);
    await run(() => hook.result.current.transition.mutateAsync({ id: t.id, to: 'planned' }));
    expect(hook.result.current.backlog.data).toEqual([]);
    expect(backlogRead).not.toHaveBeenCalled();
  });

  it('the backlog is what “+ Add” can pull in: no timed task, no parent — its parts instead', async () => {
    const { api, hook } = setup();
    const plain = await api.createTask({ title: 'plain' });
    const timed = await api.createTask({ title: 'timed' });
    await api.setTaskDue(timed.id, { dueDay: '2026-08-05', dueTime: '15:00' });
    const p = await api.createTask({ title: 'P' });
    const [part] = await api.createTasks([{ title: 'part', parentId: p.id }]);
    await reload(hook);
    await waitFor(() => expect(byId(hook, part!.id)).toBeTruthy());
    expect(hook.result.current.backlog.data?.map((x) => x.id).sort()).toEqual(
      [plain.id, part!.id].sort(),
    );
  });
});

describe('a series deadline occurrence (recurring D8)', () => {
  it('unplanned, it is waiting in the backlog like an untimed task', async () => {
    const { api, hook } = setup(undefined, () => Date.now()); // getDay refuses a day after the clock's
    const today = todayKey(4);
    await api.upsertSeries({
      title: 'Pre-lab',
      categoryId: null,
      defaultEstimateMin: 45,
      rule: { kind: 'daily' },
      anchorDate: today,
      dueOffsetDays: 1,
      dueTime: '14:00',
    });
    await api.getDay(today);
    const [row] = await api.listPlansForDay(today);
    await api.removePlan(row!.id);
    await api.getDay(today);
    await reload(hook);
    await waitFor(() => expect(byId(hook, row!.taskId)?.status).toBe('backlog'));
    expect(hook.result.current.backlog.data?.map((x) => x.id)).toContain(row!.taskId);
  });
});

describe('the life backlog (D14)', () => {
  it('leaves an Aperture-area task out; no area and a retired category read by their area', async () => {
    const { api, qc, hook } = setup();
    const ap = await api.upsertCategory({ label: 'Aperture', isWork: true, area: 'aperture' });
    const sc = await api.upsertCategory({ label: 'MATH', isWork: true, area: 'school' });
    const none = await api.upsertCategory({ label: 'Misc', isWork: false });
    const dev = await api.createTask({ title: 'dev', categoryId: ap.id });
    const hw = await api.createTask({ title: 'hw', categoryId: sc.id });
    const misc = await api.createTask({ title: 'misc', categoryId: none.id });
    const bare = await api.createTask({ title: 'bare' });
    // The roster was read before these existed (Settings' writes invalidate it; a direct api call doesn't).
    await run(() => qc.invalidateQueries({ queryKey: qk.categories() }));
    await reload(hook);
    await waitFor(() =>
      expect(hook.result.current.backlog.data?.map((x) => x.id).sort()).toEqual(
        [hw.id, misc.id, bare.id].sort(),
      ),
    );
    expect(hook.result.current.backlog.data?.map((x) => x.id)).not.toContain(dev.id);
  });
});

describe('errands', () => {
  it('a check-off chains an unstarted errand through in_progress to done, and the list shows it', async () => {
    const { api, hook } = setup();
    await api.upsertPlace({ name: 'Market' });
    const t = await api.createTask({ title: 'milk', place: 'market' });
    await reload(hook);
    const transition = vi.spyOn(api, 'transitionTask');
    holdList(api);
    await run(() => hook.result.current.checkOff.mutateAsync(t));
    expect(transition.mock.calls.map((c) => c[1])).toEqual(['in_progress', 'done']);
    expect(byId(hook, t.id)!.status).toBe('done');
  });

  it('a started errand is just finished', async () => {
    const { api, hook } = setup();
    await api.upsertPlace({ name: 'Market' });
    const t = await api.transitionTask(
      (await api.createTask({ title: 'milk', place: 'market' })).id,
      'in_progress',
    );
    await reload(hook);
    const transition = vi.spyOn(api, 'transitionTask');
    await run(() => hook.result.current.checkOff.mutateAsync(t));
    expect(transition.mock.calls.map((c) => c[1])).toEqual(['done']);
  });

  it('setting a place shows in the list at once', async () => {
    const { api, hook } = setup();
    await api.upsertPlace({ name: 'Market' });
    const t = await api.createTask({ title: 'milk' });
    await reload(hook);
    holdList(api);
    await run(() => hook.result.current.setPlace.mutateAsync({ id: t.id, place: 'market' }));
    expect(byId(hook, t.id)!.place).toBe('market');
  });
});

describe('what a task write refetches', () => {
  it('setting a due date refetches the day — the sweep settles a planned task that gained a time; a title does not', async () => {
    // Live, stepping: today is today, and the sweep's stamp is newer than the write's (a tie keeps ours).
    let live = Date.now();
    const { api, hook } = setup(undefined, () => (live += 1000));
    const t = await api.createTask({ title: 'OA' });
    await api.upsertPlan({ taskId: t.id, day: todayKey(4), plannedMinutes: 30, order: 0 });
    await api.transitionTask(t.id, 'planned');
    await reload(hook);
    await waitFor(() => expect(hook.result.current.day.isSuccess).toBe(true));
    const getDay = vi.spyOn(api, 'getDay');

    await run(() => hook.result.current.title.mutateAsync({ id: t.id, title: 'OA 2' }));
    await waitFor(() => expect(byId(hook, t.id)!.title).toBe('OA 2'));
    expect(getDay).not.toHaveBeenCalled();

    await run(() =>
      hook.result.current.setDue.mutateAsync({
        id: t.id,
        due: { dueDay: todayKey(4), dueTime: '23:58' },
      }),
    );
    await waitFor(() => expect(getDay).toHaveBeenCalledTimes(1));
    // The sweep moved it: a timed task is on its day by its time, not planned (lenses.md D13).
    await waitFor(() => expect(byId(hook, t.id)!.status).toBe('backlog'));
  });

  it('a transition resolves on the write by default; with `settled` only once the list refetched', async () => {
    const { api, hook } = setup();
    const t = await api.createTask({ title: 'pset' });
    await reload(hook);
    let release!: (tasks: Task[]) => void;
    const real = api.listTasks.bind(api);
    vi.spyOn(api, 'listTasks').mockImplementation(() => new Promise<Task[]>((r) => (release = r)));

    // Default: the write answers, the mutation is done — the held list read is still out.
    await run(() => hook.result.current.transition.mutateAsync({ id: t.id, to: 'planned' }));
    expect(byId(hook, t.id)!.status).toBe('planned');

    // settled: pending until that read lands.
    let done = false;
    let p!: Promise<boolean>;
    await act(async () => {
      p = hook.result.current.settled
        .mutateAsync({ id: t.id, to: 'in_progress' })
        .then(() => (done = true));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(done).toBe(false);
    await act(async () => {
      release(await real());
      await p;
    });
    expect(done).toBe(true);
  });
});
