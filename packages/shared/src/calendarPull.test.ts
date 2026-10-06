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
import type { GcalSeen, Task } from './types';

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
const END = epoch('2026-10-05', '16:00');
const T0 = { epoch, clock };
// The task as Aperture last pushed it: gcalSeen = its title + window.
const task = (over: Partial<T> = {}): T => ({
  title: 'pset',
  status: 'planned',
  dueDay: '2026-10-05',
  dueTime: '16:00',
  estimateMin: 60,
  gcalSyncError: null,
  gcalTouchedAt: 1_000,
  gcalSeen: { title: 'pset', startMs: END - 60 * 60_000, endMs: END },
  ...over,
});
// The event exactly as the push left it, edited in Google at `updatedMs`.
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
const plan = (t: T, e: PulledEvent) => calendarPullPlan(t, e, T0);

describe('calendarPullPlan', () => {
  it('our own push coming back (event = gcalSeen) is a no-op', () => {
    expect(plan(task(), event())).toEqual({ kind: 'none' });
  });
  it('a no-estimate task’s default 30-minute block is a no-op — never writes estimateMin = 30', () => {
    const seen = { title: 'pset', startMs: END - 30 * 60_000, endMs: END };
    for (const estimateMin of [null, 0])
      expect(
        plan(task({ estimateMin, gcalSeen: seen }), event({ startMs: END - 30 * 60_000 })).kind,
      ).toBe('none');
  });
  it('the end moves the deadline (day and time); the new event becomes the known one', () => {
    const end = epoch('2026-10-09', '17:00');
    expect(plan(task(), event({ startMs: end - 60 * 60_000, endMs: end }))).toEqual({
      kind: 'apply',
      fields: { dueDay: '2026-10-09', dueTime: '17:00' },
      note: 'Moved to Oct 9 5pm in Google Calendar',
      seen: { title: 'pset', startMs: end - 60 * 60_000, endMs: end },
    });
  });
  it('the start sets the working estimate, rounded to the minute', () => {
    expect(plan(task(), event({ startMs: END - 45 * 60_000 - 20_000 }))).toMatchObject({
      kind: 'apply',
      fields: { estimateMin: 45 },
      note: 'Now 45m in Google Calendar',
    });
  });
  it('any block length is taken as-is (very short, very long)', () => {
    expect(plan(task(), event({ startMs: END - 5 * 60_000 }))).toMatchObject({
      fields: { estimateMin: 5 },
    });
    expect(plan(task(), event({ startMs: END - 360 * 60_000 }))).toMatchObject({
      fields: { estimateMin: 360 },
      note: 'Now 6h in Google Calendar',
    });
  });
  it('an in-progress task takes the estimate too (only done/cancelled are frozen)', () => {
    expect(
      plan(task({ status: 'in_progress' }), event({ startMs: END - 90 * 60_000 })),
    ).toMatchObject({
      kind: 'apply',
      fields: { estimateMin: 90 },
    });
  });
  it('a rename in Google renames the task (trimmed; a blank title is ignored)', () => {
    expect(plan(task(), event({ title: '  pset 3 ' }))).toMatchObject({
      kind: 'apply',
      fields: { title: 'pset 3' },
      note: 'Renamed to “pset 3” in Google Calendar',
    });
    expect(plan(task(), event({ title: '  ' })).kind).toBe('none');
    expect(plan(task(), event({ title: null })).kind).toBe('none');
  });
  it('everything at once reads as one line', () => {
    const end = epoch('2026-10-06', '09:30');
    expect(
      plan(task(), event({ title: 'x', startMs: end - 45 * 60_000, endMs: end })),
    ).toMatchObject({
      note: 'Moved to Oct 6 9:30am · Now 45m · Renamed to “x” in Google Calendar',
    });
  });
  it('done: the end and title apply, a start drag is ignored', () => {
    const done = task({ status: 'done' });
    expect(plan(done, event({ startMs: END - 90 * 60_000 }))).toMatchObject({ kind: 'see' });
    const end = epoch('2026-10-06', '16:00');
    expect(plan(done, event({ title: 'y', startMs: end - 90 * 60_000, endMs: end }))).toMatchObject(
      {
        kind: 'apply',
        fields: { title: 'y', dueDay: '2026-10-06', dueTime: '16:00' },
      },
    );
  });
  it('cancelled: nothing, even a deletion (its event went with the cancel)', () => {
    const c = task({ status: 'cancelled' });
    expect(plan(c, event({ title: 'z' })).kind).toBe('none');
    expect(plan(c, event({ cancelled: true })).kind).toBe('none');
  });
  it('deleted or moved away in Google → unlink, whatever `updated` says', () => {
    expect(plan(task({ gcalTouchedAt: 9e15 }), event({ cancelled: true, title: null }))).toEqual({
      kind: 'unlink',
      note: PULL_REMOVED_NOTE,
    });
  });
  it('an all-day conversion ignores the time and keeps the known window; the title still syncs', () => {
    const allDay = event({ allDay: true, startMs: null, endMs: null });
    expect(plan(task(), allDay).kind).toBe('none');
    expect(plan(task(), { ...allDay, title: 'q' })).toMatchObject({
      fields: { title: 'q' },
      seen: { title: 'q', startMs: END - 60 * 60_000, endMs: END },
    });
  });
  it('a manual block (untimed task, or gcalManual) syncs the title only', () => {
    const seen = { title: 'pset', startMs: 0, endMs: 3_600_000 };
    for (const t of [
      task({ dueTime: null, gcalSeen: seen }),
      task({ gcalManual: true, gcalSeen: seen }),
    ]) {
      expect(plan(t, event({ startMs: 60_000, endMs: 3_700_000 }))).toMatchObject({ kind: 'see' });
      expect(plan(t, event({ title: 'm', startMs: 0, endMs: 3_600_000 }))).toMatchObject({
        kind: 'apply',
        fields: { title: 'm' },
      });
    }
  });
  it('made recurring in Google → ignored', () => {
    expect(plan(task(), event({ recurring: true, title: 'r' })).kind).toBe('none');
  });
  it('first sighting (linked before two-way sync): only remembered, nothing applied', () => {
    const end = epoch('2026-10-09', '17:00');
    expect(plan(task({ gcalSeen: undefined }), event({ title: 'g', endMs: end }))).toEqual({
      kind: 'see',
      seen: { title: 'g', startMs: END - 60 * 60_000, endMs: end },
    });
  });
  it('a field only Aperture changed (unsent: failed, done, or sync off) is never taken from Google', () => {
    // The task moved to 6pm but that never reached Google; Google's echo of a rename still says 4pm.
    const t = task({ dueTime: '18:00', gcalTouchedAt: 0 });
    expect(plan(t, event({ title: 'renamed', updatedMs: 5_000 }))).toMatchObject({
      kind: 'apply',
      fields: { title: 'renamed' },
    });
    expect(plan(t, event({ updatedMs: 5_000 })).kind).toBe('none');
    // Aperture renamed (unsent); Google moved the block: the move applies, the title stays Aperture's.
    const end = epoch('2026-10-05', '17:00');
    expect(
      plan(task({ title: 'mine' }), event({ startMs: end - 60 * 60_000, endMs: end })),
    ).toMatchObject({
      fields: { dueTime: '17:00' },
    });
  });
  it('latest wins: an event state older than Aperture’s last push is stale; a newer one wins', () => {
    const t = task({ title: 'aperture', gcalTouchedAt: 3_000 });
    expect(plan(t, event({ title: 'google', updatedMs: 2_000 }))).toMatchObject({ kind: 'see' }); // nothing applied
    expect(plan(t, event({ title: 'google', updatedMs: 4_000 }))).toMatchObject({
      kind: 'apply',
      fields: { title: 'google' },
    });
  });
  it('a stale state takes Google’s value into the base for a field Aperture hasn’t sent — so it can’t undo Aperture later', () => {
    // Aperture renamed (push failed, stamped 3000) after an unpulled Google rename (2000).
    const t = task({ title: 'aperture', gcalTouchedAt: 3_000 });
    const stale = plan(t, event({ title: 'google', updatedMs: 2_000 }));
    expect(stale).toEqual({
      kind: 'see',
      seen: { title: 'google', startMs: END - 60 * 60_000, endMs: END },
    });
    // A later Google drag: the title is NOT re-detected as Google's; only the move applies.
    const absorbed = task({
      title: 'aperture',
      gcalTouchedAt: 3_000,
      gcalSeen: (stale as { seen: GcalSeen }).seen,
    });
    const end = epoch('2026-10-05', '17:00');
    expect(
      plan(
        absorbed,
        event({ title: 'google', startMs: end - 60 * 60_000, endMs: end, updatedMs: 4_000 }),
      ),
    ).toMatchObject({
      kind: 'apply',
      fields: { dueTime: '17:00' },
    });
    // A field Aperture already sent stays as known (nothing to absorb).
    expect(
      plan(task({ gcalTouchedAt: 3_000 }), event({ title: 'google', updatedMs: 2_000 })),
    ).toEqual({ kind: 'none' });
  });
  it('titles compare trim-insensitively (an untrimmed title is not a rename)', () => {
    const t = task({
      title: 'pset ',
      gcalSeen: { title: 'pset ', startMs: END - 60 * 60_000, endMs: END },
    });
    expect(plan(t, event({ title: 'pset ' })).kind).toBe('none');
  });
  it('an owed removal is never pulled into', () => {
    const owed = task({ gcalSyncError: gcalSyncMessage('delete', 'x') });
    expect(plan(owed, event({ title: 'g' })).kind).toBe('none');
  });
  it('the repeated fall-back hour and the skipped spring-forward hour are idempotent (instants, not wall clocks)', () => {
    const tz = 'America/Los_Angeles';
    const z = {
      epoch: (d: string, h: string) => zonedEpoch(d, h, tz),
      clock: (ms: number) => zonedDayTime(ms, tz),
    };
    for (const [day, hhmm] of [
      ['2026-11-01', '01:30'],
      ['2027-03-14', '02:30'], // doesn't exist — resolves to 3:30am, and the echo must not "move" it
    ] as const) {
      const end = zonedEpoch(day, hhmm, tz);
      const t = task({
        dueDay: day,
        dueTime: hhmm,
        estimateMin: 30,
        gcalSeen: { title: 'pset', startMs: end - 30 * 60_000, endMs: end },
      });
      expect(calendarPullPlan(t, event({ startMs: end - 30 * 60_000, endMs: end }), z).kind).toBe(
        'none',
      );
    }
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
