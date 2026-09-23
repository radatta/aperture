import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { addDays, todayKey } from '@aperture/shared';
import { renderApp } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';

// Lens state persists in both stores; clear both so tests can't leak into each other.
beforeEach(() => {
  globalThis.localStorage?.clear();
  globalThis.sessionStorage?.clear();
});

const today = () => todayKey(4);

async function seeded() {
  const api = createStubClient({ seed: false, storageKey: `tasklist-${Math.random()}` });
  const csen = await api.upsertCategory({ label: 'CSEN 146', isWork: true });
  const soci = await api.upsertCategory({ label: 'SOCI 49', isWork: true });
  return { api, csen, soci };
}

const pill = (name: string) =>
  screen.getByRole('button', { name: new RegExp(`^${name}( · \\d+)?$`) });

describe('/tasks lenses', () => {
  it('opens on Today with the capacity pass, and counts Today + Week on their pills', async () => {
    const { api } = await seeded();
    await api.createTask({ title: 'due soon', dueDay: addDays(today(), 2) });
    renderApp({ api, path: '/tasks' });

    expect(await screen.findByText('Hours available today')).toBeTruthy();
    expect(pill('Today').getAttribute('aria-pressed')).toBe('true');
    expect(await screen.findByRole('button', { name: 'Week · 1' })).toBeTruthy();
    expect(screen.getByText('Nothing planned yet.')).toBeTruthy();
  });

  it('Week groups by category; adding to today moves the task to the Today lens', async () => {
    const { api, csen, soci } = await seeded();
    await api.createTask({ title: 'pset 2', categoryId: csen.id, dueDay: addDays(today(), 1) });
    await api.createTask({ title: 'reading', categoryId: soci.id, dueDay: today() });
    await api.createTask({ title: 'someday', dueDay: addDays(today(), 30) }); // backlog, not week
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=week' });

    expect(await screen.findByRole('button', { name: /CSEN 146 · 1/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /SOCI 49 · 1/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'someday' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Add pset 2 to today' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'pset 2' })).toBeNull());
    expect(await api.listPlansForDay(today())).toHaveLength(1);

    await user.click(pill('Today'));
    expect(await screen.findByRole('button', { name: 'pset 2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unplan' })).toBeTruthy();
  });

  it('typing searches every open task, grouped by where each lives', async () => {
    const { api, csen } = await seeded();
    const onToday = await api.createTask({ title: 'pset 1', categoryId: csen.id });
    await api.upsertPlan({ taskId: onToday.id, day: today(), plannedMinutes: 30, order: 0 });
    await api.transitionTask(onToday.id, 'planned');
    await api.createTask({ title: 'pset 3', categoryId: csen.id });
    await api.createTask({ title: 'groceries' });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=backlog' });

    await user.type(await screen.findByLabelText('Search tasks'), 'csen');

    const todayGroup = (await screen.findByText(/^Today · 1$/)).closest('section')!;
    expect(within(todayGroup as HTMLElement).getByRole('button', { name: 'pset 1' })).toBeTruthy();
    expect(screen.getByText(/^Backlog · 1$/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'groceries' })).toBeNull();

    await user.clear(screen.getByLabelText('Search tasks'));
    await user.type(screen.getByLabelText('Search tasks'), 'zzz');
    expect(await screen.findByText('Nothing matches “zzz”.')).toBeTruthy();
  });

  it('switching lens keeps the search text', async () => {
    const { api } = await seeded();
    await api.createTask({ title: 'groceries' });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=week' });

    await api.createTask({ title: 'laundry' });
    await user.type(await screen.findByLabelText('Search tasks'), 'groc');
    await user.click(pill('Backlog'));
    expect((screen.getByLabelText('Search tasks') as HTMLInputElement).value).toBe('groc');
    // Still searching: without the text, Backlog would list laundry too.
    expect(await screen.findByRole('button', { name: 'groceries' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'laundry' })).toBeNull();
  });

  it('filters show as chips; zero results offer a reset', async () => {
    const { api, csen } = await seeded();
    await api.createTask({ title: 'pset 3', categoryId: csen.id });
    await api.createTask({ title: 'groceries' });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=backlog' });

    await user.click(await screen.findByRole('button', { name: 'Filter' }));
    const cats = within(screen.getByRole('group', { name: 'Category' }));
    await user.click(cats.getByRole('button', { name: 'CSEN 146' }));
    expect(screen.getByRole('button', { name: 'Filter · 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove filter: CSEN 146' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'groceries' })).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Due: Dated' }));
    expect(await screen.findByText('Nothing matches.')).toBeTruthy();
    // The open panel has its own Reset; use the empty state's.
    await user.click(screen.getAllByRole('button', { name: 'Reset to lens' }).at(-1)!);
    expect(await screen.findByRole('button', { name: 'groceries' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter' })).toBeTruthy();
  });

  it('a big group starts collapsed, and the choice sticks across visits', async () => {
    const { api } = await seeded();
    for (let i = 0; i < 8; i++) await api.createTask({ title: `chore ${i}` });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=backlog' });

    const header = await screen.findByRole('button', { name: /No category · 8/ });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'chore 0' })).toBeNull();
    await user.click(header);
    expect(await screen.findByRole('button', { name: 'chore 0' })).toBeTruthy();

    cleanup();
    renderApp({ api, path: '/tasks?lens=backlog' });
    expect(
      (await screen.findByRole('button', { name: /No category · 8/ })).getAttribute(
        'aria-expanded',
      ),
    ).toBe('true');
  });

  it('Today: an in-progress task off the plan gets its own tier; Unplan sends a task back', async () => {
    const { api } = await seeded();
    const started = await api.createTask({ title: 'started earlier' });
    await api.transitionTask(started.id, 'in_progress');
    const planned = await api.createTask({ title: 'planned one' });
    await api.upsertPlan({ taskId: planned.id, day: today(), plannedMinutes: 30, order: 0 });
    await api.transitionTask(planned.id, 'planned');
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });

    expect(await screen.findByText('In progress · not planned today')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add started earlier to today' })).toBeTruthy();

    await user.click(await screen.findByRole('button', { name: 'Unplan' }));
    await waitFor(async () => expect((await api.getTask(planned.id))?.status).toBe('backlog'));
    expect(await api.listPlansForDay(today())).toHaveLength(0);
  });

  it('Done lists finished and dropped history, newest first', async () => {
    // A ticking clock, so each finish has its own timestamp.
    let clock = Date.now();
    const api = createStubClient({
      seed: false,
      storageKey: `tasklist-done-${Math.random()}`,
      now: () => (clock += 1000),
    });
    const a = await api.createTask({ title: 'finished', estimateMin: 10 });
    await api.transitionTask(a.id, 'in_progress');
    await api.setTaskActual(a.id, 12);
    await api.transitionTask(a.id, 'done');
    const b = await api.createTask({ title: 'dropped' });
    await api.transitionTask(b.id, 'cancelled');
    await api.createTask({ title: 'still open' });
    renderApp({ api, path: '/tasks?lens=done' });

    await screen.findByRole('button', { name: 'finished' });
    const titles = screen
      .getAllByRole('button', { name: /^(finished|dropped|still open)$/ })
      .map((b) => b.textContent);
    expect(titles).toEqual(['dropped', 'finished']); // dropped last → first; open tasks absent
  });
});

describe('focus after a row leaves', () => {
  it('"+ Today" moves the row out of Week and focus lands on the list, not <body>', async () => {
    const api = createStubClient({ seed: false, storageKey: `tasklist-focus-${Math.random()}` });
    await api.createTask({ title: 'due soon', dueDay: addDays(todayKey(4), 1) });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=week' });

    const add = await screen.findByRole('button', { name: 'Add due soon to today' });
    add.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(add.isConnected).toBe(false));
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });
});
