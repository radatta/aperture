import { describe, expect, it } from 'vitest';
import {
  calendarPullPlan,
  isPullFresh,
  PULL_REMOVED_NOTE,
  pullNote,
  type PulledEvent,
} from './calendarPull';
import { gcalSyncMessage } from './calendarSync';
import { localEpochFromDayTime, zonedDayTime, zonedEpoch } from './dates';
import type { DueClock, DueEpoch } from './due';
import type { Task } from './types';

// A toy October clock: day N of the month = N days of ms, plus the wall minutes.
const pad = (n: number) => String(n).padStart(2, '0');
const epoch: DueEpoch = (day, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return Number(day.slice(-2)) * 86_400_000 + (h * 60 + m) * 60_000;
};
const clock: DueClock = (ms) => {
  const min = Math.round((ms % 86_400_000) / 60_000);
  return {
    day: `2026-10-${pad(Math.floor(ms / 86_400_000))}`,
    hhmm: `${pad(Math.floor(min / 60))}:${pad(min % 60)}`,
  };
};
type T = Parameters<typeof calendarPullPlan>[0];
const task = (over: Partial<T> = {}): T => ({
  title: 'pset',
  status: 'planned',
  dueDay: '2026-10-05',
  dueTime: '16:00',
  estimateMin: 60,
  gcalSyncError: null,
  gcalTouchedAt: 1_000,
  ...over,
});
const END = epoch('2026-10-05', '16:00');
// The event exactly as the task's push left it (title + window), edited in Google at `updatedMs`.
const event = (over: Partial<PulledEvent> = {}): PulledEvent => ({
  eventId: 'evt',
  cancelled: false,
  recurring: false,
  title: 'pset',
  allDay: false,
  startMs: END - 60 * 60_000,
  endMs: END,
  updatedMs: 2_000,
  ...over,
});

