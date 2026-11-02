import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiClient, PomodoroSession } from '@aperture/shared';
import { renderApp } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';

beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => vi.useRealTimers());

const stub = () => createStubClient({ seed: true, storageKey: `pomo-${Math.random()}` });
const boom = (method: string) => () => Promise.reject(new Error(`${method} failed (503)`));

async function startFocus(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTitle('Start a 25-minute focus block'));
  await screen.findByRole('button', { name: 'Pause' });
}

describe('PomodoroProvider: failed calls never look like success', () => {
  it('a failed adopt-load shows an error row, never an empty dock', async () => {
    const api = stub();
    api.listRunningSessions = boom('listRunningSessions');
    renderApp({ api, path: '/settings' });
    await screen.findByText('Couldn’t check for running timers.');
    expect(screen.getByTitle('Start a 25-minute focus block')).toBeTruthy(); // starting is still safe
  });

  it('Retry on the adopt row re-reads running sessions', async () => {
    const user = userEvent.setup();
    const api = stub();
    const real = api.listRunningSessions.bind(api);
    let fail = true;
    api.listRunningSessions = () => (fail ? boom('listRunningSessions')() : real());
    renderApp({ api, path: '/settings' });
    await screen.findByText('Couldn’t check for running timers.');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(screen.queryByText('Couldn’t check for running timers.')).toBeNull(),
    );
  });

  it('a failed stop keeps the timer and says so', async () => {
    const user = userEvent.setup();
    const api = stub();
    api.stopSession = boom('stopSession');
    renderApp({ api, path: '/settings' });
    await startFocus(user);
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await screen.findByText('Couldn’t stop — try again.');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });

  it('a failed pause still pauses locally', async () => {
    const user = userEvent.setup();
    const api = stub();
    renderApp({ api, path: '/settings' });
    await startFocus(user);
    api.heartbeatSession = boom('heartbeatSession');
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    await screen.findByRole('button', { name: 'Resume' });
    await screen.findByText('not syncing');
  });

  it('a failed resume stays paused and says so', async () => {
    const user = userEvent.setup();
    const api = stub();
    api.resumeSession = boom('resumeSession');
    renderApp({ api, path: '/settings' });
    await startFocus(user);
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    await user.click(await screen.findByRole('button', { name: 'Resume' }));
    await screen.findByText('Couldn’t resume — try again.');
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
  });

  it('two failed heartbeats mark the timer not syncing; a good one clears it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const api = stub();
    const real = api.heartbeatSession.bind(api);
    renderApp({ api, path: '/settings' });
    await startFocus(user);
    let fail = true;
    api.heartbeatSession = (id) => (fail ? boom('heartbeatSession')() : real(id));
    await act(async () => void vi.advanceTimersByTime(15_000));
    expect(screen.queryByText('not syncing')).toBeNull(); // one miss is a blip
    await act(async () => void vi.advanceTimersByTime(15_000));
    await screen.findByText('not syncing');
    fail = false;
    await act(async () => void vi.advanceTimersByTime(15_000));
    await waitFor(() => expect(screen.queryByText('not syncing')).toBeNull());
  });

  it('a failed keep keeps the stale prompt and says so', async () => {
    const user = userEvent.setup();
    const api: ApiClient = stub();
    const old: PomodoroSession = {
      ...(await api.startSession({
        taskId: null,
        categoryId: null,
        kind: 'work',
        label: 'Old',
        day: '2026-01-01',
      })),
    };
    old.lastHeartbeatAt = Date.now() - 10 * 60_000;
    api.listRunningSessions = async () => [old];
    api.resolveStaleSession = boom('resolveStaleSession');
    renderApp({ api, path: '/settings' });
    await user.click(await screen.findByRole('button', { name: 'Keep' }));
    await screen.findByText('Couldn’t save — try again.');
    expect(screen.getByText(/was left running/)).toBeTruthy();
  });

  it('a failed start says so', async () => {
    const user = userEvent.setup();
    const api = stub();
    api.startSession = boom('startSession');
    renderApp({ api, path: '/settings' });
    await user.click(await screen.findByTitle('Start a 25-minute focus block'));
    await screen.findByText('Couldn’t start the timer — try again.');
  });
});
