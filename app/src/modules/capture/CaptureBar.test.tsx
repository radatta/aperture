import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { focusManager } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { addDays, todayKey, type ParseTaskResult } from '@aperture/shared';
import { renderWithProviders } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';
import { STUB_FAIL_NEXT_PARSE_KEY } from '../../data/stubParse';
import { CAPTURE_OUTBOX_KEY, CAPTURE_PARKED_KEY, OUTBOX_STALE_MS } from './captureOutbox';
import { PomodoroProvider } from '../pomodoro/PomodoroProvider';
import { IdleFocus } from '../pomodoro/TimerBar';
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

  // userEvent can't compose, so these fire the keydown an IME produces. A composing Enter must fall
  // through untouched (the IME commits on it); the proof that nothing saved is that one real Enter
  // afterwards leaves exactly one entry.
  describe('IME composition', () => {
    async function composed(storageKey: string) {
      const api = createStubClient({ seed: false, storageKey });
      const user = userEvent.setup();
      renderWithProviders(<CaptureBar />, { api });
      await user.type(field(), 'にほんご');
      fireEvent.compositionStart(field());
      return { api, user };
    }

    it('Enter mid-IME composition never submits', async () => {
      const { api, user } = await composed('cap-ime-enter');
      fireEvent.keyDown(field(), { key: 'Enter', isComposing: true });
      expect(field().value).toBe('にほんご');
      fireEvent.compositionEnd(field());
      await user.keyboard('{Enter}');
      await waitFor(async () => expect(await api.listLogEntries(todayKey(4))).toHaveLength(1));
      expect(field().value).toBe('');
    });

    it('a committing Enter with keyCode 229 never submits', async () => {
      const { api, user } = await composed('cap-ime-229');
      // WebKit: keydown after compositionend, isComposing already false, keyCode still 229.
      fireEvent.compositionEnd(field());
      fireEvent.keyDown(field(), { key: 'Enter', keyCode: 229 });
      expect(field().value).toBe('にほんご');
      await user.keyboard('{Enter}');
      await waitFor(async () => expect(await api.listLogEntries(todayKey(4))).toHaveLength(1));
    });

    it('⌘Enter mid-composition never reviews or saves', async () => {
      const { api, user, box } = await taskBar();
      const parse = vi.spyOn(api, 'parseTask');
      await user.type(box(), 'にほんご');
      fireEvent.compositionStart(box());
      fireEvent.keyDown(box(), { key: 'Enter', metaKey: true, isComposing: true });
      expect(box().value).toBe('にほんご');
      expect(parse).not.toHaveBeenCalled();
      expect(screen.queryByText('Reading it…')).toBeNull();
      fireEvent.compositionEnd(box());
      await user.keyboard('{Enter}');
      await waitFor(async () => expect(await api.listTasks()).toHaveLength(1));
      expect(parse).toHaveBeenCalledTimes(1);
    });

    it('Enter after compositionend saves as usual', async () => {
      const { api, user } = await composed('cap-ime-after');
      fireEvent.compositionEnd(field());
      await user.keyboard('{Enter}');
      await waitFor(async () => {
        const entries = await api.listLogEntries(todayKey(4));
        expect(entries.map((e) => e.text)).toEqual(['にほんご']);
      });
    });
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

    it('an empty token region waits while the caret sits after " | ", and refuses a save visibly', async () => {
      const { api, user, box } = await taskBar();
      await user.type(box(), 'milk | ');
      // About to type a token: no red mid-thought.
      expect(screen.queryByText(/nothing after/)).toBeNull();
      await user.keyboard('{Enter}');
      expect(await screen.findByText(/Not saved/)).toBeTruthy();
      // The preview row's red line shows again, not only the refusal's reason.
      const said = screen.getAllByText(/nothing after ' \| '/);
      expect(said.some((el) => el.className.includes('text-danger'))).toBe(true);
      expect(box().value).toBe('milk | ');
      expect(await api.listTasks()).toHaveLength(0);
      // Red is never a once-only refusal: Enter and Save again still refuse.
      await user.keyboard('{Enter}');
      await user.click(screen.getByLabelText('Save task'));
      expect(screen.getByText(/Not saved/)).toBeTruthy();
      expect(screen.queryByText(/Enter or Save again/)).toBeNull();
      expect(box().value).toBe('milk | ');
      expect(await api.listTasks()).toHaveLength(0);
    });

    it('an empty token region shows its error once the caret leaves it, or the field', async () => {
      const { user, box } = await taskBar();
      await user.type(box(), 'milk | ');
      expect(screen.queryByText(/nothing after/)).toBeNull();
      await user.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}');
      expect(await screen.findByText(/nothing after ' \| '/)).toBeTruthy();
      await user.keyboard('{End}');
      await waitFor(() => expect(screen.queryByText(/nothing after/)).toBeNull());
      act(() => box().blur());
      expect(await screen.findByText(/nothing after ' \| '/)).toBeTruthy();
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

    it('an unknown label warns once the caret leaves it, then saves uncategorised', async () => {
      const { api, user, box } = await taskBar();
      await waitFor(async () => expect(await api.listCategories()).toHaveLength(1));
      await user.type(box(), 'x | #Nope');
      // Still being typed: the next letter might make it a match, so no gold warning yet.
      expect(screen.queryByText(/no category/)).toBeNull();
      await user.type(box(), ' ');
      expect(await screen.findByText(/no category 'Nope'/)).toBeTruthy();
      await user.keyboard('{Enter}');

      await waitFor(async () => {
        const [t] = await api.listTasks();
        expect(t).toMatchObject({ title: 'x', categoryId: null });
      });
    });

    it('Enter with an unknown #label still at the caret refuses once and shows why, then saves', async () => {
      const { api, user, box } = await taskBar();
      await waitFor(async () => expect(await api.listCategories()).toHaveLength(1));
      await user.type(box(), 'x | #zz');
      expect(screen.queryByText(/no category/)).toBeNull();
      await user.keyboard('{Enter}');
      expect(await screen.findByText(/Not saved/)).toBeTruthy();
      expect(screen.getByText("no category 'zz' — created without one")).toBeTruthy();
      expect(box().value).toBe('x | #zz');
      expect(await api.listTasks()).toHaveLength(0);

      await user.click(screen.getByLabelText('Save task'));
      await waitFor(async () =>
        expect((await api.listTasks())[0]).toMatchObject({ title: 'x', categoryId: null }),
      );
    });

    it('Enter on a half-typed #label with one match takes it, as Tab would', async () => {
      const { api, user, box } = await taskBar();
      await waitFor(async () => expect(await api.listCategories()).toHaveLength(1));
      await user.type(box(), 'x | #Adm');
      await screen.findByRole('group', { name: 'Suggestions' });
      expect(screen.queryByText(/no category/)).toBeNull();
      await user.keyboard('{Enter}');
      const [admin] = await api.listCategories();
      await waitFor(async () =>
        expect((await api.listTasks())[0]).toMatchObject({ title: 'x', categoryId: admin!.id }),
      );
    });

    it('a half-typed #label that starts several refuses the save and says which', async () => {
      const { api, user, box } = await taskBar({ categories: ['Admin', 'Admissions'] });
      await waitFor(async () => expect(await api.listCategories()).toHaveLength(2));
      await user.type(box(), 'x | #Adm');
      await user.keyboard('{Enter}');
      expect(await screen.findByText(/Not saved/)).toBeTruthy();
      expect(screen.getByText('#Adm could be Admin or Admissions — pick one')).toBeTruthy();
      expect(box().value).toBe('x | #Adm');
      expect(await api.listTasks()).toHaveLength(0);
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

    it('"→ today" with a timed line plans nothing and says when it lands — by its time', async () => {
      const { api, user, box } = await taskBar();
      const day = addDays(todayKey(4), 1);
      await user.click(screen.getByRole('button', { name: 'today' }));
      await user.type(box(), `submit form | due:${day}@16:00`);
      await user.keyboard('{Enter}');

      expect(await screen.findByText(/due tomorrow 4pm, by its time/)).toBeTruthy();
      expect(await api.listPlansForDay(todayKey(4))).toEqual([]);
      const [t] = await api.listTasks();
      expect(t).toMatchObject({ title: 'submit form', dueDay: day, dueTime: '16:00' });
    });

    it('a timed line without “→ today” says when it lands — never “backlog”', async () => {
      const { user, box } = await taskBar();
      const day = addDays(todayKey(4), 1);
      await user.type(box(), `submit form | due:${day}@00:30`);
      await user.keyboard('{Enter}');
      expect(await screen.findByText(/due tonight 12:30am, by its time/)).toBeTruthy();
      expect(screen.queryByText(/→ backlog/)).toBeNull();
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
      expect(box().value).toBe('memo | due:2026-10-02');
      expect(await screen.findByText('10/2/2026')).toBeTruthy();
    });

    it('a day chip leads straight into the time chips; a space skips them', async () => {
      vi.setSystemTime(new Date(2026, 8, 30, 12));
      const { user, box } = await taskBar();
      await user.type(box(), 'memo | due:');
      await user.click(chip('Fri'));
      const times = within(chips()!)
        .getAllByRole('button')
        .map((b) => b.textContent);
      expect(times).toEqual(['9am', '12pm', '5pm', '11:59pm']);
      await user.click(chip('5pm'));
      expect(box().value).toBe('memo | due:2026-10-02@17:00 ');

      await user.clear(box());
      await user.type(box(), 'memo | due:');
      await user.click(chip('Fri'));
      await user.type(box(), ' ');
      expect(chips()).toBeNull(); // no time wanted — past the token, the chips are gone
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

  // Quick add (docs/areas/tasks/quick-add.md): the stub's heuristic stands in for Haiku, through the
  // same shared flow and validator as the Lambda.
  describe('quick add', () => {
    const adminId = async (api: { listCategories(): Promise<{ id: string; label: string }[]> }) =>
      (await api.listCategories()).find((c) => c.label === 'Admin')!.id;

    it('Enter clears at once, saves what the parse read, and says what it saved', async () => {
      const { api, user, box } = await taskBar();
      await user.type(box(), 'admin, file taxes due tmw 30m');
      await user.keyboard('{Enter}');
      expect(box().value).toBe('');
      await waitFor(async () =>
        expect((await api.listTasks())[0]).toMatchObject({
          title: 'file taxes',
          categoryId: await adminId(api),
          dueDay: addDays(todayKey(4), 1),
          estimateMin: 30,
        }),
      );
      expect(await screen.findByText('file taxes · Admin · due tomorrow · 30m')).toBeTruthy();
      // Announced once, by the receipt's live region (the visible readback is aria-hidden).
      expect(screen.getByRole('status').textContent).toMatch(
        /Task added → backlog: file taxes · Admin/,
      );
    });

    it("a ' | ' line never reaches the model", async () => {
      const { api, user, box } = await taskBar();
      const parse = vi.spyOn(api, 'parseTask');
      await user.type(box(), 'memo | ~30');
      await user.keyboard('{Enter}');
      await waitFor(async () =>
        expect((await api.listTasks())[0]).toMatchObject({ title: 'memo', estimateMin: 30 }),
      );
      expect(parse).not.toHaveBeenCalled();
    });

    it('Review shows the parse; a second press saves exactly it, without parsing again', async () => {
      const { api, user, box } = await taskBar();
      const parse = vi.spyOn(api, 'parseTask');
      await user.type(box(), 'admin, file taxes 45m');
      await user.click(screen.getByRole('button', { name: 'Review before saving' }));
      expect(await screen.findByText('file taxes')).toBeTruthy();
      expect(screen.getByText('#Admin')).toBeTruthy();
      expect(screen.getByText('45m')).toBeTruthy();
      expect(box().value).toBe('admin, file taxes 45m'); // the text stays until you save
      await user.click(screen.getByRole('button', { name: 'Save reviewed task' }));
      await waitFor(async () =>
        expect((await api.listTasks())[0]).toMatchObject({ title: 'file taxes', estimateMin: 45 }),
      );
      expect(parse).toHaveBeenCalledTimes(1);
      expect(box().value).toBe('');
    });

    it('⌘Enter reviews, and Enter on a shown preview saves it', async () => {
      const { api, user, box } = await taskBar();
      const parse = vi.spyOn(api, 'parseTask');
      await user.type(box(), 'admin, renew passport');
      await user.keyboard('{Meta>}{Enter}{/Meta}');
      expect(await screen.findByText('renew passport')).toBeTruthy();
      expect(await api.listTasks()).toHaveLength(0);
      await user.keyboard('{Enter}');
      await waitFor(async () =>
        expect((await api.listTasks())[0]).toMatchObject({ title: 'renew passport' }),
      );
      expect(parse).toHaveBeenCalledTimes(1);
    });

    it('editing the text hides the preview, and the next save parses the new text', async () => {
      const { api, user, box } = await taskBar();
      await user.type(box(), 'admin, call bank');
      await user.click(screen.getByRole('button', { name: 'Review before saving' }));
      expect(await screen.findByText('call bank')).toBeTruthy();
      await user.type(box(), ' 15m');
      expect(screen.queryByText('call bank')).toBeNull();
      expect(screen.getByRole('button', { name: 'Review before saving' })).toBeTruthy();
      await user.keyboard('{Enter}');
      await waitFor(async () =>
        expect((await api.listTasks())[0]).toMatchObject({ title: 'call bank', estimateMin: 15 }),
      );
    });

    it('a parse that lands after the text changed never shows', async () => {
      const { api, user, box } = await taskBar();
      let resolve!: (r: ParseTaskResult) => void;
      vi.spyOn(api, 'parseTask').mockReturnValueOnce(new Promise((r) => (resolve = r)));
      await user.type(box(), 'old text');
      await user.click(screen.getByRole('button', { name: 'Review before saving' }));
      expect(screen.getByText('Reading it…')).toBeTruthy();
      await user.type(box(), '!');
      resolve({
        ok: true,
        source: 'haiku',
        input: { title: 'STALE' },
        categoryLabel: null,
        placeName: null,
        dropped: [],
        today: todayKey(4),
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.queryByText('STALE')).toBeNull();
      expect(screen.queryByText('Reading it…')).toBeNull();
    });

    it('a failed parse saves the line as typed, and says so', async () => {
      const { api, user, box } = await taskBar();
      localStorage.setItem(STUB_FAIL_NEXT_PARSE_KEY, '1');
      await user.type(box(), 'admin, file taxes 30m');
      await user.keyboard('{Enter}');
      await waitFor(async () =>
        expect((await api.listTasks())[0]).toMatchObject({
          title: 'admin, file taxes 30m',
          categoryId: null,
          estimateMin: null,
        }),
      );
      expect(await screen.findByText(/Saved unparsed → backlog/)).toBeTruthy();
      expect(
        screen.getByText(/Saved as typed — couldn’t parse \(unavailable: stub failNextParse\)/),
      ).toBeTruthy();
      expect(box().value).toBe('');
    });

    it('a transport error on the parse is a raw save too', async () => {
      const { api, user, box } = await taskBar();
      vi.spyOn(api, 'parseTask').mockRejectedValueOnce(new Error('offline'));
      await user.type(box(), 'water plants');
      await user.keyboard('{Enter}');
      await waitFor(async () =>
        expect((await api.listTasks())[0]).toMatchObject({ title: 'water plants' }),
      );
      expect(await screen.findByText(/Saved unparsed/)).toBeTruthy();
    });

    it('a failed Review says so in the preview, and saving keeps the line as typed', async () => {
      const { api, user, box } = await taskBar();
      localStorage.setItem(STUB_FAIL_NEXT_PARSE_KEY, '1');
      await user.type(box(), 'admin, file taxes');
      await user.click(screen.getByRole('button', { name: 'Review before saving' }));
      expect(await screen.findByText(/Couldn’t parse \(unavailable/)).toBeTruthy();
      await user.keyboard('{Enter}');
      await waitFor(async () =>
        expect((await api.listTasks())[0]).toMatchObject({ title: 'admin, file taxes' }),
      );
    });

    it('a failed create puts the typed text back and says so', async () => {
      const { api, user, box } = await taskBar();
      api.createTask = () => Promise.reject(new Error('offline'));
      await user.type(box(), 'admin, file taxes 30m');
      await user.keyboard('{Enter}');
      expect(await screen.findByText(/Couldn't save/)).toBeTruthy();
      await waitFor(() => expect(box().value).toBe('admin, file taxes 30m'));
    });

    // mutate()'s per-call callbacks fire only for the latest call, so a failed capture followed by a
    // quick second one used to lose its restore. Each save now owns its promise.
    it('restores a failed capture even when another one follows it at once', async () => {
      const { api, user, box } = await taskBar();
      let reject!: (e: Error) => void;
      const real = api.createTask.bind(api);
      api.createTask = vi
        .fn()
        .mockReturnValueOnce(new Promise((_, r) => (reject = r)))
        .mockImplementation(real);
      await user.type(box(), 'first');
      await user.keyboard('{Enter}');
      await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
      await user.type(box(), 'second');
      await user.keyboard('{Enter}');
      await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(2));
      reject(new Error('offline'));
      expect(await screen.findByText(/Couldn't save/)).toBeTruthy();
      await waitFor(() => expect(box().value).toBe('first'));
    });

    // The restore above only works into an empty field. Auto waits on a parse first, so by the time a
    // create fails the user may be mid-way through the next capture — that one must not be overwritten.
    it('a failed save never overwrites a newer capture: it is parked, and Put back trades places', async () => {
      const { api, user, box } = await taskBar();
      let reject!: (e: Error) => void;
      api.createTask = vi.fn().mockReturnValueOnce(new Promise((_, r) => (reject = r)));
      await user.type(box(), 'first');
      await user.keyboard('{Enter}');
      await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
      await user.type(box(), 'half-typed second');
      reject(new Error('offline'));
      expect(await screen.findByText("Couldn't save — kept below the box.")).toBeTruthy();
      expect(box().value).toBe('half-typed second');
      expect(screen.getByText('Couldn’t save: “first”')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Put back' }));
      expect(box().value).toBe('first');
      expect(screen.getByText('Set aside: “half-typed second”')).toBeTruthy();
      const discard = screen.getByRole('button', { name: 'Discard' });
      // The short name is told apart by its description: the parked text itself.
      expect(discard.getAttribute('aria-describedby')).toBeTruthy();
      expect(document.getElementById(discard.getAttribute('aria-describedby')!)?.textContent).toBe(
        'Set aside: “half-typed second”',
      );
      await user.click(discard);
      expect(screen.queryByText(/Set aside/)).toBeNull();
    });

    it('an Auto capture sits in the outbox through the parse AND the create, until it settles', async () => {
      const { api, user, box } = await taskBar();
      let parsed!: (r: ParseTaskResult) => void;
      vi.spyOn(api, 'parseTask').mockReturnValueOnce(new Promise((r) => (parsed = r)));
      const real = api.createTask.bind(api);
      let created!: () => void;
      api.createTask = vi.fn(
        (input) => new Promise((r) => (created = () => r(real(input)))),
      ) as typeof api.createTask;
      const outbox = () => JSON.parse(localStorage.getItem(CAPTURE_OUTBOX_KEY) ?? '[]');
      await user.type(box(), 'call bank');
      await user.keyboard('{Enter}');
      expect(box().value).toBe('');
      expect(outbox()).toMatchObject([{ text: 'call bank', mode: 'task', toToday: false }]);
      parsed({ ok: false, reason: 'timeout' });
      await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
      expect(outbox()).toHaveLength(1); // parsed, but the create hasn't landed
      created();
      await waitFor(async () => expect((await api.listTasks())[0]?.title).toBe('call bank'));
      await waitFor(() => expect(localStorage.getItem(CAPTURE_OUTBOX_KEY)).toBeNull());
    });

    it('a failed create leaves the outbox for the field or the parked list — never neither', async () => {
      const { api, user, box } = await taskBar();
      let reject!: (e: Error) => void;
      api.createTask = vi.fn().mockReturnValueOnce(new Promise((_, r) => (reject = r)));
      await user.type(box(), 'first');
      await user.keyboard('{Enter}');
      await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
      await user.type(box(), 'busy');
      reject(new Error('offline'));
      await screen.findByText('Couldn’t save: “first”');
      await waitFor(() => expect(localStorage.getItem(CAPTURE_OUTBOX_KEY)).toBeNull());
      expect(JSON.parse(localStorage.getItem(CAPTURE_PARKED_KEY)!)).toMatchObject([
        { text: 'first', why: 'failed' },
      ]);
    });

    it('"→ today" Auto captures leave the outbox too, planned or not', async () => {
      const { api, user, box } = await taskBar();
      api.upsertPlan = () => Promise.reject(new Error('offline'));
      await user.click(screen.getByRole('button', { name: 'today' }));
      await user.type(box(), 'pay rent');
      await user.keyboard('{Enter}');
      expect(await screen.findByText(/couldn’t plan it/)).toBeTruthy();
      expect(localStorage.getItem(CAPTURE_OUTBOX_KEY)).toBeNull();
    });

    it('parked captures survive closing the app again', async () => {
      const { api, user, box } = await taskBar();
      api.createTask = vi.fn().mockRejectedValueOnce(new Error('offline'));
      vi.spyOn(api, 'parseTask').mockImplementationOnce(async (t) => {
        await user.type(box(), 'busy'); // the field is taken by the time the save fails
        return { ok: false, reason: 'timeout', detail: t };
      });
      await user.type(box(), 'first');
      await user.keyboard('{Enter}');
      await screen.findByText('Couldn’t save: “first”');
      cleanup(); // the app closes
      const api2 = createStubClient({ seed: false, storageKey: `cap-reopen-${Math.random()}` });
      renderWithProviders(<CaptureBar />, { api: api2 });
      expect(await screen.findByText('Couldn’t save: “first”')).toBeTruthy();
      await userEvent.setup().click(screen.getByRole('button', { name: 'Discard' }));
      expect(localStorage.getItem(CAPTURE_PARKED_KEY)).toBeNull();
    });

    it("another tab's young entry is left alone, then parked once it's stale (foreground sweep)", async () => {
      const t0 = Date.now();
      localStorage.setItem(
        CAPTURE_OUTBOX_KEY,
        JSON.stringify([
          { id: 'young', text: 'from the other tab', mode: 'task', toToday: false, at: t0 - 1_000 },
        ]),
      );
      await taskBar();
      expect(screen.queryByText(/from the other tab/)).toBeNull();
      vi.spyOn(Date, 'now').mockReturnValue(t0 + OUTBOX_STALE_MS);
      try {
        document.dispatchEvent(new Event('visibilitychange'));
        expect(await screen.findByText(/check first: “from the other tab”/)).toBeTruthy();
      } finally {
        vi.mocked(Date.now).mockRestore();
      }
    });

    it('a capture left unsent when the app closed comes back on launch, parked, flagged as maybe saved', async () => {
      localStorage.setItem(
        CAPTURE_OUTBOX_KEY,
        JSON.stringify([
          {
            id: 'old',
            text: 'renew passport',
            mode: 'task',
            toToday: true,
            at: Date.now() - OUTBOX_STALE_MS,
          },
          { id: 'new', text: 'in flight elsewhere', mode: 'task', toToday: false, at: Date.now() },
        ]),
      );
      const { user, box } = await taskBar();
      expect(
        await screen.findByText(/it may have saved, check first: “renew passport”/),
      ).toBeTruthy();
      expect(screen.queryByText(/in flight elsewhere/)).toBeNull(); // another tab's save may still land
      expect(JSON.parse(localStorage.getItem(CAPTURE_OUTBOX_KEY)!)).toMatchObject([{ id: 'new' }]);
      expect(screen.getByRole('status').textContent).toBe('Unsent capture kept below the box.');
      await user.click(screen.getByRole('button', { name: 'Put back' }));
      expect(box().value).toBe('renew passport');
      expect(screen.getByRole('button', { name: 'today' }).getAttribute('aria-pressed')).toBe(
        'true',
      );
    });

    it('✨ on a failed preview parses again; the preview reads due dates relatively', async () => {
      const { user, box } = await taskBar();
      localStorage.setItem(STUB_FAIL_NEXT_PARSE_KEY, '1');
      await user.type(box(), 'admin, file taxes due tmw');
      await user.click(screen.getByRole('button', { name: 'Review before saving' }));
      expect(await screen.findByText(/Couldn’t parse/)).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Retry parse' }));
      expect(await screen.findByText('file taxes')).toBeTruthy();
      expect(screen.getByText('due tomorrow')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Save reviewed task' })).toBeTruthy();
    });

    it('switching modes drops the preview; a " | " line has no ✨ and ⌘Enter saves it', async () => {
      const { api, user, box } = await taskBar();
      await user.type(box(), 'admin, call bank');
      await user.click(screen.getByRole('button', { name: 'Review before saving' }));
      expect(await screen.findByText('call bank')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Log' }));
      await user.click(screen.getByRole('button', { name: 'Task' }));
      expect(box().value).toBe('admin, call bank');
      expect(screen.queryByText('call bank')).toBeNull();
      await user.clear(box());
      await user.type(box(), 'memo | ~30');
      expect(screen.queryByRole('button', { name: /Review|Retry/ })).toBeNull();
      await user.keyboard('{Meta>}{Enter}{/Meta}');
      await waitFor(async () =>
        expect((await api.listTasks())[0]).toMatchObject({ title: 'memo', estimateMin: 30 }),
      );
    });

    it('✨ keeps focus in the field (the phone keyboard stays up)', async () => {
      const { user, box } = await taskBar();
      await user.type(box(), 'admin, call bank');
      const blurs = vi.fn();
      box().addEventListener('blur', blurs);
      await user.click(screen.getByRole('button', { name: 'Review before saving' }));
      await screen.findByText('call bank');
      expect(blurs).not.toHaveBeenCalled(); // not merely refocused after: never left
      expect(document.activeElement).toBe(box());
    });

    it('a preview parsed against a day that has since rolled over is dropped', async () => {
      const { api, user, box } = await taskBar();
      vi.spyOn(api, 'parseTask').mockResolvedValueOnce({
        ok: true,
        source: 'haiku',
        input: { title: 'yesterday parse' },
        categoryLabel: null,
        placeName: null,
        dropped: [],
        today: addDays(todayKey(4), -1),
      });
      await user.type(box(), 'x');
      await user.click(screen.getByRole('button', { name: 'Review before saving' }));
      await waitFor(() => expect(api.parseTask).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.queryByText('yesterday parse')).toBeNull();
    });

    it('"→ today" plans a quick-added task, from Auto and from Review', async () => {
      const { api, user, box } = await taskBar();
      const today = todayKey(4);
      await user.click(screen.getByRole('button', { name: 'today' }));
      await user.type(box(), 'admin, pay rent 10m');
      await user.keyboard('{Enter}');
      expect(await screen.findByText(/Task added → today/)).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'today' }));
      await user.type(box(), 'admin, book flight');
      await user.click(screen.getByRole('button', { name: 'Review before saving' }));
      await screen.findByText('book flight');
      await user.click(screen.getByRole('button', { name: 'Save reviewed task' }));
      await waitFor(async () => expect(await api.listPlansForDay(today)).toHaveLength(2));
      const titles = await Promise.all(
        (await api.listPlansForDay(today)).map(async (p) => (await api.getTask(p.taskId))?.title),
      );
      expect(titles.sort()).toEqual(['book flight', 'pay rent']);
    });
  });
});

describe('CaptureBar — places', () => {
  async function placeBar(opts: { hangPlaces?: boolean; more?: string[]; focus?: boolean } = {}) {
    const api = createStubClient({ seed: false, storageKey: `cap-place-${Math.random()}` });
    await api.upsertPlace({ name: 'Corner Shop', slug: 'corner' });
    for (const name of opts.more ?? []) await api.upsertPlace({ name });
    if (opts.hangPlaces) vi.spyOn(api, 'listPlaces').mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    // AppShell docks the idle Focus button in the bar's trailing slot.
    const bar = opts.focus ? (
      <PomodoroProvider>
        <CaptureBar trailing={<IdleFocus />} />
      </PomodoroProvider>
    ) : (
      <CaptureBar />
    );
    renderWithProviders(bar, { api });
    await user.click(screen.getByRole('button', { name: 'Task' }));
    const box = () => screen.getByLabelText('Capture task') as HTMLTextAreaElement;
    return { api, user, box };
  }

  it('an @ chip types the link word, the preview reads the name, and the task lands on the list', async () => {
    const { api, user, box } = await placeBar();
    await user.type(box(), 'milk | @co');
    const chip = await waitFor(() =>
      within(screen.getByRole('group', { name: 'Suggestions' })).getByText('@Corner Shop', {
        selector: 'button',
      }),
    );
    await user.click(chip);
    expect(box().value).toBe('milk | @corner ');
    expect(await screen.findByText('@Corner Shop', { selector: 'span' })).toBeTruthy();
    await user.keyboard('{Enter}');
    await waitFor(async () =>
      expect((await api.listTasks())[0]).toMatchObject({ title: 'milk', place: 'corner' }),
    );
  });

  it('the receipt names the store an errand went to, not the backlog', async () => {
    const { user, box } = await placeBar();
    await user.type(box(), 'milk | @corner');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Task added → Corner Shop')).toBeTruthy();
  });

  it('Enter on a half-typed @place with one match takes it — never a quiet drop off the list', async () => {
    const { api, user, box } = await placeBar();
    await user.type(box(), 'milk | @cor');
    await screen.findByRole('group', { name: 'Suggestions' });
    // Still being typed at the caret: no "no place" warning flashes while the chip shows.
    expect(screen.queryByText(/no place/)).toBeNull();
    await user.keyboard('{Enter}');
    await waitFor(async () =>
      expect((await api.listTasks())[0]).toMatchObject({ title: 'milk', place: 'corner' }),
    );
    expect(await screen.findByText('Task added → Corner Shop')).toBeTruthy();
  });

  it('a half-typed @place that starts several refuses the save and says which', async () => {
    const { api, user, box } = await placeBar({ more: ['Costco'] });
    await user.type(box(), 'milk | @co');
    await screen.findByRole('group', { name: 'Suggestions' });
    expect(screen.queryByText(/could be/)).toBeNull(); // mid-word: the chips speak
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/Not saved/)).toBeTruthy();
    expect(screen.getByText('@co could be Corner Shop or Costco — pick one')).toBeTruthy();
    expect(box().value).toBe('milk | @co');
    expect(await api.listTasks()).toHaveLength(0);
  });

  it('an @word that starts no place warns once you leave it, and saves off any list', async () => {
    const { api, user, box } = await placeBar();
    await user.type(box(), 'milk | @zz');
    expect(screen.queryByText(/no place/)).toBeNull(); // still being typed at the caret
    act(() => box().blur());
    expect(await screen.findByText(/no place '@zz'/)).toBeTruthy();
    await user.type(box(), ' ');
    await user.keyboard('{Enter}');
    await waitFor(async () =>
      expect((await api.listTasks())[0]).toMatchObject({ title: 'milk', place: null }),
    );
    expect(await screen.findByText('Task added → backlog')).toBeTruthy();
  });

  // The typing rule hides the warning while the caret is in the token — so Enter right there must not
  // save it unseen (the receipt says only where it went). The first press shows it; the next one saves.
  it('Enter with an unknown @word still at the caret refuses once and shows why, then saves', async () => {
    const { api, user, box } = await placeBar();
    await user.type(box(), 'milk | @zz');
    expect(screen.queryByText(/no place/)).toBeNull();
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/Not saved/)).toBeTruthy();
    expect(screen.getByText("no place '@zz' — created without one")).toBeTruthy();
    expect(screen.getByText('Enter or Save again to save without it.')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(
      /Not saved: no place '@zz' — created without one — Enter or Save again to save without it/,
    );
    expect(box().value).toBe('milk | @zz');
    expect(await api.listTasks()).toHaveLength(0);

    await user.keyboard('{Enter}');
    await waitFor(async () =>
      expect((await api.listTasks())[0]).toMatchObject({ title: 'milk', place: null }),
    );
    expect(await screen.findByText('Task added → backlog')).toBeTruthy();
    expect(box().value).toBe('');
  });

  it('no other bar control takes focus from the field while a warning is held back', async () => {
    const { user, box } = await placeBar({ focus: true });
    await screen.findByRole('button', { name: /^Focus$/ });
    await user.type(box(), 'milk | @zz');
    const blurred = vi.fn();
    box().addEventListener('blur', blurred);
    // Log last: Log mode drops the token warning by design.
    for (const name of [/today/, /^Focus$/, /^Log$/]) {
      const control = screen.getByRole('button', { name });
      await user.pointer({ keys: '[MouseLeft>]', target: control });
      expect(document.activeElement).toBe(box());
      expect(screen.queryByText(/no place/)).toBeNull(); // nothing grew under the press
      await user.pointer({ keys: '[/MouseLeft]', target: control });
    }
    expect(blurred).not.toHaveBeenCalled();
  });

  it('Put back and × keep focus in the field: no blur, no warning grown under the press', async () => {
    localStorage.setItem(
      CAPTURE_PARKED_KEY,
      JSON.stringify([
        { id: 'a', text: 'stamps', mode: 'task', toToday: false, why: 'set-aside' },
        { id: 'b', text: 'eggs', mode: 'task', toToday: false, why: 'set-aside' },
      ]),
    );
    const { user, box } = await placeBar();
    await user.type(box(), 'milk | @zz');
    const blurred = vi.fn();
    box().addEventListener('blur', blurred);
    const discard = screen.getAllByRole('button', { name: 'Discard' })[0]!;
    await user.pointer({ keys: '[MouseLeft>]', target: discard });
    expect(document.activeElement).toBe(box());
    expect(screen.queryByText(/no place/)).toBeNull();
    await user.pointer({ keys: '[/MouseLeft]', target: discard });
    expect(screen.queryByText('Set aside: “stamps”')).toBeNull();
    const putBack = screen.getByRole('button', { name: 'Put back' });
    await user.pointer({ keys: '[MouseLeft>]', target: putBack });
    expect(document.activeElement).toBe(box());
    expect(screen.queryByText(/no place/)).toBeNull();
    await user.pointer({ keys: '[/MouseLeft]', target: putBack });
    expect(box().value).toBe('eggs');
    expect(screen.getByText('Set aside: “milk | @zz”')).toBeTruthy();
    expect(blurred).not.toHaveBeenCalled();
  });

  // The typing rule's three steps, deliberately: leaving the field shows the warning, coming back into the
  // token holds it back again, and Enter there still refuses once before it saves.
  it('blur shows a held warning, tapping back into the token hides it, and Enter refuses once more', async () => {
    const { api, user, box } = await placeBar();
    await user.type(box(), 'milk | @zz');
    expect(screen.queryByText(/no place/)).toBeNull();
    act(() => box().blur());
    expect(await screen.findByText("no place '@zz' — created without one")).toBeTruthy();
    await user.click(box()); // the caret lands at the end: back in the token
    expect(box().selectionStart).toBe('milk | @zz'.length);
    expect(screen.queryByText(/no place/)).toBeNull();
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/Not saved/)).toBeTruthy();
    expect(screen.getByText("no place '@zz' — created without one")).toBeTruthy();
    expect(await api.listTasks()).toHaveLength(0);
    await user.keyboard('{Enter}');
    await waitFor(async () =>
      expect((await api.listTasks())[0]).toMatchObject({ title: 'milk', place: null }),
    );
  });

  // The refusal's promise isn't the receipt's: a late receipt landing in between (an earlier capture's save
  // or its parked failure) must not hide the warning again or make the promised second press refuse.
  it.each([
    ['an earlier save', 'resolve', 'Task added → Corner Shop'],
    ['an earlier failure parked', 'reject', "Couldn't save — kept below the box."],
  ] as const)('a held refusal survives a late receipt from %s', async (_, how, late) => {
    const { api, user, box } = await placeBar();
    const real = api.createTask.bind(api);
    let settle!: () => void;
    api.createTask = vi
      .fn()
      .mockImplementationOnce(
        (input: Parameters<typeof real>[0]) =>
          new Promise((ok, fail) => {
            settle = () => (how === 'resolve' ? ok(real(input)) : fail(new Error('offline')));
          }),
      )
      .mockImplementation(real);
    await user.type(box(), 'eggs | @corner');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
    await user.type(box(), 'milk | @zz');
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/Not saved/)).toBeTruthy();
    act(() => settle());
    expect(await screen.findByText(late)).toBeTruthy();
    expect(screen.queryByText(/Not saved/)).toBeNull(); // the slot is the late receipt's now
    // …but the warning and the promise stay, with the caret still in the token.
    expect(document.activeElement).toBe(box());
    expect(screen.getByText("no place '@zz' — created without one")).toBeTruthy();
    expect(screen.getByText('Enter or Save again to save without it.')).toBeTruthy();
    await user.keyboard('{Enter}');
    await waitFor(async () =>
      expect((await api.listTasks()).find((t) => t.title === 'milk')).toMatchObject({
        place: null,
      }),
    );
  });

  it('Put back drops a refusal even when the line it brings back is refused too', async () => {
    localStorage.setItem(
      CAPTURE_PARKED_KEY,
      JSON.stringify([
        { id: 'a', text: 'y | ~45m', mode: 'task', toToday: false, why: 'set-aside' },
      ]),
    );
    const { user, box } = await placeBar();
    await user.type(box(), 'x | ~30m');
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/Not saved/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Put back' }));
    expect(box().value).toBe('y | ~45m');
    expect(screen.getByText(/invalid estimate/)).toBeTruthy(); // its own error shows in the preview
    expect(screen.queryByText(/Not saved/)).toBeNull(); // but nothing was refused for it yet
  });

  it('Put back and a mode switch drop a held refusal: the next press refuses afresh', async () => {
    localStorage.setItem(
      CAPTURE_PARKED_KEY,
      JSON.stringify([{ id: 'a', text: 'eggs', mode: 'task', toToday: false, why: 'set-aside' }]),
    );
    const { api, user, box } = await placeBar();
    await user.type(box(), 'milk | @zz');
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/Not saved/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Put back' }));
    expect(box().value).toBe('eggs');
    expect(screen.queryByText(/Not saved/)).toBeNull();
    // The refused line comes back from the parked list: its earlier refusal doesn't carry over.
    await user.click(screen.getByRole('button', { name: 'Put back' }));
    expect(box().value).toBe('milk | @zz');
    expect(screen.queryByText(/no place/)).toBeNull(); // caret at its end: held back again
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/Not saved/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Log' }));
    await user.click(screen.getByRole('button', { name: 'Task' }));
    expect(screen.queryByText(/Not saved/)).toBeNull();
    expect(screen.queryByText(/no place/)).toBeNull();
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/Not saved/)).toBeTruthy();
    expect(await api.listTasks()).toHaveLength(0);
  });

  it('the Save button keeps focus in the field: no blur, no layout shift, a refusal then a save', async () => {
    const { api, user, box } = await placeBar();
    await user.type(box(), 'milk | @zz');
    const save = screen.getByLabelText('Save task');
    const blurred = vi.fn();
    box().addEventListener('blur', blurred);
    // pointerdown → mousedown → click, as a tap or a mouse press does — the field must not blur between.
    await user.pointer({ keys: '[MouseLeft>]', target: save });
    expect(blurred).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(box());
    expect(screen.queryByText(/no place/)).toBeNull(); // nothing grew under the press
    await user.pointer({ keys: '[/MouseLeft]', target: save });
    expect(await screen.findByText(/Not saved/)).toBeTruthy();
    expect(screen.getByText("no place '@zz' — created without one")).toBeTruthy();
    expect(box().value).toBe('milk | @zz');
    expect(await api.listTasks()).toHaveLength(0);

    await user.click(save);
    await waitFor(async () =>
      expect((await api.listTasks())[0]).toMatchObject({ title: 'milk', place: null }),
    );
    expect(blurred).not.toHaveBeenCalled();
  });

  it('a known @place still saves on the first Enter', async () => {
    const { api, user, box } = await placeBar();
    await user.type(box(), 'milk | @corner');
    await user.keyboard('{Enter}');
    await waitFor(async () =>
      expect((await api.listTasks())[0]).toMatchObject({ title: 'milk', place: 'corner' }),
    );
    expect(screen.queryByText(/Not saved/)).toBeNull();
  });

  it('a held-back refusal goes once the text changes — the next held warning refuses again', async () => {
    const { api, user, box } = await placeBar();
    await user.type(box(), 'milk | @zz');
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/Not saved/)).toBeTruthy();
    await user.type(box(), 'q');
    await waitFor(() => expect(screen.queryByText(/Not saved/)).toBeNull());
    expect(screen.queryByText(/no place/)).toBeNull(); // typing again: held back again
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/Not saved/)).toBeTruthy();
    expect(screen.getByText("no place '@zzq' — created without one")).toBeTruthy();
    expect(await api.listTasks()).toHaveLength(0);
  });

  it('waits for places before an @place line can save', async () => {
    const { api, user, box } = await placeBar({ hangPlaces: true });
    await user.type(box(), 'milk | @corner');
    expect(await screen.findByText('Loading places…')).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/Not saved/)).toBeTruthy();
    expect(box().value).toBe('milk | @corner');
    expect(await api.listTasks()).toHaveLength(0);
  });

  it('quick add takes a known @word and says which list it went on', async () => {
    const { api, user, box } = await placeBar();
    await user.type(box(), 'milk @corner');
    await user.keyboard('{Enter}');
    await waitFor(async () =>
      expect((await api.listTasks())[0]).toMatchObject({ title: 'milk', place: 'corner' }),
    );
    expect(await screen.findByText('milk · no category · @Corner Shop')).toBeTruthy();
    expect(screen.getByText(/Task added → Corner Shop/)).toBeTruthy();
  });
});