describe('calendarPullPlan', () => {
  it('our own push coming back (event matches the task) is a no-op', () => {
    expect(calendarPullPlan(task(), event(), clock)).toEqual({ kind: 'none' });
  });
  it('a no-estimate task’s default 30-minute block is a no-op — never writes estimateMin = 30', () => {
    const t = task({ estimateMin: null });
    expect(calendarPullPlan(t, event({ startMs: END - 30 * 60_000 }), clock).kind).toBe('none');
    expect(
      calendarPullPlan(task({ estimateMin: 0 }), event({ startMs: END - 30 * 60_000 }), clock).kind,
    ).toBe('none');
  });
  it('the end moves the deadline (day and time)', () => {
    const end = epoch('2026-10-09', '17:00');
    expect(
      calendarPullPlan(task(), event({ startMs: end - 60 * 60_000, endMs: end }), clock),
    ).toEqual({
      kind: 'apply',
      fields: { dueDay: '2026-10-09', dueTime: '17:00' },
      note: 'Moved to Oct 9 5pm in Google Calendar',
    });
  });
  it('the start sets the working estimate, rounded to the minute', () => {
    const a = calendarPullPlan(task(), event({ startMs: END - 45 * 60_000 - 20_000 }), clock);
    expect(a).toEqual({
      kind: 'apply',
      fields: { estimateMin: 45 },
      note: 'Now 45m in Google Calendar',
    });
  });
  it('any block length is taken as-is (very short, very long)', () => {
    expect(calendarPullPlan(task(), event({ startMs: END - 5 * 60_000 }), clock)).toMatchObject({
      fields: { estimateMin: 5 },
    });
    expect(calendarPullPlan(task(), event({ startMs: END - 360 * 60_000 }), clock)).toMatchObject({
      fields: { estimateMin: 360 },
      note: 'Now 6h in Google Calendar',
    });
  });
  it('an in-progress task takes the estimate too (only done/cancelled are frozen)', () => {
    expect(
      calendarPullPlan(
        task({ status: 'in_progress' }),
        event({ startMs: END - 90 * 60_000 }),
        clock,
      ),
    ).toMatchObject({ kind: 'apply', fields: { estimateMin: 90 } });
  });
  it('a rename in Google renames the task (trimmed; a blank title is ignored)', () => {
    expect(calendarPullPlan(task(), event({ title: '  pset 3 ' }), clock)).toEqual({
      kind: 'apply',
      fields: { title: 'pset 3' },
      note: 'Renamed to “pset 3” in Google Calendar',
    });
    expect(calendarPullPlan(task(), event({ title: '  ' }), clock).kind).toBe('none');
    expect(calendarPullPlan(task(), event({ title: null }), clock).kind).toBe('none');
  });
  it('everything at once reads as one line', () => {
    const end = epoch('2026-10-06', '09:30');
    const a = calendarPullPlan(
      task(),
      event({ title: 'x', startMs: end - 45 * 60_000, endMs: end }),
      clock,
    );
    expect(a).toMatchObject({
      note: 'Moved to Oct 6 9:30am · Now 45m · Renamed to “x” in Google Calendar',
    });
  });
  it('done: the end and title apply, a start drag is ignored', () => {
    const done = task({ status: 'done' });
    expect(calendarPullPlan(done, event({ startMs: END - 90 * 60_000 }), clock).kind).toBe('none');
    const end = epoch('2026-10-06', '16:00');
    expect(
      calendarPullPlan(done, event({ title: 'y', startMs: end - 90 * 60_000, endMs: end }), clock),
    ).toMatchObject({
      kind: 'apply',
      fields: { title: 'y', dueDay: '2026-10-06', dueTime: '16:00' },
    });
  });
  it('cancelled: nothing, even a deletion (its event went with the cancel)', () => {
    const c = task({ status: 'cancelled' });
    expect(calendarPullPlan(c, event({ title: 'z' }), clock).kind).toBe('none');
    expect(calendarPullPlan(c, event({ cancelled: true }), clock).kind).toBe('none');
  });
  it('deleted or moved away in Google → unlink, whatever `updated` says', () => {
    expect(
      calendarPullPlan(
        task({ gcalTouchedAt: 9e15 }),
        event({ cancelled: true, title: null }),
        clock,
      ),
    ).toEqual({
      kind: 'unlink',
      note: PULL_REMOVED_NOTE,
    });
  });
  it('an all-day conversion ignores the time; the title still syncs', () => {
    const allDay = event({ allDay: true, startMs: null, endMs: null });
    expect(calendarPullPlan(task(), allDay, clock).kind).toBe('none');
    expect(calendarPullPlan(task(), { ...allDay, title: 'q' }, clock)).toMatchObject({
      fields: { title: 'q' },
    });
  });
  it('a manual block (untimed task) syncs the title only', () => {
    const manual = task({ dueTime: null });
    expect(calendarPullPlan(manual, event({ startMs: 0, endMs: 3_600_000 }), clock).kind).toBe(
      'none',
    );
    expect(
      calendarPullPlan(manual, event({ title: 'm', startMs: 0, endMs: 3_600_000 }), clock),
    ).toEqual({
      kind: 'apply',
      fields: { title: 'm' },
      note: 'Renamed to “m” in Google Calendar',
    });
  });
  it('a manual block on a timed task (picker / MCP) syncs the title only', () => {
    const manual = task({ gcalManual: true });
    const end = epoch('2026-10-05', '11:00');
    expect(
      calendarPullPlan(manual, event({ startMs: end - 15 * 60_000, endMs: end }), clock).kind,
    ).toBe('none');
    expect(
      calendarPullPlan(manual, event({ title: 'm', startMs: 0, endMs: 60_000 }), clock),
    ).toMatchObject({
      fields: { title: 'm' },
    });
  });
  it('made recurring in Google → ignored', () => {
    expect(calendarPullPlan(task(), event({ recurring: true, title: 'r' }), clock).kind).toBe(
      'none',
    );
  });
  it('latest wins: an Aperture change newer than the Google edit stands', () => {
    const edited = event({ title: 'g' });
    expect(calendarPullPlan(task({ gcalTouchedAt: 3_000 }), edited, clock).kind).toBe('none');
    expect(calendarPullPlan(task({ gcalTouchedAt: 1_000 }), edited, clock).kind).toBe('apply');
    expect(calendarPullPlan(task({ gcalTouchedAt: undefined }), edited, clock).kind).toBe('apply');
  });
  it('an owed removal is never pulled into', () => {
    const owed = task({ gcalSyncError: gcalSyncMessage('delete', 'x') });
    expect(calendarPullPlan(owed, event({ title: 'g' }), clock).kind).toBe('none');
  });
  it('a failed push (create/patch) does not block the pull', () => {
    const failed = task({ gcalSyncError: gcalSyncMessage('patch', 'x'), gcalTouchedAt: 1_000 });
    expect(calendarPullPlan(failed, event({ title: 'g' }), clock).kind).toBe('apply');
  });
  it('the repeated fall-back hour is idempotent with a real zone clock', () => {
    const tz = 'America/Los_Angeles';
    const zClock: DueClock = (ms) => zonedDayTime(ms, tz);
    // 1:30am on 2026-11-01 happens twice; the task resolves to the first (zonedEpoch's choice).
    const t = task({ dueDay: '2026-11-01', dueTime: '01:30', estimateMin: 30 });
    const first = zonedEpoch('2026-11-01', '01:30', tz);
    expect(
      calendarPullPlan(t, event({ startMs: first - 30 * 60_000, endMs: first }), zClock).kind,
    ).toBe('none');
    // The second 1:30am (an hour later) reads the same wall clock → still no change to write.
    const second = first + 3_600_000;
    expect(
      calendarPullPlan(t, event({ startMs: second - 30 * 60_000, endMs: second }), zClock).kind,
    ).toBe('none');
  });
});

describe('pullNote', () => {
  it('truncates a long title', () => {
    expect(pullNote({ title: 'a'.repeat(60) })).toBe(
      `Renamed to “${'a'.repeat(39)}…” in Google Calendar`,
    );
  });
});

describe('isPullFresh', () => {
  const at = localEpochFromDayTime('2026-10-05', '10:00');
  it('shows until the next 4am rollover, then clears', () => {
    const t = { gcalPulledAt: at };
    expect(isPullFresh(t, 4, localEpochFromDayTime('2026-10-05', '23:00'))).toBe(true);
    expect(isPullFresh(t, 4, localEpochFromDayTime('2026-10-06', '03:59'))).toBe(true);
    expect(isPullFresh(t, 4, localEpochFromDayTime('2026-10-06', '04:00'))).toBe(false);
  });
  it('never pulled → no mark', () => {
    expect(isPullFresh({ gcalPulledAt: null }, 4, at)).toBe(false);
    expect(isPullFresh({} as Pick<Task, 'gcalPulledAt'>, 4, at)).toBe(false);
  });
});
