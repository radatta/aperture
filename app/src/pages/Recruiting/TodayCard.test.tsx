import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';

beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => vi.restoreAllMocks());

const stub = (seed: boolean) => createStubClient({ seed, storageKey: `today-${Math.random()}` });
const card = async () => screen.findByRole('region', { name: 'Today’s practice' });
const slots = async () => within(await card()).findByRole('list', { name: 'Today’s slots' });
const titles = async () =>
  within(await slots())
    .getAllByRole('listitem')
    .map((li) => within(li).getAllByRole('link')[0]!.textContent);

// The seeded stub's day: a Sliding Window focus, two new problems, Two Sum due as a re-solve, a stretch.
describe('the Today card', () => {
  it('shows the focus, four slots with reasons and LeetCode links, the floor, what’s due next and momentum', async () => {
    renderApp({ api: stub(true), path: '/recruiting' });
    const c = await card();
    expect(await within(c).findByText('Sliding Window · day 1 of 3')).toBeTruthy();
    expect(await titles()).toEqual([
      'Best Time to Buy and Sell Stock',
      'Permutation in String',
      'Two Sum',
      'Longest Repeating Character Replacement',
    ]);
    const list = await slots();
    expect(within(list).getAllByText(/^New · /)).toHaveLength(2);
    expect(within(list).getByText('Re-solve · Easy · 30 min')).toBeTruthy();
    expect(within(list).getByText(/^Re-solve due since/)).toBeTruthy();
    const link = within(list).getByRole('link', { name: 'Two Sum' });
    expect(link.getAttribute('href')).toBe('https://leetcode.com/problems/two-sum/');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(within(c).getByText(/Short on time\? Floor:/)).toBeTruthy();
    // Add Two Numbers is due but not a slot; the next 48 hours' re-solve says when.
    const queue = within(c).getByRole('region', { name: 'Re-solves coming up' });
    expect(within(queue).getByText('Add Two Numbers')).toBeTruthy();
    expect(within(queue).getByText('due')).toBeTruthy();
    expect(within(c).getByText('3 of 7 days practised this week')).toBeTruthy();
    // The sittings list still follows below.
    expect(screen.getByText(/3 sittings/)).toBeTruthy();
  });

  it('Another swaps a slot to an easier problem, and Restore brings the original back', async () => {
    const user = userEvent.setup();
    const api = stub(true);
    renderApp({ api, path: '/recruiting' });
    await slots();
    // Nothing easier is left unseen in Sliding Window, so its slots offer no Another.
    expect(
      screen.queryByRole('button', { name: 'Another problem — Permutation in String' }),
    ).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Another problem — Two Sum' }));
    await waitFor(async () => expect(await titles()).not.toContain('Two Sum'));
    const swapped = (await api.getCoachToday()).slots.find((s) => s.kind === 're-solve')!;
    expect(swapped.swappedFrom).toBe('two-sum');
    expect(within(await slots()).getByText(/^Swapped in for/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: `Restore — ${swapped.title}` }));
    await waitFor(async () => expect(await titles()).toContain('Two Sum'));
    expect((await api.getCoachToday()).slots.every((s) => !s.swappedFrom)).toBe(true);
  });

  // The plan's rule: one change per tap, each replacing the slot's last, so the engine's pick is never lost.
  it('a double tap on Another still remembers the original, and one Restore brings it back', async () => {
    const user = userEvent.setup();
    const api = stub(true);
    renderApp({ api, path: '/recruiting' });
    await slots();
    await user.dblClick(screen.getByRole('button', { name: 'Another problem — Two Sum' }));
    await waitFor(async () => expect(await titles()).not.toContain('Two Sum'));
    const slot = (await api.getCoachToday()).slots.find((s) => s.kind === 're-solve')!;
    expect(slot.swappedFrom).toBe('two-sum');
    await user.click(await screen.findByRole('button', { name: `Restore — ${slot.title}` }));
    await waitFor(async () => expect(await titles()).toContain('Two Sum'));
  });

  it('Skip today marks the slot skipped; Restore undoes it', async () => {
    const user = userEvent.setup();
    const api = stub(true);
    renderApp({ api, path: '/recruiting' });
    await slots();
    await user.click(screen.getByRole('button', { name: 'Skip today — Permutation in String' }));
    expect(await within(await slots()).findByText('skipped today')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Restore — Permutation in String' }));
    await waitFor(async () =>
      expect(within(await slots()).queryByText('skipped today')).toBeNull(),
    );
    expect((await api.getCoachToday()).slots.every((s) => s.status === 'open')).toBe(true);
  });

  it('a refused change says why, inline', async () => {
    const user = userEvent.setup();
    const api = stub(true);
    vi.spyOn(api, 'setCoachSlot').mockRejectedValue(
      new Error('No unseen problem left in Arrays & Hashing at or under Easy; pass toSlug'),
    );
    renderApp({ api, path: '/recruiting' });
    await slots();
    await user.click(screen.getByRole('button', { name: 'Another problem — Two Sum' }));
    expect((await within(await card()).findByRole('alert')).textContent).toMatch(
      /No unseen problem left/,
    );
  });

  it('Floor day names the one problem that counts today; Full day turns it off', async () => {
    const user = userEvent.setup();
    const api = stub(true);
    renderApp({ api, path: '/recruiting' });
    await slots();
    await user.click(screen.getByRole('button', { name: 'Floor day' }));
    expect(await within(await card()).findByText(/Floor day: just/)).toBeTruthy();
    expect((await api.getCoachToday()).floor?.on).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Full day' }));
    expect(await within(await card()).findByText(/Short on time\?/)).toBeTruthy();
  });

  it('Change sets the focus pattern; the coach’s pick clears it', async () => {
    const user = userEvent.setup();
    const api = stub(true);
    renderApp({ api, path: '/recruiting' });
    const c = await card();
    await within(c).findByText('Sliding Window · day 1 of 3');
    await user.click(within(c).getByRole('button', { name: 'Change' }));
    await user.selectOptions(within(c).getByLabelText('Focus pattern'), 'two-pointers');
    expect(await within(c).findByText('Two Pointers · day 1 of 3 · your pick')).toBeTruthy();
    expect((await api.getCoachToday()).focus.source).toBe('override');
    await user.click(within(c).getByRole('button', { name: 'Change' }));
    await user.selectOptions(within(c).getByLabelText('Focus pattern'), '');
    expect(await within(c).findByText('Sliding Window · day 1 of 3')).toBeTruthy();
  });

  it('an empty account gets new problems only — no carry-over, no re-solves', async () => {
    renderApp({ api: stub(false), path: '/recruiting' });
    const list = await slots();
    expect(within(list).queryByText(/^Re-solve/)).toBeNull();
    expect(within(list).queryByText(/^Carry-over/)).toBeNull();
    expect(within(list).getAllByText(/^New · /).length).toBeGreaterThan(0);
    expect(within(await card()).getByText('0 of 7 days practised this week')).toBeTruthy();
    expect(screen.getByText(/No sittings yet/)).toBeTruthy(); // the list's own empty state still shows
  });

  it('a slot with its sitting open links to the sitting', async () => {
    const api = stub(false);
    const roll = await api.upsertRoll({ name: 'LeetCode', categoryId: null, estimateMin: 45 });
    await api.updateSettings({ leetcodeRollId: roll.id });
    const first = (await api.getCoachToday()).slots[0]!;
    const { sitting } = await api.lcSittingStart({
      clientSittingId: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      problemSlug: first.slug,
      problemTitle: first.title,
      difficulty: first.difficulty ?? 'Easy',
      lang: 'python3',
      startedAt: Date.now(),
      tzOffsetMinutes: new Date().getTimezoneOffset(),
    });
    renderApp({ api, path: '/recruiting' });
    const list = await slots();
    expect(within(list).getByText('in progress')).toBeTruthy();
    expect(within(list).getByRole('link', { name: 'Open sitting →' }).getAttribute('href')).toBe(
      `/recruiting/sittings/${sitting.id}`,
    );
  });

  it('a failed read says so on the card, with a Retry that recovers', async () => {
    const user = userEvent.setup();
    const api = stub(true);
    const real = api.getCoachToday.bind(api);
    const spy = vi.spyOn(api, 'getCoachToday').mockRejectedValueOnce(new Error('offline'));
    renderApp({ api, path: '/recruiting' });
    const c = await card();
    expect((await within(c).findByRole('alert')).textContent).toContain(
      'Couldn’t load today’s plan.',
    );
    spy.mockImplementation(real);
    await user.click(within(c).getByRole('button', { name: 'Retry' }));
    expect(await within(c).findByText('Sliding Window · day 1 of 3')).toBeTruthy();
  });
});
