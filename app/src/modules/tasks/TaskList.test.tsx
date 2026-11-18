import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
  const math = await api.upsertCategory({ label: 'MATH 200', isWork: true });
  const phys = await api.upsertCategory({ label: 'PHYS 110', isWork: true });
  return { api, math, phys };
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

  it('Week is flat and soonest-first; adding to today moves the task to the Today lens', async () => {
    const { api, math, phys } = await seeded();
    await api.createTask({ title: 'pset 2', categoryId: math.id, dueDay: addDays(today(), 1) });
    await api.createTask({ title: 'reading', categoryId: phys.id, dueDay: today() });
    await api.createTask({ title: 'someday', dueDay: addDays(today(), 30) }); // backlog, not week
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=week' });

    // No category headers, and the soonest due comes first even though MATH sorts ahead of PHYS.
    const reading = await screen.findByRole('button', { name: 'reading' });
    const pset = screen.getByRole('button', { name: 'pset 2' });
    expect(reading.compareDocumentPosition(pset) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: /MATH 200 · / })).toBeNull();
    expect(screen.queryByRole('button', { name: /PHYS 110 · / })).toBeNull();
    expect(screen.queryByRole('button', { name: 'someday' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Add pset 2 to today' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'pset 2' })).toBeNull());
    expect(await api.listPlansForDay(today())).toHaveLength(1);

    await user.click(pill('Today'));
    expect(await screen.findByRole('button', { name: 'pset 2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unplan' })).toBeTruthy();
  });

  it('Week can still be grouped by category for the session, shown as a chip', async () => {
    const { api, math } = await seeded();
    await api.createTask({ title: 'pset 2', categoryId: math.id, dueDay: addDays(today(), 1) });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=week' });

    await user.click(await screen.findByRole('button', { name: 'Filter' }));
    await user.selectOptions(screen.getByLabelText('Group'), 'category');
    expect(await screen.findByRole('button', { name: /MATH 200 · 1/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter · 1' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Remove filter: By category' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /MATH 200 · / })).toBeNull());
    expect(screen.getByRole('button', { name: 'Filter' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'pset 2' })).toBeTruthy();
  });

  it('typing searches every open task, grouped by where each lives', async () => {
    const { api, math } = await seeded();
    const onToday = await api.createTask({ title: 'pset 1', categoryId: math.id });
    await api.upsertPlan({ taskId: onToday.id, day: today(), plannedMinutes: 30, order: 0 });
    await api.transitionTask(onToday.id, 'planned');
    await api.createTask({ title: 'pset 3', categoryId: math.id });
    await api.createTask({ title: 'groceries' });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=backlog' });

    await user.type(await screen.findByLabelText('Search tasks'), 'math');

    const todayGroup = (await screen.findByText(/^Today · 1$/)).closest('section')!;
    expect(within(todayGroup as HTMLElement).getByRole('button', { name: 'pset 1' })).toBeTruthy();
    expect(screen.getByText(/^Backlog · 1$/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'groceries' })).toBeNull();

    await user.clear(screen.getByLabelText('Search tasks'));
    await user.type(screen.getByLabelText('Search tasks'), 'zzz');
    expect(await screen.findByText('Nothing matches “zzz”.')).toBeTruthy();
  });

  it('search finds a word only in the notes, and the row says "in notes"', async () => {
    const { api } = await seeded();
    await api.createTask({ title: 'pset 4', notes: 'q6: use the lemma from lecture' });
    await api.createTask({ title: 'lemma review' });
    await api.createTask({ title: 'groceries' });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=backlog' });

    await user.type(await screen.findByLabelText('Search tasks'), 'lemma');

    expect(await screen.findByRole('button', { name: 'lemma review' })).toBeTruthy();
    expect(screen.getAllByText('in notes')).toHaveLength(1); // the title match needs no hint
    // The hint sits in pset 4's own title + meta column.
    const column = screen.getByText('in notes').closest('.min-w-0') as HTMLElement;
    expect(within(column).getByRole('button', { name: 'pset 4' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'groceries' })).toBeNull();
  });

  it('a task with notes carries a quiet marker, never a snippet', async () => {
    const { api } = await seeded();
    await api.createTask({ title: 'with notes', notes: 'secret detail here' });
    renderApp({ api, path: '/tasks?lens=backlog' });

    expect(await screen.findByRole('button', { name: 'with notes' })).toBeTruthy();
    expect(screen.getByText('Has notes')).toBeTruthy(); // screen-reader text for the icon
    expect(screen.queryByText(/secret detail/)).toBeNull();
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
    const { api, math } = await seeded();
    await api.createTask({ title: 'pset 3', categoryId: math.id });
    await api.createTask({ title: 'groceries' });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=backlog' });

    await user.click(await screen.findByRole('button', { name: 'Filter' }));
    const cats = within(screen.getByRole('group', { name: 'Category' }));
    await user.click(cats.getByRole('button', { name: 'MATH 200' }));
    expect(screen.getByRole('button', { name: 'Filter · 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove filter: MATH 200' })).toBeTruthy();
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

  it('Today: a finished task on the plan moves to a collapsed Done today group that remembers', async () => {
    const { api } = await seeded();
    const open = await api.createTask({ title: 'still to do' });
    await api.upsertPlan({ taskId: open.id, day: today(), plannedMinutes: 30, order: 0 });
    await api.transitionTask(open.id, 'planned');
    const fin = await api.createTask({ title: 'finished one', estimateMin: 45 });
    await api.upsertPlan({ taskId: fin.id, day: today(), plannedMinutes: 45, order: 1 });
    await api.transitionTask(fin.id, 'in_progress');
    await api.setTaskActual(fin.id, 45);
    await api.transitionTask(fin.id, 'done');
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });

    const header = await screen.findByRole('button', { name: 'Done today · 1' });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'finished one' })).toBeNull();
    // Its planned minutes still count: the plan you set is what the capacity check measures.
    expect(screen.getByText(/1h 15m planned/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Unplan' })).toHaveLength(1);

    await user.click(header);
    const group = screen.getByRole('region', { name: 'Done today' });
    expect(within(group).getByRole('button', { name: 'finished one' })).toBeTruthy();
    expect(within(group).queryByRole('button', { name: /Unplan|Start/ })).toBeNull();

    cleanup();
    renderApp({ api, path: '/tasks' });
    expect(
      (await screen.findByRole('button', { name: 'Done today · 1' })).getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('Today: once everything planned is done, it says so instead of "Nothing planned yet."', async () => {
    const { api } = await seeded();
    const t = await api.createTask({ title: 'only one', estimateMin: 30 });
    await api.upsertPlan({ taskId: t.id, day: today(), plannedMinutes: 30, order: 0 });
    await api.transitionTask(t.id, 'in_progress');
    await api.setTaskActual(t.id, 30);
    await api.transitionTask(t.id, 'done');
    renderApp({ api, path: '/tasks' });

    expect(await screen.findByText('Everything planned is done.')).toBeTruthy();
    expect(screen.queryByText('Nothing planned yet.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Done today · 1' })).toBeTruthy();
  });

  it('Today: a task finished off the plan lands in Done today; a dropped one shows nowhere', async () => {
    const { api } = await seeded();
    const off = await api.createTask({ title: 'started off plan', estimateMin: 30 });
    await api.transitionTask(off.id, 'in_progress');
    await api.setTaskActual(off.id, 30);
    await api.transitionTask(off.id, 'done');
    const dropped = await api.createTask({ title: 'dropped one' });
    await api.upsertPlan({ taskId: dropped.id, day: today(), plannedMinutes: 30, order: 0 });
    await api.transitionTask(dropped.id, 'planned');
    await api.transitionTask(dropped.id, 'cancelled');
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });

    await user.click(await screen.findByRole('button', { name: 'Done today · 1' }));
    expect(screen.getByRole('button', { name: 'started off plan' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'dropped one' })).toBeNull();
    expect(screen.getByText('Nothing planned yet.')).toBeTruthy();
    // Its row stays as history, but a dropped task is out of the day's load.
    expect(screen.getByText(/^0m planned/)).toBeTruthy();
  });

  it('Done: a finished task with a row today offers no Unplan', async () => {
    const { api } = await seeded();
    const t = await api.createTask({ title: 'done on plan', estimateMin: 30 });
    await api.upsertPlan({ taskId: t.id, day: today(), plannedMinutes: 30, order: 0 });
    await api.transitionTask(t.id, 'in_progress');
    await api.setTaskActual(t.id, 30);
    await api.transitionTask(t.id, 'done');
    renderApp({ api, path: '/tasks?lens=done' });

    expect(await screen.findByRole('button', { name: 'done on plan' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Unplan' })).toBeNull();
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

describe('Backlog folds the Aperture area away (D14)', () => {
  async function withAreas() {
    const { api, math } = await seeded();
    const ap = await api.upsertCategory({ label: 'Aperture', isWork: true, area: 'aperture' });
    await api.createTask({ title: 'fix cache policy', categoryId: ap.id });
    await api.createTask({ title: 'retune palette', categoryId: ap.id });
    await api.createTask({ title: 'pset 4', categoryId: math.id });
    await api.createTask({ title: 'no category task' });
    return { api, ap, math };
  }

  it('hides Aperture-area tasks behind "Aperture · N"; the chip shows them, and again hides them', async () => {
    const { api } = await withAreas();
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=backlog' });

    expect(await screen.findByRole('button', { name: 'pset 4' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'no category task' })).toBeTruthy(); // Personal
    expect(screen.queryByRole('button', { name: 'fix cache policy' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Aperture · 2$/ })).toBeNull(); // no group yet
    const chip = screen.getByRole('button', { name: 'Aperture area · 2' });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Filter' })).toBeTruthy(); // the fold is no filter
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();

    await user.click(chip);
    expect(await screen.findByRole('button', { name: 'fix cache policy' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Aperture · 2$/ })).toBeTruthy(); // the group header
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Filter' })).toBeTruthy(); // still no filter count

    await user.click(chip);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'fix cache policy' })).toBeNull(),
    );
  });

  it('a search finds an Aperture task while it is folded away', async () => {
    const { api } = await withAreas();
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=backlog' });
    await user.type(await screen.findByLabelText('Search tasks'), 'palette');
    expect(await screen.findByRole('button', { name: 'retune palette' })).toBeTruthy();
  });

  it('an Aperture task due this week sits in Week; a retired Aperture category still folds', async () => {
    const { api, ap } = await withAreas();
    await api.createTask({ title: 'ship it', categoryId: ap.id, dueDay: addDays(today(), 2) });
    await api.upsertCategory({ id: ap.id, label: 'Aperture', isWork: true, active: false });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=week' });
    expect(await screen.findByRole('button', { name: 'ship it' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Aperture area · / })).toBeNull(); // no chip off Backlog

    await user.click(pill('Backlog'));
    expect(await screen.findByRole('button', { name: 'pset 4' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'fix cache policy' })).toBeNull();
    expect((await api.listCategories()).find((c) => c.id === ap.id)?.area).toBe('aperture');
  });

  it('with only Aperture work waiting, Backlog reads clear but the chip still offers it', async () => {
    const api = createStubClient({ seed: false, storageKey: `tasklist-${Math.random()}` });
    const ap = await api.upsertCategory({ label: 'Aperture', isWork: true, area: 'aperture' });
    await api.createTask({ title: 'fix cache policy', categoryId: ap.id });
    renderApp({ api, path: '/tasks?lens=backlog' });
    expect(await screen.findByText('Backlog is clear.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Aperture area · 1' })).toBeTruthy();
  });
});

