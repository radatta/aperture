import { describe, expect, it } from 'vitest';
import {
  calendarPullPlan,
  hasKeptPart,
  isKeptNote,
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
  gcalSeen: { title: 'pset', startMs: END - 60 * 60_000, endMs: END, updatedMs: 2_000 },
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
const FIRST = { firstSync: true };
const plan = (t: T, e: PulledEvent, opts = FIRST) => calendarPullPlan(t, e, T0, opts);

describe('calendarPullPlan', () => {
  it('our own push coming back (event = gcalSeen) is a no-op', () => {
    expect(plan(task(), event())).toEqual({ kind: 'none' });
  });
  it('a no-estimate task’s default 30-minute block is a no-op — never writes estimateMin = 30', () => {
    const seen = { title: 'pset', startMs: END - 30 * 60_000, endMs: END, updatedMs: 2_000 };
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
      seen: { title: 'pset', startMs: end - 60 * 60_000, endMs: end, updatedMs: 2_000 },
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
    const newer = { title: 'pset', startMs: 0, endMs: 1, updatedMs: 9e15 };
    expect(plan(task({ gcalSeen: newer }), event({ cancelled: true, title: null }))).toEqual({
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
  it('an event on an untimed task syncs its title only (no window to map)', () => {
    const t = task({
      dueTime: null,
      gcalSeen: { title: 'pset', startMs: 0, endMs: 3_600_000, updatedMs: 2_000 },
    });
    expect(plan(t, event({ startMs: 60_000, endMs: 3_700_000 }))).toMatchObject({ kind: 'see' });
    expect(plan(t, event({ title: 'm', startMs: 0, endMs: 3_600_000 }))).toMatchObject({
      kind: 'apply',
      fields: { title: 'm' },
    });
  });
  it('made recurring in Google → ignored', () => {
    expect(plan(task(), event({ recurring: true, title: 'r' })).kind).toBe('none');
  });
  it('first sighting (linked before two-way sync): remembered as Google has it, nothing applied', () => {
    const end = epoch('2026-10-09', '17:00');
    const first = plan(task({ gcalSeen: undefined }), event({ title: 'g', endMs: end }));
    expect(first).toEqual({
      kind: 'see',
      seen: { title: 'g', startMs: END - 60 * 60_000, endMs: end, updatedMs: 2_000 },
    });
    // Where it differed, the task's value is Aperture's unsent one: a later Google edit to it is kept
    // out (the next push sends the task's); an untouched field still applies.
    const known = task({ gcalSeen: (first as { seen: GcalSeen }).seen });
    expect(
      plan(known, event({ title: 'g2', startMs: END - 90 * 60_000, endMs: end, updatedMs: 3_000 })),
    ).toMatchObject({
      fields: {},
      note: 'Kept your title and time — changed in Google Calendar too',
    });
    const inStep = task({ gcalSeen: { ...(first as { seen: GcalSeen }).seen, title: 'pset' } });
    expect(plan(inStep, event({ title: 'g2', endMs: end, updatedMs: 3_000 }))).toMatchObject({
      fields: { title: 'g2' },
    });
  });
  it('first seen in a later delta (changed in Google since the first sync): Google’s change applies', () => {
    const later = { firstSync: false };
    const end = epoch('2026-10-09', '17:00');
    const fresh = task({ gcalSeen: undefined });
    expect(plan(fresh, event({ startMs: end - 60 * 60_000, endMs: end }), later)).toEqual({
      kind: 'apply',
      fields: { dueDay: '2026-10-09', dueTime: '17:00' },
      note: 'Moved to Oct 9 5pm in Google Calendar',
      seen: { title: 'pset', startMs: end - 60 * 60_000, endMs: end, updatedMs: 2_000 },
    });
    expect(plan(fresh, event({ title: 'g' }), later)).toMatchObject({ fields: { title: 'g' } });
    // Nothing that maps (an echo of the task as it is) is only remembered; an untimed task takes the title.
    expect(plan(fresh, event(), later)).toMatchObject({ kind: 'see' });
    const untimed = task({ dueDay: null, dueTime: null, gcalSeen: undefined });
    expect(plan(untimed, event({ title: 'g', endMs: end }), later)).toMatchObject({
      fields: { title: 'g' },
    });
    // An all-day conversion keeps the task's window as the known one.
    expect(plan(fresh, event({ allDay: true, startMs: null, endMs: null }), later)).toMatchObject({
      kind: 'see',
      seen: { startMs: END - 60 * 60_000, endMs: END },
    });
    // A no-estimate task's default block, dragged: the deadline moves, estimateMin stays unwritten.
    const bare = task({ estimateMin: null, gcalSeen: undefined });
    expect(plan(bare, event({ startMs: end - 30 * 60_000, endMs: end }), later)).toMatchObject({
      fields: { dueDay: '2026-10-09', dueTime: '17:00' },
    });
    expect(plan(bare, event({ startMs: end - 30 * 60_000, endMs: end }), later)).not.toHaveProperty(
      'fields.estimateMin',
    );
    // A done task: the deadline applies, a stretched block never rewrites the estimate.
    const done = task({ status: 'done', gcalSeen: undefined });
    expect(plan(done, event({ startMs: end - 90 * 60_000, endMs: end }), later)).toMatchObject({
      fields: { dueDay: '2026-10-09', dueTime: '17:00' },
    });
    expect(plan(done, event({ startMs: end - 90 * 60_000, endMs: end }), later)).not.toHaveProperty(
      'fields.estimateMin',
    );
  });
  it('first seen in a later delta holding a failed push: only remembered (Aperture’s value is unsent)', () => {
    const failed = task({ gcalSeen: undefined, gcalSyncError: gcalSyncMessage('patch', 'x') });
    expect(plan(failed, event({ title: 'g' }), { firstSync: false })).toMatchObject({
      kind: 'see',
      seen: { title: 'g' },
    });
  });
  it('residual: a block placed off the deadline before two-way sync, first seen later, moves the deadline to it', () => {
    // Documented (calendar → First sight in a later delta): any Google change to it reads as a move.
    const picked = { startMs: epoch('2026-10-05', '09:00'), endMs: epoch('2026-10-05', '10:30') };
    expect(
      plan(task({ gcalSeen: undefined }), event({ ...picked, title: 'r' }), { firstSync: false }),
    ).toMatchObject({ fields: { title: 'r', dueTime: '10:30', estimateMin: 90 } });
  });
  it('a block placed off the deadline before two-way sync never moves the deadline to it', () => {
    // A picked 09:00–10:00 block on a task due 16:00: first sight, then a Google rename's echo.
    const picked = { startMs: epoch('2026-10-05', '09:00'), endMs: epoch('2026-10-05', '10:00') };
    const first = plan(task({ gcalSeen: undefined }), event(picked));
    const known = task({ gcalSeen: (first as { seen: GcalSeen }).seen });
    expect(plan(known, event({ ...picked, title: 'r', updatedMs: 3_000 }))).toMatchObject({
      fields: { title: 'r' },
    });
    // …and a Google drag of it is kept out: the task's deadline is the unsent value.
    expect(
      plan(
        known,
        event({
          startMs: picked.startMs + 3_600_000,
          endMs: picked.endMs + 3_600_000,
          updatedMs: 3_000,
        }),
      ),
    ).toMatchObject({ fields: {}, note: 'Kept your time — moved in Google Calendar too' });
  });
  it('a deadline matches its base by instant or by wall-clock minute (fall-back hour, an end with seconds)', () => {
    const tz = 'America/Los_Angeles';
    const z = {
      epoch: (d: string, h: string) => zonedEpoch(d, h, tz),
      clock: (ms: number) => zonedDayTime(ms, tz),
    };
    // The second 1:30 on fall-back night maps to the same dueTime, but the epoch resolves the first.
    const second = zonedEpoch('2026-11-01', '01:30', tz) + 3_600_000;
    const t = task({
      dueDay: '2026-11-01',
      dueTime: '01:30',
      estimateMin: 30,
      gcalSeen: { title: 'pset', startMs: second - 30 * 60_000, endMs: second, updatedMs: 2_000 },
    });
    const later = second + 3_600_000;
    expect(
      calendarPullPlan(
        t,
        event({ startMs: later - 30 * 60_000, endMs: later, updatedMs: 3_000 }),
        z,
        FIRST,
      ),
    ).toMatchObject({ kind: 'apply', fields: { dueTime: '02:30' } });
    // An end 20 seconds past the minute.
    const odd = task({
      gcalSeen: {
        title: 'pset',
        startMs: END - 60 * 60_000,
        endMs: END + 20_000,
        updatedMs: 2_000,
      },
    });
    const five = epoch('2026-10-05', '17:00');
    expect(
      plan(odd, event({ startMs: five - 60 * 60_000, endMs: five, updatedMs: 3_000 })),
    ).toMatchObject({ kind: 'apply', fields: { dueTime: '17:00' } });
  });
  it('a start-only drag on a deadline in the skipped spring-forward hour leaves the deadline alone', () => {
    const tz = 'America/Los_Angeles';
    const z = {
      epoch: (d: string, h: string) => zonedEpoch(d, h, tz),
      clock: (ms: number) => zonedDayTime(ms, tz),
    };
    const end = zonedEpoch('2027-03-14', '02:30', tz);
    const t = task({
      dueDay: '2027-03-14',
      dueTime: '02:30',
      estimateMin: 30,
      gcalSeen: { title: 'pset', startMs: end - 30 * 60_000, endMs: end, updatedMs: 2_000 },
    });
    expect(
      calendarPullPlan(
        t,
        event({ startMs: end - 60 * 60_000, endMs: end, updatedMs: 3_000 }),
        z,
        FIRST,
      ),
    ).toMatchObject({
      kind: 'apply',
      fields: { estimateMin: 60 },
      note: 'Now 1h in Google Calendar',
    });
  });
  it('a newer state with nothing to map still advances the base’s version', () => {
    expect(plan(task(), event({ updatedMs: 5_000 }))).toEqual({
      kind: 'see',
      seen: { title: 'pset', startMs: END - 60 * 60_000, endMs: END, updatedMs: 5_000 },
    });
    expect(plan(task(), event({ updatedMs: 2_000 }))).toEqual({ kind: 'none' }); // the echo
  });
  it('a Google change the pull doesn’t take never reads as Aperture’s unsent edit later', () => {
    // A done task's start drag is ignored; its next end drag still applies.
    const done = task({ status: 'done' });
    const s1 = plan(done, event({ startMs: END - 180 * 60_000 }));
    expect(s1).toMatchObject({ kind: 'see' });
    const end = epoch('2026-10-06', '09:00');
    expect(
      plan(
        task({ status: 'done', gcalSeen: (s1 as { seen: GcalSeen }).seen }),
        event({ startMs: end - 60 * 60_000, endMs: end, updatedMs: 3_000 }),
      ),
    ).toMatchObject({ kind: 'apply', fields: { dueDay: '2026-10-06', dueTime: '09:00' } });
    // A block a few seconds off the minute: the estimate rounds, and the next drag still applies.
    const s2 = plan(task(), event({ startMs: END - 45 * 60_000 - 20_000 }));
    const rounded = task({ estimateMin: 45, gcalSeen: (s2 as { seen: GcalSeen }).seen });
    expect(
      plan(rounded, event({ startMs: end - 45 * 60_000 - 20_000, endMs: end, updatedMs: 3_000 })),
    ).toEqual({
      kind: 'apply',
      fields: { dueDay: '2026-10-06', dueTime: '09:00' },
      note: 'Moved to Oct 6 9am in Google Calendar',
      seen: { title: 'pset', startMs: end - 45 * 60_000 - 20_000, endMs: end, updatedMs: 3_000 },
    });
  });
  it('a field only Aperture changed (unsent: failed, done, or sync off) is never taken from Google', () => {
    // The task moved to 6pm but that never reached Google; Google's echo of a rename still says 4pm.
    const t = task({ dueTime: '18:00' });
    expect(plan(t, event({ title: 'renamed', updatedMs: 5_000 }))).toMatchObject({
      kind: 'apply',
      fields: { title: 'renamed' },
    });
    expect(plan(t, event({ updatedMs: 5_000 })).kind).toBe('see'); // nothing applied
    // Aperture renamed (unsent); Google moved the block: the move applies, the title stays Aperture's.
    const end = epoch('2026-10-05', '17:00');
    expect(
      plan(task({ title: 'mine' }), event({ startMs: end - 60 * 60_000, endMs: end })),
    ).toMatchObject({
      fields: { dueTime: '17:00' },
    });
  });
  it('an event state older than the base is stale: nothing applies, nothing is recorded', () => {
    const t = task({
      title: 'aperture',
      gcalSeen: { title: 'pset', startMs: END - 60 * 60_000, endMs: END, updatedMs: 3_000 },
    });
    expect(plan(t, event({ title: 'google', updatedMs: 2_000 }))).toEqual({ kind: 'none' });
    expect(plan(task({ title: 'google' }), event({ title: 'google', updatedMs: 500 }))).toEqual({
      kind: 'none',
    });
  });
  it('both changed the same field: Aperture’s unsent value stays, whatever the clocks say — and the row says so', () => {
    const t = task({ title: 'aperture' });
    for (const updatedMs of [2_000, 9_000])
      expect(plan(t, event({ title: 'google', updatedMs }))).toEqual({
        kind: 'apply',
        fields: {},
        note: 'Kept your title — renamed in Google Calendar too',
        seen: { title: 'google', startMs: END - 60 * 60_000, endMs: END, updatedMs },
      });
    // The base now holds Google's title, so a later drag applies only the move — no second note.
    const after = task({
      title: 'aperture',
      gcalSeen: { title: 'google', startMs: END - 60 * 60_000, endMs: END, updatedMs: 2_000 },
    });
    const end = epoch('2026-10-05', '17:00');
    expect(
      plan(
        after,
        event({ title: 'google', startMs: end - 60 * 60_000, endMs: end, updatedMs: 4_000 }),
      ),
    ).toEqual({
      kind: 'apply',
      fields: { dueDay: '2026-10-05', dueTime: '17:00' },
      note: 'Moved to Oct 5 5pm in Google Calendar',
      seen: { title: 'google', startMs: end - 60 * 60_000, endMs: end, updatedMs: 4_000 },
    });
  });
  it('an unsent deadline vs a Google drag: Aperture’s time stays', () => {
    const end = epoch('2026-10-05', '17:00');
    expect(
      plan(task({ dueTime: '18:00' }), event({ startMs: end - 60 * 60_000, endMs: end })),
    ).toMatchObject({
      kind: 'apply',
      fields: {},
      note: 'Kept your time — moved in Google Calendar too',
    });
    // Google moved it to exactly Aperture's new time: both agree — nothing to keep or apply.
    const six = epoch('2026-10-05', '18:00');
    expect(
      plan(task({ dueTime: '18:00' }), event({ startMs: six - 60 * 60_000, endMs: six })),
    ).toMatchObject({ kind: 'see' });
  });
  it('both renamed to the same title: nothing to keep', () => {
    expect(plan(task({ title: 'same' }), event({ title: 'same' }))).toMatchObject({ kind: 'see' });
  });
  it('mixed: what only Google changed applies; what both changed is kept', () => {
    const end = epoch('2026-10-05', '17:00');
    expect(
      plan(
        task({ title: 'mine' }),
        event({ title: 'theirs', startMs: end - 60 * 60_000, endMs: end }),
      ),
    ).toMatchObject({
      fields: { dueTime: '17:00' },
      note: 'Moved to Oct 5 5pm in Google Calendar · Kept your title',
    });
  });
  it('a done task’s unsent rename is kept over a later Google rename', () => {
    expect(
      plan(task({ status: 'done', title: 'mine' }), event({ title: 'theirs', updatedMs: 9_000 })),
    ).toMatchObject({ fields: {}, note: 'Kept your title — renamed in Google Calendar too' });
  });
  it('an event first seen all-day has no known window, so a Google re-time isn’t "kept" out', () => {
    const t = task({ gcalSeen: { title: 'pset', startMs: null, endMs: null, updatedMs: 2_000 } });
    const end = epoch('2026-10-05', '17:00');
    expect(plan(t, event({ startMs: end - 60 * 60_000, endMs: end }))).toMatchObject({
      kind: 'apply',
      fields: { dueTime: '17:00' },
    });
  });
  it('first sight comes before the stale check (a task with no base always gets one)', () => {
    expect(plan(task({ gcalSeen: undefined }), event({ updatedMs: 1 }))).toMatchObject({
      kind: 'see',
    });
  });
  it('titles compare trim-insensitively (an untrimmed title is not a rename)', () => {
    const t = task({
      title: 'pset ',
      gcalSeen: { title: 'pset ', startMs: END - 60 * 60_000, endMs: END, updatedMs: 2_000 },
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
        gcalSeen: { title: 'pset', startMs: end - 30 * 60_000, endMs: end, updatedMs: 2_000 },
      });
      expect(
        calendarPullPlan(t, event({ startMs: end - 30 * 60_000, endMs: end }), z, FIRST).kind,
      ).toBe('none');
    }
  });
  describe('a parent’s due marker and a part’s named block', () => {
    const MARK = { startMs: END - 15 * 60_000, endMs: END };
    const parentTask = (over: Partial<T> = {}) =>
      task({
        estimateMin: null,
        gcalSeen: { title: 'P2', ...MARK, updatedMs: 2_000 },
        title: 'P2',
        ...over,
      });
    const LATER = { firstSync: false, parent: true };
    it('dragging the marker’s end moves the parent’s deadline', () => {
      const end = epoch('2026-10-09', '17:00');
      const a = calendarPullPlan(
        parentTask(),
        event({ title: 'P2', startMs: end - 15 * 60_000, endMs: end, updatedMs: 3_000 }),
        T0,
        LATER,
      );
      expect(a).toMatchObject({
        kind: 'apply',
        fields: { dueDay: '2026-10-09', dueTime: '17:00' },
      });
    });
    it('stretching the marker (a start drag) maps to nothing — never an estimate', () => {
      const a = calendarPullPlan(
        parentTask(),
        event({ title: 'P2', startMs: END - 90 * 60_000, endMs: END, updatedMs: 3_000 }),
        T0,
        LATER,
      );
      expect(a.kind).toBe('see');
    });
    it('a parent whose marker is unmoved has no unsent time (its length isn’t the estimate)', () => {
      const a = calendarPullPlan(
        parentTask({ estimateMin: 120 }),
        event({ title: 'P2 renamed', ...MARK, updatedMs: 3_000 }),
        T0,
        LATER,
      );
      expect(a).toMatchObject({ kind: 'apply', fields: { title: 'P2 renamed' } });
    });

    const WIN = { startMs: END - 60 * 60_000, endMs: END };
    const part = (seenTitle: string) =>
      task({ title: 'Part 1', gcalSeen: { title: seenTitle, ...WIN, updatedMs: 2_000 } });
    const named = { firstSync: false, parentTitle: 'P2' };
    it('a rename keeping the prefix writes only the part’s own title', () => {
      const a = calendarPullPlan(
        part('P2 · Part 1'),
        event({ title: 'P2 · Part 1 reading', updatedMs: 3_000 }),
        T0,
        named,
      );
      expect(a).toMatchObject({ kind: 'apply', fields: { title: 'Part 1 reading' } });
    });
    it('a rename dropping the prefix is taken whole', () => {
      const a = calendarPullPlan(
        part('P2 · Part 1'),
        event({ title: 'Reading', updatedMs: 3_000 }),
        T0,
        named,
      );
      expect(a).toMatchObject({ kind: 'apply', fields: { title: 'Reading' } });
    });
    it('a rename to the bare prefix (blank after stripping) writes nothing', () => {
      const a = calendarPullPlan(
        part('P2 · Part 1'),
        event({ title: 'P2 · ', updatedMs: 3_000 }),
        T0,
        named,
      );
      expect(a.kind).toBe('see');
    });
    it('our own prefixed push echoing back is a no-op', () => {
      const a = calendarPullPlan(part('P2 · Part 1'), event({ title: 'P2 · Part 1' }), T0, named);
      expect(a.kind).toBe('none');
    });
    it('a v1 block (seen bare) is renamed from Google like any other — the prefix isn’t the part’s', () => {
      const a = calendarPullPlan(
        part('Part 1'),
        event({ title: 'Something else', updatedMs: 3_000 }),
        T0,
        named,
      );
      expect(a).toMatchObject({ kind: 'apply', fields: { title: 'Something else' } });
    });
    it('after a rename that dropped the prefix, the next Google rename still applies', () => {
      const after = task({
        title: 'Reading',
        gcalSeen: { title: 'Reading', ...WIN, updatedMs: 3_000 },
      });
      const a = calendarPullPlan(
        after,
        event({ title: 'Reading ch 3', updatedMs: 4_000 }),
        T0,
        named,
      );
      expect(a).toMatchObject({ kind: 'apply', fields: { title: 'Reading ch 3' } });
      // An Aperture rename not sent yet is still kept over Google's.
      const unsent = task({
        title: 'Mine',
        gcalSeen: { title: 'P2 · Part 1', ...WIN, updatedMs: 3_000 },
      });
      const b = calendarPullPlan(
        unsent,
        event({ title: 'P2 · Theirs', updatedMs: 4_000 }),
        T0,
        named,
      );
      expect(b).toMatchObject({
        kind: 'apply',
        fields: {},
        note: expect.stringMatching(/^Kept your title/),
      });
    });
    it('the look Aperture sent rides along in the base (colour is never read back)', () => {
      const seen = {
        title: 'P2',
        startMs: END - 15 * 60_000,
        endMs: END,
        updatedMs: 2_000,
        marker: true,
      };
      const a = calendarPullPlan(
        task({ title: 'P2', estimateMin: null, gcalSeen: seen }),
        event({ title: 'P2 renamed', startMs: seen.startMs, endMs: END, updatedMs: 3_000 }),
        T0,
        { firstSync: false, parent: true },
      );
      expect(a).toMatchObject({ kind: 'apply', seen: { marker: true } });
    });
    it('first sight after the first sync bases on the prefixed block title', () => {
      const a = calendarPullPlan(
        task({ title: 'Part 1', gcalSeen: null }),
        event({ title: 'P2 · Part 1' }),
        T0,
        named,
      );
      expect(a).toEqual({ kind: 'see', seen: { title: 'P2 · Part 1', ...WIN, updatedMs: 2_000 } });
    });
  });
});

describe('pullNote', () => {
  it('truncates a long title', () => {
    expect(pullNote({ title: 'a'.repeat(60) })).toBe(
      `Renamed to “${'a'.repeat(39)}…” in Google Calendar`,
    );
  });
  it('says what was kept out, alone or beside what applied', () => {
    expect(pullNote({}, ['title'])).toBe('Kept your title — renamed in Google Calendar too');
    expect(pullNote({}, ['time'])).toBe('Kept your time — moved in Google Calendar too');
    expect(pullNote({}, ['title', 'time'])).toBe(
      'Kept your title and time — changed in Google Calendar too',
    );
    expect(pullNote({ title: 'x' }, ['time'])).toBe(
      'Renamed to “x” in Google Calendar · Kept your time',
    );
    expect(isKeptNote(pullNote({}, ['time']))).toBe(true);
    expect(isKeptNote(pullNote({ title: 'x' }, ['time']))).toBe(false);
    expect(hasKeptPart(pullNote({ title: 'x' }, ['time']))).toBe(true);
    expect(hasKeptPart(pullNote({ title: 'x' }))).toBe(false);
  });
});

describe('isPullFresh', () => {
  const at = localEpochFromDayTime('2026-10-05', '10:00');
  it('shows until the next 4am rollover, then clears', () => {
    const t = { gcalPulled: { at, note: 'x' } };
    expect(isPullFresh(t, 4, localEpochFromDayTime('2026-10-05', '23:00'))).toBe(true);
    expect(isPullFresh(t, 4, localEpochFromDayTime('2026-10-06', '03:59'))).toBe(true);
    expect(isPullFresh(t, 4, localEpochFromDayTime('2026-10-06', '04:00'))).toBe(false);
  });
  it('never pulled → no mark', () => {
    expect(isPullFresh({ gcalPulled: null }, 4, at)).toBe(false);
    expect(isPullFresh({} as Pick<Task, 'gcalPulled'>, 4, at)).toBe(false);
  });
});
