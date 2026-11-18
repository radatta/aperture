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
async function taskBar(
  opts: {
    hangCategories?: boolean;
    categories?: string[];
    history?: Record<string, string[]>; // category label → titles, created before the bar mounts
  } = {},
) {
  const api = createStubClient({ seed: false, storageKey: `cap-tok-${Math.random()}` });
  for (const label of opts.categories ?? ['Admin']) {
    const { id } = await api.upsertCategory({ label, isWork: true });
    for (const title of opts.history?.[label] ?? [])
      await api.createTask({ title, categoryId: id });
  }
  if (opts.hangCategories) vi.spyOn(api, 'listCategories').mockReturnValue(new Promise(() => {}));
  const list = vi.spyOn(api, 'listTasks'); // before the render: it counts the bar's own reads
  const user = userEvent.setup();
  renderWithProviders(<CaptureBar />, { api });
  await user.click(screen.getByRole('button', { name: 'Task' }));
  const box = () => screen.getByLabelText('Capture task') as HTMLTextAreaElement;
  return { api, user, box, list };
}

function field() {
  return screen.getByLabelText('Capture log') as HTMLTextAreaElement;
}

// Review first: Enter reads a natural task line into a preview; once it has landed, Enter saves exactly it.
async function reviewThenSave(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard('{Enter}');
  await screen.findByRole('button', { name: 'Save reviewed task' });
  await user.keyboard('{Enter}');
}

