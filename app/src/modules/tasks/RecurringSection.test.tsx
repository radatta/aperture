import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { addDays, fmtMonthShortDay, todayKey } from '@aperture/shared';
import { createStubClient } from '../../data/stubClient';
import { renderApp } from '../../test/utils';

beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => vi.restoreAllMocks());

const today = todayKey(4);
const stub = () => createStubClient({ seed: false, storageKey: `recurring-${Math.random()}` });

async function openForm(api = stub()) {
  const user = userEvent.setup();
  renderApp({ api, path: '/tasks?lens=recurring' });
  await user.click(await screen.findByRole('button', { name: 'New recurring task' }));
  await screen.findByLabelText('Title');
  return { api, user };
}

describe('RecurringSection — cadences', () => {
  it('a new series takes a due offset and an until, and its row reads them back', async () => {
    const until = addDays(today, 30);
    const { api, user } = await openForm();
    await user.type(screen.getByLabelText('Title'), 'Weekly report');
    await user.selectOptions(screen.getByLabelText('Repeats'), 'weekdays');
    await user.type(screen.getByLabelText('Estimate (min)'), '60');
    await user.selectOptions(screen.getByLabelText('Due'), '1');
    // A native date input takes its value as YYYY-MM-DD (the key the stub stores verbatim).
    await user.type(screen.getByLabelText('Until'), until);
    await user.click(screen.getByRole('button', { name: 'Add series' }));

    await waitFor(async () => expect(await api.listSeries()).toHaveLength(1));
    const [series] = await api.listSeries();
    expect(series).toMatchObject({
      title: 'Weekly report',
      defaultEstimateMin: 60,
      dueOffsetDays: 1,
      until,
      anchorDate: today,
    });
    await screen.findByText(`Weekdays · due next day · until ${fmtMonthShortDay(until)}`);
    // The form closed and the draft cleared.
    expect(screen.queryByLabelText('Title')).toBeNull();
  });

  it('no cadence reads as the rule alone; an until already past reads "ended" with Stop still offered', async () => {
    const api = stub();
    await api.upsertSeries({
      title: 'Standup',
      categoryId: null,
      defaultEstimateMin: 15,
      rule: { kind: 'daily' },
      anchorDate: today,
    });
    await api.upsertSeries({
      title: 'Old lab',
      categoryId: null,
      defaultEstimateMin: 60,
      rule: { kind: 'weekly', daysOfWeek: [1] },
      anchorDate: addDays(today, -60),
      dueOffsetDays: 2,
      until: addDays(today, -1),
    });
    renderApp({ api, path: '/tasks?lens=recurring' });
    await screen.findByText('Every day');
    const old = screen.getByText('Old lab').closest('div[class*="rounded"]') ?? document.body;
    expect(
      within(old as HTMLElement).getByText(
        `Mon · due in 2 days · ended ${fmtMonthShortDay(addDays(today, -1))}`,
      ),
    ).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Stop' })).toHaveLength(2);
  });

  it('a refused save says so inline and keeps the draft', async () => {
    const api = stub();
    vi.spyOn(api, 'upsertSeries').mockRejectedValue(new Error('Until must be a date (YYYY-MM-DD)'));
    const { user } = await openForm(api);
    await user.type(screen.getByLabelText('Title'), 'Quiz prep');
    await user.click(screen.getByRole('button', { name: 'Add series' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Until must be a date (YYYY-MM-DD)',
    );
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Quiz prep');
  });
});
