import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { todayKey } from '@aperture/shared';
import type { ApiClient } from '@aperture/shared';
import { createStubClient } from '../data/stubClient';
import { renderApp, renderWithProviders } from '../test/utils';
import { AddToTodayDialog } from '../modules/tasks/AddToTodayDialog';
import { AddToCalendarForm } from '../modules/tasks/editor/AddToCalendarForm';
import { TaskDetailsForm } from '../modules/tasks/editor/TaskDetailsForm';
import { BulkAddDialog } from '../modules/tasks/BulkAddDialog';

// A failed read never collapses to an empty list or a default (docs/product/CONVENTIONS.md → Failed
// reads). Each test fails one read on the stub and checks the screen says so instead of the empty copy.

beforeEach(() => globalThis.localStorage?.clear());

const stub = (seed = true) => createStubClient({ seed, storageKey: `fr-${Math.random()}` });
function failing(api: ApiClient, ...methods: (keyof ApiClient)[]) {
  for (const m of methods)
    (api as unknown as Record<string, unknown>)[m] = () =>
      Promise.reject(new Error(`${m} failed (503)`));
  return api;
}

describe('Home never shows a failed read as empty', () => {
  it('a failed log read says so instead of “Nothing logged yet”', async () => {
    const user = userEvent.setup();
    renderApp({ api: failing(stub(), 'listLogEntries') });
    await user.click(await screen.findByRole('button', { name: 'Night' }));
    await screen.findByText('Couldn’t load today’s review.');
    expect(screen.queryByText(/Nothing logged yet/)).toBeNull();
  });

  it('a failed habits read says so instead of “No habits yet”', async () => {
    const user = userEvent.setup();
    renderApp({ api: failing(stub(), 'listHabits') });
    await user.click(await screen.findByRole('button', { name: 'Night' }));
    await screen.findByText(/Couldn.t load this\. Check your connection/);
    expect(screen.queryByText(/No habits yet/)).toBeNull();
  });

  it('failed habit checks say so and blank the counts instead of reading as misses', async () => {
    const user = userEvent.setup();
    renderApp({ api: failing(stub(), 'listHabitChecks') });
    await user.click(await screen.findByRole('button', { name: 'Night' }));
    await screen.findByText('Couldn’t load this week’s checks.');
    expect(screen.getAllByText(/^—\/\d this week$/).length).toBeGreaterThan(0);
  });

  it('the Flux and Finance lines say couldn’t load instead of vanishing', async () => {
    const user = userEvent.setup();
    renderApp({ api: failing(stub(), 'listFluxSets', 'getFinanceOverview') });
    await user.click(await screen.findByRole('button', { name: 'Night' }));
    await screen.findByText('Flux · couldn’t load today’s sets');
    await screen.findByText('Finances · couldn’t load');
  });

  it('a failed calendar read never shows a free day', async () => {
    const user = userEvent.setup();
    renderApp({ api: failing(stub(), 'getCalendarBusy') });
    await user.click(await screen.findByRole('button', { name: 'Morning' }));
    await screen.findByText('Couldn’t read your calendars.');
    expect(screen.queryByText('longest free stretch')).toBeNull();
  });

  it('a failed day read disables Intent instead of overwriting it', async () => {
    const user = userEvent.setup();
    renderApp({ api: failing(stub(), 'getDay') });
    await user.click(await screen.findByRole('button', { name: 'Morning' }));
    await screen.findByText('Couldn’t load today’s intent.');
    expect(screen.getByLabelText<HTMLInputElement>('Day intent').disabled).toBe(true);
  });

  it('a failed plan read says so instead of “Nothing planned yet”', async () => {
    const user = userEvent.setup();
    renderApp({ api: failing(stub(), 'listPlansForDay') });
    await user.click(await screen.findByRole('button', { name: 'Morning' }));
    await screen.findAllByText(/Couldn.t load this\. Check your connection/);
    expect(screen.queryByText(/Nothing planned yet/)).toBeNull();
  });
});

