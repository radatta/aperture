import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderApp } from '../../test/utils';

beforeEach(() => globalThis.localStorage?.clear());

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
  });

  it('navigates to Recruiting from the nav', async () => {
    renderApp({ path: '/' });
    const link = await screen.findByRole('link', { name: 'Recruiting' });
    expect(link).toBeTruthy();
  });
});
