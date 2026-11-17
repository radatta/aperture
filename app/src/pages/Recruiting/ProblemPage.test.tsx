import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { addDays, todayKey } from '@aperture/shared';
import { renderApp } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';

// Synthetic fixtures only: catalog slugs, made-up days, outcomes and notes.
beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => vi.restoreAllMocks());

const freshApi = () => createStubClient({ seed: false, storageKey: `problem-${Math.random()}` });
const ago = (n: number) => addDays(todayKey(4, Date.now()), -n);

describe('Problem page', () => {
  it('every try newest first: minutes over the cap, cause, the note, a history-only one', async () => {
    const api = freshApi();
    await api.logCoachAttempts([
      {
        slug: 'two-sum',
        day: '2024-05-02',
        outcome: 'solved',
        historical: true,
        note: 'on paper',
      },
      {
        slug: 'two-sum',
        day: ago(9),
        outcome: 'failed',
        help: 'solution',
        cause: 'no-trace',
        minutes: 41,
      },
      {
        slug: 'two-sum',
        day: ago(2),
        outcome: 'solved',
        help: 'hint',
        cause: 'boundary',
        minutes: 34,
      },
    ]);
    renderApp({ api, path: '/recruiting/progress/two-sum' });
    expect(await screen.findByRole('heading', { name: 'Two Sum' })).toBeTruthy();
    expect(screen.getByText(/Arrays & Hashing · Easy · NeetCode 150/)).toBeTruthy();
    const tries = within(
      screen.getByRole('region', { name: '3 tries, newest first' }),
    ).getAllByRole('listitem');
    expect(tries).toHaveLength(3);
    expect(within(tries[0]!).getByText('34 min, over the 30 min cap')).toBeTruthy();
    expect(within(tries[0]!).getByText(/a hint · Boundary/)).toBeTruthy();
    expect(within(tries[1]!).getByText('Peeked')).toBeTruthy();
    expect(within(tries[2]!).getByText('Before the coach')).toBeTruthy();
    expect(within(tries[2]!).getByText('Solved')).toBeTruthy();
    expect(within(tries[2]!).getByText('Note: on paper')).toBeTruthy();
    expect(within(tries[2]!).getByText(/history only/)).toBeTruthy();
  });

  it('a long history lists every try', async () => {
    const api = freshApi();
    await api.logCoachAttempts(
      Array.from({ length: 40 }, (_, i) => ({
        slug: 'two-sum',
        day: ago(55 - i),
        outcome: 'clean' as const,
      })),
    );
    renderApp({ api, path: '/recruiting/progress/two-sum' });
    const list = await screen.findByRole('region', { name: '40 tries, newest first' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(40);
  });

  it('an untried list problem reads Not tried yet; an unknown slug says so', async () => {
    const one = renderApp({ api: freshApi(), path: '/recruiting/progress/valid-anagram' });
    expect(await screen.findByText('Not tried yet.')).toBeTruthy();
    one.unmount();
    renderApp({ api: freshApi(), path: '/recruiting/progress/not-a-real-problem' });
    expect(await screen.findByText('No problem by that name.')).toBeTruthy();
  });

  it('back from a Solves row keeps the filters', async () => {
    const api = freshApi();
    await api.logCoachAttempts([{ slug: 'two-sum', day: ago(1), outcome: 'clean' }]);
    const user = userEvent.setup();
    const { router } = renderApp({ api, path: '/recruiting/progress?view=solves&status=clean' });
    await user.click(await screen.findByRole('link', { name: 'Two Sum' }));
    await user.click(await screen.findByRole('link', { name: '← Progress' }));
    expect(router.state.location.search).toBe('?view=solves&status=clean');
  });
});
