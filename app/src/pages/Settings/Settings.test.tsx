import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';

beforeEach(() => globalThis.localStorage?.clear());

async function twoCats() {
  const api = createStubClient({ seed: false, storageKey: `settings-${Math.random()}` });
  const hw = await api.upsertCategory({ label: 'Homework', isWork: true });
  await api.upsertCategory({ label: 'Courses', isWork: true });
  return { api, hw };
}

const renameFields = () =>
  screen.getAllByLabelText(/^Rename /).map((el) => (el as HTMLInputElement).value);

describe('categories: retire / restore', () => {
  it('asks before retiring, then sorts the row after active ones, and restores', async () => {
    const { api, hw } = await twoCats();
    const user = userEvent.setup();
    renderApp({ api, path: '/settings' });

    await user.click(await screen.findByLabelText('More actions for Homework'));
    await user.click(screen.getByRole('menuitem', { name: 'Retire…' }));
    expect((await api.listCategories()).find((c) => c.id === hw.id)?.active).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Retire' }));
    await waitFor(async () =>
      expect((await api.listCategories()).find((c) => c.id === hw.id)?.active).toBe(false),
    );
    // The confirm collapsed; focus goes back to the row's menu trigger, not <body>.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('More actions for Homework')),
    );
    expect(await screen.findByText('Retired')).toBeTruthy();
    expect(renameFields()).toEqual(['Courses', 'Homework']);
    expect(screen.queryByLabelText('Move Homework up')).toBeNull(); // arrows are for active rows

    await user.click(screen.getByLabelText('More actions for Homework'));
    await user.click(screen.getByRole('menuitem', { name: 'Restore' }));
    await waitFor(async () =>
      expect((await api.listCategories()).find((c) => c.id === hw.id)?.active).toBe(true),
    );
    expect(await screen.findByLabelText('Move Homework up')).toBeTruthy(); // arrows are back
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('More actions for Homework')),
    );
  });

  it('renaming a retired category keeps it retired', async () => {
    const { api, hw } = await twoCats();
    await api.upsertCategory({ id: hw.id, label: 'Homework', isWork: true, active: false });
    const user = userEvent.setup();
    renderApp({ api, path: '/settings' });

    const field = await screen.findByLabelText('Rename Homework');
    await user.clear(field);
    await user.type(field, 'Old homework');
    await user.tab();

    await waitFor(async () =>
      expect((await api.listCategories()).find((c) => c.id === hw.id)?.label).toBe('Old homework'),
    );
    expect((await api.listCategories()).find((c) => c.id === hw.id)?.active).toBe(false);
  });
});

describe('finances settings', () => {
  it('says why a bad value isn’t saved, keeps it for fixing, and saves a good one', async () => {
    const api = createStubClient({ seed: false, storageKey: `settings-fin-${Math.random()}` });
    const user = userEvent.setup();
    renderApp({ api, path: '/settings' });
    const day = await screen.findByLabelText('Card payment day');
    await user.clear(day);
    await user.type(day, '40');
    await user.tab();
    expect(await screen.findByText('Enter a day from 1 to 31.')).toBeTruthy();
    expect(day.getAttribute('aria-invalid')).toBe('true');
    expect((day as HTMLInputElement).value).toBe('40');
    expect((await api.getSettings()).financePaymentDay).toBe(20);

    const budget = screen.getByLabelText('Budget per period ($)');
    await user.clear(budget);
    await user.type(budget, '-5');
    await user.tab();
    expect(await screen.findByText('Enter a dollar amount, like 600 or 600.00.')).toBeTruthy();
    expect(screen.getByText(/Now \$600\.00, payment day 20/)).toBeTruthy(); // still shows

    await user.clear(day);
    await user.type(day, '15');
    await user.tab();
    await waitFor(async () => expect((await api.getSettings()).financePaymentDay).toBe(15));
    expect(screen.queryByText('Enter a day from 1 to 31.')).toBeNull();
  });
});

describe('calendar auto-sync toggle', () => {
  it('is on by default and turns off', async () => {
    const api = createStubClient({ seed: true, storageKey: `settings-cal-${Math.random()}` });
    const user = userEvent.setup();
    renderApp({ api, path: '/settings' });
    const box = (await screen.findByRole('checkbox', {
      name: /Add tasks with a due time to this calendar automatically/,
    })) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await user.click(box);
    await waitFor(async () => expect((await api.getSettings()).autoCalendar).toBe(false));
  });
});

describe('build stamp', () => {
  it('shows the build the page came from — "local" outside a deploy', async () => {
    renderApp({ path: '/settings' });
    expect(await screen.findByText('Build local')).toBeTruthy();
  });
});

describe('flux section', () => {
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('/settings#flux scrolls to the Flux section once it has loaded', async () => {
    const scrolled: Element[] = [];
    // jsdom has no scrollIntoView; record what gets scrolled to.
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this);
    });
    const api = createStubClient({ seed: false, storageKey: `settings-${Math.random()}` });
    renderApp({ api, path: '/settings#flux' });
    await screen.findByLabelText('Count sessions as reps of');
    await waitFor(() => expect(scrolled.map((el) => el.id)).toContain('flux'));
  });
});
