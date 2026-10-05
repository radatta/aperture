import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { focusManager } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { todayKey } from '@aperture/shared';
import { renderWithProviders } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';
import { CaptureBar } from './CaptureBar';

beforeEach(() => globalThis.localStorage?.clear());

// A fresh stub with one category, in Task mode — the setup every token test starts from.
async function taskBar(opts: { hangCategories?: boolean; categories?: string[] } = {}) {
  const api = createStubClient({ seed: false, storageKey: `cap-tok-${Math.random()}` });
  for (const label of opts.categories ?? ['Admin'])
    await api.upsertCategory({ label, isWork: true });
  if (opts.hangCategories) vi.spyOn(api, 'listCategories').mockReturnValue(new Promise(() => {}));
  const user = userEvent.setup();
  renderWithProviders(<CaptureBar />, { api });
  await user.click(screen.getByRole('button', { name: 'Task' }));
  const box = () => screen.getByLabelText('Capture task') as HTMLTextAreaElement;
  return { api, user, box };
}

function field() {
  return screen.getByLabelText('Capture log') as HTMLTextAreaElement;
}

describe('CaptureBar', () => {
  it('logs an entry on Enter, then clears and stays in Log mode', async () => {
    const api = createStubClient({ seed: false, storageKey: 'cap-test' });
    const user = userEvent.setup();
    renderWithProviders(<CaptureBar />, { api });

    await user.type(field(), 'shipped the thing');
    await user.keyboard('{Enter}');

    await waitFor(async () => {
      const entries = await api.listLogEntries(todayKey(4));
      expect(entries.map((e) => e.text)).toContain('shipped the thing');
    });
    expect(field().value).toBe('');
    // still Log mode — it was Log to begin with and a submit keeps the current mode
    expect(screen.getByLabelText('Capture log')).toBeTruthy();
  });

  // The whole point of the rebuild: a long thought has to stay readable while you write it, which
  // means the control must wrap rather than scroll a single line sideways.
  it('captures into a wrapping textarea, not a single-line input', async () => {
    const api = createStubClient({ seed: false, storageKey: 'cap-textarea' });
    renderWithProviders(<CaptureBar />, { api });
    expect(field().tagName).toBe('TEXTAREA');
  });

  it('keeps Shift+Enter as a newline instead of submitting', async () => {
    const api = createStubClient({ seed: false, storageKey: 'cap-multiline' });
    const user = userEvent.setup();
    renderWithProviders(<CaptureBar />, { api });

    await user.type(field(), 'first line');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.type(field(), 'second line');

    expect(field().value).toBe('first line\nsecond line');
    expect(await api.listLogEntries(todayKey(4))).toHaveLength(0);
  });

  it('confirms where the capture went, so a submit is never silent', async () => {
    const api = createStubClient({ seed: false, storageKey: 'cap-receipt' });
    const user = userEvent.setup();
    renderWithProviders(<CaptureBar />, { api });

    await user.type(field(), 'a thought');
    await user.keyboard('{Enter}');

    expect(await screen.findByText(/Logged/)).toBeTruthy();
  });

  it('routes a Task capture to the backlog and says so', async () => {
    const api = createStubClient({ seed: false, storageKey: 'cap-task' });
    const user = userEvent.setup();
    renderWithProviders(<CaptureBar />, { api });

    await user.click(screen.getByRole('button', { name: 'Task' }));
    await user.type(screen.getByLabelText('Capture task'), 'fix the flaky test');
    await user.keyboard('{Enter}');

    await waitFor(async () => {
      const tasks = await api.listTasks();
      expect(tasks.map((t) => t.title)).toContain('fix the flaky test');
    });
    expect(await screen.findByText(/Task added/)).toBeTruthy();
    // Stays in Task mode after submit — logging several tasks in a row shouldn't mean re-picking it.
    expect(screen.getByLabelText('Capture task')).toBeTruthy();
  });

  it('"→ today" plans the next task only, then resets', async () => {
    const api = createStubClient({ seed: false, storageKey: `cap-today-${Math.random()}` });
    const user = userEvent.setup();
    renderWithProviders(<CaptureBar />, { api });

    await user.click(screen.getByRole('button', { name: 'Task' }));
    const pill = screen.getByRole('button', { name: 'today' });
    await user.click(pill);
    expect(pill.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByPlaceholderText('New task for today…')).toBeTruthy();

    await user.type(screen.getByLabelText('Capture task'), 'buy stamps');
    await user.keyboard('{Enter}');

    expect(await screen.findByText(/Task added → today/)).toBeTruthy();
    const [row] = await api.listPlansForDay(todayKey(4));
    expect((await api.getTask(row!.taskId))?.title).toBe('buy stamps');
    expect(pill.getAttribute('aria-pressed')).toBe('false'); // one-shot

    await user.type(screen.getByLabelText('Capture task'), 'next one');
    await user.keyboard('{Enter}');
    await waitFor(async () =>
      expect((await api.listTasks()).map((t) => t.title)).toContain('next one'),
    );
    expect(await api.listPlansForDay(todayKey(4))).toHaveLength(1); // not planned
  });

  it('says so when a "→ today" task was created but could not be planned', async () => {
    const api = createStubClient({ seed: false, storageKey: `cap-today-fail-${Math.random()}` });
    api.upsertPlan = () => Promise.reject(new Error('offline'));
    const user = userEvent.setup();
    renderWithProviders(<CaptureBar />, { api });

    await user.click(screen.getByRole('button', { name: 'Task' }));
    await user.click(screen.getByRole('button', { name: 'today' }));
    await user.type(screen.getByLabelText('Capture task'), 'call bank');
    await user.keyboard('{Enter}');

    expect(await screen.findByText(/backlog \(couldn’t plan it\)/)).toBeTruthy();
    expect((await api.listTasks()).map((t) => t.title)).toContain('call bank');
  });

  // Capture's whole premise is that it's safe to hand it a thought. The field clears optimistically,
  // so without an onError the write rolls back, the entry disappears, the box is already empty, and
  // nothing says so — the thought is just gone.
  it('puts the text back and says so when the write fails', async () => {
    const api = createStubClient({ seed: false, storageKey: 'cap-fail' });
    api.createLogEntry = () => Promise.reject(new Error('offline'));
    const user = userEvent.setup();
    renderWithProviders(<CaptureBar />, { api });

    await user.type(field(), 'a thought I do not want to lose');
    await user.keyboard('{Enter}');

    expect(await screen.findByText(/Couldn't save/)).toBeTruthy();
    await waitFor(() => expect(field().value).toBe('a thought I do not want to lose'));
  });

  it('commits from the Send button, for phones with no Enter key on the keyboard', async () => {
    const api = createStubClient({ seed: false, storageKey: 'cap-send' });
    const user = userEvent.setup();
    renderWithProviders(<CaptureBar />, { api });

    await user.type(field(), 'tapped, not typed');
    await user.click(screen.getByLabelText('Save log'));

    await waitFor(async () => {
      const entries = await api.listLogEntries(todayKey(4));
      expect(entries.map((e) => e.text)).toContain('tapped, not typed');
    });
  });

  describe('Task tokens', () => {
    it('parses optional tokens after " | " into the created task', async () => {
      const { api, user, box } = await taskBar();
      await waitFor(async () => expect(await api.listCategories()).toHaveLength(1));
      await user.type(box(), 'draft memo | ~30 #admin due:2026-10-03 notes:"x"');
      expect(await screen.findByText('#admin')).toBeTruthy();
      await user.keyboard('{Enter}');

      await waitFor(async () => {
        const [t] = await api.listTasks();
        expect(t).toMatchObject({ title: 'draft memo', estimateMin: 30, dueDay: '2026-10-03' });
        expect(t?.categoryId).toEqual(expect.any(String));
        expect(t?.notes).toBe('x');
      });
      expect(box().value).toBe('');
      expect(await screen.findByText(/Task added/)).toBeTruthy();
    });

    it('without " | " a title is literal and nothing is previewed', async () => {
      const { api, user, box } = await taskBar();
      await user.type(box(), 'fix issue #42 ~5');
      expect(box().getAttribute('aria-describedby')).toBeNull();
      await user.keyboard('{Enter}');
      await user.type(box(), 'a|b');
      await user.keyboard('{Enter}');

      await waitFor(async () => {
        const titles = (await api.listTasks()).map((t) => t.title).sort();
        expect(titles).toEqual(['a|b', 'fix issue #42 ~5']);
      });
      expect((await api.listTasks()).every((t) => t.estimateMin === null)).toBe(true);
    });

    it('a red error refuses Enter and Send, keeps the text, and says so', async () => {
      const { api, user, box } = await taskBar();
      await user.type(box(), 'x | ~30m');
      expect(await screen.findByText(/invalid estimate/)).toBeTruthy();
      expect(box().getAttribute('aria-invalid')).toBe('true');

      await user.keyboard('{Enter}');
      expect(await screen.findByText(/Not saved/)).toBeTruthy();
      await user.click(screen.getByLabelText('Save task'));
      expect(box().value).toBe('x | ~30m');
      expect(await api.listTasks()).toHaveLength(0);
    });

    it('an unknown label warns before submit, then saves uncategorised', async () => {
      const { api, user, box } = await taskBar();
      await waitFor(async () => expect(await api.listCategories()).toHaveLength(1));
      await user.type(box(), 'x | #Nope');
      expect(await screen.findByText(/no category 'Nope'/)).toBeTruthy();
      await user.keyboard('{Enter}');

      await waitFor(async () => {
        const [t] = await api.listTasks();
        expect(t).toMatchObject({ title: 'x', categoryId: null });
      });
    });

    it('"→ today" with an estimate plans that many minutes', async () => {
      const { api, user, box } = await taskBar();
      await user.click(screen.getByRole('button', { name: 'today' }));
      await user.type(box(), 'buy stamps | ~20');
      await user.keyboard('{Enter}');

      await waitFor(async () => {
        const [plan] = await api.listPlansForDay(todayKey(4));
        expect(plan?.plannedMinutes).toBe(20);
      });
      expect(screen.getByRole('button', { name: 'today' }).getAttribute('aria-pressed')).toBe(
        'false',
      );
    });

    it('waits for categories before a #label line can save', async () => {
      const { api, user, box } = await taskBar({ hangCategories: true });
      await user.type(box(), 'x | #Admin');
      expect(await screen.findByText('Loading categories…')).toBeTruthy();
      await user.keyboard('{Enter}');
      expect(await screen.findByText(/Not saved/)).toBeTruthy();
      expect(box().value).toBe('x | #Admin');
      expect(await api.listTasks()).toHaveLength(0);

      // A line without a label doesn't need them.
      await user.clear(box());
      await user.type(box(), 'y | ~5');
      await user.keyboard('{Enter}');
      await waitFor(async () => expect((await api.listTasks()).map((t) => t.title)).toEqual(['y']));
    });

    it('tokens across a line break are refused, not split', async () => {
      const { api, user, box } = await taskBar();
      await user.type(box(), 'a');
      await user.keyboard('{Shift>}{Enter}{/Shift}');
      await user.type(box(), 'b | ~5');
      expect(await screen.findByText(/single line/)).toBeTruthy();
      await user.keyboard('{Enter}');
      expect(await screen.findByText(/Not saved/)).toBeTruthy();
      expect(await api.listTasks()).toHaveLength(0);
    });

    it('a failed write puts the tokenised text back', async () => {
      const { api, user, box } = await taskBar();
      api.createTask = () => Promise.reject(new Error('offline'));
      await user.type(box(), 'memo | ~30');
      await user.keyboard('{Enter}');

      expect(await screen.findByText(/Couldn't save/)).toBeTruthy();
      await waitFor(() => expect(box().value).toBe('memo | ~30'));
    });

    it('a refusal announces its reason and clears once the cause is gone', async () => {
      const { user, box } = await taskBar();
      await user.type(box(), 'x | ~30m');
      await user.keyboard('{Enter}');
      const status = await screen.findByRole('status');
      await waitFor(() => expect(status.textContent).toMatch(/Not saved.*invalid estimate/));

      await user.click(screen.getByRole('button', { name: 'Log' }));
      await waitFor(() => expect(status.textContent).not.toMatch(/Not saved/));
    });

    it('a failed category refetch keeps the loaded list usable', async () => {
      const { api, user, box } = await taskBar();
      await user.type(box(), 'memo | #Admin');
      expect(await screen.findByText('#Admin')).toBeTruthy(); // loaded + matched (teal chip)
      // A focus-driven refetch fails: status goes to error, the cached list stays.
      const spy = vi.spyOn(api, 'listCategories').mockRejectedValue(new Error('offline'));
      try {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
        await waitFor(() => expect(spy).toHaveBeenCalled());
        await expect(spy.mock.results[0]!.value).rejects.toThrow();
        await new Promise((r) => setTimeout(r, 0)); // let the query settle into its error state
      } finally {
        focusManager.setFocused(undefined);
      }
      await user.keyboard('{Enter}');
      await waitFor(async () => {
        const [t] = await api.listTasks();
        expect(t?.categoryId).toEqual(expect.any(String));
      });
    });
  });

  describe('Token suggestions', () => {
    const chips = () => screen.queryByRole('group', { name: 'Suggestions' });
    const chip = (label: string) =>
      within(screen.getByRole('group', { name: 'Suggestions' })).getByText(label, {
        selector: 'button',
      });

    it('a tapped category chip completes the token and keeps focus', async () => {
      const { user, box } = await taskBar();
      await user.type(box(), 'memo | #ad');
      await user.click(await waitFor(() => chip('Admin')));
      expect(box().value).toBe('memo | #Admin ');
      expect(document.activeElement).toBe(box());
      expect(box().selectionStart).toBe(box().value.length);
    });

    it('matches a later word and quotes a multi-word label', async () => {
      const { user, box } = await taskBar({ categories: ['Admin', 'Deep Work'] });
      await user.type(box(), 'memo | #work');
      await user.click(await waitFor(() => chip('Deep Work')));
      expect(box().value).toBe('memo | #"Deep Work" ');
      expect(await screen.findByText('#Deep Work')).toBeTruthy();
    });

    it('due chips insert the concrete date', async () => {
      vi.setSystemTime(new Date(2026, 8, 30, 12)); // a Wednesday; reset by setup's useRealTimers
      const { user, box } = await taskBar();
      await user.type(box(), 'memo | due:');
      const names = within(chips()!)
        .getAllByRole('button')
        .map((b) => b.textContent);
      expect(names).toEqual(['Today', 'Tomorrow', 'Fri', 'Mon', 'Tue', 'Oct 7']);
      await user.click(chip('Fri'));
      expect(box().value).toBe('memo | due:2026-10-02 ');
      expect(await screen.findByText('10/2/2026')).toBeTruthy();
    });

    it('Tab accepts while chips show, and switches mode when they do not', async () => {
      const { user, box } = await taskBar();
      await user.type(box(), 'memo | ~');
      await user.keyboard('{Tab}');
      expect(box().value).toBe('memo | ~15 ');
      await user.keyboard('{Tab}');
      expect(screen.getByLabelText('Capture idea')).toBeTruthy();
    });

    it('Shift+Tab switches mode even with chips showing', async () => {
      const { user, box } = await taskBar();
      await user.type(box(), 'memo | ~');
      await user.keyboard('{Shift>}{Tab}{/Shift}');
      expect((screen.getByLabelText('Capture log') as HTMLTextAreaElement).value).toBe('memo | ~');
    });

    it('offers nothing outside a token after " | "', async () => {
      const { user, box } = await taskBar();
      await user.type(box(), '#ad memo');
      expect(chips()).toBeNull();
      await user.clear(box());
      await user.type(box(), 'memo | notes:"#ad');
      expect(chips()).toBeNull();
      await user.clear(box());
      await user.click(screen.getByRole('button', { name: 'Log' }));
      await user.type(screen.getByLabelText('Capture log'), 'memo | #ad');
      expect(chips()).toBeNull();
    });

    it('completes a token in the middle of the line', async () => {
      const { user, box } = await taskBar();
      await user.type(box(), 'memo | #ad ~3');
      await user.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}');
      await user.click(await waitFor(() => chip('Admin')));
      expect(box().value).toBe('memo | #Admin ~3');
      expect(box().selectionStart).toBe(14);
    });

    it('accepting an already-complete token still places the caret', async () => {
      const { user, box } = await taskBar();
      await user.type(box(), 'memo | #Admin ~3');
      await user.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}'); // caret at the end of #Admin
      await user.keyboard('{Tab}');
      expect(box().value).toBe('memo | #Admin ~3');
      expect(box().selectionStart).toBe(14);
      await user.keyboard('0');
      expect(box().value).toBe('memo | #Admin 0~3'); // typing lands at the placed caret, no jump
    });

    it('chips carry a standalone accessible name', async () => {
      vi.setSystemTime(new Date(2026, 8, 30, 12));
      const { user, box } = await taskBar();
      await user.type(box(), 'memo | due:2026-10-0');
      expect(screen.getByRole('button', { name: 'Due Friday, Oct 2' })).toBeTruthy();
    });

    it('a whole day offers time chips that type the @HH:MM form', async () => {
      vi.setSystemTime(new Date(2026, 8, 30, 12));
      const { api, user, box } = await taskBar();
      await user.type(box(), 'memo | due:2026-10-02');
      const names = within(chips()!)
        .getAllByRole('button')
        .map((b) => b.textContent);
      expect(names).toEqual(['9am', '12pm', '5pm', '11:59pm']);
      await user.click(screen.getByRole('button', { name: 'Due Friday, Oct 2 at 5pm' }));
      expect(box().value).toBe('memo | due:2026-10-02@17:00 ');
      await user.keyboard('{Enter}');
      await waitFor(async () => {
        const t = (await api.listTasks()).find((x) => x.title === 'memo');
        expect(t).toMatchObject({ dueDay: '2026-10-02', dueTime: '17:00' });
      });
    });

    it('Escape still blurs the field', async () => {
      const { user, box } = await taskBar();
      await user.type(box(), 'memo | #ad');
      await user.keyboard('{Escape}');
      expect(document.activeElement).not.toBe(box());
    });
  });
});
