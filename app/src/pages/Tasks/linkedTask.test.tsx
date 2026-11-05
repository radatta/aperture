import { describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { taskPushPath } from '@aperture/shared';
import { createStubClient } from '../../data/stubClient';
import { renderApp } from '../../test/utils';

const stub = () => createStubClient({ seed: false, storageKey: `linked-${Math.random()}` });

// A reminder's tap-through (reminders D8): /tasks?lens=today&task=<id>&n=<tag>.
describe('Tasks: a reminder’s link', () => {
  it('opens the linked task once, then drops task and n from the URL (replaced, lens kept)', async () => {
    const api = stub();
    const t = await api.createTask({ title: 'Renew passport' });
    const { router } = renderApp({ api, path: taskPushPath(t.id, t.id) });
    expect(await screen.findByRole('dialog', { name: 'Task: Renew passport' })).toBeTruthy();
    await waitFor(() => expect(router.state.location.search).toBe('?lens=today'));
    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('a batch link (n only) just lands on Today and drops n', async () => {
    const { router } = renderApp({ api: stub(), path: taskPushPath(null, 'b29400000') });
    await waitFor(() => expect(router.state.location.search).toBe('?lens=today'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a task deleted since the ping says so instead of opening nothing', async () => {
    const { router } = renderApp({ api: stub(), path: taskPushPath('01GONE', '01GONE') });
    expect(await screen.findByText(/That reminder’s task is gone/)).toBeTruthy();
    await waitFor(() => expect(router.state.location.search).toBe('?lens=today'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a task the cached list predates still opens, and a new link clears the old "gone" note', async () => {
    const api = stub();
    const { router } = renderApp({ api, path: taskPushPath('01GONE', '01GONE') });
    expect(await screen.findByText(/That reminder’s task is gone/)).toBeTruthy(); // the list is cached
    const fresh = await api.createTask({ title: 'Made on the phone' }); // behind the cache's back
    await act(() => router.navigate(taskPushPath(fresh.id, fresh.id)));
    expect(await screen.findByRole('dialog', { name: 'Task: Made on the phone' })).toBeTruthy();
    expect(screen.queryByText(/That reminder’s task is gone/)).toBeNull();
    await waitFor(() => expect(router.state.location.search).toBe('?lens=today'));
  });

  it('a task that can’t be read says so instead of calling it gone', async () => {
    const api = stub();
    vi.spyOn(api, 'getTask').mockRejectedValue(new Error('getTask failed (503)'));
    const { router } = renderApp({ api, path: taskPushPath('01ELSEWHERE', '01ELSEWHERE') });
    expect(await screen.findByText(/Couldn’t open that reminder’s task/)).toBeTruthy();
    expect(screen.queryByText(/is gone/)).toBeNull();
    await waitFor(() => expect(router.state.location.search).toBe('?lens=today'));
  });
});
