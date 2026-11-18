import { beforeEach, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { todayKey } from '@aperture/shared';
import { ApiContext } from '../api-context';
import { qk } from '../queryKeys';
import { createStubClient } from '../stubClient';
import { usePlansForDay, useRemovePlan, useUpsertPlan } from './usePlans';

beforeEach(() => globalThis.localStorage?.clear());

const DAY = todayKey(4);

// The plan hooks own their key: the row a write returns lands in that day's list at once, then the
// plans queries refetch once — never tasks, never the day. A slow server stands in for a real one.
function setup() {
  const api = createStubClient({ seed: false, storageKey: `use-plans-${Math.random()}` });
  const calls: string[] = [];
  // hold() parks every plans read until its release runs: what lands meanwhile can only be the write-through.
  let held: Promise<void> | null = null;
  const hold = () => {
    let release!: () => void;
    held = new Promise<void>((resolve) => (release = resolve));
    return () => {
      held = null;
      release();
    };
  };
  const proxied = new Proxy(api, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        const call = () => (v as (...a: unknown[]) => unknown).apply(target, args);
        return held && prop === 'listPlansForDay' ? held.then(call) : call();
      };
    },
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <ApiContext value={proxied}>{children}</ApiContext>
    </QueryClientProvider>
  );
  const hook = renderHook(
    () => ({ plans: usePlansForDay(DAY), upsert: useUpsertPlan(), remove: useRemovePlan() }),
    { wrapper },
  );
  const settled = () => waitFor(() => expect(qc.isFetching()).toBe(0));
  const reads = (method: string) => calls.filter((c) => c === method).length;
  return { api, qc, hook, calls, settled, reads, hold };
}

describe('usePlans: write-through, one refetch', () => {
  it('an upsert appends the row to its day and refetches the plans once — nothing else', async () => {
    const { api, qc, hook, calls, settled, reads, hold } = setup();
    const t = await api.createTask({ title: 'pset' });
    await settled();
    calls.length = 0;
    const release = hold();

    let p!: Promise<unknown>;
    act(() => {
      p = hook.result.current.upsert.mutateAsync({
        taskId: t.id,
        day: DAY,
        plannedMinutes: 30,
        order: 0,
      });
    });
    // Written through before any refetch lands: every plans read is held, so the row can only be the write's.
    // waitFor runs outside act — nested inside it, it switches React's act environment off mid-scope.
    await waitFor(() => expect(qc.getQueryData(qk.plans(DAY))).toHaveLength(1));
    await act(async () => {
      release();
      await p;
    });
    await settled();

    expect(reads('listPlansForDay')).toBe(1);
    expect(reads('listTasks')).toBe(0);
    expect(reads('getDay')).toBe(0);
    expect(hook.result.current.plans.data).toMatchObject([{ taskId: t.id, plannedMinutes: 30 }]);
  });

  it('an upsert by id replaces the row in place; a remove drops it; each refetches once', async () => {
    const { api, hook, calls, settled, reads } = setup();
    const t = await api.createTask({ title: 'pset' });
    const row = await api.upsertPlan({ taskId: t.id, day: DAY, plannedMinutes: 30, order: 0 });
    await settled();
    calls.length = 0;

    await act(
      async () =>
        void (await hook.result.current.upsert.mutateAsync({
          id: row.id,
          taskId: t.id,
          day: DAY,
          plannedMinutes: 45,
          order: 0,
        })),
    );
    await settled();
    expect(hook.result.current.plans.data).toMatchObject([{ id: row.id, plannedMinutes: 45 }]);
    expect(reads('listPlansForDay')).toBe(1);

    await act(
      async () => void (await hook.result.current.remove.mutateAsync({ id: row.id, day: DAY })),
    );
    await settled();
    expect(hook.result.current.plans.data).toEqual([]);
    expect(reads('listPlansForDay')).toBe(2);
    expect(reads('listTasks')).toBe(0);
    expect(reads('getDay')).toBe(0);
  });

  it('a failed upsert writes nothing through and still refetches, so the list is the server’s', async () => {
    const { api, hook, calls, settled, reads } = setup();
    const t = await api.createTask({ title: 'pset' });
    await settled();
    calls.length = 0;
    api.upsertPlan = () => Promise.reject(new Error('offline'));

    await act(async () => {
      await expect(
        hook.result.current.upsert.mutateAsync({
          taskId: t.id,
          day: DAY,
          plannedMinutes: 30,
          order: 0,
        }),
      ).rejects.toThrow('offline');
    });
    await settled();

    expect(hook.result.current.plans.data).toEqual([]);
    expect(reads('listPlansForDay')).toBe(1);
  });
});
