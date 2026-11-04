import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { addDays, placeLensPath, todayKey } from '@aperture/shared';
import { createStubClient } from '../../data/stubClient';
import { renderApp } from '../../test/utils';

beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => vi.restoreAllMocks());

let clock = 1_800_000_000_000;
async function errands() {
  clock = 1_800_000_000_000;
  const api = createStubClient({
    seed: false,
    now: () => (clock += 1000),
    storageKey: `places-lens-${Math.random()}`,
  });
  await api.upsertPlace({ name: 'Corner Shop', slug: 'corner' });
  await api.upsertPlace({ name: 'Market' });
  const cat = await api.upsertCategory({ label: 'Home', isWork: false });
  const milk = await api.createTask({
    title: 'milk',
    place: 'market',
    categoryId: cat.id,
    estimateMin: 5,
    notes: '2% only',
  });
  await api.createTask({ title: 'bread', place: 'corner' });
  await api.createTask({ title: 'eggs', place: 'market' });
  await api.createTask({ title: 'not an errand' });
  return { api, milk };
}

const groupTitles = (name: string) =>
  within(screen.getByRole('region', { name }))
    .getAllByRole('button', { name: /^Check off / })
    .map((b) => b.getAttribute('aria-label')!.replace('Check off ', ''));

describe('Places lens', () => {
  it('groups errands by place in the order they were added, each list oldest first', async () => {
    const { api } = await errands();
    renderApp({ api, path: '/tasks?lens=places' });
    await screen.findByRole('region', { name: 'Market' });
    const regions = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(regions).toEqual(['Corner Shop', 'Market']);
    expect(groupTitles('Market')).toEqual(['milk', 'eggs']);
    expect(groupTitles('Corner Shop')).toEqual(['bread']);
    expect(screen.queryByText('not an errand')).toBeNull(); // that one's in the Backlog
    expect(screen.getByRole('button', { name: 'Places · 3' })).toBeTruthy();
  });

  it('an errand due this week lives on Week, not here — each task in exactly one lens', async () => {
    const { api } = await errands();
    await api.createTask({ title: 'stamps', place: 'corner', dueDay: addDays(todayKey(4), 1) });
    renderApp({ api, path: '/tasks?lens=places' });
    await screen.findByRole('region', { name: 'Corner Shop' });
    expect(groupTitles('Corner Shop')).toEqual(['bread']);
  });

  it('check-offs are thumb-sized', async () => {
    const { api } = await errands();
    renderApp({ api, path: '/tasks?lens=places' });
    const check = await screen.findByRole('button', { name: 'Check off milk' });
    expect(check.className).toMatch(/\bh-11\b/); // 44px
    expect(check.className).toMatch(/\bw-11\b/);
  });

  it('one tap finishes an unstarted errand (started then done) and offers Add again', async () => {
    const { api, milk } = await errands();
    const transition = vi.spyOn(api, 'transitionTask');
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=places' });
    await user.click(await screen.findByRole('button', { name: 'Check off milk' }));
    expect(await screen.findByText('Checked off “milk”.')).toBeTruthy();
    expect(transition.mock.calls.map((c) => c[1])).toEqual(['in_progress', 'done']);
    expect((await api.getTask(milk.id))!.status).toBe('done');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Check off milk' })).toBeNull(),
    );

    await user.click(screen.getByRole('button', { name: 'Add again' }));
    await waitFor(() => expect(groupTitles('Market')).toEqual(['eggs', 'milk']));
    const copy = (await api.listTasks()).find((t) => t.title === 'milk' && t.status === 'backlog');
    // A copy of the errand, not just its title: same list, category, estimate and notes.
    expect(copy).toMatchObject({
      place: 'market',
      categoryId: milk.categoryId,
      estimateMin: 5,
      notes: '2% only',
    });
    expect(screen.queryByText('Checked off “milk”.')).toBeNull();
  });

  it('a failed check-off says so and keeps the errand', async () => {
    const { api } = await errands();
    vi.spyOn(api, 'transitionTask').mockRejectedValueOnce(new Error('transitionTask failed (503)'));
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=places' });
    await user.click(await screen.findByRole('button', { name: 'Check off milk' }));
    expect(await screen.findByText('Couldn’t check that off — try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check off milk' })).toBeTruthy();
  });

  it('a failed Add again says so and keeps the offer', async () => {
    const { api } = await errands();
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=places' });
    await user.click(await screen.findByRole('button', { name: 'Check off milk' }));
    await screen.findByText('Checked off “milk”.');
    vi.spyOn(api, 'createTasks').mockRejectedValueOnce(new Error('createTasks failed (503)'));
    await user.click(screen.getByRole('button', { name: 'Add again' }));
    expect(await screen.findByText('Couldn’t add “milk” back — try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add again' })).toBeTruthy();
  });

  it('the Shortcut’s link opens that store’s list and scrolls to it, even when collapsed', async () => {
    const { api } = await errands();
    localStorage.setItem('aperture.tasks.collapsed', JSON.stringify({ 'places:market': true }));
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderApp({ api, path: placeLensPath('market') });
    await screen.findByRole('button', { name: 'Check off milk' });
    expect(scroll).toHaveBeenCalledTimes(1);
    expect((scroll.mock.contexts[0] as HTMLElement).getAttribute('aria-label')).toBe('Market');
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; // jsdom has none
  });

  it('a linked store with nothing on it still shows, saying so', async () => {
    const { api } = await errands();
    await api.upsertPlace({ name: 'Hardware' });
    renderApp({ api, path: placeLensPath('hardware') });
    const region = await screen.findByRole('region', { name: 'Hardware' });
    expect(within(region).getByText('Nothing on this list.')).toBeTruthy();
  });

  it('a link to a store that no longer exists says so', async () => {
    const { api } = await errands();
    renderApp({ api, path: placeLensPath('gone') });
    expect(await screen.findByText(/No place “gone” — it may have been renamed/)).toBeTruthy();
  });

  it('with no places it points to Settings; with places but no errands it shows how to add one', async () => {
    const empty = createStubClient({ seed: false, storageKey: `places-empty-${Math.random()}` });
    const { unmount } = renderApp({ api: empty, path: '/tasks?lens=places' });
    expect(await screen.findByText('No places yet.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Settings' }).getAttribute('href')).toBe(
      '/settings',
    );
    unmount();

    await empty.upsertPlace({ name: 'Corner Shop', slug: 'corner' });
    renderApp({ api: empty, path: '/tasks?lens=places' });
    expect(await screen.findByText('No errands.')).toBeTruthy();
    expect(screen.getByText(/“milk \| @corner”/)).toBeTruthy();
  });

  it('an errand’s parts are its rows, each a one-tap check — the counts are the digest’s items', async () => {
    const { api } = await errands();
    const party = await api.createTask({ title: 'party', place: 'corner' });
    await api.createTasks([
      { title: 'cups', parentId: party.id },
      { title: 'ice', parentId: party.id },
    ]);
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=places' });
    await screen.findByRole('button', { name: 'Check off cups' });
    // The parent gives way to its open parts, as the Shortcut's digest lists them.
    expect(groupTitles('Corner Shop')).toEqual(['bread', 'cups', 'ice']);
    expect(screen.queryByRole('button', { name: 'Check off party' })).toBeNull();
    expect((await api.listPlaceTasks('corner')).count).toBe(3);
    expect(screen.getByRole('button', { name: 'Places · 5' })).toBeTruthy();
    const header = within(screen.getByRole('region', { name: 'Corner Shop' })).getByRole('button', {
      name: /Corner Shop/,
    });
    expect(header.textContent).toMatch(/3/);
    expect(screen.getAllByText('part of party')).toHaveLength(2);
    const check = screen.getByRole('button', { name: 'Check off ice' });
    expect(check.className).toMatch(/\bh-11\b/);
    expect(screen.queryByRole('button', { name: /to today/ })).toBeNull(); // not the Add-to-today +

    await user.click(screen.getByRole('button', { name: 'Check off cups' }));
    await screen.findByText('Checked off “cups”.');
    await user.click(screen.getByRole('button', { name: 'Check off ice' }));
    await screen.findByText('Checked off “ice”.');
    // Every part done: the parent is the item again, finished the usual way — as thumb-sized as a check.
    const markDone = await screen.findByRole('button', { name: 'Mark done' });
    expect(markDone.className).toMatch(/\bmin-h-11\b/);
    await user.click(markDone);
    await waitFor(async () => expect((await api.getTask(party.id))!.status).toBe('done'));
    // The part's Add again goes with it: it would bring "ice" back loose, not as a part.
    await waitFor(() => expect(screen.queryByText('Checked off “ice”.')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Add again' })).toBeNull();
  });

  it('Add again on a part puts it back under its open parent', async () => {
    const { api } = await errands();
    const party = await api.createTask({ title: 'party', place: 'corner' });
    await api.createTasks([
      { title: 'cups', parentId: party.id },
      { title: 'ice', parentId: party.id },
    ]);
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=places' });
    await user.click(await screen.findByRole('button', { name: 'Check off cups' }));
    await screen.findByText('Checked off “cups”.');
    await user.click(screen.getByRole('button', { name: 'Add again' }));
    await waitFor(() => expect(groupTitles('Corner Shop')).toEqual(['bread', 'ice', 'cups']));
    const copy = (await api.listTasks()).find((t) => t.title === 'cups' && t.status === 'backlog');
    expect(copy).toMatchObject({ parentId: party.id, place: 'corner' });
  });

  it('a search from Places looks across every open task', async () => {
    const { api } = await errands();
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=places' });
    await screen.findByRole('button', { name: 'Check off milk' });
    expect(screen.queryByRole('button', { name: 'Filter' })).toBeNull(); // search only here
    await user.type(screen.getByLabelText('Search tasks'), 'errand');
    expect(await screen.findByText('not an errand')).toBeTruthy();
  });
});
