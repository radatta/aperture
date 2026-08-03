import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/utils';

beforeEach(() => globalThis.localStorage?.clear());

describe('home mode switch', () => {
  it('pins Night → shows the review layout and paints dark', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole('button', { name: 'Night' }));
    expect(screen.getByText('Today in review')).toBeTruthy();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('pins Morning → shows the plan layout and paints light', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole('button', { name: 'Morning' }));
    expect(screen.getByText('Plan today')).toBeTruthy();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('pins Daytime → shows the do layout', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole('button', { name: 'Daytime' }));
    expect(screen.getByText('Time budget')).toBeTruthy();
  });
});

describe('routing', () => {
  it('navigates from home to the Tasks deep view (plan pass)', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole('link', { name: 'Tasks' }));
    // The real Tasks page opens on the Plan tab — capacity field is there synchronously.
    expect(await screen.findByText('Hours available today')).toBeTruthy();
  });

  it('deep-links straight to the log', () => {
    renderApp({ path: '/log' });
    // The capture bar (global) and the log day-nav both render on the log route.
    expect(screen.getByLabelText('Capture log')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Today' })).toBeTruthy();
  });
});
