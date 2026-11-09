import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';

beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => vi.restoreAllMocks());

// vi.spyOn, not `{ ...api }` — createStubClient returns a class instance, so a spread copies its fields
// and drops every method, and renderApp mounts the whole shell (which calls several of them).
function apiWithFailingSittings(behavior: 'reject' | 'hang') {
  const api = createStubClient({ seed: false, storageKey: `rec-${Math.random()}` });
  vi.spyOn(api, 'listSittings').mockImplementation(() =>
    behavior === 'reject' ? Promise.reject(new Error('boom')) : new Promise(() => {}),
  );
  return api;
}

describe('Recruiting page', () => {
  it('lists the seeded sittings by day with their first-submit outcome', async () => {
    renderApp({ path: '/recruiting' });
    expect(screen.getByRole('heading', { name: 'Recruiting' })).toBeTruthy();
    // The seed folds three ended sittings with the shared folds: runtime error → accepted, a first-submit
    // accept, and a run before a wrong submit → accepted.
    expect(await screen.findByText('Two Sum')).toBeTruthy();
    expect(screen.getByText('first submit accepted')).toBeTruthy();
    expect(screen.getAllByText('accepted on submit 2')).toHaveLength(2);
    expect(screen.getByText(/1 run/)).toBeTruthy();
    // The summary renders only once there are rows; pin the counts so hiding it can't go unnoticed.
    expect(screen.getByText(/3 sittings · 3 problems · 1 first-submit accepted/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Open sitting' })).toBeNull(); // none open in the seed
  });

  it('pins an open sitting above the days with its running clock', async () => {
    const api = createStubClient({ seed: false, storageKey: `rec-${Math.random()}` });
    const roll = await api.upsertRoll({ name: 'LeetCode', categoryId: null, estimateMin: 45 });
    await api.updateSettings({ leetcodeRollId: roll.id });
    await api.lcSittingStart({
      clientSittingId: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      problemSlug: 'rotting-oranges',
      problemTitle: 'Rotting Oranges',
      difficulty: 'Medium',
      lang: 'python3',
      startedAt: Date.now(),
      tzOffsetMinutes: new Date().getTimezoneOffset(),
    });
    renderApp({ api, path: '/recruiting' });
    const open = await screen.findByRole('region', { name: 'Open sitting' });
    expect(within(open).getByText('Rotting Oranges')).toBeTruthy();
    expect(within(open).getByText(/In progress/)).toBeTruthy();
    expect(within(open).getByText('no submit yet')).toBeTruthy();
  });

  it('navigates to Recruiting from the nav', async () => {
    renderApp({ path: '/' });
    const link = await screen.findByRole('link', { name: 'Recruiting' });
    expect(link).toBeTruthy();
  });

  // The tabs are real routes, not in-page state: Stories is a link, and its URL loads directly.
  it('exposes Stories as a linked tab that switches the view', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/recruiting' });
    await user.click(await screen.findByRole('link', { name: 'Stories' }));
    // Seeded stub has a story in the bank; the attempts list must be gone.
    expect(await screen.findByText('Turned around the failing migration')).toBeTruthy();
    expect(screen.queryByText('first submit accepted')).toBeNull();
  });

  it('deep-links directly to /recruiting/stories', async () => {
    renderApp({ path: '/recruiting/stories' });
    expect(await screen.findByText('Turned around the failing migration')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Recruiting' })).toBeTruthy();
  });

  // The absence assertions are the point: a failed or in-flight query must never render the empty state
  // ("No sittings yet … press Start") — telling you to fix a problem you don't have. Both pin EmptyState's
  // copy, so changing that component's wording turns these red.
  it('shows an error state, not the empty state, when the query fails', async () => {
    renderApp({ api: apiWithFailingSittings('reject'), path: '/recruiting' });
    expect(await screen.findByText(/Couldn't load this/)).toBeTruthy();
    expect(screen.queryByText(/No sittings yet/)).toBeNull();
    expect(screen.queryByText(/0 sittings/)).toBeNull(); // the summary must not assert a total either
  });

  it('shows a loading state, not the empty state, while the query is in flight', async () => {
    renderApp({ api: apiWithFailingSittings('hang'), path: '/recruiting' });
    // Scoped: "Loading…" is EmptyState's copy and any other pending list in the shell would render it too.
    expect(await within(screen.getByRole('main')).findByText('Loading…')).toBeTruthy();
    expect(screen.queryByText(/No sittings yet/)).toBeNull();
    expect(screen.queryByText(/0 sittings/)).toBeNull();
  });
});
