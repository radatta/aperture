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
    // The stub's deterministic draft: one line per judged run or submit that wasn't accepted — the Run counts,
    // LeetCode's "Accepted" with correct_answer false.
    expect(within(draft).getAllByRole('checkbox')).toHaveLength(2);
    expect(within(draft).getByLabelText<HTMLInputElement>('Draft line 1').value).toBe(
      'Run 1 (Wrong Answer): "abba" → expected 2, got 3', // the Run's own case, from its data_input
    );
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
    // Refused by the form's own count (Save held), not by the normalizer after a press.
    expect(screen.getByRole('button', { name: 'Save review' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(screen.queryByRole('alert')).toBeNull();
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

describe('the stub’s sittings', () => {
  it('its draft names a Run’s expected and output when no input was captured', async () => {
    const { api, sitting } = await withOpenSitting();
    await api.lcSittingEvents({
      sittingId: sitting.id,
      events: [
        {
          id: '01HZZZZZZZZZZZZZZZZZZZZZZY',
          type: 'run',
          at: sitting.clientStartedAt + 60_000,
          payload: {
            result: {
              status_code: 10,
              status_msg: 'Accepted',
              correct_answer: false,
              code_answer: ['3'],
              expected_code_answer: ['2'],
            },
          },
        },
      ],
    });
    expect(await api.draftSittingReview(sitting.id)).toEqual({
      ok: true,
      mistakes: ['Run 1 (Wrong Answer): expected 2, got 3'],
    });
    // Only one half captured: that half alone, never "expected null".
    await api.lcSittingEvents({
      sittingId: sitting.id,
      events: [
        {
          id: '01HZZZZZZZZZZZZZZZZZZZZZZX',
          type: 'run',
          at: sitting.clientStartedAt + 120_000,
          payload: {
            result: {
              status_code: 10,
              status_msg: 'Accepted',
              correct_answer: false,
              code_answer: ['[0,0]'],
            },
          },
        },
      ],
    });
    expect(await api.draftSittingReview(sitting.id)).toMatchObject({
      mistakes: ['Run 1 (Wrong Answer): expected 2, got 3', 'Run 2 (Wrong Answer): got [0,0]'],
    });
  });

  it('names an accepted Run’s fold-out “Case”, a wrong one’s “Failing case”', async () => {
    const { api, sitting } = await withOpenSitting();
    const run = (id: string, at: number, correct: boolean) => ({
      id,
      type: 'run' as const,
      at: sitting.clientStartedAt + at,
      payload: {
        request: { data_input: '[2,7]\n9' },
        result: {
          status_code: 10,
          status_msg: 'Accepted',
          correct_answer: correct,
          total_correct: correct ? 3 : 0,
          total_testcases: 3,
          code_answer: ['[0,1]'],
          expected_code_answer: ['[0,1]'],
        },
      },
    });
    await api.lcSittingEvents({
      sittingId: sitting.id,
      events: [
        run('01HZZZZZZZZZZZZZZZZZZZZZZW', 60_000, true),
        run('01HZZZZZZZZZZZZZZZZZZZZZZV', 120_000, false),
      ],
    });
    renderApp({ api, path: `/recruiting/sittings/${sitting.id}` });
    const timeline = await screen.findByRole('list', { name: 'Runs and submits' });
    const item = (text: string) => within(timeline).getByText(text).closest('li') as HTMLElement;
    await within(timeline).findByText('Accepted · 3/3');
    expect(within(item('Accepted · 3/3')).getByText('Case', { selector: 'summary' })).toBeTruthy();
    expect(
      within(item('Wrong Answer · 0/3')).getByText('Failing case', { selector: 'summary' }),
    ).toBeTruthy();
  });

  it('every seeded sitting ends no earlier than its last run or submit', async () => {
    const api = seeded();
    for (const s of await api.listSittings()) {
      const { sitting, events } = await api.getSitting(s.id);
      const last = Math.max(...events.filter((e) => e.type !== 'snapshot').map((e) => e.at));
      expect(sitting.endedAt, sitting.problemSlug).toBeGreaterThanOrEqual(last);
    }
  });

  // --- The coach's cause and peeked (docs/areas/recruiting/coach.md) ---
  const pressed = (name: string) =>
    screen.getByRole('button', { name }).getAttribute('aria-pressed');
  const CAUSES = ['No trace', 'API slip', 'Boundary', 'Off by one', 'Quit early'];

  it('starts on the suggested No trace after a first submit with no run; an untouched Save keeps it', async () => {
    const user = userEvent.setup();
    const api = seeded();
    await open(api);
    await screen.findByRole('button', { name: 'No trace' });
    expect(pressed('No trace')).toBe('true');
    expect(screen.getByText(/suggested/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    const { sitting } = await api.getSitting(await idOf(api, 'two-sum'));
    expect(sitting.review?.cause).toBe('no-trace');
  });

  it('one cause at a time, a second tap clears it; Peeked and the cause read back after a reload', async () => {
    const user = userEvent.setup();
    const api = seeded();
    const { unmount } = await open(api);
    await user.click(await screen.findByRole('button', { name: 'Boundary' }));
    expect(pressed('Boundary')).toBe('true');
    expect(pressed('No trace')).toBe('false');
    await user.click(screen.getByRole('button', { name: 'Boundary' }));
    expect(pressed('Boundary')).toBe('false');
    await user.click(screen.getByRole('button', { name: 'Off by one' }));
    await user.click(screen.getByRole('button', { name: 'Peeked' }));
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    const id = await idOf(api, 'two-sum');
    expect((await api.getSitting(id)).sitting.review).toMatchObject({
      help: 'solution',
      cause: 'off-by-one',
    });
    unmount();
    await open(api);
    await screen.findByRole('button', { name: 'Off by one' });
    expect(pressed('Off by one')).toBe('true');
    expect(pressed('Peeked')).toBe('true');
    expect(screen.queryByText(/suggested/)).toBeNull();
  });

  it('a cleared suggestion stays cleared: no suggestion comes back, and the next Save keeps none', async () => {
    const user = userEvent.setup();
    const api = seeded();
    const id = await idOf(api, 'two-sum');
    await open(api);
    await user.click(await screen.findByRole('button', { name: 'No trace' }));
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect((await api.getSitting(id)).sitting.review?.cause ?? null).toBeNull();
    await waitFor(() => expect(pressed('No trace')).toBe('false'));
    expect(screen.queryByText(/suggested/)).toBeNull();
    await user.type(screen.getByLabelText('One-liner'), 'second save');
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    await waitFor(async () =>
      expect((await api.getSitting(id)).sitting.review?.insight).toBe('second save'),
    );
    expect((await api.getSitting(id)).sitting.review?.cause ?? null).toBeNull();
    expect(pressed('No trace')).toBe('false');
  });

  it('a stored cause Claude cleared shows none, not the suggestion', async () => {
    const api = seeded();
    const id = await idOf(api, 'two-sum');
    // A review that says something else (a cause alone, cleared, leaves no review — and the suggestion is back).
    await api.patchSittingReview(id, { help: 'hint', cause: 'api-slip' });
    await api.patchSittingReview(id, { cause: null });
    await open(api);
    await screen.findByRole('button', { name: 'No trace' });
    expect(CAUSES.map(pressed)).toEqual(CAUSES.map(() => 'false'));
    expect(screen.queryByText(/suggested/)).toBeNull();
  });

  it('help and the cause refuse taps while a Save is in flight', async () => {
    const user = userEvent.setup();
    const api = seeded();
    let release: (() => void) | undefined;
    let armed = false; // only the Save's re-read waits; the page's own load doesn't
    const real = api.getSitting.bind(api);
    await open(api);
    await screen.findByRole('button', { name: 'Boundary' });
    vi.spyOn(api, 'getSitting').mockImplementation(async (id) => {
      const out = await real(id);
      if (armed) return out;
      armed = true;
      await new Promise<void>((r) => (release = r));
      return out;
    });
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    await screen.findByRole('button', { name: 'Saving…' });
    await user.click(screen.getByRole('button', { name: 'Boundary' }));
    await user.click(screen.getByRole('button', { name: 'Peeked' }));
    expect(pressed('Boundary')).toBe('false');
    expect(pressed('Peeked')).toBe('false');
    release!();
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  // F169: Claude marks the problem peeked (and tags the cause) over MCP while the form is open; the user's
  // Save of other fields must keep both, and the form then shows them.
  it('a Save after Claude’s mark_peeked keeps the peek and the cause it set', async () => {
    const user = userEvent.setup();
    const api = seeded();
    const id = await idOf(api, 'two-sum');
    await open(api);
    await screen.findByRole('button', { name: 'A hint' });
    expect(pressed('A hint')).toBe('true');
    await api.patchSittingReview(id, { help: 'solution', cause: 'quit-early' });
    await user.type(screen.getByLabelText('One-liner'), 'Trace the failing case first');
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect((await api.getSitting(id)).sitting.review).toMatchObject({
      insight: 'Trace the failing case first',
      help: 'solution',
      cause: 'quit-early',
    });
    await waitFor(() => expect(pressed('Peeked')).toBe('true'));
    expect(pressed('Quit early')).toBe('true');
  });

  it('what the user picked wins over Claude’s write', async () => {
    const user = userEvent.setup();
    const api = seeded();
    const id = await idOf(api, 'two-sum');
    await open(api);
    await user.click(await screen.findByRole('button', { name: 'No help' }));
    await user.click(screen.getByRole('button', { name: 'Boundary' }));
    await api.patchSittingReview(id, { help: 'solution', cause: 'quit-early' });
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect((await api.getSitting(id)).sitting.review).toMatchObject({
      help: 'none',
      cause: 'boundary',
    });
  });

  it('a failed read before the save keeps every field and says so', async () => {
    const user = userEvent.setup();
    const api = seeded();
    await open(api);
    await user.type(await screen.findByLabelText('One-liner'), 'keep me');
    vi.spyOn(api, 'getSitting').mockRejectedValueOnce(new Error('offline'));
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn’t save the review/);
    expect(screen.getByLabelText<HTMLInputElement>('One-liner').value).toBe('keep me');
  });
});
