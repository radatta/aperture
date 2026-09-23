import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiClient } from '@aperture/shared';
import { renderApp } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';

beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => vi.restoreAllMocks());

async function apiWithAdmin(): Promise<ApiClient> {
  const api = createStubClient({ seed: false, storageKey: `bulk-${Math.random()}` });
  await api.upsertCategory({ label: 'Admin', isWork: true });
  return api;
}

const area = () =>
  screen.getByRole('textbox', { name: 'Tasks, one per line' }) as HTMLTextAreaElement;
const addBtn = () => screen.getByRole('button', { name: /Add \d+ task/ }) as HTMLButtonElement;

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Bulk add/ }));
  await waitFor(() => expect(document.activeElement).toBe(area()));
}

describe('bulk add', () => {
  it('parses a paste, gates on errors, and creates every task in order on submit', async () => {
    const api = await apiWithAdmin();
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });
    await open(user);

    // An error line blocks the whole batch.
    await user.paste('email coach | ~30 #Admin\nbroken | ~oops\nbook flight | due:2026-10-02');
    expect(screen.getByText(/invalid estimate/)).toBeTruthy();
    expect(addBtn().disabled).toBe(true);

    // Fix it → submit enables and creates all three, in paste order, as backlog tasks with fields.
    await user.clear(area());
    await user.paste('email coach | ~30 #Admin\nfinish pset | ~90\nbook flight | due:2026-10-02');
    await waitFor(() => expect(addBtn().disabled).toBe(false));
    await user.click(addBtn());

    await waitFor(async () => {
      const tasks = await api.listBacklog();
      expect(tasks.map((t) => t.title)).toEqual(['email coach', 'finish pset', 'book flight']);
    });
    const tasks = await api.listBacklog();
    const coach = tasks.find((t) => t.title === 'email coach')!;
    expect(coach.estimateMin).toBe(30);
    expect(coach.categoryId).not.toBeNull(); // #Admin resolved
    expect(coach.estimateLockedMin).toBeNull(); // unlocked
    expect(tasks.find((t) => t.title === 'book flight')!.dueDay).toBe('2026-10-02');

    // Receipt shows, dialog closed, focus back on the trigger.
    expect(await screen.findByText(/Added 3 to Backlog/)).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /Bulk add/ })),
    );
  });

  it('an unknown #label is a warning — the task is still created, uncategorised', async () => {
    const api = await apiWithAdmin();
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });
    await open(user);

    await user.paste('write memo | #Nope');
    expect(screen.getByText(/no category 'Nope'/)).toBeTruthy();
    expect(addBtn().disabled).toBe(false); // yellow does not block
    await user.click(addBtn());

    await waitFor(async () => {
      const [t] = await api.listBacklog();
      expect(t?.title).toBe('write memo');
      expect(t?.categoryId).toBeNull();
    });
  });

  it('a retired #label is unknown and missing from the hint — the task lands uncategorised', async () => {
    const api = await apiWithAdmin();
    const old = await api.upsertCategory({ label: 'Studying', isWork: true });
    await api.upsertCategory({ id: old.id, label: 'Studying', isWork: true, active: false });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });
    await open(user);

    expect(screen.getByText(/Categories:/).textContent).not.toMatch(/Studying/);
    await user.paste('read ch 3 | #Studying');
    expect(screen.getByText(/no category 'Studying'/)).toBeTruthy();
    await user.click(addBtn());

    await waitFor(async () => {
      const [t] = await api.listBacklog();
      expect(t?.title).toBe('read ch 3');
      expect(t?.categoryId).toBeNull();
    });
  });

  it('Cancel drops the draft and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderApp({ api: await apiWithAdmin(), path: '/tasks' });
    await open(user);

    await user.paste('a throwaway line');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /Bulk add/ })),
    );
    // Reopen → the draft is gone.
    await open(user);
    expect(area().value).toBe('');
  });

  it('blocks submit while categories are still loading, if the paste uses #labels', async () => {
    const api = await apiWithAdmin();
    // Category list never resolves → an #Admin would silently miss; submit must wait.
    vi.spyOn(api, 'listCategories').mockImplementation(() => new Promise<never>(() => {}));
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });
    await open(user);

    await user.paste('write memo | #Admin');
    expect(screen.getByText(/Loading categories/)).toBeTruthy();
    expect(addBtn().disabled).toBe(true);

    // A title-only paste is unaffected — no #label to resolve.
    await user.clear(area());
    await user.paste('write memo');
    await waitFor(() => expect(addBtn().disabled).toBe(false));
  });

  it('a failed write keeps the dialog open with the text intact', async () => {
    const api = await apiWithAdmin();
    vi.spyOn(api, 'createTasks').mockRejectedValue(new Error('network'));
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });
    await open(user);

    await user.paste('keep me | ~15');
    await user.click(addBtn());

    expect(await screen.findByText(/Couldn.t save/)).toBeTruthy();
    expect(area().value).toBe('keep me | ~15'); // text preserved
  });
});
