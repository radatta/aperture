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
});
