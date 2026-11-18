import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { addDays, NEETCODE_150, PATTERNS, todayKey } from '@aperture/shared';
import type { CoachStats } from '@aperture/shared';
import { renderApp } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';
import { ApiError } from '../../data/retry';
import { fmtRate, patternRows } from './patternsHelpers';

// Synthetic fixtures only: catalog slugs and made-up outcomes.
beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => vi.restoreAllMocks());

const freshApi = () => createStubClient({ seed: false, storageKey: `patterns-${Math.random()}` });
const slugs = (pattern: string) =>
  NEETCODE_150.filter((c) => c.pattern === pattern && !c.premium).map((c) => c.slug);
const ago = (n: number) => addDays(todayKey(4, Date.now()), -n);
const row = (name: string) => screen.getByRole('listitem', { name });

describe('Patterns tab', () => {
  it('an empty account: says nothing is ranked yet, lists every pattern not started, focus line shown', async () => {
    renderApp({ api: freshApi(), path: '/recruiting/patterns' });
    expect(await screen.findByText('Nothing to rank yet.')).toBeTruthy();
    expect(await screen.findByText(/^Focus · Arrays & Hashing · day 1 of 3/)).toBeTruthy();
    const items = within(
      screen.getByRole('list', { name: 'Weakest first tries first' }),
    ).getAllByRole('listitem');
    expect(items).toHaveLength(PATTERNS.length);
    expect(screen.getAllByText('Not started')).toHaveLength(PATTERNS.length);
    expect(row('Arrays & Hashing').getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('link', { name: 'Patterns' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('a pattern with 2 tries shows counts and no percentage; 5 or more adds one', async () => {
    const api = freshApi();
    const tp = slugs('two-pointers');
    const st = slugs('stack');
    await api.logCoachAttempts([
      { slug: tp[0]!, day: ago(3), outcome: 'clean' },
      { slug: tp[1]!, day: ago(2), outcome: 'failed', cause: 'boundary' },
      ...st.slice(0, 5).map((slug, i) => ({
        slug,
        day: ago(5 - i),
        outcome: i < 3 ? ('clean' as const) : ('solved' as const),
      })),
    ]);
    renderApp({ api, path: '/recruiting/patterns' });
    await screen.findByText(
      (_, el) => el?.tagName === 'P' && /^7 problems · 7 attempts/.test(el.textContent ?? ''),
    );
    expect(within(row('Two Pointers')).getByText('First try 1 of 2')).toBeTruthy();
    expect(within(row('Two Pointers')).getByText('Boundary 1')).toBeTruthy();
    expect(within(row('Stack')).getByText('First try 3 of 5 (60%)')).toBeTruthy();
    // Two Pointers missed more, so it ranks above Stack.
    const names = within(screen.getByRole('list', { name: 'Weakest first tries first' }))
      .getAllByRole('listitem')
      .map((li) => li.getAttribute('data-pattern'));
    expect(names.indexOf('two-pointers')).toBeLessThan(names.indexOf('stack'));
  });

  it('“Set as focus” moves the day’s focus to day 1 of the pick; “Back to the coach’s pick” clears it', async () => {
    const api = freshApi();
    const user = userEvent.setup();
    renderApp({ api, path: '/recruiting/patterns' });
    await user.click(await screen.findByRole('button', { name: 'Set as focus, Graphs' }));
    expect(await screen.findByText(/^Focus · Graphs · day 1 of 3/)).toBeTruthy();
    await waitFor(() => expect(row('Graphs').getAttribute('aria-current')).toBe('true'));
    // The clicked button is gone: keyboard focus lands on the row that now holds the focus, not the top of the page.
    await waitFor(() => expect(document.activeElement).toBe(row('Graphs')));
    expect((await api.getCoachToday()).focus).toMatchObject({
      pattern: 'graphs',
      day: 1,
      source: 'override',
    });

    await user.click(screen.getByRole('button', { name: 'Back to the coach’s pick' }));
    expect(await screen.findByText(/^Focus · Arrays & Hashing/)).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement?.textContent).toMatch(/^Focus · Arrays & Hashing/),
    );
    expect((await api.getCoachToday()).focus.source).toBe('engine');
  });

  it('a refused focus write says why inline and changes nothing', async () => {
    const api = freshApi();
    vi.spyOn(api, 'setCoachFocus').mockRejectedValue(new Error('Nothing unseen is left in Graphs'));
    const user = userEvent.setup();
    renderApp({ api, path: '/recruiting/patterns' });
    await user.click(await screen.findByRole('button', { name: 'Set as focus, Graphs' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Nothing unseen is left in Graphs. Nothing changed.',
    );
    expect(row('Arrays & Hashing').getAttribute('aria-current')).toBe('true');
    // Shown in the row it was asked from, so it's on screen where the click was.
    expect(within(row('Graphs')).getByRole('alert')).toBeTruthy();
  });

  it('a write that may have landed (a 5xx) never claims nothing changed', async () => {
    const api = freshApi();
    vi.spyOn(api, 'setCoachFocus').mockRejectedValue(
      new ApiError('setCoachFocus failed (500)', 500),
    );
    const user = userEvent.setup();
    renderApp({ api, path: '/recruiting/patterns' });
    await user.click(await screen.findByRole('button', { name: 'Set as focus, Graphs' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Couldn’t confirm the focus change — it may have saved; the focus line shows what stands.',
    );
  });

  it('a failed stats read shows the error with Retry, never an empty ranking', async () => {
    const api = freshApi();
    const read = vi.spyOn(api, 'getCoachStats').mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    renderApp({ api, path: '/recruiting/patterns' });
    expect(await screen.findByText('Couldn’t load the patterns.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Weakest first tries first' })).toBeNull();
    read.mockRestore();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Nothing to rank yet.')).toBeTruthy();
  });

  it('a failed focus read says so; the ranking still shows', async () => {
    const api = freshApi();
    vi.spyOn(api, 'getCoachToday').mockRejectedValue(new Error('offline'));
    renderApp({ api, path: '/recruiting/patterns' });
    expect(await screen.findByText('Couldn’t load the focus.')).toBeTruthy();
    expect(screen.getAllByText('Not started')).toHaveLength(PATTERNS.length);
  });

  it('the Sittings tab is unchanged next to it', async () => {
    renderApp({ api: freshApi(), path: '/recruiting' });
    expect(await screen.findByText('No sittings yet.')).toBeTruthy();
    expect(screen.queryByText('Nothing to rank yet.')).toBeNull();
  });
});

describe('helpers', () => {
  it('fmtRate: a dash for none, counts under 5, a percentage from 5', () => {
    expect(fmtRate({ hit: 0, of: 0 })).toBe('—');
    expect(fmtRate({ hit: 2, of: 4 })).toBe('2 of 4');
    expect(fmtRate({ hit: 2, of: 6 })).toBe('2 of 6 (33%)');
  });

  it('patternRows: the ranking, then patterns with nothing unseen, then the rest in roadmap order', () => {
    const stat = (pattern: CoachStats['patterns'][number]['pattern']) =>
      ({ pattern }) as CoachStats['patterns'][number];
    const rows = patternRows(['stack', 'trees'], [stat('trees'), stat('tries')]);
    expect(rows.slice(0, 3).map((r) => [r.pattern, r.rank, r.stat?.pattern ?? null])).toEqual([
      ['stack', 1, null],
      ['trees', 2, 'trees'],
      ['tries', null, 'tries'],
    ]);
    expect(rows).toHaveLength(PATTERNS.length);
    // A problem outside the roadmap lands on `other`: one more row, last, never rankable.
    const withOther = patternRows(['stack'], [stat('other')]);
    expect(withOther).toHaveLength(PATTERNS.length + 1);
    expect(withOther.at(-1)).toMatchObject({ pattern: 'other', rank: null });
  });
});

describe('Patterns tab: mock interviews', () => {
  const section = () => screen.findByRole('region', { name: 'Mock interviews' });

  it('none yet: one line pointing at the Today card, no chart', async () => {
    renderApp({ api: freshApi(), path: '/recruiting/patterns' });
    const s = await section();
    expect(within(s).getByText(/None logged yet/)).toBeTruthy();
    expect(within(s).queryByRole('img')).toBeNull();
  });

  it('each done mock shows its scores beside its week’s first tries; the chart waits for two', async () => {
    const api = freshApi();
    await api.logCoachAttempts([
      { slug: slugs('two-pointers')[0]!, outcome: 'clean', day: ago(0) },
    ]);
    await api.upsertMock({ day: ago(0), scores: { code: 3, solve: 2 }, partner: 'Study group' });
    await api.upsertMock({ status: 'planned', day: addDays(ago(0), 1) }); // planned: not listed here
    const { unmount } = renderApp({ api, path: '/recruiting/patterns' });
    let s = await section();
    expect(await within(s).findByText('Code 3 · Solve 2')).toBeTruthy();
    expect(within(s).getByText('First try that week 1 of 1')).toBeTruthy();
    expect(within(s).getByText(/with Study group/)).toBeTruthy();
    expect(within(s).getAllByRole('listitem')).toHaveLength(1);
    expect(within(s).queryByRole('img')).toBeNull();
    unmount();
    await api.upsertMock({ day: ago(30), scores: { code: 1, solve: 2, communicate: 3 } });
    renderApp({ api, path: '/recruiting/patterns' });
    s = await section();
    const chart = await within(s).findByRole('img');
    expect(chart.getAttribute('aria-label')).toMatch(/Code 1, Solve 2; .* Code 3, Solve 2$/);
    expect(within(s).getByText('No first try that week')).toBeTruthy();
    expect(within(s).getByText('Code 1 · Solve 2 · Communication 3')).toBeTruthy();
  });

  it('Delete asks once, inline; No keeps it, Yes removes it', async () => {
    const user = userEvent.setup();
    const api = freshApi();
    const m = await api.upsertMock({ day: ago(1), scores: { code: 2, solve: 2 } });
    renderApp({ api, path: '/recruiting/patterns' });
    const s = await section();
    const del = await within(s).findByRole('button', { name: /^Delete the mock on / });
    await user.click(del);
    await user.click(within(s).getByRole('button', { name: 'No' }));
    expect(await api.listMocks()).toEqual([m]);
    await user.click(within(s).getByRole('button', { name: /^Delete the mock on / }));
    await user.click(within(s).getByRole('button', { name: /^Yes, delete the mock on / }));
    await waitFor(() => expect(within(s).getByText(/None logged yet/)).toBeTruthy());
    expect(await api.listMocks()).toEqual([]);
  });

  it('a failed read is a LoadError with Retry, and the rest of the tab still shows', async () => {
    const api = freshApi();
    const read = vi.spyOn(api, 'listMocks').mockRejectedValue(new Error('offline'));
    renderApp({ api, path: '/recruiting/patterns' });
    expect(await screen.findByText('Couldn’t load the mocks.', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Weakest first tries first' })).toBeTruthy();
    read.mockRestore();
  });
});