describe('Tasks never shows a failed read as empty', () => {
  it('a failed categories read says so with Retry, and marks the tags it can’t resolve', async () => {
    const user = userEvent.setup();
    const api = stub();
    const real = api.listCategories.bind(api);
    let fail = true;
    api.listCategories = () =>
      fail ? Promise.reject(new Error('listCategories failed (503)')) : real();
    renderApp({ api, path: '/tasks?lens=backlog' });
    await screen.findByText(/Couldn.t load categories — labels and category filters are off/);
    expect(screen.getAllByTitle('Couldn’t load categories').length).toBeGreaterThan(0); // the “—” pills
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(screen.queryByText(/labels and category filters are off/)).toBeNull(),
    );
    expect(screen.queryAllByTitle('Couldn’t load categories')).toHaveLength(0);
  });

  it('a failed series read says so instead of “No recurring tasks yet”', async () => {
    renderApp({ api: failing(stub(), 'listSeries'), path: '/tasks?lens=recurring' });
    await screen.findByText(/Couldn.t load this\. Check your connection/);
    expect(screen.queryByText('No recurring tasks yet.')).toBeNull();
  });

  it('a failed calibration read says so instead of the empty state', async () => {
    renderApp({ api: failing(stub(), 'getCalibration'), path: '/tasks?lens=calibration' });
    await screen.findByText(/Couldn.t load this\. Check your connection/);
    expect(screen.queryByText(/No finished tasks with an estimate yet/)).toBeNull();
  });

  it('a failed tasks read in Add to today says so instead of an empty list', async () => {
    const api = failing(stub(), 'listTasks');
    renderWithProviders(<AddToTodayDialog open onClose={() => {}} />, { api });
    await screen.findByText('Couldn’t load your tasks.');
    expect(screen.queryByText(/Nothing waiting/)).toBeNull();
  });

  it('a failed calendars read never says to connect an account', async () => {
    const api = failing(stub(), 'listGoogleCalendars');
    const task = await api.createTask({ title: 'Essay', dueDay: todayKey(4) });
    renderWithProviders(<AddToCalendarForm task={task} onDone={() => {}} />, { api });
    await screen.findByText('Couldn’t load your calendars.');
    expect(screen.queryByText(/Connect a Google account/)).toBeNull();
  });

  it('a failed categories read disables the task’s category picker', async () => {
    const api = stub(false);
    const cat = await api.upsertCategory({ label: 'School', isWork: true });
    const task = await api.createTask({ title: 'Essay', categoryId: cat.id });
    failing(api, 'listCategories');
    renderWithProviders(<TaskDetailsForm task={task} />, { api });
    await screen.findByText('Couldn’t load categories.');
    expect(screen.getByLabelText<HTMLSelectElement>('Category').disabled).toBe(true);
  });

  it('a #label paste with failed categories says so and stays blocked', async () => {
    const user = userEvent.setup();
    const api = failing(stub(), 'listCategories');
    renderWithProviders(<BulkAddDialog open onClose={() => {}} onAdded={() => {}} />, { api });
    await user.click(await screen.findByRole('textbox'));
    await user.paste('write memo | #Admin');
    await screen.findByText(/Couldn.t load categories — remove the #labels/);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /^Add/ }).disabled).toBe(true);
  });
});

describe('Settings, Habits and Rolls never show a failed read as empty', () => {
  it('a failed settings read shows an error, not an empty page — once, not twice', async () => {
    renderApp({ api: failing(stub(), 'getSettings'), path: '/settings' });
    await screen.findByText(/Couldn.t load your settings — calendar, preferences/);
    expect(screen.queryByText(/running on defaults/)).toBeNull(); // the shell's notice steps aside here
  });

  it('a failed settings read disables Intent and says why, instead of a field that never loads', async () => {
    const user = userEvent.setup();
    renderApp({ api: failing(stub(), 'getSettings') });
    await user.click(await screen.findByRole('button', { name: 'Morning' }));
    await screen.findByText('Couldn’t load today’s intent.');
    expect(screen.getByLabelText<HTMLInputElement>('Day intent').disabled).toBe(true);
  });

  it('a failed settings read hides the Today capacity field instead of an empty one', async () => {
    renderApp({ api: failing(stub(), 'getSettings'), path: '/tasks' });
    await screen.findByText('Couldn’t load today’s capacity.');
  });

  it('a failed plan read on Daytime says so instead of “No plan to budget against”', async () => {
    const user = userEvent.setup();
    renderApp({ api: failing(stub(), 'listPlansForDay') });
    await user.click(await screen.findByRole('button', { name: 'Daytime' }));
    await screen.findAllByText(/Couldn.t load this\. Check your connection/);
    expect(screen.queryByText(/No plan to budget against/)).toBeNull();
  });

  it('failed checks blank the Habits page counts and lock the cells', async () => {
    renderApp({ api: failing(stub(), 'listHabitChecks'), path: '/habits' });
    await screen.findByText('Couldn’t load your check-ins.');
    expect(screen.getAllByText(/^—\/\d this week$/).length).toBeGreaterThan(0);
    const cell = screen.getAllByRole<HTMLButtonElement>('button', { name: / on / })[0]!;
    expect(cell.disabled).toBe(true);
  });

  it('a failed categories read says so above the list', async () => {
    renderApp({ api: failing(stub(), 'listCategories'), path: '/settings' });
    await screen.findByText('Couldn’t load categories.');
  });

  it('failed checks say so while the habit cards still render', async () => {
    renderApp({ api: failing(stub(), 'listHabitChecks'), path: '/habits' });
    await screen.findByText('Couldn’t load your check-ins.');
    expect(screen.queryByText('No habits yet.')).toBeNull();
  });

  it('a failed tasks read says so above the roll sheets', async () => {
    renderApp({ api: failing(stub(), 'listTasks'), path: '/rolls' });
    await screen.findByText(/Couldn.t load your reps/);
  });

  it('a failed rolls read is said once on the Rolls page', async () => {
    renderApp({ api: failing(stub(), 'listRolls'), path: '/rolls' });
    await screen.findByText(/Couldn.t load this\. Check your connection/);
    expect(screen.queryByText('Couldn’t load your Rolls.')).toBeNull(); // not again by the picker
  });
});
