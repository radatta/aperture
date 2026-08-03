import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { todayKey } from '@aperture/shared';
import { renderWithProviders } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';
import { CaptureBar } from './CaptureBar';

beforeEach(() => globalThis.localStorage?.clear());

describe('CaptureBar', () => {
  it('logs an entry on Enter, then clears and stays in Log mode', async () => {
    const api = createStubClient({ seed: false, storageKey: 'cap-test' });
    const user = userEvent.setup();
    renderWithProviders(<CaptureBar />, { api });

    const input = screen.getByLabelText('Capture log') as HTMLInputElement;
    await user.type(input, 'shipped the thing');
    await user.keyboard('{Enter}');

    await waitFor(async () => {
      const entries = await api.listLogEntries(todayKey(4));
      expect(entries.map((e) => e.text)).toContain('shipped the thing');
    });
    expect(input.value).toBe('');
    // still Log mode (never asked for structure, snapped back)
    expect(screen.getByLabelText('Capture log')).toBeTruthy();
  });
});
