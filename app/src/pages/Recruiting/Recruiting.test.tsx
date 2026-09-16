import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';

beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => vi.restoreAllMocks());

// vi.spyOn, not `{ ...api }` — createStubClient returns a class instance, so a spread copies its fields
// and drops every method, and renderApp mounts the whole shell (which calls several of them).
function apiWithFailingAttempts(behavior: 'reject' | 'hang') {
  const api = createStubClient({ seed: false, storageKey: `rec-${Math.random()}` });
  vi.spyOn(api, 'listLeetcodeAttempts').mockImplementation(() =>
    behavior === 'reject' ? Promise.reject(new Error('boom')) : new Promise(() => {}),
  );
  return api;
}

describe('Recruiting page', () => {
  it('lists seeded LeetCode attempts with a derived per-problem attempt-count', async () => {
    renderApp({ path: '/recruiting' });
    expect(screen.getByRole('heading', { name: 'Recruiting' })).toBeTruthy();

    // Seed has Two Sum twice (runtime_error → accepted), so it renders two rows and the accepted one
    // is "attempt 2 of 2" — proving the derived ordinal.
    const twoSum = await screen.findAllByText('Two Sum');
    expect(twoSum.length).toBe(2);
    // two-sum and longest-substring each have a 2nd (accepted) attempt → two "attempt 2 of 2" rows.
    expect((await screen.findAllByText(/attempt 2 of 2/)).length).toBe(2);
    expect(screen.getAllByText('Accepted').length).toBe(3); // two-sum, add-two-numbers, longest-substring
    expect(screen.getAllByText('Runtime Error').length).toBe(1);
    // The summary renders only once there are rows; pin the counts so hiding it can't go unnoticed.
    expect(screen.getByText(/3 solved · 3 problems · 5 attempts/)).toBeTruthy();
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
    expect(screen.queryByText(/attempt 2 of 2/)).toBeNull();
  });

  it('deep-links directly to /recruiting/stories', async () => {
    renderApp({ path: '/recruiting/stories' });
    expect(await screen.findByText('Turned around the failing migration')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Recruiting' })).toBeTruthy();
  });

  // The absence assertions are the point: a failed or in-flight query used to render "No LeetCode
  // attempts captured yet. Install the extension" — telling you to fix a problem you don't have, on the
  // one page whose worst documented failure mode is already silent emptiness. Both pin EmptyState's
  // copy, so changing that component's wording turns these red.
  it('shows an error state, not the empty state, when the query fails', async () => {
    renderApp({ api: apiWithFailingAttempts('reject'), path: '/recruiting' });
    expect(await screen.findByText(/Couldn't load this/)).toBeTruthy();
    expect(screen.queryByText(/No LeetCode attempts captured yet/)).toBeNull();
    expect(screen.queryByText(/0 solved/)).toBeNull(); // the summary must not assert a total either
  });

  it('shows a loading state, not the empty state, while the query is in flight', async () => {
    renderApp({ api: apiWithFailingAttempts('hang'), path: '/recruiting' });
    // Scoped: "Loading…" is EmptyState's copy and any other pending list in the shell would render it too.
    expect(await within(screen.getByRole('main')).findByText('Loading…')).toBeTruthy();
    expect(screen.queryByText(/No LeetCode attempts captured yet/)).toBeNull();
    expect(screen.queryByText(/0 solved/)).toBeNull();
  });
});
