import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/utils';
import { createStubClient, STUB_COACH_PICK_KEY } from '../../data/stubClient';
import { ApiError } from '../../data/retry';
import { addDays, AI_PICK_NOTICE } from '@aperture/shared';
import type { CoachAiView, CoachToday } from '@aperture/shared';

beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => vi.restoreAllMocks());

const stub = (seed: boolean) => createStubClient({ seed, storageKey: `today-${Math.random()}` });
const card = async () => screen.findByRole('region', { name: 'Today’s practice' });
const slots = async () => within(await card()).findByRole('list', { name: 'Today’s slots' });
const titles = async () =>
  within(await slots())
    .getAllByRole('listitem')
    .map((li) => within(li).getAllByRole('link')[0]!.textContent?.replace(/\s*↗$/, ''));

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
    expect(within(list).getByText(/^Re-solve today: blank editor, no hints/)).toBeTruthy();
    const link = within(list).getByRole('link', { name: 'Two Sum' });
    expect(link.getAttribute('href')).toBe('https://leetcode.com/problems/two-sum/');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(within(c).getByText(/Short on time\? Floor:/)).toBeTruthy();
    // Add Two Numbers is due but not a slot; the next 48 hours' re-solve says when.
    const queue = within(c).getByRole('region', { name: 'Next 48 hours' });
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
    const swapped = (await api.getCoachToday()).slots.find((s) => s.swappedFrom === 'two-sum')!;
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
    const slot = (await api.getCoachToday()).slots.find((s) => s.swappedFrom === 'two-sum')!;
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
    // The pressed Skip is gone: focus moves to the row's Restore, not <body>.
    const restore = screen.getByRole('button', { name: 'Restore — Permutation in String' });
    await waitFor(() => expect(document.activeElement).toBe(restore));
    await user.click(screen.getByRole('button', { name: 'Restore — Permutation in String' }));
    await waitFor(async () =>
      expect(within(await slots()).queryByText('skipped today')).toBeNull(),
    );
    expect((await api.getCoachToday()).slots.every((s) => s.status === 'open')).toBe(true);
  });

  it('a double tap on Skip still lands focus on Restore', async () => {
    const user = userEvent.setup();
    renderApp({ api: stub(true), path: '/recruiting' });
    await slots();
    await user.dblClick(screen.getByRole('button', { name: 'Skip today — Permutation in String' }));
    const restore = await screen.findByRole('button', { name: 'Restore — Permutation in String' });
    await waitFor(() => expect(document.activeElement).toBe(restore));
  });

  it('Another keeps focus in its row, though the swapped-in problem can be another kind', async () => {
    const user = userEvent.setup();
    renderApp({ api: stub(true), path: '/recruiting' });
    await slots();
    const another = screen.getByRole('button', { name: 'Another problem — Two Sum' });
    await user.click(another);
    await waitFor(async () => expect(await titles()).not.toContain('Two Sum'));
    const row = document.activeElement?.closest('li');
    expect(row && within(row).queryByText(/^Swapped in for Two Sum/)).toBeTruthy();
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
    // The picker closed: focus is back on Change, not <body>.
    await waitFor(() =>
      expect(document.activeElement).toBe(within(c).getByRole('button', { name: 'Change' })),
    );
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

// The day's AI pick on the card (docs/areas/recruiting/coach.md → The AI pick). The stub's stand-in reads like the
// rules, so the model's own words come from a spied read.
// Home's LeetCode line shows in morning mode only (Home/index.tsx), so the tests that start from Home pin a morning.
const MORNING = Date.parse('2026-11-17T17:00:00Z'); // 09:00 in Los Angeles

describe('the AI pick on the Today card', () => {
  const view = (o: Partial<CoachAiView>): CoachAiView => ({
    status: 'ok',
    source: 'ai',
    notice: null,
    reason: null,
    note: null,
    focusChange: null,
    model: 'claude-opus-5-5',
    pickedAt: 1,
    ...o,
  });

  it('the first open starts the pick once, and the picked slots show', async () => {
    const api = stub(true);
    expect((await api.getCoachToday()).ai?.status).toBe('due');
    const start = vi.spyOn(api, 'startCoachPick');
    renderApp({ api, path: '/recruiting' });
    expect(await titles()).toHaveLength(4);
    expect(start).toHaveBeenCalledTimes(1);
    expect((await api.getCoachToday()).ai?.status).toBe('ok');
  });

  it('shows the day note, each slot’s why in place of the rule, and a focus change', async () => {
    const api = stub(true);
    const real = await api.startCoachPick();
    const t: CoachToday = {
      ...real,
      focus: { ...real.focus, source: 'ai' },
      ai: view({
        note: 'One re-solve, then rest.',
        focusChange: { from: 'two-pointers', to: 'sliding-window', why: 'Weaker first tries' },
      }),
      slots: real.slots.map((x, i) => (i === 2 ? { ...x, aiWhy: 'Failed it on Thursday' } : x)),
    };
    vi.spyOn(api, 'getCoachToday').mockResolvedValue(t);
    renderApp({ api, path: '/recruiting' });
    const c = await card();
    expect(await within(c).findByText('One re-solve, then rest.')).toBeTruthy();
    expect(within(c).getByText('Failed it on Thursday')).toBeTruthy();
    expect(within(c).queryByText(/^Re-solve today: blank editor/)).toBeNull();
    expect(
      within(c).getByText(/Opus moved the focus from Two Pointers to Sliding Window — Weaker/),
    ).toBeTruthy();
    expect(within(c).getByText(/· Opus’s pick$/)).toBeTruthy();
  });

  it('a failed pick says so, over the rules’ slots', async () => {
    globalThis.localStorage.setItem(STUB_COACH_PICK_KEY, 'fallback');
    renderApp({ api: stub(true), path: '/recruiting' });
    const c = await card();
    expect(await within(c).findByText(AI_PICK_NOTICE)).toBeTruthy();
    expect(within(c).getByRole('status')).toBeTruthy();
    expect(await titles()).toHaveLength(4);
  });

  it('a rejected answer reads the same', async () => {
    globalThis.localStorage.setItem(STUB_COACH_PICK_KEY, 'invalid');
    renderApp({ api: stub(true), path: '/recruiting' });
    expect(await within(await card()).findByText(AI_PICK_NOTICE)).toBeTruthy();
  });

  it('while it runs: “Opus is picking”, no slots, then a claim that never lands turns into the notice', async () => {
    const api = stub(true);
    const real = await api.getCoachToday();
    const pending: CoachToday = {
      ...real,
      ai: view({ status: 'pending', source: 'rules', pickedAt: null }),
    };
    const fell: CoachToday = {
      ...real,
      ai: view({
        status: 'fallback',
        source: 'rules',
        notice: AI_PICK_NOTICE,
        reason: 'timeout',
        pickedAt: null,
      }),
    };
    const reads = vi
      .spyOn(api, 'getCoachToday')
      .mockResolvedValueOnce(pending)
      .mockResolvedValue(fell);
    renderApp({ api, path: '/recruiting' });
    const c = await card();
    expect(await within(c).findByText(/Opus is picking today’s problems/)).toBeTruthy();
    expect(within(c).queryByRole('list', { name: 'Today’s slots' })).toBeNull();
    // It polls while pending; the stale claim reads back as the fallback.
    expect(await within(c).findByText(AI_PICK_NOTICE, {}, { timeout: 5_000 })).toBeTruthy();
    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(await titles()).toHaveLength(4);
  });

  it('a start that fails shows the rules with a Retry', async () => {
    const user = userEvent.setup();
    const api = stub(true);
    const start = vi.spyOn(api, 'startCoachPick').mockRejectedValueOnce(new Error('offline'));
    renderApp({ api, path: '/recruiting' });
    const c = await card();
    expect(await within(c).findByText(/Couldn’t start today’s AI pick/)).toBeTruthy();
    expect(await titles()).toHaveLength(4);
    await user.click(within(c).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(c).queryByText(/Couldn’t start/)).toBeNull());
  });

  it('a start that failed on Home shows the Retry on the card, never a stuck “picking”', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: MORNING }); // Home's LeetCode line is morning-only
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const api = stub(true);
    vi.spyOn(api, 'startCoachPick').mockRejectedValueOnce(new Error('offline'));
    renderApp({ api, path: '/' });
    const line = await screen.findByText(/^LeetCode · \d+ today/);
    await user.click(line);
    const c = await card();
    expect(await within(c).findByText(/Couldn’t start today’s AI pick/)).toBeTruthy();
    expect(within(c).queryByText(/Opus is picking/)).toBeNull();
    expect(within(c).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('a failed start keeps its Retry past the cache’s clean-up (5 minutes)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: MORNING }); // Home's LeetCode line is morning-only
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const api = stub(true);
      vi.spyOn(api, 'startCoachPick').mockRejectedValueOnce(new Error('offline'));
      renderApp({ api, path: '/' });
      await user.click(await screen.findByText(/^LeetCode · \d+ today/));
      const c = await card();
      expect(await within(c).findByText(/Couldn’t start today’s AI pick/)).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(6 * 60_000);
      });
      expect(within(c).getByRole('button', { name: 'Retry' })).toBeTruthy();
      expect(within(c).queryByText(/Opus is picking/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('with the switch off: the rules, no start, no notice', async () => {
    const api = stub(true);
    await api.updateSettings({ coachAiPick: false });
    const start = vi.spyOn(api, 'startCoachPick');
    renderApp({ api, path: '/recruiting' });
    expect(await titles()).toHaveLength(4);
    expect(start).not.toHaveBeenCalled();
    expect(within(await card()).queryByText(AI_PICK_NOTICE)).toBeNull();
  });
}, 15_000);

// Mocks (coach.md → Mocks): the week's one line, Log a mock, and a planned one in the next 48 hours.
describe('the Today card’s mocks', () => {
  const mockSection = async () =>
    within(await card()).findByRole('region', { name: 'Mock interviews' });

  it('with none this week: one muted line, never a count of weeks', async () => {
    renderApp({ api: stub(true), path: '/recruiting' });
    const m = await mockSection();
    const line = within(m).getByTestId('mock-line');
    expect(line.textContent).toBe('No mock this week yet');
    expect(line.className).toMatch(/text-ink-muted/);
    expect(within(m).queryByText(/\d+ weeks?/)).toBeNull();
  });

  it('logs a done mock with its scores; the line shows them and focus returns to Log a mock', async () => {
    const user = userEvent.setup();
    const api = stub(true);
    renderApp({ api, path: '/recruiting' });
    const m = await mockSection();
    await user.click(within(m).getByRole('button', { name: 'Log a mock' }));
    const form = within(m).getByRole('form', { name: 'Log a mock' });
    await user.click(within(form).getByRole('button', { name: 'Code 3 of 4' }));
    await user.click(within(form).getByRole('button', { name: 'Solve 2 of 4' }));
    await user.type(within(form).getByLabelText('Who ran it (optional)'), 'Study group');
    await user.click(within(form).getByRole('button', { name: 'Save mock' }));
    await waitFor(() =>
      expect(within(m).getByTestId('mock-line').textContent).toBe(
        'Mock this week: Code 3 · Solve 2',
      ),
    );
    expect(within(m).queryByRole('form')).toBeNull();
    expect(document.activeElement).toBe(within(m).getByRole('button', { name: 'Log a mock' }));
    const [saved] = await api.listMocks();
    expect(saved).toMatchObject({
      status: 'done',
      partner: 'Study group',
      scores: { code: 3, solve: 2 },
    });
  });

  it('a done mock without Code is refused inline, keeping what was typed; nothing is saved', async () => {
    const user = userEvent.setup();
    const api = stub(true);
    renderApp({ api, path: '/recruiting' });
    const m = await mockSection();
    await user.click(within(m).getByRole('button', { name: 'Log a mock' }));
    const form = within(m).getByRole('form', { name: 'Log a mock' });
    await user.click(within(form).getByRole('button', { name: 'Solve 4 of 4' }));
    await user.type(within(form).getByLabelText('Notes (optional)'), 'ran long');
    const before = (await api.listMocks()).length;
    await user.click(within(form).getByRole('button', { name: 'Save mock' }));
    expect(within(form).getByRole('alert').textContent).toMatch(/Code and Solve/);
    expect((within(form).getByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe(
      'ran long',
    );
    expect((await api.listMocks()).length).toBe(before);
  });

  it('a refused save says why and keeps the form', async () => {
    const user = userEvent.setup();
    const api = stub(true);
    vi.spyOn(api, 'upsertMock').mockRejectedValueOnce(
      new Error('day must be within the last 365 days'),
    );
    renderApp({ api, path: '/recruiting' });
    const m = await mockSection();
    await user.click(within(m).getByRole('button', { name: 'Log a mock' }));
    const form = within(m).getByRole('form', { name: 'Log a mock' });
    await user.click(within(form).getByRole('button', { name: 'Code 2 of 4' }));
    await user.click(within(form).getByRole('button', { name: 'Solve 2 of 4' }));
    await user.click(within(form).getByRole('button', { name: 'Save mock' }));
    expect((await within(form).findByRole('alert')).textContent).toMatch(/365 days/);
    expect(within(m).getByRole('form')).toBeTruthy();
  });

  it('plans one for tomorrow: it shows in the next 48 hours; Cancel removes it', async () => {
    const user = userEvent.setup();
    const api = stub(true);
    renderApp({ api, path: '/recruiting' });
    const m = await mockSection();
    await user.click(within(m).getByRole('button', { name: 'Log a mock' }));
    const form = within(m).getByRole('form', { name: 'Log a mock' });
    await user.click(within(form).getByRole('button', { name: 'Planned' }));
    expect(within(form).queryByRole('button', { name: 'Code 1 of 4' })).toBeNull();
    const day = within(form).getByLabelText('Day') as HTMLInputElement;
    const tomorrow = addDays((await api.getCoachToday()).day, 1);
    await user.clear(day);
    await user.type(day, tomorrow);
    await user.click(within(form).getByRole('button', { name: 'Plan mock' }));
    const queue = await within(await card()).findByRole('region', { name: 'Next 48 hours' });
    expect(await within(queue).findByText('Mock interview')).toBeTruthy();
    expect(within(queue).getByText('tomorrow')).toBeTruthy();
    expect(within(m).getByTestId('mock-line').textContent).toBe('Mock planned tomorrow');
    // Not yet its day: no Log it.
    expect(within(queue).queryByRole('button', { name: /^Log it — mock / })).toBeNull();
    await user.click(
      within(queue).getByRole('button', { name: 'Cancel — mock tomorrow, with a person' }),
    );
    await waitFor(() => expect(within(queue).queryByText('Mock interview')).toBeNull());
    expect((await api.listMocks()).some((x) => x.status === 'planned')).toBe(false);
  });

  it('a planned mock today logs onto the same row with Log it', async () => {
    const user = userEvent.setup();
    const api = stub(true);
    const today = (await api.getCoachToday()).day;
    const p = await api.upsertMock({ status: 'planned', day: today, kind: 'claude' });
    renderApp({ api, path: '/recruiting' });
    const queue = await within(await card()).findByRole('region', { name: 'Next 48 hours' });
    await user.click(
      await within(queue).findByRole('button', { name: 'Log it — mock today, with claude' }),
    );
    const form = within(await mockSection()).getByRole('form', { name: 'Log the planned mock' });
    await user.click(within(form).getByRole('button', { name: 'Code 4 of 4' }));
    await user.click(within(form).getByRole('button', { name: 'Solve 3 of 4' }));
    await user.click(within(form).getByRole('button', { name: 'Save mock' }));
    await waitFor(async () =>
      expect((await api.listMocks()).find((x) => x.id === p.id)).toMatchObject({
        status: 'done',
        kind: 'claude',
        scores: { code: 4, solve: 3 },
      }),
    );
    expect((await api.listMocks()).filter((x) => x.status === 'planned')).toEqual([]);
  });

  it('Log it keeps the notes the mock was planned with', async () => {
    const user = userEvent.setup();
    const api = stub(true);
    const today = (await api.getCoachToday()).day;
    const p = await api.upsertMock({ status: 'planned', day: today, notes: 'bring a timer' });
    renderApp({ api, path: '/recruiting' });
    const queue = await within(await card()).findByRole('region', { name: 'Next 48 hours' });
    await user.click(
      await within(queue).findByRole('button', { name: 'Log it — mock today, with a person' }),
    );
    const form = within(await mockSection()).getByRole('form', { name: 'Log the planned mock' });
    expect((within(form).getByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe(
      'bring a timer',
    );
    await user.click(within(form).getByRole('button', { name: 'Code 2 of 4' }));
    await user.click(within(form).getByRole('button', { name: 'Solve 2 of 4' }));
    await user.click(within(form).getByRole('button', { name: 'Save mock' }));
    await waitFor(async () =>
      expect((await api.listMocks()).find((x) => x.id === p.id)).toMatchObject({
        status: 'done',
        notes: 'bring a timer',
      }),
    );
  });

  it('a planned mock whose day passed waits under the line, with Log it and Cancel', async () => {
    const user = userEvent.setup();
    const api = stub(true);
    const today = (await api.getCoachToday()).day;
    const p = await api.upsertMock({ status: 'planned', day: addDays(today, -1) });
    renderApp({ api, path: '/recruiting' });
    const m = await mockSection();
    const list = await within(m).findByRole('list', { name: 'Planned mocks not logged yet' });
    expect(within(list).getByText('yesterday')).toBeTruthy();
    expect(
      within(list).getByRole('button', { name: 'Log it — mock yesterday, with a person' }),
    ).toBeTruthy();
    await user.click(
      within(list).getByRole('button', { name: 'Cancel — mock yesterday, with a person' }),
    );
    await waitFor(() =>
      expect(within(m).queryByRole('list', { name: 'Planned mocks not logged yet' })).toBeNull(),
    );
    expect((await api.listMocks()).some((x) => x.id === p.id)).toBe(false);
    expect(document.activeElement).toBe(within(m).getByRole('button', { name: 'Log a mock' }));
  });

  it('a failed Cancel says so and keeps the row', async () => {
    const user = userEvent.setup();
    const api = stub(true);
    const today = (await api.getCoachToday()).day;
    await api.upsertMock({ status: 'planned', day: addDays(today, 1) });
    vi.spyOn(api, 'deleteMock').mockRejectedValueOnce(new Error('No such mock'));
    renderApp({ api, path: '/recruiting' });
    const queue = await within(await card()).findByRole('region', { name: 'Next 48 hours' });
    await user.click(
      await within(queue).findByRole('button', { name: 'Cancel — mock tomorrow, with a person' }),
    );
    expect((await within(await mockSection()).findByRole('alert')).textContent).toBe(
      'No such mock. Nothing changed.',
    );
    expect(within(queue).getByText('Mock interview')).toBeTruthy();
  });

  it('a save that may have landed (a 5xx) says so and keeps the form', async () => {
    const user = userEvent.setup();
    const api = stub(true);
    vi.spyOn(api, 'upsertMock').mockRejectedValueOnce(new ApiError('Bad gateway', 502));
    renderApp({ api, path: '/recruiting' });
    const m = await mockSection();
    await user.click(within(m).getByRole('button', { name: 'Log a mock' }));
    const form = within(m).getByRole('form', { name: 'Log a mock' });
    await user.click(within(form).getByRole('button', { name: 'Code 2 of 4' }));
    await user.click(within(form).getByRole('button', { name: 'Solve 2 of 4' }));
    await user.click(within(form).getByRole('button', { name: 'Save mock' }));
    expect((await within(form).findByRole('alert')).textContent).toMatch(/may have saved/);
  });

  it('the form takes focus on open; an optional score sets, then clears on a second tap', async () => {
    const user = userEvent.setup();
    const api = stub(true);
    renderApp({ api, path: '/recruiting' });
    const m = await mockSection();
    await user.click(within(m).getByRole('button', { name: 'Log a mock' }));
    const form = within(m).getByRole('form', { name: 'Log a mock' });
    expect(form.contains(document.activeElement)).toBe(true);
    const comm = within(form).getByRole('button', { name: 'Communication 3 of 4' });
    await user.click(comm);
    expect(comm.getAttribute('aria-pressed')).toBe('true');
    await user.click(comm);
    expect(comm.getAttribute('aria-pressed')).toBe('false');
    await user.click(comm);
    await user.click(within(form).getByRole('button', { name: 'Code 1 of 4' }));
    await user.click(within(form).getByRole('button', { name: 'Solve 1 of 4' }));
    await user.click(within(form).getByRole('button', { name: 'Save mock' }));
    await waitFor(async () =>
      expect((await api.listMocks())[0]?.scores).toEqual({ code: 1, solve: 1, communicate: 3 }),
    );
  });

  it('Cancel on a row while a form is open keeps focus in the mock section; Log it focuses its form', async () => {
    const user = userEvent.setup();
    const api = stub(true);
    const today = (await api.getCoachToday()).day;
    await api.upsertMock({ status: 'planned', day: addDays(today, 1) });
    await api.upsertMock({ status: 'planned', day: today, partner: 'Study group' });
    renderApp({ api, path: '/recruiting' });
    const m = await mockSection();
    const queue = await within(await card()).findByRole('region', { name: 'Next 48 hours' });
    await user.click(
      await within(queue).findByRole('button', { name: 'Log it — mock today, with Study group' }),
    );
    const form = within(m).getByRole('form', { name: 'Log the planned mock' });
    expect(document.activeElement).toBe(form); // the form, not its date field
    await user.click(
      within(queue).getByRole('button', { name: 'Cancel — mock tomorrow, with a person' }),
    );
    await waitFor(() => expect(within(queue).queryByText('tomorrow')).toBeNull());
    expect(document.activeElement).toBe(m);
  });

  it('an unlogged mock from last year says its year, in the row and its buttons', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.parse('2027-01-05T17:00:00Z') });
    try {
      const api = stub(true);
      await api.upsertMock({ status: 'planned', day: '2026-12-20', kind: 'claude' });
      renderApp({ api, path: '/recruiting' });
      const list = await within(await mockSection()).findByRole('list', {
        name: 'Planned mocks not logged yet',
      });
      expect(within(list).getByText(/, 2026$/)).toBeTruthy();
      expect(
        within(list).getByRole('button', { name: /^Cancel — mock .*, 2026, with claude$/ }),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a cancel that lands after focus moved into the open form leaves focus where it went', async () => {
    const user = userEvent.setup();
    const api = stub(true);
    const today = (await api.getCoachToday()).day;
    await api.upsertMock({ status: 'planned', day: addDays(today, 1) });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = api.deleteMock.bind(api);
    vi.spyOn(api, 'deleteMock').mockImplementationOnce(async (id) => {
      await gate;
      return real(id);
    });
    renderApp({ api, path: '/recruiting' });
    const m = await mockSection();
    await user.click(within(m).getByRole('button', { name: 'Log a mock' }));
    const queue = await within(await card()).findByRole('region', { name: 'Next 48 hours' });
    await user.click(
      await within(queue).findByRole('button', { name: 'Cancel — mock tomorrow, with a person' }),
    );
    const notes = within(m).getByLabelText('Notes (optional)');
    await user.click(notes);
    release();
    await waitFor(() => expect(within(queue).queryByText('tomorrow')).toBeNull());
    expect(document.activeElement).toBe(notes);
    await user.click(within(m).getByRole('button', { name: 'Cancel' })); // the form's own Cancel
    expect(document.activeElement).toBe(within(m).getByRole('button', { name: 'Log a mock' }));
  });

  it('a pointer Cancel that never focused its button (Safari) still lands focus on Log a mock', async () => {
    const api = stub(true);
    const today = (await api.getCoachToday()).day;
    await api.upsertMock({ status: 'planned', day: addDays(today, 1) });
    renderApp({ api, path: '/recruiting' });
    const m = await mockSection();
    const queue = await within(await card()).findByRole('region', { name: 'Next 48 hours' });
    const cancel = await within(queue).findByRole('button', {
      name: 'Cancel — mock tomorrow, with a person',
    });
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.click(cancel); // no focus moves, as Safari's click
    await waitFor(() =>
      expect(document.activeElement).toBe(within(m).getByRole('button', { name: 'Log a mock' })),
    );
  });

  it('Log it opened on a mock whose cancel then lands closes with it', async () => {
    const user = userEvent.setup();
    const api = stub(true);
    const today = (await api.getCoachToday()).day;
    await api.upsertMock({ status: 'planned', day: today });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = api.deleteMock.bind(api);
    vi.spyOn(api, 'deleteMock').mockImplementationOnce(async (id) => {
      await gate;
      return real(id);
    });
    renderApp({ api, path: '/recruiting' });
    const m = await mockSection();
    const queue = await within(await card()).findByRole('region', { name: 'Next 48 hours' });
    await user.click(
      await within(queue).findByRole('button', { name: 'Cancel — mock today, with a person' }),
    );
    await user.click(
      within(queue).getByRole('button', { name: 'Log it — mock today, with a person' }),
    );
    expect(within(m).getByRole('form', { name: 'Log the planned mock' })).toBeTruthy();
    release();
    await waitFor(() =>
      expect(within(m).queryByRole('form', { name: 'Log the planned mock' })).toBeNull(),
    );
    expect(document.activeElement).toBe(within(m).getByRole('button', { name: 'Log a mock' }));
  });
});
