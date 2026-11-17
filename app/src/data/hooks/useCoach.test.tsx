import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { ApiContext } from '../api-context';
import { qk } from '../queryKeys';
import { createStubClient } from '../stubClient';
import { useCoachToday } from './useCoach';

beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => vi.restoreAllMocks());

// The day's AI pick start is shared by every reader and outlives any one of them (docs/areas/recruiting/coach.md →
// The AI pick): a start that failed reads as failed — a Retry, never a stuck "picking" — wherever and whenever the
// plan is read again that day.
describe('useCoachToday and the AI pick start', () => {
  function setup() {
    const api = createStubClient({ seed: true, storageKey: `use-coach-${Math.random()}` });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>
        <ApiContext value={api}>{children}</ApiContext>
      </QueryClientProvider>
    );
    return { api, qc, mount: () => renderHook(() => useCoachToday(), { wrapper }) };
  }

  it('starts once on a due day, and the plan lands', async () => {
    const { api, mount } = setup();
    const start = vi.spyOn(api, 'startCoachPick');
    const a = mount();
    mount();
    await waitFor(() => expect(a.result.current.data?.ai?.status).toBe('ok'));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('a failed start still reads as failed after its first reader is gone and the plan was dropped', async () => {
    const { api, qc, mount } = setup();
    vi.spyOn(api, 'startCoachPick').mockRejectedValueOnce(new Error('offline'));
    const first = mount();
    await waitFor(() => expect(first.result.current.startFailed).toBe(true));
    first.unmount();
    qc.removeQueries({ queryKey: qk.coachToday() }); // as the plan's own clean-up would, minutes later
    const again = mount();
    await waitFor(() => expect(again.result.current.data?.ai?.status).toBe('due'));
    expect(again.result.current.startFailed).toBe(true);
  });
});
