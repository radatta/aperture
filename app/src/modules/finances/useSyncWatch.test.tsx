import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { FINANCE_SYNCING_MAX_MS } from '@aperture/shared';
import type { FinanceItemSync, FinanceOverview } from '@aperture/shared';
import { ApiContext } from '../../data/api-context';
import { createStubClient } from '../../data/stubClient';
import { useSyncWatch } from './useSyncWatch';

// The watch against fake overview sequences — the async Lambda shape the inline stub can't produce:
// request → polls that read `syncing` → a finished run.
function overview(syncing: boolean, items: Partial<FinanceItemSync>[]): FinanceOverview {
  return {
    sync: {
      syncing,
      lastSyncedAt: null,
      lastError: null,
      lastErrorAt: null,
      environment: 'sandbox',
      items: items.map((i) => ({
        itemId: 'bofa',
        lastSyncedAt: 100,
        lastError: null,
        lastErrorAt: null,
        ...i,
      })),
    },
  } as FinanceOverview;
}

function setup(first: FinanceOverview) {
  const api = createStubClient({ seed: false, storageKey: `watch-${Math.random()}` });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ApiContext value={api}>{children}</ApiContext>
    </QueryClientProvider>
  );
  return renderHook(({ o }) => useSyncWatch(o), { wrapper, initialProps: { o: first } });
}

afterEach(() => vi.useRealTimers());

describe('useSyncWatch', () => {
  it('a failure after a syncing phase opens the dialog for that item', () => {
    const h = setup(overview(false, [{}]));
    act(() => h.result.current.arm());
    h.rerender({ o: overview(true, [{}]) }); // the poll sees the request
    expect(h.result.current.failed).toBeNull();
    h.rerender({ o: overview(false, [{ lastError: 'INSTITUTION_DOWN', lastErrorAt: 200 }]) });
    expect(h.result.current.failed).toEqual({ itemId: 'bofa', code: 'INSTITUTION_DOWN' });
  });

  it('the overview on screen when arming never decides, even though it isn’t syncing', () => {
    const o = overview(false, [{ lastError: 'INSTITUTION_DOWN', lastErrorAt: 50 }]);
    const h = setup(o);
    act(() => h.result.current.arm());
    h.rerender({ o });
    expect(h.result.current.failed).toBeNull();
  });

  it('an old error still showing is not news; a success disarms', () => {
    const old = { lastError: 'INSTITUTION_DOWN', lastErrorAt: 50 };
    const h = setup(overview(false, [old]));
    act(() => h.result.current.arm());
    h.rerender({ o: overview(true, [old]) });
    h.rerender({ o: overview(false, [{ lastSyncedAt: 300 }]) }); // succeeded
    expect(h.result.current.failed).toBeNull();
    // Disarmed: a later scheduled failure doesn't pop the dialog.
    h.rerender({ o: overview(false, [{ lastError: 'INSTITUTION_DOWN', lastErrorAt: 400 }]) });
    expect(h.result.current.failed).toBeNull();
  });

  it('connecting a second bank: its first-sync failure is caught although lastSyncedAt went to null', () => {
    const h = setup(overview(false, [{}]));
    act(() => h.result.current.arm());
    h.rerender({ o: overview(true, [{}, { itemId: 'chase', lastSyncedAt: null }]) });
    h.rerender({
      o: overview(false, [
        {},
        {
          itemId: 'chase',
          lastSyncedAt: null,
          lastError: 'INSTITUTION_NOT_RESPONDING',
          lastErrorAt: 210,
        },
      ]),
    });
    expect(h.result.current.failed).toEqual({
      itemId: 'chase',
      code: 'INSTITUTION_NOT_RESPONDING',
    });
  });

  it('a refused request (disarm) or an expired arm never opens it later', () => {
    vi.useFakeTimers();
    const h = setup(overview(false, [{}]));
    act(() => h.result.current.arm());
    act(() => h.result.current.disarm());
    h.rerender({ o: overview(false, [{ lastError: 'INSTITUTION_DOWN', lastErrorAt: 200 }]) });
    expect(h.result.current.failed).toBeNull();

    act(() => h.result.current.arm());
    h.rerender({ o: overview(true, [{ lastError: 'INSTITUTION_DOWN', lastErrorAt: 200 }]) });
    act(() => void vi.advanceTimersByTime(FINANCE_SYNCING_MAX_MS + 1)); // the run never reported
    h.rerender({ o: overview(false, [{ lastError: 'INSTITUTION_DOWN', lastErrorAt: 900 }]) });
    expect(h.result.current.failed).toBeNull();
  });
});
