import { describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { taskPushPath } from '@aperture/shared';
import { createStubClient } from '../../data/stubClient';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/utils';

const stub = () => createStubClient({ seed: false, storageKey: `linked-${Math.random()}` });

// A reminder's tap-through (reminders D8): /tasks?lens=today&task=<id>&n=<tag>.
describe('Tasks: a reminder’s link', () => {
  it('clears a sticky search, so the tap lands on Today, not on an old result list', async () => {
    const api = stub();
    const t = await api.createTask({ title: 'Renew passport' });
    const user = userEvent.setup();
    const { router } = renderApp({ api, path: '/tasks' });
    await user.type(await screen.findByRole('searchbox', { name: 'Search tasks' }), 'groceries');
    await act(() => router.navigate(taskPushPath(t.id, t.id)));
    expect(await screen.findByRole('dialog', { name: 'Task: Renew passport' })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search tasks' }).value).toBe(
        '',
      ),
    );
    expect(sessionStorage.getItem('aperture.tasks.query')).not.toMatch(/groceries/);
    // Once per link: typing again after it stays typed.
    await waitFor(() => expect(router.state.location.search).toBe('?lens=today'));
    await user.keyboard('{Escape}');
    await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), 'milk');
    expect(screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search tasks' }).value).toBe(
      'milk',
    );
  });

  it('a search stored earlier this session is cleared by a cold-start tap too', async () => {
    const api = stub();
    const t = await api.createTask({ title: 'Renew passport' });
    const user = userEvent.setup();
    const first = renderApp({ api, path: '/tasks' });
    await user.type(await screen.findByRole('searchbox', { name: 'Search tasks' }), 'groceries');
    first.unmount();
    renderApp({ api, path: taskPushPath(t.id, t.id) });
    expect(await screen.findByRole('dialog', { name: 'Task: Renew passport' })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search tasks' }).value).toBe(
        '',
      ),
    );
  });

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

  it('a newer link that lands while an older one is still being read wins; the older answer is dropped', async () => {
    const api = stub();
    const newer = await api.createTask({ title: 'Newer reminder' });
    const real = api.getTask.bind(api);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const getTask = vi.spyOn(api, 'getTask').mockImplementation(async (id) => {
      await gate;
      return real(id);
    });
    // The older link names a task the list doesn't hold, so it waits on its read — which, answered,
    // would say "gone".
    const { router } = renderApp({ api, path: taskPushPath('01ELSEWHERE', '01ELSEWHERE') });
    await waitFor(() => expect(getTask).toHaveBeenCalledWith('01ELSEWHERE'));
    getTask.mockClear();
    await act(() => router.navigate(taskPushPath(newer.id, newer.id)));
    expect(await screen.findByRole('dialog', { name: 'Task: Newer reminder' })).toBeTruthy();
    await waitFor(() => expect(router.state.location.search).toBe('?lens=today'));
    release(); // the older read answers now: nothing of it shows
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/That reminder’s task is gone/)).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Task: Newer reminder' })).toBeTruthy();
  });

  it('a lens switch before the read lands drops its answer: no modal, no note', async () => {
    const api = stub();
    const elsewhere = await api.createTask({ title: 'Read late' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // The link's task isn't in the list, so it waits on a read — which, answered, would open "Read late".
    vi.spyOn(api, 'getTask').mockImplementation(async () => {
      await gate;
      return elsewhere;
    });
    const user = userEvent.setup();
    const { router } = renderApp({ api, path: taskPushPath('01ELSEWHERE', '01ELSEWHERE') });
    await waitFor(() => expect(api.getTask).toHaveBeenCalledWith('01ELSEWHERE'));
    await user.click(screen.getByRole('button', { name: /^Week/ }));
    await waitFor(() => expect(router.state.location.search).toBe('?lens=week'));
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole('dialog', { name: 'Task: Read late' })).toBeNull();
    expect(screen.queryByText(/That reminder’s task/)).toBeNull();
    expect(router.state.location.search).toBe('?lens=week');
  });
});
