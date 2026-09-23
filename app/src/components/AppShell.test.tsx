import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../test/utils';

beforeEach(() => globalThis.localStorage?.clear());

describe('dock: idle Focus', () => {
  it('sits inside the capture panel while idle, and hands over to the timer row once started', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/settings' });

    const focus = await screen.findByTitle('Start a 25-minute focus block');
    // Inside the capture panel (the element holding the capture field), not a floating row above it.
    const panel = screen.getByLabelText('Capture log').closest('.rounded-2xl');
    expect(panel?.contains(focus)).toBe(true);

    await user.click(focus);
    await waitFor(() => expect(screen.queryByTitle('Start a 25-minute focus block')).toBeNull());
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });
});
