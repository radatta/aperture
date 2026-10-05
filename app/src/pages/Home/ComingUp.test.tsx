import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { addDays, todayKey } from '@aperture/shared';
import type { ApiClient } from '@aperture/shared';
import { createStubClient } from '../../data/stubClient';
import { renderApp } from '../../test/utils';

beforeEach(() => globalThis.localStorage?.clear());

const TODAY = todayKey(4);

async function dated(api: ApiClient, title: string, offset: number) {
  const t = await api.createTask({ title });
  await api.setTaskDueDay(t.id, addDays(TODAY, offset));
  return t;
}

describe('Coming up radar', () => {
  it('shows a capped soonest-first radar with a this-week overflow, excluding planned-today', async () => {
    const api = createStubClient({ seed: false, storageKey: `cu-${Math.random()}` });
    await dated(api, 'Due soon', 1);
    await dated(api, 'Due later', 3);
    await dated(api, 'Due mid', 5);
    await dated(api, 'Due next week', 6);
    // A dated task planned for today belongs to the tight plane above → must NOT reach the radar.
    // If it weren't excluded it would take a top-3 slot and push "Due mid" (+5) out of the rendered
    // items into the count — so "Due mid" being a rendered item proves the exclusion.
    const planned = await dated(api, 'Planned today dated', 2);
    await api.upsertPlan({ taskId: planned.id, day: TODAY, plannedMinutes: 30, order: 0 });

    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Daytime' }));

    expect(await screen.findByText('Coming up')).toBeTruthy();
    expect(screen.getByText('Due soon')).toBeTruthy();
    expect(screen.getByText('Due later')).toBeTruthy();
    expect(screen.getByText('Due mid')).toBeTruthy(); // in top-3 only because planned-today is excluded
    expect(screen.getByText('+1 more this week')).toBeTruthy(); // 'Due next week' (+6) overflow
  });

  it('shows the empty state when nothing has a due day', async () => {
    const api = createStubClient({ seed: false, storageKey: `cu-empty-${Math.random()}` });
    await api.createTask({ title: 'No deadline here' });
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Daytime' }));

    expect(await screen.findByText('No deadlines on the radar.')).toBeTruthy();
  });
});

describe('Coming up — due times', () => {
  it('shows the time, sorts a timed task before an untimed one that day, and colours a past one', async () => {
    const api = createStubClient({ seed: false, storageKey: `cu-t-${Math.random()}` });
    const tomorrow = addDays(TODAY, 1);
    await api.createTask({ title: 'Untimed tomorrow', dueDay: tomorrow });
    await api.createTask({ title: 'Timed tomorrow', dueDay: tomorrow, dueTime: '23:59' });
    await api.createTask({ title: 'Long gone', dueDay: addDays(TODAY, -2), dueTime: '09:00' });
    const user = userEvent.setup();
    renderApp({ api });
    await user.click(screen.getByRole('button', { name: 'Daytime' }));

    await screen.findByText('Timed tomorrow');
    const titles = ['Long gone', 'Timed tomorrow', 'Untimed tomorrow'].map((t) =>
      screen.getByText(t),
    );
    // Document order = radar order.
    expect(
      titles[1]!.compareDocumentPosition(titles[2]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText(/due tomorrow 11:59pm/)).toBeTruthy();
    const pastRow = titles[0]!.closest('.rounded-lg') as HTMLElement;
    expect(pastRow.className).toMatch(/border-danger!/);
    expect(pastRow.textContent).toMatch(/past due/);
  });
});
