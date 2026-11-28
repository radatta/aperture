import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStubClient } from '../../data/stubClient';
import { renderApp, timersAdopted } from '../../test/utils';

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

  it('deep-links straight to the log', async () => {
    renderApp({ path: '/log' });
    await timersAdopted();
    // The capture bar (global) and the log day-nav both render on the log route.
    expect(screen.getByLabelText('Capture log')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Today' })).toBeTruthy();
  });
});

describe('Plan today › the waiting count', () => {
  async function apertureBacklog() {
    const api = createStubClient({ seed: false, storageKey: `home-${Math.random()}` });
    const cat = await api.upsertCategory({ label: 'A', isWork: true, area: 'aperture' });
    await api.createTask({ title: 'a1', categoryId: cat.id });
    await api.createTask({ title: 'a2', categoryId: cat.id });
    await api.createTask({ title: 'life' });
    return api;
  }
  const line = () => document.body.textContent?.match(/\d+ waiting in the backlog/)?.[0] ?? null;

  it('shows no count until the roster is in, so it never starts high and drops', async () => {
    const api = await apertureBacklog();
    const real = api.listCategories.bind(api);
    let open = () => {};
    const gate = new Promise<void>((r) => (open = r));
    vi.spyOn(api, 'listCategories').mockImplementation(async () => {
      await gate;
      return real();
    });
    const user = userEvent.setup();
    renderApp({ api, path: '/' });
    await user.click(screen.getByRole('button', { name: 'Morning' }));
    await screen.findByText(/Nothing planned yet/);
    await new Promise((r) => setTimeout(r, 100)); // the tasks read has landed
    expect(line()).toBeNull();
    open();
    await waitFor(() => expect(line()).toBe('1 waiting in the backlog'));
  });

  it('a failed roster still counts, every task as Personal', async () => {
    const api = await apertureBacklog();
    vi.spyOn(api, 'listCategories').mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderApp({ api, path: '/' });
    await user.click(screen.getByRole('button', { name: 'Morning' }));
    await waitFor(() => expect(line()).toBe('3 waiting in the backlog'), { timeout: 15_000 });
  }, 20_000);
});

// The morning line for LeetCode (scenario 15): the coach's day in one line, linking to the Today card.
describe('the LeetCode morning line', () => {
  const morning = async (api: ReturnType<typeof createStubClient>) => {
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Morning' }));
  };

  it('reads the coach’s day and links to it', async () => {
    const api = createStubClient({ seed: true, storageKey: `lc-${Math.random()}` });
    await morning(api);
    const line = await screen.findByText('LeetCode · 4 today · +1 re-solve due');
    expect(line.closest('a')?.getAttribute('href')).toBe('/recruiting');
  });

  it('shows nothing, and reads nothing, with no LeetCode roll linked', async () => {
    const api = createStubClient({ seed: false, storageKey: `lc-${Math.random()}` });
    const read = vi.spyOn(api, 'getCoachToday');
    await morning(api);
    expect(await screen.findByText('Plan today')).toBeTruthy();
    expect(screen.queryByText(/^LeetCode ·/)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('a failed read is one visible line, never silence', async () => {
    const api = createStubClient({ seed: true, storageKey: `lc-${Math.random()}` });
    vi.spyOn(api, 'getCoachToday').mockRejectedValue(new Error('offline'));
    await morning(api);
    const line = await screen.findByText('LeetCode · couldn’t load today’s plan');
    expect(line.closest('a')?.getAttribute('href')).toBe('/recruiting');
  });
});
