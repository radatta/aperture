import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { todayKey } from '@aperture/shared';
import { renderWithProviders } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';
import { LogPage } from './index';

async function page(key: string) {
  const api = createStubClient({ seed: false, storageKey: `log-page-${key}` });
  const e = await api.createLogEntry('disk pw', todayKey(4));
  const user = userEvent.setup();
  renderWithProviders(<LogPage />, { api });
  const lock = async () => screen.findByRole('button', { name: 'Private entry' });
  return { api, e, user, lock };
}

describe('LogPage lock', () => {
  it('a tap makes the entry private, and another makes it public again', async () => {
    const { api, e, user, lock } = await page('toggle');
    await user.click(await lock());
    await waitFor(async () => expect((await api.listLogEntries(e.day))[0]?.private).toBe(true));
    await waitFor(async () => expect((await lock()).getAttribute('aria-pressed')).toBe('true'));
    await user.click(await lock());
    await waitFor(async () => expect((await api.listLogEntries(e.day))[0]?.private).toBe(false));
  });

  it('a failed toggle rolls the lock back and says so', async () => {
    const { api, user, lock } = await page('fail');
    api.setLogEntryPrivate = () => Promise.reject(new Error('offline'));
    await user.click(await lock());
    expect(await screen.findByRole('alert')).toBeTruthy();
    await waitFor(async () => expect((await lock()).getAttribute('aria-pressed')).toBe('false'));
  });

  it('a queued second toggle never snaps back when the first one lands', async () => {
    const api = createStubClient({ seed: false, storageKey: 'log-page-queue' });
    const day = todayKey(4);
    await api.createLogEntry('a', day);
    await api.createLogEntry('b', day);
    const real = api.setLogEntryPrivate.bind(api);
    const gates: Array<() => void> = [];
    api.setLogEntryPrivate = (id, v) =>
      new Promise((res) => gates.push(() => void real(id, v).then(res)));
    const user = userEvent.setup();
    renderWithProviders(<LogPage />, { api });
    const locks = async () => screen.findAllByRole('button', { name: 'Private entry' });
    await user.click((await locks())[0]!);
    await user.click((await locks())[1]!);
    await waitFor(() => expect(gates).toHaveLength(1)); // the second waits its turn
    gates[0]!();
    await waitFor(() => expect(gates).toHaveLength(2));
    // a refresh now would read b as public; b's lock must stay pressed
    await new Promise((r) => setTimeout(r, 50));
    expect((await locks())[1]!.getAttribute('aria-pressed')).toBe('true');
    gates[1]!();
    await waitFor(async () =>
      expect((await api.listLogEntries(day)).map((e) => e.private)).toEqual([true, true]),
    );
  });

  it('a failed first toggle rolls back only its own row, not a queued second', async () => {
    const api = createStubClient({ seed: false, storageKey: 'log-page-undo' });
    const day = todayKey(4);
    await api.createLogEntry('a', day);
    await api.createLogEntry('b', day);
    const real = api.setLogEntryPrivate.bind(api);
    const gates: Array<() => void> = [];
    let first = true;
    api.setLogEntryPrivate = (id, v) =>
      new Promise((res, rej) =>
        gates.push(() => {
          if (first) {
            first = false;
            rej(new Error('offline'));
          } else void real(id, v).then(res);
        }),
      );
    const user = userEvent.setup();
    renderWithProviders(<LogPage />, { api });
    const locks = async () => screen.findAllByRole('button', { name: 'Private entry' });
    await user.click((await locks())[0]!);
    await user.click((await locks())[1]!);
    await waitFor(() => expect(gates).toHaveLength(1));
    gates[0]!();
    expect(await screen.findByRole('alert')).toBeTruthy();
    await waitFor(() => expect(gates).toHaveLength(2));
    const [a, b] = await locks();
    expect(a!.getAttribute('aria-pressed')).toBe('false');
    expect(b!.getAttribute('aria-pressed')).toBe('true');
    gates[1]!();
  });

  it('the failure line goes when you move to another day', async () => {
    const { api, user, lock } = await page('fail-day');
    api.setLogEntryPrivate = () => Promise.reject(new Error('offline'));
    await user.click(await lock());
    expect(await screen.findByRole('alert')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Previous day' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
