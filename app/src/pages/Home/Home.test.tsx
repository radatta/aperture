import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStubClient } from '../../data/stubClient';
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

  it('pins Daytime → shows the do layout (Right now + Coming up + budget)', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole('button', { name: 'Daytime' }));
    expect(screen.getByText('Right now')).toBeTruthy();
    expect(screen.getByText('Coming up')).toBeTruthy();
    expect(screen.getByText('Time budget')).toBeTruthy();
  });
});

describe('night review', () => {
  it('shows a done task’s reflection under its delta, as plain text; none adds nothing', async () => {
    const api = createStubClient({ seed: false, storageKey: `night-${Math.random()}` });
    const finish = async (title: string, reflection: string | null) => {
      const t = await api.createTask({ title, estimateMin: 30 });
      await api.transitionTask(t.id, 'in_progress');
      await api.setTaskActual(t.id, 45, reflection);
      await api.transitionTask(t.id, 'done');
    };
    await finish('Pset 4', 'Should have **outlined** first');
    await finish('Lab prep', null);
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Night' }));
    expect(await screen.findByText('Should have outlined first')).toBeTruthy(); // markers dropped
    expect(screen.getByText('Lab prep')).toBeTruthy();
    expect(screen.queryByText(/\*\*/)).toBeNull();
  });
});

describe('routing', () => {
  it('navigates from home to the Tasks deep view (plan pass)', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole('link', { name: 'Tasks' }));
    // The Tasks page opens on the Today lens — the capacity field is there synchronously.
    expect(await screen.findByText('Hours available today')).toBeTruthy();
  });

  it('deep-links straight to the log', () => {
    renderApp({ path: '/log' });
    // The capture bar (global) and the log day-nav both render on the log route.
    expect(screen.getByLabelText('Capture log')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Today' })).toBeTruthy();
  });
});