describe('Today: a time decides the day (option 3)', () => {
  it('a timed task due today is under "By time", with no Unplan, and counts toward the day', async () => {
    const api = createStubClient({ seed: false, storageKey: `tasklist-bytime-${Math.random()}` });
    await api.createTask({ title: 'OA', dueDay: todayKey(4), dueTime: '23:58', estimateMin: 45 });
    const p = await api.createTask({ title: 'essay', estimateMin: 30 });
    await api.upsertPlan({ taskId: p.id, day: todayKey(4), plannedMinutes: 30, order: 0 });
    await api.transitionTask(p.id, 'planned');
    renderApp({ api, path: '/tasks' });

    expect(await screen.findByText('By time')).toBeTruthy();
    expect(screen.getAllByText('Planned today')).toHaveLength(1);
    const oa = (await screen.findByRole('button', { name: 'OA' })).closest(
      '.rounded-2xl',
    ) as HTMLElement;
    expect(within(oa).queryByRole('button', { name: 'Unplan' })).toBeNull();
    expect(screen.getByText(/1h 15m planned/)).toBeTruthy(); // 45 + 30
    const titles = screen
      .getAllByRole('button', { name: /^(OA|essay)$/ })
      .map((b) => b.textContent);
    expect(titles).toEqual(['OA', 'essay']); // by time first
  });

  it('a started timed task due today sits under "By time", not in the off-plan tier', async () => {
    const api = createStubClient({ seed: false, storageKey: `tasklist-bytime-${Math.random()}` });
    const t = await api.createTask({ title: 'OA', dueDay: todayKey(4), dueTime: '23:58' });
    await api.transitionTask(t.id, 'in_progress');
    renderApp({ api, path: '/tasks' });
    expect(await screen.findByText('By time')).toBeTruthy();
    expect(screen.queryByText(/not planned today/)).toBeNull();
  });

  it('a timed task on Week has no “+ Today” — its day is its time', async () => {
    const api = createStubClient({ seed: false, storageKey: `tasklist-bytime-${Math.random()}` });
    await api.createTask({ title: 'later', dueDay: addDays(todayKey(4), 2), dueTime: '10:00' });
    await api.createTask({ title: 'untimed', dueDay: addDays(todayKey(4), 2) });
    renderApp({ api, path: '/tasks?lens=week' });
    expect(await screen.findByRole('button', { name: 'Add untimed to today' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add later to today' })).toBeNull();
  });
});

// recurring.md D8: a series occurrence due after its work day is planned like an untimed task.
async function deadlineOccurrence(title: string) {
  const api = createStubClient({ seed: false, storageKey: `tasklist-occ-${Math.random()}` });
  await api.upsertSeries({
    title,
    categoryId: null,
    defaultEstimateMin: 45,
    rule: { kind: 'daily' },
    anchorDate: todayKey(4),
    dueOffsetDays: 1,
    dueTime: '14:00',
  });
  await api.getDay(todayKey(4));
  const [row] = await api.listPlansForDay(todayKey(4));
  return { api, row: row! };
}

describe('a series deadline occurrence (recurring D8)', () => {
  it('sits in the plan with Unplan on its work day, not under By time', async () => {
    const { api } = await deadlineOccurrence('Pre-lab');
    renderApp({ api, path: '/tasks' });
    const card = (await screen.findByRole('button', { name: 'Pre-lab' })).closest(
      '.rounded-2xl',
    ) as HTMLElement;
    expect(within(card).getByRole('button', { name: 'Unplan' })).toBeTruthy();
    expect(within(card).getByText(/due tomorrow 2pm/)).toBeTruthy();
    expect(screen.queryByText('By time')).toBeNull();
  });

  it('unplanned, it offers “+ Today” on Week — unlike a plain timed task', async () => {
    const { api, row } = await deadlineOccurrence('Pre-lab');
    await api.removePlan(row.id);
    await api.getDay(todayKey(4));
    renderApp({ api, path: '/tasks?lens=week' });
    expect(await screen.findByRole('button', { name: 'Add Pre-lab to today' })).toBeTruthy();
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
    // The list wrapper (the one focusable non-control around the rows) takes it.
    await waitFor(() => expect(document.activeElement?.getAttribute('tabindex')).toBe('-1'));
  });

  it('marking a Today row done moves it into the collapsed group, and focus never drops to <body>', async () => {
    const api = createStubClient({ seed: false, storageKey: `tasklist-focus-${Math.random()}` });
    const t = await api.createTask({ title: 'finish me', estimateMin: 20 });
    await api.upsertPlan({ taskId: t.id, day: todayKey(4), plannedMinutes: 20, order: 0 });
    await api.transitionTask(t.id, 'in_progress');
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });

    const row = (await screen.findByRole('button', { name: 'finish me' })).closest('.rounded-2xl');
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Done' }));
    await user.type(await screen.findByLabelText('Actual (min)'), '18');
    await user.click(screen.getByRole('button', { name: 'Mark done' }));

    expect(await screen.findByRole('button', { name: 'Done today · 1' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'finish me' })).toBeNull());
    // The collapsed group hides the row's title, so the list area takes focus.
    await waitFor(() => expect(document.activeElement?.getAttribute('tabindex')).toBe('-1'));
  });

  it('a row marked done moves at once — from the write, not a refetch of the list', async () => {
    const api = createStubClient({ seed: false, storageKey: `tasklist-write-${Math.random()}` });
    const t = await api.createTask({ title: 'finish me', estimateMin: 20 });
    await api.upsertPlan({ taskId: t.id, day: todayKey(4), plannedMinutes: 20, order: 0 });
    await api.transitionTask(t.id, 'in_progress');
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });

    const row = (await screen.findByRole('button', { name: 'finish me' })).closest('.rounded-2xl');
    vi.spyOn(api, 'listTasks').mockImplementation(() => new Promise(() => {})); // never answers
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Done' }));
    await user.type(await screen.findByLabelText('Actual (min)'), '18');
    await user.click(screen.getByRole('button', { name: 'Mark done' }));
    expect(await screen.findByRole('button', { name: 'Done today · 1' })).toBeTruthy();
  });

  it('after a plain close, the next tap ends the watch: a later lens switch never pulls focus back', async () => {
    const api = createStubClient({ seed: false, storageKey: `tasklist-focus-${Math.random()}` });
    const t = await api.createTask({ title: 'just looking' });
    await api.upsertPlan({ taskId: t.id, day: todayKey(4), plannedMinutes: 20, order: 0 });
    await api.transitionTask(t.id, 'planned');
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks' });

    await user.click(await screen.findByRole('button', { name: 'just looking' }));
    await user.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'just looking' })),
    );

    // A Safari tap: pointerdown, no focus move (focus falls to <body>), then the click.
    const week = pill('Week');
    fireEvent.pointerDown(week);
    (document.activeElement as HTMLElement).blur();
    fireEvent.click(week);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'just looking' })).toBeNull());
    expect(document.activeElement).toBe(document.body);
  });
});

describe('filter panel', () => {
  it('Escape closes it even after clicking plain panel text, and focus returns to Filter', async () => {
    const api = createStubClient({ seed: false, storageKey: `tasklist-esc-${Math.random()}` });
    await api.createTask({ title: 'groceries' });
    const user = userEvent.setup();
    renderApp({ api, path: '/tasks?lens=backlog' });

    await user.click(await screen.findByRole('button', { name: 'Filter' }));
    // The row's label text — not a control, so focus falls to <body>.
    await user.click(within(screen.getByRole('group', { name: 'Category' })).getByText('Category'));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('group', { name: 'Category' })).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Filter' })),
    );
  });
});
