import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { addDays, todayKey } from '@aperture/shared';
import { renderApp } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';
import { LENS_PRESET } from './query';
import { isStored, QUERY_KEY, type Stored } from './useTaskQuery';

beforeEach(() => {
  globalThis.localStorage?.clear();
  globalThis.sessionStorage?.clear();
});

const stored = (over: Partial<Stored['query']> = {}, day = todayKey(4)): Stored => ({
  day,
  lens: 'backlog',
  query: { ...LENS_PRESET.backlog, ...over },
});
// The shape a session stored before the areas field: the same query without it.
const beforeAreas = (over: Partial<Stored['query']> = {}): Stored => {
  const s = stored(over);
  const query = { ...s.query } as Partial<Stored['query']>;
  delete query.areas;
  return { ...s, query: query as Stored['query'] };
};

// A stub with an Aperture-area category holding one backlog task, and a school one holding another.
async function seeded() {
  const api = createStubClient({ seed: false, storageKey: `tq-${Math.random()}` });
  const ap = await api.upsertCategory({ label: 'Aperture', isWork: true, area: 'aperture' });
  const sc = await api.upsertCategory({ label: 'CSEN 146', isWork: true, area: 'school' });
  await api.createTask({ title: 'fix cache policy', categoryId: ap.id });
  await api.createTask({ title: 'pset 4', categoryId: sc.id });
  return api;
}

describe('isStored (D4) — a stored query from before a field resets, never crashes', () => {
  it('accepts the current shape and rejects one without areas', () => {
    expect(isStored(stored())).toBe(true);
    expect(isStored(beforeAreas())).toBe(false);
    expect(isStored(null)).toBe(false);
    expect(isStored({ day: 1, lens: 'backlog', query: stored().query } as unknown as Stored)).toBe(
      false,
    );
  });

  it('a stored query without areas → Backlog loads on its preset (Aperture folded away)', async () => {
    const api = await seeded();
    sessionStorage.setItem(QUERY_KEY, JSON.stringify(beforeAreas({ sort: 'title' })));
    renderApp({ api, path: '/tasks?lens=backlog' });
    expect(await screen.findByRole('button', { name: 'pset 4' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'fix cache policy' })).toBeNull();
    expect(screen.queryByText('Sort: Title')).toBeNull(); // the old query's sort was dropped with it
  });

  it('the chip sticks for the session and resets on a new day', async () => {
    const api = await seeded();
    sessionStorage.setItem(QUERY_KEY, JSON.stringify(stored({ areas: [] })));
    renderApp({ api, path: '/tasks?lens=backlog' });
    expect(await screen.findByRole('button', { name: 'fix cache policy' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Aperture area · 1' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('yesterday’s shown-Aperture query is gone today', async () => {
    const api = await seeded();
    sessionStorage.setItem(
      QUERY_KEY,
      JSON.stringify(stored({ areas: [] }, addDays(todayKey(4), -1))),
    );
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=backlog' });
    expect(await screen.findByRole('button', { name: 'pset 4' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'fix cache policy' })).toBeNull();
    const chip = screen.getByRole('button', { name: 'Aperture area · 1' });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    await user.click(chip);
    expect(await screen.findByRole('button', { name: 'fix cache policy' })).toBeTruthy();
    expect((JSON.parse(sessionStorage.getItem(QUERY_KEY)!) as Stored).query.areas).toEqual([]);
  });
});
