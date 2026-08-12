import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { todayKey } from '@aperture/shared';
import { renderWithProviders } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';
import { CaptureBar } from './CaptureBar';

beforeEach(() => globalThis.localStorage?.clear());

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
    // still Log mode (never asked for structure, snapped back)
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
});
