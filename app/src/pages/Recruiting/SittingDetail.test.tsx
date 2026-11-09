import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiClient } from '@aperture/shared';
import { renderApp } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';

beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => vi.restoreAllMocks());

const seeded = () => createStubClient({ seed: true, storageKey: `sit-${Math.random()}` });
const idOf = async (api: ApiClient, slug: string) =>
  (await api.listSittings()).find((s) => s.problemSlug === slug)!.id;
const open = async (api: ApiClient, slug = 'two-sum') =>
  renderApp({ api, path: `/recruiting/sittings/${await idOf(api, slug)}` });

// A sitting open right now: a LeetCode roll linked, then the stub's real Start (it attaches and starts a rep).
async function withOpenSitting() {
  const api = createStubClient({ seed: false, storageKey: `sit-${Math.random()}` });
  const roll = await api.upsertRoll({ name: 'LeetCode', categoryId: null, estimateMin: 45 });
  await api.updateSettings({ leetcodeRollId: roll.id });
  const { sitting } = await api.lcSittingStart({
    clientSittingId: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
    problemSlug: 'rotting-oranges',
    problemTitle: 'Rotting Oranges',
    difficulty: 'Medium',
    lang: 'python3',
    startedAt: Date.now(),
    tzOffsetMinutes: new Date().getTimezoneOffset(),
  });
  return { api, sitting };
}

