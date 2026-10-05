import { describe, expect, it } from 'vitest';
import { calendarSyncPlan } from './calendarSync';
import type { DueEpoch } from './due';
import type { Task } from './types';

const epoch: DueEpoch = (day, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return Number(day.slice(-2)) * 86_400_000 + (h * 60 + m) * 60_000;
};
const REF = { accountSub: 'acct', calendarId: 'me@example.com' };
const ON = { autoCalendar: true, calendarWriteDefault: REF };
type T = Pick<Task, 'title' | 'status' | 'dueDay' | 'dueTime' | 'estimateMin' | 'gcalEventId'>;
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
  it('linked: a day/time/estimate/title change patches the event (title + window)', () => {
    for (const next of [
      linked({ dueDay: '2026-10-06' }),
      linked({ dueTime: '17:00' }),
      linked({ estimateMin: 90 }),
      linked({ title: 'renamed' }),
    ]) {
      const a = calendarSyncPlan(linked(), next, ON, epoch);
      expect(a.kind).toBe('patch');
      if (a.kind === 'patch') {
        expect(a.title).toBe(next.title);
        expect(a.endMs).toBe(epoch(next.dueDay!, next.dueTime!));
        expect(a.startMs).toBe(a.endMs! - next.estimateMin! * 60_000);
      }
    }
    expect(calendarSyncPlan(linked(), linked(), ON, epoch).kind).toBe('none');
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
  it('ensure (the retry) syncs to the task as it is now', () => {
    expect(calendarSyncPlan(task(), task(), ON, epoch, { ensure: true }).kind).toBe('create');
    expect(calendarSyncPlan(linked(), linked(), ON, epoch, { ensure: true }).kind).toBe('patch');
  });
  it('undefined fields from older rows compare equal to null', () => {
    const old = { ...linked(), dueTime: undefined } as unknown as T;
    expect(calendarSyncPlan(old, linked({ dueTime: null }), ON, epoch).kind).toBe('none');
  });
});
