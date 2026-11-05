import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
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
});
