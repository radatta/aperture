import { describe, expect, it } from 'vitest';
import {
  calendarSyncPlan,
  gcalSyncMessage,
  hasUnsent,
  isPendingRemoval,
  seenAfter,
} from './calendarSync';
import type { DueEpoch } from './due';
import type { Task } from './types';

const epoch: DueEpoch = (day, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return Number(day.slice(-2)) * 86_400_000 + (h * 60 + m) * 60_000;
};
const REF = { accountSub: 'acct', calendarId: 'me@example.com' };
const ON = { autoCalendar: true, calendarWriteDefault: REF };
type T = Pick<Task, 'title' | 'status' | 'dueDay' | 'dueTime' | 'estimateMin' | 'gcalEventId'> &
  Partial<Pick<Task, 'gcalSyncError' | 'gcalSeen'>>;
const task = (over: Partial<T> = {}): T => ({
  title: 'pset',
  status: 'backlog',
  dueDay: '2026-10-05',
  dueTime: '16:00',
  estimateMin: 60,
  gcalEventId: null,
  ...over,
});
const END = epoch('2026-10-05', '16:00');
const linked = (over: Partial<T> = {}) => task({ gcalEventId: 'evt', ...over });

describe('calendarSyncPlan', () => {
  it('a fresh timed task → create, ending at the deadline, on the default calendar', () => {
    expect(calendarSyncPlan(null, task(), ON, epoch)).toEqual({
      kind: 'create',
      target: REF,
      title: 'pset',
      startMs: END - 60 * 60_000,
      endMs: END,
      marker: false,
    });
  });
  it('untimed tasks never create (no all-day events)', () => {
    expect(calendarSyncPlan(null, task({ dueTime: null }), ON, epoch).kind).toBe('none');
    expect(calendarSyncPlan(null, task({ dueDay: null, dueTime: null }), ON, epoch).kind).toBe(
      'none',
    );
  });
  it('gaining a time creates; a rename or estimate change alone never does', () => {
    expect(calendarSyncPlan(task({ dueTime: null }), task(), ON, epoch).kind).toBe('create');
    expect(calendarSyncPlan(task(), task({ title: 'renamed' }), ON, epoch).kind).toBe('none');
    expect(calendarSyncPlan(task(), task({ estimateMin: 90 }), ON, epoch).kind).toBe('none');
  });
  it('linked + known: a day/time/estimate change patches the window only — never the title', () => {
    const known = linked({
      gcalSeen: { title: 'pset', startMs: END - 60 * 60_000, endMs: END, updatedMs: 1 },
    });
    for (const next of [
      { ...known, dueDay: '2026-10-06' },
      { ...known, dueTime: '17:00' },
      { ...known, estimateMin: 90 },
    ]) {
      const end = epoch(next.dueDay!, next.dueTime!);
      expect(calendarSyncPlan(known, next, ON, epoch)).toEqual({
        kind: 'patch',
        startMs: end - next.estimateMin! * 60_000,
        endMs: end,
      });
    }
    expect(calendarSyncPlan(linked(), linked(), ON, epoch).kind).toBe('none');
  });
  it('linked + known: a rename patches the title only, so it cannot undo a drag made in Google', () => {
    const known = linked({
      gcalSeen: { title: 'pset', startMs: END - 60 * 60_000, endMs: END, updatedMs: 1 },
    });
    expect(calendarSyncPlan(known, { ...known, title: 'renamed' }, ON, epoch)).toEqual({
      kind: 'patch',
      title: 'renamed',
    });
    expect(
      calendarSyncPlan(known, { ...known, title: 'renamed', dueTime: '17:00' }, ON, epoch),
    ).toMatchObject({ kind: 'patch', title: 'renamed', endMs: epoch('2026-10-05', '17:00') });
  });
  it('linked before two-way sync (event not known yet): any change sends everything, once', () => {
    expect(calendarSyncPlan(linked(), linked({ title: 'renamed' }), ON, epoch)).toEqual({
      kind: 'patch',
      title: 'renamed',
      startMs: END - 60 * 60_000,
      endMs: END,
    });
  });
  it('with a known event (gcalSeen), a patch sends whatever the event lacks — including unsent changes', () => {
    const seen = { title: 'pset', startMs: END - 60 * 60_000, endMs: END, updatedMs: 1 };
    // A time change that never reached Google (failed, or made with sync off): the next rename sends it.
    const unsent = linked({ dueTime: '18:00', gcalSeen: seen });
    const end = epoch('2026-10-05', '18:00');
    expect(calendarSyncPlan(unsent, { ...unsent, title: 'renamed' }, ON, epoch)).toEqual({
      kind: 'patch',
      title: 'renamed',
      startMs: end - 60 * 60_000,
      endMs: end,
    });
    // In step with the event: a rename sends the title only.
    const synced = linked({ gcalSeen: seen });
    expect(calendarSyncPlan(synced, { ...synced, title: 'r' }, ON, epoch)).toEqual({
      kind: 'patch',
      title: 'r',
    });
    expect(calendarSyncPlan(synced, { ...synced }, ON, epoch).kind).toBe('none');
  });
  it('a block placed off the deadline snaps to it with the next push — a rename, an estimate change, or Retry', () => {
    // A picked block (sync was off, or picked before the task had a time): a timed task's one block is
    // its auto block.
    const picked = linked({ gcalSeen: { title: 'pset', startMs: 0, endMs: 60_000, updatedMs: 1 } });
    const window = { startMs: END - 60 * 60_000, endMs: END };
    expect(calendarSyncPlan(picked, { ...picked, title: 'x' }, ON, epoch)).toEqual({
      kind: 'patch',
      title: 'x',
      ...window,
    });
    expect(calendarSyncPlan(picked, { ...picked, estimateMin: 90 }, ON, epoch)).toEqual({
      kind: 'patch',
      startMs: END - 90 * 60_000,
      endMs: END,
    });
    expect(calendarSyncPlan(null, picked, ON, epoch, { ensure: true })).toEqual({
      kind: 'patch',
      title: 'pset',
      ...window,
    });
  });
  it('a window not known (first seen all-day) is re-timed only when the task’s time changes', () => {
    const allDay = linked({
      gcalSeen: { title: 'pset', startMs: null, endMs: null, updatedMs: 1 },
    });
    expect(calendarSyncPlan(allDay, { ...allDay, title: 'r' }, ON, epoch)).toEqual({
      kind: 'patch',
      title: 'r',
    });
    expect(calendarSyncPlan(allDay, { ...allDay, dueTime: '17:00' }, ON, epoch)).toMatchObject({
      endMs: epoch('2026-10-05', '17:00'),
    });
  });
  it('an untrimmed title against a trimmed base is not re-sent', () => {
    const t = linked({
      title: 'pset ',
      gcalSeen: { title: 'pset', startMs: END - 60 * 60_000, endMs: END, updatedMs: 1 },
    });
    expect(calendarSyncPlan(t, { ...t }, ON, epoch).kind).toBe('none');
  });
  it('hasUnsent: what the next push would send', () => {
    const seen = { title: 'pset', startMs: END - 60 * 60_000, endMs: END, updatedMs: 1 };
    expect(hasUnsent(linked({ gcalSeen: seen }), epoch)).toBe(false);
    expect(hasUnsent(linked({ gcalSeen: seen, title: 'x' }), epoch)).toBe(true);
    expect(hasUnsent(linked({ gcalSeen: seen, dueTime: '17:00' }), epoch)).toBe(true);
    expect(hasUnsent(linked({ gcalSeen: seen, title: ' pset ' }), epoch)).toBe(false);
    expect(hasUnsent(linked({ gcalSeen: { ...seen, startMs: null, endMs: null } }), epoch)).toBe(
      false,
    ); // a window not known moves only with the task's own time
    expect(hasUnsent(task({ gcalSeen: seen, title: 'x' }), epoch)).toBe(false); // not linked
  });
  it('seenAfter: the event as known after a create/patch', () => {
    const prev = { title: 'a', startMs: 1, endMs: 2, updatedMs: 10 };
    expect(seenAfter({ kind: 'patch', title: 'b' }, prev, 20)).toEqual({
      title: 'b',
      startMs: 1,
      endMs: 2,
      updatedMs: 20,
    });
    expect(seenAfter({ kind: 'patch', startMs: 5, endMs: 6 }, null, 30)).toEqual({
      title: null,
      startMs: 5,
      endMs: 6,
      updatedMs: 30,
    });
  });
  it('a manual event on an untimed task moves when the task gains a time', () => {
    const a = calendarSyncPlan(linked({ dueTime: null }), linked(), ON, epoch);
    expect(a).toMatchObject({ kind: 'patch', endMs: END });
  });
  it('an untimed task with a manual event: rename patches the title only; a day move leaves it', () => {
    const prev = linked({ dueTime: null });
    expect(calendarSyncPlan(prev, linked({ dueTime: null, title: 'x' }), ON, epoch)).toEqual({
      kind: 'patch',
      title: 'x',
    });
    expect(
      calendarSyncPlan(prev, linked({ dueTime: null, dueDay: '2026-10-09' }), ON, epoch).kind,
    ).toBe('none');
  });
  it('losing the time (or the day) removes the event', () => {
    expect(calendarSyncPlan(linked(), linked({ dueTime: null }), ON, epoch).kind).toBe('delete');
    expect(
      calendarSyncPlan(linked(), linked({ dueDay: null, dueTime: null }), ON, epoch).kind,
    ).toBe('delete');
  });
  it('an owed removal is honoured even when finished or with sync turned off since', () => {
    const owedOff = linked({ dueTime: null, gcalSyncError: gcalSyncMessage('delete', 'x') });
    const OFF = { autoCalendar: false, calendarWriteDefault: REF };
    expect(calendarSyncPlan(owedOff, { ...owedOff, status: 'cancelled' }, OFF, epoch).kind).toBe(
      'delete',
    );
    expect(calendarSyncPlan(null, owedOff, OFF, epoch, { ensure: true }).kind).toBe('delete');
  });
  describe('a parent: its one event is the due marker', () => {
    const OFF = { autoCalendar: false, calendarWriteDefault: REF };
    const parent = { parent: true };
    const MARK = { startMs: END - 15 * 60_000, endMs: END };
    const seenMarker = { title: 'pset', ...MARK, updatedMs: 1 };

    it('a timed parent creates a 15-minute marker ending at its deadline', () => {
      expect(calendarSyncPlan(null, task(), ON, epoch, parent)).toEqual({
        kind: 'create',
        target: REF,
        title: 'pset',
        ...MARK,
        marker: true,
      });
      // A due change on an unlinked parent creates it; nothing else does (lazy, like any block).
      expect(calendarSyncPlan(task(), task({ dueTime: '17:00' }), ON, epoch, parent).kind).toBe(
        'create',
      );
      expect(calendarSyncPlan(task(), task({ title: 'x' }), ON, epoch, parent).kind).toBe('none');
    });
    it('adopt (block → marker) re-sends window and marker even when the windows coincide', () => {
      const block = linked({
        estimateMin: 15,
        gcalSeen: { title: 'pset', ...MARK, updatedMs: 1 },
      });
      expect(calendarSyncPlan(block, block, ON, epoch, { ...parent, ensure: true })).toEqual({
        kind: 'patch',
        title: 'pset',
        ...MARK,
        marker: true,
      });
    });
    it('release (marker → block) patches back to the estimate window, marker off', () => {
      const p = linked({ gcalSeen: seenMarker });
      expect(calendarSyncPlan(p, p, ON, epoch, { wasParent: true, ensure: true })).toEqual({
        kind: 'patch',
        title: 'pset',
        startMs: END - 60 * 60_000,
        endMs: END,
        marker: false,
      });
    });
    it('a due change moves the marker; a rename alone patches the title only', () => {
      const p = linked({ gcalSeen: seenMarker });
      const moved = calendarSyncPlan(p, { ...p, dueTime: '17:00' }, ON, epoch, parent);
      expect(moved).toEqual({
        kind: 'patch',
        startMs: END + 45 * 60_000,
        endMs: END + 60 * 60_000,
        marker: true,
      });
      expect(calendarSyncPlan(p, { ...p, title: 'renamed' }, ON, epoch, parent)).toEqual({
        kind: 'patch',
        title: 'renamed',
      });
      // Its parts' estimates don't size it: nothing to send when the window is the marker's.
      expect(calendarSyncPlan(p, p, ON, epoch, parent).kind).toBe('none');
    });
    it('a done parent keeps its marker; sync off leaves it alone', () => {
      const p = linked({ gcalSeen: seenMarker });
      expect(calendarSyncPlan(p, { ...p, status: 'done' }, ON, epoch, parent).kind).toBe('none');
      expect(calendarSyncPlan(p, { ...p, dueTime: '17:00' }, OFF, epoch, parent).kind).toBe('none');
    });
    it('an untimed parent has no marker: none, and an event it had goes (sync on or off)', () => {
      const untimed = task({ dueTime: null });
      expect(calendarSyncPlan(null, untimed, ON, epoch, { ...parent, ensure: true }).kind).toBe(
        'none',
      );
      const manual = linked({ dueTime: null });
      expect(calendarSyncPlan(manual, manual, ON, epoch, parent).kind).toBe('delete');
      expect(calendarSyncPlan(manual, manual, OFF, epoch, parent).kind).toBe('delete');
      // Losing its time takes the marker with it.
      const p = linked({ gcalSeen: seenMarker });
      expect(calendarSyncPlan(p, { ...p, dueTime: null }, ON, epoch, parent).kind).toBe('delete');
    });
    it('an owed removal still wins', () => {
      const owed = linked({ dueTime: null, gcalSyncError: gcalSyncMessage('delete', 'x') });
      expect(calendarSyncPlan(owed, owed, OFF, epoch, parent).kind).toBe('delete');
    });
  });

  describe('a part: its block is named after its parent', () => {
    const named = { parentTitle: 'P2' };
    const WIN = { startMs: END - 60 * 60_000, endMs: END };
    it('creates as "P2 · Part 1"', () => {
      expect(calendarSyncPlan(null, task({ title: 'Part 1' }), ON, epoch, named)).toMatchObject({
        kind: 'create',
        title: 'P2 · Part 1',
        marker: false,
      });
    });
    it('a parent rename patches a known block’s title only; no marker field on a plain block', () => {
      const part = linked({
        title: 'Part 1',
        gcalSeen: { title: 'P2 · Part 1', ...WIN, updatedMs: 1 },
      });
      expect(calendarSyncPlan(part, part, ON, epoch, named).kind).toBe('none');
      expect(calendarSyncPlan(part, part, ON, epoch, { parentTitle: 'P3' })).toEqual({
        kind: 'patch',
        title: 'P3 · Part 1',
      });
      expect(calendarSyncPlan(part, { ...part, dueTime: '17:00' }, ON, epoch, named)).toEqual({
        kind: 'patch',
        startMs: END,
        endMs: END + 60 * 60_000,
      });
    });
    it('a v1 block (bare "Part 1") gets the prefix with its next push', () => {
      const v1 = linked({ title: 'Part 1', gcalSeen: { title: 'Part 1', ...WIN, updatedMs: 1 } });
      expect(calendarSyncPlan(v1, v1, ON, epoch, named)).toEqual({
        kind: 'patch',
        title: 'P2 · Part 1',
      });
    });
    it('an untimed part’s manual event renames with the prefix', () => {
      const manual = linked({
        title: 'Part 1',
        dueTime: null,
        gcalSeen: { title: 'P2 · Part 1', startMs: null, endMs: null, updatedMs: 1 },
      });
      expect(calendarSyncPlan(manual, manual, ON, epoch, { parentTitle: 'P3' })).toEqual({
        kind: 'patch',
        title: 'P3 · Part 1',
      });
    });
  });

  describe('hasUnsent with a context', () => {
    it('reads a part’s block title and a parent’s marker window', () => {
      const WIN = { startMs: END - 60 * 60_000, endMs: END };
      const part = linked({
        title: 'Part 1',
        gcalSeen: { title: 'P2 · Part 1', ...WIN, updatedMs: 1 },
      });
      expect(hasUnsent(part, epoch, { parentTitle: 'P2' })).toBe(false);
      expect(hasUnsent(part, epoch)).toBe(true);
      const MARK = { startMs: END - 15 * 60_000, endMs: END };
      const p = linked({ gcalSeen: { title: 'pset', ...MARK, updatedMs: 1 } });
      expect(hasUnsent(p, epoch, { parent: true })).toBe(false);
      expect(hasUnsent(p, epoch)).toBe(true);
    });
  });

  it('a finished task still honours an owed removal', () => {
    const owed = linked({ dueTime: null, gcalSyncError: gcalSyncMessage('delete', 'x') });
    expect(calendarSyncPlan(owed, { ...owed, status: 'done' }, ON, epoch).kind).toBe('delete');
    expect(calendarSyncPlan(owed, { ...owed, status: 'cancelled' }, ON, epoch).kind).toBe('delete');
  });
  it('done and cancelled are left alone (cancel deletes elsewhere)', () => {
    expect(calendarSyncPlan(linked(), linked({ status: 'done', title: 'x' }), ON, epoch).kind).toBe(
      'none',
    );
    expect(calendarSyncPlan(null, task({ status: 'cancelled' }), ON, epoch).kind).toBe('none');
  });
  it('toggle off: nothing at all — no create, no patch, no delete', () => {
    const OFF = { autoCalendar: false, calendarWriteDefault: REF };
    expect(calendarSyncPlan(null, task(), OFF, epoch).kind).toBe('none');
    expect(calendarSyncPlan(linked(), linked({ title: 'x' }), OFF, epoch).kind).toBe('none');
    expect(calendarSyncPlan(linked(), linked({ dueTime: null }), OFF, epoch).kind).toBe('none');
  });
  it('no default calendar → no create; an old settings row (undefined toggle) counts as on', () => {
    expect(
      calendarSyncPlan(null, task(), { autoCalendar: true, calendarWriteDefault: null }, epoch)
        .kind,
    ).toBe('none');
    const legacy = { calendarWriteDefault: REF } as unknown as typeof ON;
    expect(calendarSyncPlan(null, task(), legacy, epoch).kind).toBe('create');
  });
  it('a failed remove is finished by the next sync of any kind; other untimed events only rename', () => {
    const pending = linked({
      dueTime: null,
      gcalSyncError: gcalSyncMessage('delete', 'invalid_grant'),
    });
    expect(calendarSyncPlan(null, pending, ON, epoch, { ensure: true }).kind).toBe('delete');
    // An ordinary rename must not quietly "adopt" the event as a manual one.
    expect(calendarSyncPlan(pending, { ...pending, title: 'renamed' }, ON, epoch).kind).toBe(
      'delete',
    );
    const renameFailed = linked({ dueTime: null, gcalSyncError: gcalSyncMessage('patch', 'x') });
    expect(calendarSyncPlan(null, renameFailed, ON, epoch, { ensure: true }).kind).toBe('patch');
    expect(isPendingRemoval(pending.gcalSyncError)).toBe(true);
    expect(isPendingRemoval(null)).toBe(false);
  });
  it('an estimate change from none to 0 still re-times the event (0 ≠ null)', () => {
    expect(
      calendarSyncPlan(linked({ estimateMin: null }), linked({ estimateMin: 0 }), ON, epoch).kind,
    ).toBe('patch');
  });
  it('ensure (the retry) syncs to the task as it is now', () => {
    expect(calendarSyncPlan(task(), task(), ON, epoch, { ensure: true }).kind).toBe('create');
    expect(calendarSyncPlan(linked(), linked(), ON, epoch, { ensure: true })).toEqual({
      kind: 'patch',
      title: 'pset',
      startMs: END - 60 * 60_000,
      endMs: END,
    });
  });
  it('undefined fields from older rows compare equal to null', () => {
    const old = { ...linked(), dueTime: undefined } as unknown as T;
    expect(calendarSyncPlan(old, linked({ dueTime: null }), ON, epoch).kind).toBe('none');
  });
});
