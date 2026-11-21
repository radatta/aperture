import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { addDays, NEETCODE_150, todayKey } from '@aperture/shared';
import { renderApp } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';

// Synthetic fixtures only: catalog slugs, made-up days and outcomes.
beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => vi.restoreAllMocks());

const freshApi = () => createStubClient({ seed: false, storageKey: `progress-${Math.random()}` });
const ago = (n: number) => addDays(todayKey(4, Date.now()), -n);
const card = (name: RegExp) => screen.getByRole('button', { name });
const AH = NEETCODE_150.filter((c) => c.pattern === 'arrays-hashing');
const SW = NEETCODE_150.filter((c) => c.pattern === 'sliding-window');

describe('Progress tab', () => {
  it('an empty account: the whole list untried, five stages, every pattern a card', async () => {
    renderApp({ api: freshApi(), path: '/recruiting/progress' });
    expect(await screen.findByText('150 not tried')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Progress' }).getAttribute('aria-current')).toBe(
      'page',
    );
    for (const s of [
      'Foundations',
      'Linked structures',
      'Search',
      'Dynamic programming',
      'Toolkit',
    ])
      expect(screen.getByRole('region', { name: s })).toBeTruthy();
    expect(card(/^Arrays & Hashing, 0 of 9 done, 9 not tried/)).toBeTruthy();
    expect(screen.getAllByRole('button', { expanded: false })).toHaveLength(18);
    expect(screen.queryByText(/Premium/)).toBeNull(); // the setting is on by default
  });

  it('counts done, tried and history-only solves; a card opens its problems and closes back to itself', async () => {
    const api = freshApi();
    await api.logCoachAttempts([
      { slug: AH[0]!.slug, day: ago(5), outcome: 'clean' },
      { slug: AH[1]!.slug, day: ago(4), outcome: 'failed', cause: 'boundary' },
      { slug: AH[2]!.slug, day: '2024-03-01', outcome: 'solved', historical: true },
      { slug: SW[0]!.slug, day: ago(2), outcome: 'solved', minutes: 41 },
    ]);
    const user = userEvent.setup();
    renderApp({ api, path: '/recruiting/progress' });
    const ah = await screen.findByRole('button', {
      name: /^Arrays & Hashing, 2 of 9 done, 1 tried, 6 not tried/,
    });
    expect(screen.getByText('146 not tried')).toBeTruthy();
    await user.click(ah);
    expect(ah.getAttribute('aria-expanded')).toBe('true');
    const panel = screen.getByRole('region', { name: 'Arrays & Hashing problems' });
    const rows = within(panel).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(AH.length);
    expect(within(rows[2]!).getAllByText(/Solved before/).length).toBeGreaterThan(0);
    expect(within(rows[2]!).getAllByText(/Not in the re-solve queue/).length).toBeGreaterThan(0);
    expect(within(rows[1]!).getAllByText(/Not yet/).length).toBeGreaterThan(0);
    expect(
      within(panel)
        .getAllByRole('link', { name: /on LeetCode/ })[0]!
        .getAttribute('href'),
    ).toBe(`https://leetcode.com/problems/${AH[0]!.slug}/`);
    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Arrays & Hashing problems' })).toBeNull();
    expect(document.activeElement).toBe(ah);
  });

  it('the open pattern and Left only survive a reload (they live in the URL)', async () => {
    const api = freshApi();
    await api.logCoachAttempts([{ slug: SW[0]!.slug, day: ago(3), outcome: 'clean' }]);
    const user = userEvent.setup();
    renderApp({ api, path: '/recruiting/progress?open=sliding-window&left=1' });
    const panel = await screen.findByRole('region', { name: 'Sliding Window problems' });
    expect(within(panel).getAllByRole('row')).toHaveLength(SW.length); // header + the 5 left
    expect(screen.getByRole('button', { name: 'Left only' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    await user.click(screen.getByRole('button', { name: /^Sliding Window,/ }));
    const left = await screen.findByRole('region', { name: 'What’s left' });
    expect(within(left).getByText('149 not tried across the list')).toBeTruthy();
  });

  it('Premium off: untried Premium problems are counted and marked', async () => {
    const api = freshApi();
    await api.updateSettings({ leetcodePremium: false });
    renderApp({ api, path: '/recruiting/progress?open=arrays-hashing' });
    expect(await screen.findByText(/150 not tried \(7 Premium\)/)).toBeTruthy();
    expect(screen.getByText('Premium', { selector: 'span' })).toBeTruthy();
    expect(screen.getAllByText(/Premium, not tried/).length).toBeGreaterThan(0);
  });

  it('a failed records read shows the error with Retry, never an empty map', async () => {
    const api = freshApi();
    const read = vi.spyOn(api, 'listProblemRecords').mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    renderApp({ api, path: '/recruiting/progress' });
    expect(await screen.findByText('Couldn’t load your progress.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Foundations' })).toBeNull();
    read.mockRestore();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('150 not tried')).toBeTruthy();
  });

  it('a failed focus read: the map still draws, with a line saying no pattern is marked', async () => {
    const api = freshApi();
    vi.spyOn(api, 'getCoachToday').mockRejectedValue(new Error('offline'));
    renderApp({ api, path: '/recruiting/progress' });
    expect(
      await screen.findByText('Couldn’t load the focus, so no pattern is marked.'),
    ).toBeTruthy();
    expect(card(/^Arrays & Hashing,/)).toBeTruthy();
  });

  it('Solves: newest first, filters in the URL, no match offers Clear filters; empty says so', async () => {
    const empty = renderApp({ api: freshApi(), path: '/recruiting/progress?view=solves' });
    expect(await screen.findByText('No solves yet.')).toBeTruthy();
    empty.unmount();
    const api = freshApi();
    await api.logCoachAttempts([
      { slug: AH[0]!.slug, day: ago(6), outcome: 'clean' },
      { slug: SW[0]!.slug, day: ago(1), outcome: 'failed', cause: 'off-by-one' },
    ]);
    const user = userEvent.setup();
    const { router } = renderApp({ api, path: '/recruiting/progress?view=solves' });
    const table = await screen.findByRole('table', { name: 'Your solves' });
    const titles = within(table)
      .getAllByRole('link')
      .map((a) => a.textContent);
    expect(titles).toEqual([SW[0]!.title, AH[0]!.title]);
    expect(within(table).getAllByText(/Off by one/).length).toBeGreaterThan(0);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'clean');
    await waitFor(() => expect(router.state.location.search).toContain('status=clean'));
    expect(
      within(screen.getByRole('table', { name: 'Your solves' })).getAllByRole('link'),
    ).toHaveLength(1);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Difficulty' }), 'Hard');
    expect(await screen.findByText('Nothing matches these filters.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByRole('table', { name: 'Your solves' })).toBeTruthy();
    expect(router.state.location.search).toBe('?view=solves');
  });

  it('Trends: sparse lines with no data; charts with some', async () => {
    const empty = renderApp({ api: freshApi(), path: '/recruiting/progress?view=trends' });
    expect(await screen.findByText(/Two weeks of practice draws this/)).toBeTruthy();
    expect(screen.getByText(/Timed tries draw this/)).toBeTruthy();
    expect(screen.getByText(/No re-solves yet/)).toBeTruthy();
    empty.unmount();
    const api = freshApi();
    await api.logCoachAttempts([
      { slug: AH[0]!.slug, day: ago(14), outcome: 'clean', minutes: 12 },
      { slug: AH[1]!.slug, day: ago(1), outcome: 'solved', minutes: 44 },
      { slug: AH[0]!.slug, day: ago(1), outcome: 'clean', minutes: 9 },
    ]);
    renderApp({ api, path: '/recruiting/progress?view=trends' });
    expect(await screen.findByRole('img', { name: /^Problems a week:/ })).toBeTruthy();
    expect(screen.getByText('2 of 3')).toBeTruthy();
    expect(screen.getByRole('img', { name: /^Re-solves clean a week:.* 1 of 1/ })).toBeTruthy();
    // Each try against its own cap (two Easy problems: 20 new, 10 re-solve): 12 of 20, 9 of 10, 44 of 20.
    expect(screen.getByRole('heading', { name: 'Time against the cap' })).toBeTruthy();
    expect(screen.getByText(/inside their cap · median 12 min/)).toBeTruthy();
    expect(
      screen.getByRole('img', {
        name: 'Tries by time against their own cap: ≤ ⅓ 0, ⅓–⅔ 1, ⅔–1× 1, 1–1.5× 0, 1.5–2× 0, 2×+ 1',
      }),
    ).toBeTruthy();
  });
});
