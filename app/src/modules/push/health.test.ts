import { describe, expect, it } from 'vitest';
import { PUSH_STALE_MS } from '@aperture/shared';
import { deviceLines, fmtWhen, pollerLines } from './health';

const NOW = new Date(2026, 10, 4, 14, 30).getTime(); // Nov 4, 2:30pm local
const at = (h: number, m: number, day = 4) => new Date(2026, 10, day, h, m).getTime();
const idle = { lastRunAt: null, lastSentAt: null, lastError: null, lastErrorAt: null };

describe('reminder health lines', () => {
  it('times read as a clock today and a date before', () => {
    expect(fmtWhen(at(14, 2), NOW)).toBe('2:02pm');
    expect(fmtWhen(at(9, 0, 3), NOW)).toBe('Nov 3 9am');
  });

  it('the poller: never ran, fresh, and paused once the heartbeat is past PUSH_STALE_MS', () => {
    expect(pollerLines(idle, NOW)).toEqual([
      { tone: 'muted', text: 'Reminder checks haven’t run yet — nothing has been sent.' },
    ]);
    expect(pollerLines({ ...idle, lastRunAt: NOW - 20_000 }, NOW)[0]!.text).toBe(
      'Reminders on · checked just now',
    );
    expect(pollerLines({ ...idle, lastRunAt: NOW - PUSH_STALE_MS }, NOW)[0]!.tone).toBe('muted');
    expect(pollerLines({ ...idle, lastRunAt: at(14, 2), lastSentAt: at(9, 0) }, NOW)[0]).toEqual({
      tone: 'danger',
      text: 'Reminders paused since 2:02pm · last sent 9am',
    });
  });

  it('an error stands until a later success supersedes it', () => {
    const p = {
      lastRunAt: NOW,
      lastSentAt: at(9, 0),
      lastError: 'push_guard_tripped',
      lastErrorAt: at(10, 0),
    };
    expect(pollerLines(p, NOW)[1]).toEqual({
      tone: 'danger',
      text: 'Last problem: push_guard_tripped (10am)',
    });
    expect(pollerLines({ ...p, lastSentAt: at(11, 0) }, NOW)).toHaveLength(1);
  });

  it('a device: added, last sent, and its standing error', () => {
    const d = {
      id: 'd1',
      label: 'iPhone · Safari',
      createdAt: at(8, 0, 1),
      lastOkAt: null,
      lastError: '410 Gone',
      lastErrorAt: at(14, 0),
    };
    expect(deviceLines(d, NOW)).toEqual([
      { tone: 'muted', text: 'Added Nov 1 8am · nothing sent yet' },
      { tone: 'danger', text: 'Last error: 410 Gone (2pm)' },
    ]);
    expect(deviceLines({ ...d, lastOkAt: at(14, 10) }, NOW)).toEqual([
      { tone: 'muted', text: 'Added Nov 1 8am · last sent 2:10pm' },
    ]);
  });
});
