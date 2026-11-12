import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LogEntry } from '@aperture/shared';
import { LogEntryRow } from './LogEntryRow';

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  id: 'e1',
  userId: 'u',
  createdAt: Date.parse('2026-08-04T17:00:00Z'),
  updatedAt: 0,
  deletedAt: null,
  day: '2026-08-04',
  text: 'disk pw',
  ...over,
});

function row(e: LogEntry) {
  const onTogglePrivate = vi.fn();
  render(
    <ul>
      <LogEntryRow entry={e} onSave={vi.fn()} onTogglePrivate={onTogglePrivate} />
    </ul>,
  );
  return onTogglePrivate;
}

afterEach(cleanup);

describe('LogEntryRow lock', () => {
  it('reads pressed on a private entry, keeps the text visible, and toggles on tap', async () => {
    const toggle = row(entry({ private: true }));
    const lock = screen.getByRole('button', { name: 'Private entry' });
    expect(lock.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('disk pw')).toBeTruthy();
    await userEvent.click(lock);
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('is unpressed on an entry stored before the flag existed', () => {
    row(entry());
    expect(screen.getByRole('button', { name: 'Private entry' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('stays reachable while the text is being edited', async () => {
    const toggle = row(entry({ private: false }));
    await userEvent.click(screen.getByTitle('Edit this entry'));
    expect(screen.getByRole('textbox', { name: 'Edit entry' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Private entry' }));
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});
