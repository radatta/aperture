import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ApiClient, PullCalendarResult } from '@aperture/shared';
import { ApiContext } from '../api-context';
import { createStubClient } from '../stubClient';
import { useCalendarPull } from './useCalendar';

beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => vi.restoreAllMocks());

const result = (changed: string[] = []): PullCalendarResult => ({
  pulled: true,
  changedTaskIds: changed,
  accounts: [],
});

function setup(opts: { seed?: boolean; pull?: () => Promise<PullCalendarResult> } = {}) {
  const api: ApiClient = createStubClient({
    seed: opts.seed ?? true, // the seed connects two accounts with auto-sync on
    storageKey: `pull-hook-${Math.random()}`,
  });
  const pull = vi.fn(opts.pull ?? (async () => result()));
  api.pullCalendar = pull;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ApiContext value={api}>{children}</ApiContext>
    </QueryClientProvider>
  );
  renderHook(() => useCalendarPull(), { wrapper });
  return { api, pull, invalidate };
}

const foreground = () =>
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });

describe('useCalendarPull', () => {
  it('pulls once on open, then again on a foreground at least a minute later', async () => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { pull } = setup();
    await waitFor(() => expect(pull).toHaveBeenCalledTimes(1));
    now += 30_000;
    foreground();
    expect(pull).toHaveBeenCalledTimes(1); // inside the minute
    now += 31_000;
    foreground();
    expect(pull).toHaveBeenCalledTimes(2);
  });

  it('never pulls without a connected account', async () => {
    const { api, pull } = setup({ seed: false });
    await api.getSettings(); // settings resolve, still nothing connected
    await act(async () => {});
    expect(pull).not.toHaveBeenCalled();
  });

  it('never pulls with auto-sync off', async () => {
    const api = createStubClient({ seed: true, storageKey: `pull-off-${Math.random()}` });
    await api.updateSettings({ autoCalendar: false });
    const pull = vi.fn(async () => result());
    api.pullCalendar = pull;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useCalendarPull(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          <ApiContext value={api}>{children}</ApiContext>
        </QueryClientProvider>
      ),
    });
    await waitFor(() => expect(client.getQueryData(['settings'])).toBeTruthy());
    expect(pull).not.toHaveBeenCalled();
  });

  it('refetches tasks only when the pull changed something', async () => {
    const { invalidate } = setup({ pull: async () => result(['t1']) });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tasks'] }));
  });

  it('an unchanged pull leaves task data alone', async () => {
    const { pull, invalidate } = setup();
    await waitFor(() => expect(pull).toHaveBeenCalled());
    await act(async () => {});
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['tasks'] });
  });

  it('a rejected pull never throws out of the app', async () => {
    const { pull } = setup({ pull: async () => Promise.reject(new Error('offline')) });
    await waitFor(() => expect(pull).toHaveBeenCalled());
    await act(async () => {});
  });
});