// A parse result the test controls, for today unless it says otherwise.
const parsed = (title: string, today = todayKey(4)): ParseTaskResult => ({
  ok: true,
  source: 'haiku',
  input: { title },
  categoryLabel: null,
  placeName: null,
  dropped: [],
  today,
});

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
  // through untouched (the IME commits on it). The negative is the field keeping its text — a submit
  // clears it at once — and the real Enter afterwards shows the guard didn't swallow the next one.
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

    it('Enter or ⌘Enter mid-composition never reviews or saves a task', async () => {
      const { api, user, box } = await taskBar();
      const parse = vi.spyOn(api, 'parseTask');
      await user.type(box(), 'にほんご');
      fireEvent.compositionStart(box());
      fireEvent.keyDown(box(), { key: 'Enter', metaKey: true, isComposing: true });
      fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
      fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 });
      expect(box().value).toBe('にほんご');
      expect(parse).not.toHaveBeenCalled();
      expect(screen.queryByText('Reading it…')).toBeNull();
      expect(await api.listTasks()).toHaveLength(0);
      // The guard didn't swallow the next one: ⌘Enter after compositionend saves it as typed.
      fireEvent.compositionEnd(box());
      await user.keyboard('{Meta>}{Enter}{/Meta}');
      await waitFor(async () =>
        expect((await api.listTasks()).map((t) => t.title)).toEqual(['にほんご']),
      );
      expect(parse).not.toHaveBeenCalled();
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
    await reviewThenSave(user);

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
    await reviewThenSave(user);

    expect(await screen.findByText(/Task added → today/)).toBeTruthy();
    const [row] = await api.listPlansForDay(todayKey(4));
    expect((await api.getTask(row!.taskId))?.title).toBe('buy stamps');
    expect(pill.getAttribute('aria-pressed')).toBe('false'); // one-shot

    await user.type(screen.getByLabelText('Capture task'), 'next one');
    await reviewThenSave(user);
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
    await reviewThenSave(user);

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

  // Review first is a Task-mode step only: Log and Idea save on one press, and nothing reads them.
  it('Idea mode saves on one Enter, and on one Send', async () => {
    const api = createStubClient({ seed: false, storageKey: `cap-idea-${Math.random()}` });
    const parse = vi.spyOn(api, 'parseTask');
    const user = userEvent.setup();
    renderWithProviders(<CaptureBar />, { api });
    await user.click(screen.getByRole('button', { name: 'Idea' }));
    const box = () => screen.getByLabelText('Capture idea') as HTMLTextAreaElement;
    await user.type(box(), 'a podcast about bridges');
    await user.keyboard('{Enter}');
    await waitFor(async () =>
      expect((await api.listIdeas()).map((i) => i.text)).toEqual(['a podcast about bridges']),
    );
    expect(box().value).toBe('');
    await user.type(box(), 'a map of every bakery');
    await user.click(screen.getByRole('button', { name: 'Save idea' }));
    await waitFor(async () => expect(await api.listIdeas()).toHaveLength(2));
    expect(parse).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Read with AI' })).toBeNull();
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

    // ⌘Enter saves as typed, so the grammar alone decides: without ' | ' it reads no tokens.
    it('without " | " a title is literal and nothing is previewed', async () => {
      const { api, user, box } = await taskBar();
      const parse = vi.spyOn(api, 'parseTask');
      await user.type(box(), 'fix issue #42 ~5');
      expect(box().getAttribute('aria-describedby')).toBeNull();
      await user.keyboard('{Meta>}{Enter}{/Meta}');
      await user.type(box(), 'a|b');
      expect(box().getAttribute('aria-describedby')).toBeNull();
      await user.keyboard('{Meta>}{Enter}{/Meta}');

      await waitFor(async () => {
        const titles = (await api.listTasks()).map((t) => t.title).sort();
        expect(titles).toEqual(['a|b', 'fix issue #42 ~5']);
      });
      expect((await api.listTasks()).every((t) => t.estimateMin === null)).toBe(true);
      expect(parse).not.toHaveBeenCalled();
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

    it('a bare ~ speaks through its chips: no red error until Enter refuses it', async () => {
      const { api, user, box } = await taskBar();
      await user.type(box(), 'x | ~');
      expect(await screen.findByLabelText('Suggestions')).toBeTruthy();
      expect(screen.queryByText(/invalid estimate/)).toBeNull();

      await user.keyboard('{Enter}');
      expect(await screen.findByText(/Not saved/)).toBeTruthy();
      // In the preview row and the status region both.
      expect(screen.getAllByText(/invalid estimate '~'/).length).toBeGreaterThan(0);
      expect(box().value).toBe('x | ~');
      expect(await api.listTasks()).toHaveLength(0);
      // Still a red error once the chips can't help: ~30m matches no preset.
      await user.type(box(), '30m');
      expect((await screen.findAllByText(/invalid estimate '~30m'/)).length).toBeGreaterThan(0);
    });

    it('a bare due: speaks through its day chips the same way', async () => {
      const { api, user, box } = await taskBar();
      await user.type(box(), 'x | due:');
      expect(await screen.findByLabelText('Suggestions')).toBeTruthy();
      expect(screen.queryByText(/invalid due date/)).toBeNull();

      await user.keyboard('{Enter}');
      expect(await screen.findByText(/Not saved/)).toBeTruthy();
      expect(screen.getAllByText(/invalid due date 'due:'/).length).toBeGreaterThan(0);
      expect(box().value).toBe('x | due:');
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

    it('Enter shows the parse, Enter again saves exactly it, and says what it saved', async () => {
      const { api, user, box } = await taskBar();
      const parse = vi.spyOn(api, 'parseTask');
      await user.type(box(), 'admin, file taxes due tmw 30m');
      await user.keyboard('{Enter}');
      expect(await screen.findByText('file taxes')).toBeTruthy();
      expect(screen.getByText('due tomorrow')).toBeTruthy();
      expect(box().value).toBe('admin, file taxes due tmw 30m'); // the text stays until you save
      expect(await api.listTasks()).toHaveLength(0);
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
      expect(parse).toHaveBeenCalledTimes(1);
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

    it('⌘Enter on a shown preview saves exactly it, without parsing again', async () => {
      const { api, user, box } = await taskBar();
      const parse = vi.spyOn(api, 'parseTask');
      await user.type(box(), 'admin, renew passport');
      await user.keyboard('{Enter}');
      expect(await screen.findByText('renew passport')).toBeTruthy();
      expect(await api.listTasks()).toHaveLength(0);
      await user.keyboard('{Meta>}{Enter}{/Meta}');
      await waitFor(async () =>
        expect((await api.listTasks())[0]).toMatchObject({
          title: 'renew passport',
          categoryId: await adminId(api),
        }),
      );
      expect(parse).toHaveBeenCalledTimes(1);
      expect(box().value).toBe('');
    });

    it('⌘Enter with no preview saves the line as typed, never parsing', async () => {
      const { api, user, box } = await taskBar();
      const parse = vi.spyOn(api, 'parseTask');
      await user.type(box(), 'admin, renew passport 30m');
      await user.keyboard('{Meta>}{Enter}{/Meta}');
      await waitFor(async () =>
        expect((await api.listTasks())[0]).toMatchObject({
          title: 'admin, renew passport 30m',
          categoryId: null,
          estimateMin: null,
        }),
      );
      expect(parse).not.toHaveBeenCalled();
      expect(box().value).toBe('');
      expect(await screen.findByText('Task added → backlog')).toBeTruthy();
    });

    it('editing the text hides the preview, and the next press parses the new text', async () => {
      const { api, user, box } = await taskBar();
      const parse = vi.spyOn(api, 'parseTask');
      await user.type(box(), 'admin, call bank');
      await user.click(screen.getByRole('button', { name: 'Review before saving' }));
      expect(await screen.findByText('call bank')).toBeTruthy();
      await user.type(box(), ' 15m');
      expect(screen.queryByText('call bank')).toBeNull();
      expect(screen.getByRole('button', { name: 'Review before saving' })).toBeTruthy();
      await reviewThenSave(user);
      await waitFor(async () =>
        expect((await api.listTasks())[0]).toMatchObject({ title: 'call bank', estimateMin: 15 }),
      );
      expect(parse).toHaveBeenCalledTimes(2);
      expect(parse.mock.calls.map(([t]) => t)).toEqual([
        'admin, call bank',
        'admin, call bank 15m',
      ]);
    });

    // A press while the parse runs waits for it: no second parse, nothing saved, the text stays put.
    it('a press while the parse is in flight is a no-op; the landed parse is what saves', async () => {
      const { api, user, box } = await taskBar();
      let resolve!: (r: ParseTaskResult) => void;
      const parse = vi
        .spyOn(api, 'parseTask')
        .mockReturnValueOnce(new Promise((r) => (resolve = r)));
      await user.type(box(), 'pay the water bill');
      await user.keyboard('{Enter}');
      expect(screen.getByText('Reading it…')).toBeTruthy();
      await user.keyboard('{Enter}');
      await user.click(screen.getByRole('button', { name: 'Review before saving' }));
      expect(parse).toHaveBeenCalledTimes(1);
      expect(box().value).toBe('pay the water bill');
      expect(await api.listTasks()).toHaveLength(0);
      await act(async () => resolve(parsed('water bill')));
      await user.click(await screen.findByRole('button', { name: 'Save reviewed task' }));
      await waitFor(async () =>
        expect((await api.listTasks()).map((t) => t.title)).toEqual(['water bill']),
      );
      expect(parse).toHaveBeenCalledTimes(1);
    });

    it('Send is outlined "Review before saving" until the parse lands, then "Save reviewed task"; other modes say Save', async () => {
      const { api, user, box } = await taskBar();
      let resolve!: (r: ParseTaskResult) => void;
      vi.spyOn(api, 'parseTask').mockReturnValueOnce(new Promise((r) => (resolve = r)));
      // Send is the field row's last button (✨ sits before it); its name changes, so not found by name.
      const send = () => [...box().parentElement!.querySelectorAll('button')].at(-1)!;
      const filled = /(^|\s)bg-teal(\s|$)/;
      await user.type(box(), 'water plants');
      expect(send().getAttribute('aria-label')).toBe('Review before saving');
      expect(send().className).not.toMatch(filled); // outlined: nothing to save yet
      await user.keyboard('{Enter}');
      expect(send().getAttribute('aria-label')).toBe('Review before saving'); // still parsing
      await act(async () => resolve(parsed('water plants')));
      await waitFor(() => expect(send().getAttribute('aria-label')).toBe('Save reviewed task'));
      expect(send().className).toMatch(filled); // filled: the next press saves
      await user.clear(box());
      await user.type(box(), 'memo | ~30');
      expect(send().getAttribute('aria-label')).toBe('Save task');
      await user.click(screen.getByRole('button', { name: 'Log' }));
      expect(screen.getByRole('button', { name: 'Save log' })).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Idea' }));
      expect(screen.getByRole('button', { name: 'Save idea' })).toBeTruthy();
    });

    it('✨ off saves the next task as typed with no parse, then turns itself back on', async () => {
      const { api, user, box } = await taskBar();
      const parse = vi.spyOn(api, 'parseTask');
      const ai = () => screen.getByRole('button', { name: 'Read with AI' });
      expect(ai().getAttribute('aria-pressed')).toBe('true'); // on by default
      await user.type(box(), 'admin, file taxes 30m');
      await user.click(ai());
      expect(ai().getAttribute('aria-pressed')).toBe('false');
      expect(document.activeElement).toBe(box()); // the toggle never takes focus
      await user.click(screen.getByRole('button', { name: 'Save task' }));
      await waitFor(async () =>
        expect((await api.listTasks())[0]).toMatchObject({
          title: 'admin, file taxes 30m',
          categoryId: null,
          estimateMin: null,
        }),
      );
      expect(parse).not.toHaveBeenCalled();
      expect(box().value).toBe('');
      expect(ai().getAttribute('aria-pressed')).toBe('true'); // one-shot
      // …so the next line is read again.
      await user.type(box(), 'admin, call bank');
      await user.keyboard('{Enter}');
      expect(await screen.findByText('call bank')).toBeTruthy();
      expect(parse).toHaveBeenCalledTimes(1);
      expect(await api.listTasks()).toHaveLength(1);
      // ✨ off with that preview showing drops it: the next Enter saves the line as typed, not the parse.
      await user.click(ai());
      expect(ai().getAttribute('aria-pressed')).toBe('false');
      expect(screen.queryByText('call bank')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Save reviewed task' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Save task' })).toBeTruthy();
      await user.keyboard('{Enter}');
      await waitFor(async () =>
        expect((await api.listTasks()).map((t) => t.title).sort()).toEqual([
          'admin, call bank',
          'admin, file taxes 30m',
        ]),
      );
      expect((await api.listTasks()).every((t) => t.categoryId === null)).toBe(true);
      expect(parse).toHaveBeenCalledTimes(1); // no further parse
      expect(ai().getAttribute('aria-pressed')).toBe('true');
      // No ✨ on a ' | ' line: it has no model step.
      await user.clear(box());
      await user.type(box(), 'memo | ~30');
      expect(screen.queryByRole('button', { name: 'Read with AI' })).toBeNull();
    });

    it('a failed create of a ✨-off save comes back ✨ off: the retry saves as typed, unparsed', async () => {
      const { api, user, box } = await taskBar();
      const parse = vi.spyOn(api, 'parseTask');
      const ai = () => screen.getByRole('button', { name: 'Read with AI' });
      vi.spyOn(api, 'createTask').mockRejectedValueOnce(new Error('offline'));
      await user.type(box(), 'admin, file taxes 30m');
      await user.click(ai());
      await user.keyboard('{Enter}');
      expect(await screen.findByText(/Couldn't save/)).toBeTruthy();
      await waitFor(() => expect(box().value).toBe('admin, file taxes 30m'));
      expect(ai().getAttribute('aria-pressed')).toBe('false');
      await user.keyboard('{Enter}');
      await waitFor(async () =>
        expect((await api.listTasks())[0]).toMatchObject({
          title: 'admin, file taxes 30m',
          categoryId: null,
          estimateMin: null,
        }),
      );
      expect(parse).not.toHaveBeenCalled();
      expect(ai().getAttribute('aria-pressed')).toBe('true'); // one-shot again once it saved
    });

    it('a failed create brings the reviewed preview back: the retry saves it, with no second parse', async () => {
      const { api, user, box } = await taskBar();
      const parse = vi.spyOn(api, 'parseTask');
      await user.type(box(), 'admin, file taxes 30m');
      await user.keyboard('{Enter}');
      expect(await screen.findByText('file taxes')).toBeTruthy();
      vi.spyOn(api, 'createTask').mockRejectedValueOnce(new Error('offline'));
      await user.keyboard('{Enter}');
      expect(await screen.findByText(/Couldn't save/)).toBeTruthy();
      await waitFor(() => expect(box().value).toBe('admin, file taxes 30m'));
      expect(screen.getByText('file taxes')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Save reviewed task' })).toBeTruthy();
      await user.keyboard('{Enter}');
      await waitFor(async () =>
        expect((await api.listTasks())[0]).toMatchObject({
          title: 'file taxes',
          categoryId: await adminId(api),
          estimateMin: 30,
        }),
      );
      expect(parse).toHaveBeenCalledTimes(1);
    });

    // The hint sits in the DOM at every width (`hidden sm:block`); jsdom applies no CSS, so it's readable here.
    it('the hint says what Enter does: reads on a natural line with ✨ on, saves otherwise', async () => {
      const { user, box } = await taskBar();
      const READS = 'Enter reads it, again saves · ⌘Enter saves now';
      const SAVES = 'Enter saves · Tab switches';
      await user.type(box(), 'admin, call bank');
      expect(screen.getByText(READS)).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Read with AI' }));
      expect(screen.getByText(SAVES)).toBeTruthy();
      expect(screen.queryByText(READS)).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Read with AI' }));
      expect(screen.getByText(READS)).toBeTruthy();
      await user.clear(box());
      await user.type(box(), 'memo | ~30 '); // past the token: no chips, so the plain hint
      expect(screen.getByText(SAVES)).toBeTruthy();
      expect(screen.queryByText(READS)).toBeNull();
    });

    it('a parse that lands after the text changed never shows, and never saves', async () => {
      const { api, user, box } = await taskBar();
      let resolve!: (r: ParseTaskResult) => void;
      vi.spyOn(api, 'parseTask').mockReturnValueOnce(new Promise((r) => (resolve = r)));
      await user.type(box(), 'old text');
      await user.click(screen.getByRole('button', { name: 'Review before saving' }));
      expect(screen.getByText('Reading it…')).toBeTruthy();
      await user.type(box(), '!');
      resolve(parsed('STALE'));
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.queryByText('STALE')).toBeNull();
      expect(screen.queryByText('Reading it…')).toBeNull();
      expect(screen.getByRole('button', { name: 'Review before saving' })).toBeTruthy();
      // The next press reads the edited line; what saves is that, never the late parse.
      await reviewThenSave(user);
      await waitFor(async () =>
        expect((await api.listTasks()).map((t) => t.title)).toEqual(['old text!']),
      );
      expect(api.parseTask).toHaveBeenCalledTimes(2);
    });

    // Review first never saves behind your back: a failed parse keeps the text and says why, Send asks
    // again, and "Save as typed" is the one-tap way to keep the line raw.
    it('a failed parse keeps the text and says why; Send retries, Save as typed saves it raw', async () => {
      const { api, user, box } = await taskBar();
      const parse = vi.spyOn(api, 'parseTask');
      localStorage.setItem(STUB_FAIL_NEXT_PARSE_KEY, '1');
      await user.type(box(), 'admin, file taxes 30m');
      await user.keyboard('{Enter}');
      expect(
        await screen.findByText(
          'Couldn’t parse (unavailable: stub failNextParse) — Send tries again',
        ),
      ).toBeTruthy();
      expect(box().value).toBe('admin, file taxes 30m');
      expect(await api.listTasks()).toHaveLength(0);
      expect(localStorage.getItem(CAPTURE_OUTBOX_KEY)).toBeNull(); // nothing sent yet
      expect(screen.getByRole('button', { name: 'Retry parse' })).toBeTruthy();
      // Retry: one more parse, and still nothing saved — this one lands ok.
      await user.keyboard('{Enter}');
      expect(await screen.findByText('file taxes')).toBeTruthy();
      expect(parse).toHaveBeenCalledTimes(2);
      expect(await api.listTasks()).toHaveLength(0);
      // Fail it again, then keep the line as typed.
      await user.type(box(), '!');
      localStorage.setItem(STUB_FAIL_NEXT_PARSE_KEY, '1');
      await user.keyboard('{Enter}');
      await user.click(await screen.findByRole('button', { name: 'Save as typed' }));
      await waitFor(async () =>
        expect((await api.listTasks())[0]).toMatchObject({
          title: 'admin, file taxes 30m!',
          categoryId: null,
          estimateMin: null,
        }),
      );
      expect(parse).toHaveBeenCalledTimes(3);
      expect(box().value).toBe('');
      expect(document.activeElement).toBe(box());
      expect(await screen.findByText('Task added → backlog')).toBeTruthy();
    });

    it('a transport error on the parse is a failed parse too: the text stays, nothing saves', async () => {
      const { api, user, box } = await taskBar();
      vi.spyOn(api, 'parseTask').mockRejectedValueOnce(new Error('offline'));
      await user.type(box(), 'water plants');
      await user.keyboard('{Enter}');
      expect(await screen.findByText(/Couldn’t parse \(network: offline\)/)).toBeTruthy();
      expect(box().value).toBe('water plants');
      expect(await api.listTasks()).toHaveLength(0);
      await user.click(screen.getByRole('button', { name: 'Save as typed' }));
      await waitFor(async () =>
        expect((await api.listTasks())[0]).toMatchObject({ title: 'water plants' }),
      );
    });

    it('a failed Review says so in the preview, and ⌘Enter saves the line as typed', async () => {
      const { api, user, box } = await taskBar();
      const parse = vi.spyOn(api, 'parseTask');
      localStorage.setItem(STUB_FAIL_NEXT_PARSE_KEY, '1');
      await user.type(box(), 'admin, file taxes');
      await user.click(screen.getByRole('button', { name: 'Review before saving' }));
      expect(await screen.findByText(/Couldn’t parse \(unavailable/)).toBeTruthy();
      await user.keyboard('{Meta>}{Enter}{/Meta}');
      await waitFor(async () =>
        expect((await api.listTasks())[0]).toMatchObject({
          title: 'admin, file taxes',
          categoryId: null,
        }),
      );
      expect(parse).toHaveBeenCalledTimes(1);
    });

    it('a failed create puts the typed text back and says so', async () => {
      const { api, user, box } = await taskBar();
      api.createTask = () => Promise.reject(new Error('offline'));
      await user.type(box(), 'admin, file taxes 30m');
      await reviewThenSave(user);
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
      await reviewThenSave(user);
      await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
      await user.type(box(), 'second');
      await reviewThenSave(user);
      await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(2));
      reject(new Error('offline'));
      expect(await screen.findByText(/Couldn't save/)).toBeTruthy();
      await waitFor(() => expect(box().value).toBe('first'));
    });

    // The restore above only works into an empty field. A create can take seconds, so by the time it
    // fails the user may be mid-way through the next capture — that one must not be overwritten.
    it('a failed save never overwrites a newer capture: it is parked, and Put back trades places', async () => {
      const { api, user, box } = await taskBar();
      let reject!: (e: Error) => void;
      api.createTask = vi.fn().mockReturnValueOnce(new Promise((_, r) => (reject = r)));
      await user.type(box(), 'first');
      await reviewThenSave(user);
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

    // While the parse runs the text is still in the field, so nothing can be lost; once the save clears the
    // field, the capture is in the outbox until its create settles.
    it('a task capture sits in the outbox through the create, until it settles', async () => {
      const { api, user, box } = await taskBar();
      let landed!: (r: ParseTaskResult) => void;
      vi.spyOn(api, 'parseTask').mockReturnValueOnce(new Promise((r) => (landed = r)));
      const real = api.createTask.bind(api);
      let created!: () => void;
      api.createTask = vi.fn(
        (input) => new Promise((r) => (created = () => r(real(input)))),
      ) as typeof api.createTask;
      const outbox = () => JSON.parse(localStorage.getItem(CAPTURE_OUTBOX_KEY) ?? '[]');
      await user.type(box(), 'call bank');
      await user.keyboard('{Enter}');
      expect(box().value).toBe('call bank'); // parsing: the field still holds it
      expect(outbox()).toEqual([]);
      await act(async () => landed(parsed('call bank')));
      await screen.findByRole('button', { name: 'Save reviewed task' });
      expect(outbox()).toEqual([]);
      await user.keyboard('{Enter}');
      expect(box().value).toBe('');
      expect(outbox()).toMatchObject([{ text: 'call bank', mode: 'task', toToday: false }]);
      await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
      expect(outbox()).toHaveLength(1); // sent, but the create hasn't landed
      created();
      await waitFor(async () => expect((await api.listTasks())[0]?.title).toBe('call bank'));
      await waitFor(() => expect(localStorage.getItem(CAPTURE_OUTBOX_KEY)).toBeNull());
    });

    it('a failed create leaves the outbox for the field or the parked list — never neither', async () => {
      const { api, user, box } = await taskBar();
      let reject!: (e: Error) => void;
      api.createTask = vi.fn().mockReturnValueOnce(new Promise((_, r) => (reject = r)));
      await user.type(box(), 'first');
      await reviewThenSave(user);
      await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
      await user.type(box(), 'busy');
      reject(new Error('offline'));
      await screen.findByText('Couldn’t save: “first”');
      await waitFor(() => expect(localStorage.getItem(CAPTURE_OUTBOX_KEY)).toBeNull());
      expect(JSON.parse(localStorage.getItem(CAPTURE_PARKED_KEY)!)).toMatchObject([
        { text: 'first', why: 'failed' },
      ]);
    });

    it('"→ today" quick-add captures leave the outbox too, planned or not', async () => {
      const { api, user, box } = await taskBar();
      api.upsertPlan = () => Promise.reject(new Error('offline'));
      await user.click(screen.getByRole('button', { name: 'today' }));
      await user.type(box(), 'pay rent');
      await reviewThenSave(user);
      expect(await screen.findByText(/couldn’t plan it/)).toBeTruthy();
      expect(localStorage.getItem(CAPTURE_OUTBOX_KEY)).toBeNull();
    });

    it('parked captures survive closing the app again', async () => {
      const { api, user, box } = await taskBar();
      let reject!: (e: Error) => void;
      api.createTask = vi.fn().mockReturnValueOnce(new Promise((_, r) => (reject = r)));
      await user.type(box(), 'first');
      await reviewThenSave(user);
      await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
      await user.type(box(), 'busy'); // the field is taken by the time the save fails
      reject(new Error('offline'));
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

    it('Send on a failed preview parses again; the preview reads due dates relatively', async () => {
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
      expect(screen.queryByRole('button', { name: 'Read with AI' })).toBeNull();
      expect(screen.queryByRole('button', { name: /Review|Retry/ })).toBeNull();
      await user.keyboard('{Meta>}{Enter}{/Meta}');
      await waitFor(async () =>
        expect((await api.listTasks())[0]).toMatchObject({ title: 'memo', estimateMin: 30 }),
      );
    });

    it('Send keeps focus in the field (the phone keyboard stays up)', async () => {
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

    it('"→ today" plans a quick-added task, saved by Enter and by Send', async () => {
      const { api, user, box } = await taskBar();
      const today = todayKey(4);
      await user.click(screen.getByRole('button', { name: 'today' }));
      await user.type(box(), 'admin, pay rent 10m');
      await reviewThenSave(user);
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

describe('CaptureBar — Review category suggestion', () => {
  // Synthetic history: two categories, twelve tasks each, with their own vocabulary.
  const history = {
    Garden: [
      'water the tomato beds',
      'prune the rose hedge',
      'spread mulch on the border',
      'sow carrot seeds',
      'stake the bean poles',
      'weed the herb patch',
      'repot the fern',
      'trim the lawn edge',
      'turn the compost heap',
      'plant tulip bulbs',
      'net the berry bushes',
      'rake the fallen leaves',
    ],
    Kitchen: [
      'descale the kettle',
      'sharpen the chef knife',
      'clean the oven racks',
      'restock the pantry shelf',
      'season the cast skillet',
      'defrost the freezer drawer',
      'wipe the range hood',
      'sort the spice rack',
      'replace the sink filter',
      'scrub the cutting board',
      'organise the baking tins',
      'degrease the stove top',
    ],
  };
  const LINE = 'mulch the tomato beds';
  const seededBar = () => taskBar({ categories: ['Garden', 'Kitchen'], history });
  const review = (user: Awaited<ReturnType<typeof taskBar>>['user']) =>
    user.click(screen.getByRole('button', { name: 'Review before saving' }));
  const chip = () => screen.queryByRole('button', { name: /^Use suggested category/ });
  const saved = async (api: Awaited<ReturnType<typeof taskBar>>['api'], title: string) =>
    (await api.listTasks()).find((t) => t.title === title);
  // "No chip" means nothing until the list it scores has landed: "no category" shows before that.
  const listLanded = async (list: Awaited<ReturnType<typeof taskBar>>['list']) => {
    await waitFor(() => expect(list).toHaveResolved());
    await act(async () => {});
  };

  it('a confident parse with no category shows the chip; the tap writes nothing, the next press saves it', async () => {
    const { api, user, box } = await seededBar();
    const parse = vi.spyOn(api, 'parseTask');
    const garden = (await api.listCategories()).find((c) => c.label === 'Garden')!;
    const before = (await api.listTasks()).length;
    await user.type(box(), LINE);
    await review(user);
    const suggested = await screen.findByRole('button', { name: 'Use suggested category Garden' });
    expect(suggested.textContent).toBe('Garden?');
    expect(screen.queryByText('no category')).toBeNull();
    await user.click(suggested);
    expect(chip()).toBeNull();
    expect(screen.getByText('#Garden')).toBeTruthy();
    expect(box().value).toBe(LINE); // the text stays until you save
    expect(document.activeElement).toBe(box()); // the phone keyboard stays up
    expect(await api.listTasks()).toHaveLength(before);
    await user.click(screen.getByRole('button', { name: 'Save reviewed task' }));
    await waitFor(async () => expect((await saved(api, LINE))?.categoryId).toBe(garden.id));
    expect(parse).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(`${LINE} · Garden`)).toBeTruthy();
  });

  it('is never pre-selected: saving a Review without the tap stays uncategorised', async () => {
    const { api, user, box } = await seededBar();
    await user.type(box(), LINE);
    await review(user);
    await screen.findByRole('button', { name: 'Use suggested category Garden' });
    await user.keyboard('{Enter}');
    await waitFor(async () => expect((await saved(api, LINE))?.categoryId).toBeNull());
    expect(await screen.findByText(`${LINE} · no category`)).toBeTruthy();
  });

  it('⌘Enter past an untapped chip, or ✨ off, never takes a suggestion', async () => {
    const { api, user, box } = await seededBar();
    await user.type(box(), LINE);
    await review(user);
    await screen.findByRole('button', { name: 'Use suggested category Garden' });
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(async () => expect((await saved(api, LINE))?.categoryId).toBeNull());
    expect(chip()).toBeNull();
    await user.type(box(), `${LINE} too`);
    await user.click(screen.getByRole('button', { name: 'Read with AI' }));
    await user.keyboard('{Enter}');
    await waitFor(async () => expect((await saved(api, `${LINE} too`))?.categoryId).toBeNull());
    expect(chip()).toBeNull();
  });

  it('keeps saying "no category" for a title the history can’t place', async () => {
    const { user, box, list } = await seededBar();
    await user.type(box(), 'quarterly filing');
    await review(user);
    expect(await screen.findByText('no category')).toBeTruthy();
    await listLanded(list);
    expect(screen.getByText('no category')).toBeTruthy();
    expect(chip()).toBeNull();
  });

  it('keeps saying "no category" under the history floor', async () => {
    const { user, box, list } = await taskBar({
      categories: ['Garden', 'Kitchen'],
      history: { Garden: history.Garden.slice(0, 5), Kitchen: history.Kitchen.slice(0, 5) },
    });
    await user.type(box(), LINE);
    await review(user);
    expect(await screen.findByText('no category')).toBeTruthy();
    await listLanded(list);
    expect(screen.getByText('no category')).toBeTruthy();
    expect(chip()).toBeNull();
  });

  it('shows no chip when the parse found a category, even one the history disagrees with', async () => {
    const { user, box, list } = await seededBar();
    await user.type(box(), `kitchen, ${LINE}`);
    await review(user);
    expect(await screen.findByText('#Kitchen')).toBeTruthy();
    expect(chip()).toBeNull();
    expect(list).not.toHaveBeenCalled(); // the slot never mounted
  });

  it('shows no chip on a grammar line', async () => {
    const { user, box, list } = await seededBar();
    await user.type(box(), `${LINE} | ~30`);
    expect((await screen.findAllByText('30m')).length).toBeGreaterThan(0);
    expect(chip()).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it('shows no chip on a failed parse', async () => {
    const { user, box, list } = await seededBar();
    globalThis.localStorage.setItem(STUB_FAIL_NEXT_PARSE_KEY, '1');
    await user.type(box(), LINE);
    await review(user);
    expect(await screen.findByText(/Couldn’t parse/)).toBeTruthy();
    expect(chip()).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it('editing the text drops a taken chip: the next Review offers it again, untaken', async () => {
    const { api, user, box } = await seededBar();
    await user.type(box(), LINE);
    await review(user);
    await user.click(await screen.findByRole('button', { name: 'Use suggested category Garden' }));
    await user.type(box(), ' again');
    expect(screen.queryByText('#Garden')).toBeNull();
    await review(user);
    await screen.findByRole('button', { name: 'Use suggested category Garden' });
    await user.keyboard('{Enter}');
    await waitFor(async () => expect((await saved(api, `${LINE} again`))?.categoryId).toBeNull());
  });

  it('by keyboard, the chip hands focus back to the field as it goes', async () => {
    const { user, box } = await seededBar();
    await user.type(box(), LINE);
    await review(user);
    (await screen.findByRole('button', { name: 'Use suggested category Garden' })).focus();
    await user.keyboard('{Enter}');
    expect(chip()).toBeNull();
    expect(document.activeElement).toBe(box());
  });

  // The chip is the only reader: a capture that shows no preview never fetches the history it scores.
  it('a grammar, ✨-off or ⌘Enter capture never reads the task list', async () => {
    const { api, user, box, list } = await taskBar();
    const create = vi.spyOn(api, 'createTask'); // waits on this: saved() would read the list itself
    await user.type(box(), 'memo | ~30');
    await user.keyboard('{Enter}');
    await screen.findByText(/Task added/);
    await user.type(box(), 'file taxes');
    await user.click(screen.getByRole('button', { name: 'Read with AI' }));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    await user.type(box(), 'water plants');
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() => expect(create).toHaveBeenCalledTimes(3));
    await act(async () => {});
    expect(list).not.toHaveBeenCalled();
    expect(create.mock.calls.map(([i]) => i.title)).toEqual(['memo', 'file taxes', 'water plants']);
  });

  it('a failed create puts the text back with the tap; the retry saves under it, without parsing again', async () => {
    const { api, user, box } = await seededBar();
    const parse = vi.spyOn(api, 'parseTask');
    const garden = (await api.listCategories()).find((c) => c.label === 'Garden')!;
    await user.type(box(), LINE);
    await review(user);
    await user.click(await screen.findByRole('button', { name: 'Use suggested category Garden' }));
    vi.spyOn(api, 'createTask').mockRejectedValueOnce(new Error('offline'));
    await user.click(screen.getByRole('button', { name: 'Save reviewed task' }));
    await waitFor(() => expect(box().value).toBe(LINE));
    expect(await screen.findByText('#Garden')).toBeTruthy();
    await user.keyboard('{Enter}');
    await waitFor(async () => expect((await saved(api, LINE))?.categoryId).toBe(garden.id));
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('switching modes drops a taken chip', async () => {
    const { api, user, box } = await seededBar();
    await user.type(box(), LINE);
    await review(user);
    await user.click(await screen.findByRole('button', { name: 'Use suggested category Garden' }));
    await user.click(screen.getByRole('button', { name: 'Log' }));
    expect(screen.queryByText('#Garden')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Task' }));
    expect(screen.queryByText('#Garden')).toBeNull();
    await user.click(box());
    await user.keyboard('{Enter}'); // read again: the chip is offered afresh, untaken
    await screen.findByRole('button', { name: 'Use suggested category Garden' });
    expect(screen.queryByText('#Garden')).toBeNull();
    await user.keyboard('{Enter}');
    await waitFor(async () => expect((await saved(api, LINE))?.categoryId).toBeNull());
  });

  it('"→ today" with a taken chip plans it under that category', async () => {
    const { api, user, box } = await seededBar();
    const garden = (await api.listCategories()).find((c) => c.label === 'Garden')!;
    await user.type(box(), LINE);
    await review(user);
    await user.click(await screen.findByRole('button', { name: 'Use suggested category Garden' }));
    await user.click(screen.getByRole('button', { name: /today/i }));
    await user.keyboard('{Enter}');
    await waitFor(async () => expect((await saved(api, LINE))?.categoryId).toBe(garden.id));
    const { id } = (await saved(api, LINE))!;
    await waitFor(async () =>
      expect((await api.listPlansForDay(todayKey(4))).map((p) => p.taskId)).toContain(id),
    );
  });

  it('switching modes while the save is pending still gets the tap back when it fails', async () => {
    const { api, user, box } = await seededBar();
    await user.type(box(), LINE);
    await review(user);
    await user.click(await screen.findByRole('button', { name: 'Use suggested category Garden' }));
    let fail!: (e: Error) => void;
    vi.spyOn(api, 'createTask').mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: 'Log' }));
    await act(async () => fail(new Error('offline')));
    expect(box().value).toBe(LINE);
    expect(await screen.findByText('#Garden')).toBeTruthy();
  });

  it('a rolled-over preview never saves, taken category included: the next press parses again', async () => {
    const { api, user, box } = await seededBar();
    const garden = (await api.listCategories()).find((c) => c.label === 'Garden')!;
    const parse = vi.spyOn(api, 'parseTask').mockResolvedValueOnce({
      ok: true,
      source: 'haiku',
      input: { title: 'yesterday parse', categoryId: garden.id },
      categoryLabel: 'Garden',
      placeName: null,
      dropped: [],
      today: addDays(todayKey(4), -1),
    });
    await user.type(box(), LINE);
    await review(user);
    await waitFor(() => expect(parse).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.queryByText('yesterday parse')).toBeNull(); // hidden: its day has gone
    expect(screen.getByRole('button', { name: 'Review before saving' })).toBeTruthy();
    expect(await api.listTasks()).toHaveLength(24); // the seeded history only
    await reviewThenSave(user);
    await waitFor(async () => expect(await saved(api, LINE)).toBeTruthy());
    expect(parse).toHaveBeenCalledTimes(2);
    expect(await saved(api, 'yesterday parse')).toBeUndefined();
    expect((await saved(api, LINE))?.categoryId).toBeNull(); // the stale parse's Garden didn't carry
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
    const { api, user, box } = await placeBar({ more: ['Counter'] });
    await user.type(box(), 'milk | @co');
    await screen.findByRole('group', { name: 'Suggestions' });
    expect(screen.queryByText(/could be/)).toBeNull(); // mid-word: the chips speak
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/Not saved/)).toBeTruthy();
    expect(screen.getByText('@co could be Corner Shop or Counter — pick one')).toBeTruthy();
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
    expect(await screen.findByText('@Corner Shop')).toBeTruthy(); // previewed before it saves
    expect(await api.listTasks()).toHaveLength(0);
    await user.keyboard('{Enter}');
    await waitFor(async () =>
      expect((await api.listTasks())[0]).toMatchObject({ title: 'milk', place: 'corner' }),
    );
    expect(await screen.findByText('milk · no category · @Corner Shop')).toBeTruthy();
    expect(screen.getByText(/Task added → Corner Shop/)).toBeTruthy();
  });
});

describe('CaptureBar private log', () => {
  function logBar(key: string) {
    const api = createStubClient({ seed: false, storageKey: `cap-priv-${key}` });
    const user = userEvent.setup();
    renderWithProviders(<CaptureBar />, { api });
    const pill = () => screen.getByRole('button', { name: 'private' });
    const saved = async (text: string) => {
      let found: { private?: boolean } | undefined;
      await waitFor(async () => {
        found = (await api.listLogEntries(todayKey(4))).find((e) => e.text === text);
        expect(found).toBeTruthy();
      });
      return found!;
    };
    return { api, user, pill, saved };
  }

  it('the private pill logs the next entry private, then resets', async () => {
    const { user, pill, saved } = logBar('pill');
    await user.click(pill());
    expect(pill().getAttribute('aria-pressed')).toBe('true');
    await user.type(field(), 'first');
    await user.keyboard('{Enter}');
    expect((await saved('first')).private).toBe(true);
    expect(await screen.findByText(/Logged privately/)).toBeTruthy();
    expect(pill().getAttribute('aria-pressed')).toBe('false');
    await user.type(field(), 'second');
    await user.keyboard('{Enter}');
    expect((await saved('second')).private).toBe(false);
  });

  it('tapping the pill twice saves public', async () => {
    const { user, pill, saved } = logBar('twice');
    await user.click(pill());
    await user.click(pill());
    await user.type(field(), 'plain');
    await user.keyboard('{Enter}');
    expect((await saved('plain')).private).toBe(false);
  });

  it('the pill shows only in Log mode, and a mode change drops it', async () => {
    const { user, pill } = logBar('mode');
    await user.click(pill());
    await user.click(screen.getByRole('button', { name: 'Idea' }));
    expect(screen.queryByRole('button', { name: 'private' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Log' }));
    expect(pill().getAttribute('aria-pressed')).toBe('false');
  });

  it('a sensitive line shows the nudge and holds the first Enter; the second saves it public', async () => {
    const { api, user, saved } = logBar('hold');
    await user.type(field(), 'disk password is hunter2');
    expect(screen.getByText('Looks sensitive — make it private?')).toBeTruthy();
    expect(field().getAttribute('aria-describedby')).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(field().value).toBe('disk password is hunter2');
    expect(screen.getByText('Looks sensitive — Enter again saves it as is')).toBeTruthy();
    expect(await api.listLogEntries(todayKey(4))).toHaveLength(0);
    await user.keyboard('{Enter}');
    expect((await saved('disk password is hunter2')).private).toBe(false);
    expect(screen.queryByText(/Looks sensitive/)).toBeNull();
  });

  it('Make private on the nudge arms the pill without saving, and Enter saves private', async () => {
    const { api, user, pill, saved } = logBar('make');
    await user.type(field(), 'wifi pw: abc');
    await user.click(screen.getByRole('button', { name: 'Make private' }));
    expect(pill().getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText(/Looks sensitive/)).toBeNull();
    expect(await api.listLogEntries(todayKey(4))).toHaveLength(0);
    await user.keyboard('{Enter}');
    expect((await saved('wifi pw: abc')).private).toBe(true);
  });

  it('Not this one dismisses the nudge for the draft, and Enter saves at once', async () => {
    const { user, saved } = logBar('dismiss');
    await user.type(field(), 'garage code 1234');
    await user.click(screen.getByRole('button', { name: 'Not this one' }));
    expect(screen.queryByText(/Looks sensitive/)).toBeNull();
    await user.type(field(), ', and the pin 5678');
    expect(screen.queryByText(/Looks sensitive/)).toBeNull();
    await user.keyboard('{Enter}');
    expect((await saved('garage code 1234, and the pin 5678')).private).toBe(false);
    // the next draft gets its own nudge
    await user.type(field(), 'new password');
    expect(screen.getByText('Looks sensitive — make it private?')).toBeTruthy();
  });

  it('a line like "pinned the keyboard PR" gets no nudge and saves on the first Enter', async () => {
    const { user, saved } = logBar('fp');
    await user.type(field(), 'pinned the keyboard PR, leetcode later');
    expect(screen.queryByText(/Looks sensitive/)).toBeNull();
    await user.keyboard('{Enter}');
    expect((await saved('pinned the keyboard PR, leetcode later')).private).toBe(false);
  });

  it('a failed private save comes back still private', async () => {
    const { api, user, pill } = logBar('fail');
    const real = api.createLogEntry.bind(api);
    api.createLogEntry = () => Promise.reject(new Error('offline'));
    await user.click(pill());
    await user.type(field(), 'secret thing');
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/Couldn't save/)).toBeTruthy();
    await waitFor(() => expect(field().value).toBe('secret thing'));
    expect(pill().getAttribute('aria-pressed')).toBe('true');
    api.createLogEntry = real;
  });

  it('a sensitive draft whose save failed retries on one Enter', async () => {
    const { api, user, saved } = logBar('nudge-retry');
    const real = api.createLogEntry.bind(api);
    api.createLogEntry = () => Promise.reject(new Error('offline'));
    await user.type(field(), 'disk password is hunter2');
    await user.keyboard('{Enter}{Enter}');
    expect(await screen.findByText(/Couldn't save/)).toBeTruthy();
    await waitFor(() => expect(field().value).toBe('disk password is hunter2'));
    api.createLogEntry = real;
    await user.keyboard('{Enter}');
    expect((await saved('disk password is hunter2')).private).toBe(false);
  });

  it('a failed private save parked behind a newer draft puts back private', async () => {
    let fail!: (e: Error) => void;
    const { api, user, pill } = logBar('park');
    const real = api.createLogEntry.bind(api);
    api.createLogEntry = () => new Promise((_, rej) => (fail = rej));
    await user.click(pill());
    await user.type(field(), 'locked one');
    await user.keyboard('{Enter}');
    await user.type(field(), 'newer');
    await act(async () => fail(new Error('offline')));
    api.createLogEntry = real;
    await user.click(await screen.findByRole('button', { name: 'Put back' }));
    expect(field().value).toBe('locked one');
    expect(pill().getAttribute('aria-pressed')).toBe('true');
  });

  it('a sensitive draft put back after a failed save retries on one Enter', async () => {
    let fail!: (e: Error) => void;
    const { api, user, saved } = logBar('park-nudge');
    const real = api.createLogEntry.bind(api);
    api.createLogEntry = () => new Promise((_, rej) => (fail = rej));
    await user.type(field(), 'disk password is hunter2');
    await user.keyboard('{Enter}{Enter}');
    await user.type(field(), 'newer');
    await act(async () => fail(new Error('offline')));
    api.createLogEntry = real;
    await user.clear(field());
    await user.click(await screen.findByRole('button', { name: 'Put back' }));
    await user.keyboard('{Enter}');
    expect((await saved('disk password is hunter2')).private).toBe(false);
  });
});