describe('a sitting’s page', () => {
  it('shows the problem, the numbers, every submit with its failing case, and the code-changed markers', async () => {
    const user = userEvent.setup();
    await open(seeded());
    expect(await screen.findByRole('heading', { name: 'Two Sum' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Two Sum' }).getAttribute('href')).toBe(
      'https://leetcode.com/problems/two-sum/',
    );
    expect(screen.getByText('Asked lately at Google, Amazon, Meta')).toBeTruthy();
    expect(screen.getByText('accepted on submit 2')).toBeTruthy();
    expect(screen.getByText(/Claude watched live · 14 pulls/)).toBeTruthy();
    const timeline = screen.getByRole('list', { name: 'Runs and submits' });
    expect(within(timeline).getByText('Runtime Error · 0/63')).toBeTruthy();
    expect(within(timeline).getByText('Accepted · 63/63')).toBeTruthy();
    // Snapshots at +4, +12 before the first submit; +21, +22 between the two.
    expect(within(timeline).getAllByText(/code changed ×2/)).toHaveLength(2);
    await user.click(within(timeline).getByText('Error', { selector: 'summary' }));
    expect(
      within(timeline).getByText('[3,3] 6', { normalizer: (s) => s.replace(/\s+/g, ' ') }),
    ).toBeTruthy();
    expect(within(timeline).getByText(/KeyError: 3/)).toBeTruthy();
    expect(screen.getByText('Final code')).toBeTruthy();
    // Ended: no End sitting.
    expect(screen.queryByRole('button', { name: 'End sitting' })).toBeNull();
  });

  it('an unknown id says so, with the way back', async () => {
    renderApp({ path: '/recruiting/sittings/01HZZZZZZZZZZZZZZZZZZZZZZZ' });
    expect(await screen.findByText('No such sitting.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to sittings' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sittings' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('a list row opens its sitting', async () => {
    const user = userEvent.setup();
    renderApp({ api: seeded(), path: '/recruiting' });
    await user.click(await screen.findByRole('link', { name: /Add Two Numbers/ }));
    expect(await screen.findByRole('heading', { name: 'Add Two Numbers' })).toBeTruthy();
    // Reviewed in the seed: its one-liner is in the form.
    expect(screen.getByLabelText<HTMLInputElement>('One-liner').value).toMatch(/^Carry handled/);
  });
});

describe('the review', () => {
  it('starts on a hint after a failed submit, saves every field, and reads back after a reload', async () => {
    const user = userEvent.setup();
    const api = seeded();
    const { unmount } = await open(api);
    expect(await screen.findByRole('button', { name: 'A hint' })).toHaveProperty(
      'ariaPressed',
      'true',
    );
    await user.type(screen.getByLabelText('One-liner'), 'Check the map before inserting');
    await user.click(screen.getByRole('button', { name: 'Add a mistake' }));
    await user.type(screen.getByLabelText('Mistake 1'), 'Inserted before looking up');
    await user.type(screen.getByLabelText('Tags'), 'Hash Map{Enter}');
    await user.type(screen.getByLabelText('How it went'), 'Quick once I saw it');
    await user.clear(screen.getByLabelText('Prep target'));
    await user.type(screen.getByLabelText('Prep target'), 'Google');
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    const { sitting } = await api.getSitting(await idOf(api, 'two-sum'));
    expect(sitting.review).toMatchObject({
      insight: 'Check the map before inserting',
      help: 'hint',
      mistakes: ['Inserted before looking up'],
      howItWent: 'Quick once I saw it',
      tags: ['hash map'],
      draftUsed: false,
    });
    expect(sitting.prepTarget).toBe('Google');

    unmount();
    await open(api);
    expect((await screen.findByLabelText<HTMLInputElement>('One-liner')).value).toBe(
      'Check the map before inserting',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Mistake 1').value).toBe(
      'Inserted before looking up',
    );
    expect(
      within(screen.getByRole('list', { name: 'Your tags' })).getByText('hash map'),
    ).toBeTruthy();
    expect(screen.getByText('Quick once I saw it')).toBeTruthy();
    expect(screen.getByText(/For Google/)).toBeTruthy();
  });

  it('Claude’s draft lines arrive unticked; only ticked ones — edited — are saved, marked draftUsed', async () => {
    const user = userEvent.setup();
    const api = seeded();
    await open(api, 'longest-substring-without-repeating-characters');
    await user.click(await screen.findByRole('button', { name: 'Draft with Claude' }));
    const draft = await screen.findByRole('group', { name: 'Claude’s draft' });
    // The stub's deterministic draft: one line per judged run or submit that wasn't accepted.
    expect(within(draft).getAllByRole('checkbox')).toHaveLength(2);
    for (const box of within(draft).getAllByRole('checkbox'))
      expect(box).toHaveProperty('checked', false);
    const line2 = within(draft).getByLabelText<HTMLInputElement>('Draft line 2');
    expect(line2.value).toBe('Submit 1 (Wrong Answer): "abba" → expected 2, got 3');
    await user.clear(line2);
    await user.type(line2, 'Moved left past a repeat it had already left behind ("abba")');
    await user.click(within(draft).getByLabelText('Keep draft line 2'));
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    const { sitting } = await api.getSitting(
      await idOf(api, 'longest-substring-without-repeating-characters'),
    );
    expect(sitting.review).toMatchObject({
      mistakes: ['Moved left past a repeat it had already left behind ("abba")'],
      draftUsed: true,
    });
    // Use all ticks every line.
    await user.click(screen.getByRole('button', { name: 'Draft with Claude' }));
    const again = await screen.findByRole('group', { name: 'Claude’s draft' });
    await user.click(within(again).getByRole('button', { name: 'Use all' }));
    for (const box of within(again).getAllByRole('checkbox'))
      expect(box).toHaveProperty('checked', true);
  });

  it('a failed draft says so inline and keeps what was typed; Save still saves', async () => {
    const user = userEvent.setup();
    const api = seeded();
    vi.spyOn(api, 'draftSittingReview').mockResolvedValueOnce({ ok: false, reason: 'timeout' });
    vi.spyOn(api, 'draftSittingReview').mockRejectedValueOnce(new Error('500'));
    await open(api);
    await user.click(await screen.findByRole('button', { name: 'Add a mistake' }));
    await user.type(screen.getByLabelText('Mistake 1'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Draft with Claude' }));
    expect(await screen.findByText(/it took too long/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Draft with Claude' }));
    expect(await screen.findByText(/the request failed/)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Mistake 1').value).toBe('mine');
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('a failed save keeps every field and says so; an over-long one-liner can’t be saved', async () => {
    const user = userEvent.setup();
    const api = seeded();
    const save = vi.spyOn(api, 'setSittingReview').mockRejectedValueOnce(new Error('offline'));
    await open(api);
    await user.type(await screen.findByLabelText('One-liner'), 'keep me');
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn’t save the review/);
    expect(screen.getByLabelText<HTMLInputElement>('One-liner').value).toBe('keep me');

    await user.type(screen.getByLabelText('One-liner'), 'x'.repeat(200));
    expect(screen.getByText(/too long to save/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('a tag left in the box is saved as a chip, and the next Save keeps it', async () => {
    const user = userEvent.setup();
    const api = seeded();
    const save = vi.spyOn(api, 'setSittingReview');
    await open(api);
    await user.type(await screen.findByLabelText('Tags'), 'Sliding Window');
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Your tags' })).getByText('sliding window'),
    ).toBeTruthy();
    await user.type(screen.getByLabelText('One-liner'), 'later');
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]![1].tags).toEqual(['sliding window']);
  });

  it('Add a mistake focuses its field; removing a tag keeps focus in the tags', async () => {
    const user = userEvent.setup();
    const api = seeded();
    await open(api);
    await user.click(await screen.findByRole('button', { name: 'Add a mistake' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Mistake 1'));
    const box = screen.getByLabelText('Tags');
    await user.type(box, 'a{Enter}b{Enter}');
    await user.click(screen.getByRole('button', { name: 'Remove tag a' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove tag b' })),
    );
    await user.click(screen.getByRole('button', { name: 'Remove tag b' }));
    await waitFor(() => expect(document.activeElement).toBe(box));
  });

  it('a review that saved with a prep target that didn’t says which', async () => {
    const user = userEvent.setup();
    const api = seeded();
    vi.spyOn(api, 'setSittingPrepTarget').mockRejectedValueOnce(new Error('offline'));
    await open(api);
    const prep = await screen.findByLabelText('Prep target');
    await user.clear(prep);
    await user.type(prep, 'Stripe');
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /review saved, but the prep target didn’t/,
    );
    expect(screen.getByLabelText<HTMLInputElement>('Prep target').value).toBe('Stripe');
  });

  it('a later Save never pulls focus into a mistake field', async () => {
    const user = userEvent.setup();
    const api = seeded();
    await open(api);
    await user.click(await screen.findByRole('button', { name: 'Add a mistake' }));
    await user.click(screen.getByRole('button', { name: 'Save review' })); // the blank line is dropped
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(screen.queryByLabelText('Mistake 1')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Draft with Claude' }));
    await user.click(await screen.findByRole('button', { name: 'Use all' }));
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    await screen.findByLabelText('Mistake 1');
    expect(document.activeElement).not.toBe(screen.getByLabelText('Mistake 1'));
  });

  it('How it went counts line breaks as the server does: many short lines still save', async () => {
    const user = userEvent.setup();
    const api = seeded();
    const save = vi.spyOn(api, 'setSittingReview');
    await open(api);
    const how = await screen.findByLabelText('How it went');
    // 1,802 characters as the server counts them (it keeps line breaks and spaces) — over 1,000 — though folding
    // whitespace would make it 902. The form must count the server's way and refuse.
    await user.click(how);
    await user.paste(Array(301).fill('ab').join('\n   '));
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getAllByText(/too long to save/).length).toBeGreaterThan(0);
  });

  it('a draft with nothing judged yet says there’s nothing to draft', async () => {
    const user = userEvent.setup();
    const { api, sitting } = await withOpenSitting();
    renderApp({ api, path: `/recruiting/sittings/${sitting.id}` });
    expect(await screen.findByText('No runs or submits yet.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Draft with Claude' }));
    expect(await screen.findByText(/Nothing to draft yet/)).toBeTruthy();
  });
});

describe('End sitting', () => {
  it('opens the rep’s Done form on the sitting’s minutes; Cancel writes nothing, Mark done ends it', async () => {
    const user = userEvent.setup();
    const { api, sitting } = await withOpenSitting();
    await api.setTaskEstimate(sitting.repTaskId, null, null); // the rep lost its estimate
    // The Rolls arrive late: the form must still start on the Roll's 45, not the 30-minute fallback.
    const listRolls = api.listRolls.bind(api);
    vi.spyOn(api, 'listRolls').mockImplementation(
      () => new Promise((r) => setTimeout(() => r(listRolls()), 50)),
    );
    renderApp({ api, path: `/recruiting/sittings/${sitting.id}` });
    expect(await screen.findByText(/In progress/)).toBeTruthy();
    const end = await screen.findByRole('button', { name: 'End sitting' });
    await waitFor(() => expect(end.getAttribute('aria-disabled')).toBeNull());
    await user.click(end);
    expect(screen.getByLabelText<HTMLInputElement>('Actual (min)').value).toBe('1');
    expect(screen.getByLabelText<HTMLInputElement>('Estimate in hindsight').value).toBe('45');
    // Focus moves into the form (not Actual — no phone keyboard), and Cancel hands it back.
    expect(document.activeElement?.contains(screen.getByLabelText('Actual (min)'))).toBe(true);
    expect(document.activeElement).not.toBe(screen.getByLabelText('Actual (min)'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'End sitting' }));
    expect((await api.getSitting(sitting.id)).sitting.status).toBe('active');

    await user.click(screen.getByRole('button', { name: 'End sitting' }));
    await user.click(screen.getByRole('button', { name: 'Mark done' }));
    await waitFor(async () =>
      expect((await api.getSitting(sitting.id)).sitting.status).toBe('done'),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'End sitting' })).toBeNull());
    // Focus goes on to the review, not the page body.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Review' })),
    );
    expect(screen.getByText('No runs or submits.')).toBeTruthy(); // ended: no "yet"
  });
});
