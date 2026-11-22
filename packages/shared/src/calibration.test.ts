import { describe, expect, it } from 'vitest';
import {
  BACKFILL_MAX,
  calibrationPoints,
  laneOf,
  planBackfill,
  scoresGap,
  withBackfilled,
} from './calibration';
import { dayKeyInZone, USER_TIME_ZONE, zonedEpoch } from './dates';
import { TASK_NOTES_MAX } from './taskNotes';
import type { Task } from './types';

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't',
    userId: 'u',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    title: 'thing',
    status: 'backlog',
    categoryId: null,
    dueDay: null,
    dueTime: null,
    notes: null,
    reflection: null,
    seriesId: null,
    rollId: null,
    estimateMin: 30,
    bufferMin: null,
    estimateLockedMin: null,
    parentId: null,
    place: null,
    actualAccruedMin: 0,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    gcalAccountId: null,
    gcalCalendarId: null,
    gcalEventId: null,
    gcalSyncError: null,
    ...over,
  };
}

const NOW = Date.parse('2026-11-19T20:00:00Z');
const TODAY = '2026-11-19';
const row = (id = 't', over = {}) => ({ id, actualMin: 40, completedDay: '2026-11-10', ...over });
const plan = (tasks: Task[], inputs: unknown[]) => planBackfill(tasks, inputs as never, TODAY, NOW);

describe('scoresGap and laneOf', () => {
  it('a rollup and a backfilled point never score; an unmarked one does', () => {
    expect(scoresGap({ parts: 0, backfilled: false })).toBe(true);
    expect(scoresGap({ parts: 2, backfilled: false })).toBe(false);
    expect(scoresGap({ parts: 0, backfilled: true })).toBe(false);
    expect(scoresGap({ parts: 0 } as never)).toBe(true); // an older Lambda's point
  });
  it('Aperture is its own lane; every other area, and none, is Life', () => {
    expect(laneOf({ area: 'aperture' })).toBe('aperture');
    for (const area of ['school', 'recruiting', 'personal'] as const)
      expect(laneOf({ area })).toBe('life');
    expect(laneOf({} as never)).toBe('life');
  });
});

describe('calibrationPoints', () => {
  const done = (over: Partial<Task>) =>
    task({
      status: 'done',
      estimateLockedMin: 30,
      actualAccruedMin: 40,
      completedAt: NOW,
      ...over,
    });
  it('joins the category’s area live; no category, or a missing one, reads Personal', () => {
    const pts = calibrationPoints(
      [
        done({ id: 'a', categoryId: 'dev' }),
        done({ id: 'b' }),
        done({ id: 'c', categoryId: 'gone' }),
        done({ id: 'd', categoryId: 'dev', backfilled: true }),
      ],
      [{ id: 'dev', area: 'aperture' }],
      4,
      { from: TODAY, to: TODAY },
    );
    expect(pts.map((p) => [p.taskId, p.area, p.backfilled])).toEqual([
      ['a', 'aperture', false],
      ['b', 'personal', false],
      ['c', 'personal', false],
      ['d', 'aperture', true],
    ]);
  });
});

describe('planBackfill', () => {
  it('closes a backlog task the way complete_task would, dated noon of its day in the user zone', () => {
    const [r] = plan([task()], [row()]);
    expect(r!.next).toMatchObject({
      status: 'done',
      estimateLockedMin: 30,
      estimateSource: 'planned',
      actualAccruedMin: 40,
      backfilled: true,
      completedAt: zonedEpoch('2026-11-10', '12:00', USER_TIME_ZONE),
    });
    expect(dayKeyInZone(r!.next!.completedAt!, USER_TIME_ZONE, 4)).toBe('2026-11-10');
    expect(r!.next!.startedAt).toBe(r!.next!.completedAt); // started "now" → clamped to the day it shipped
  });

  it('an in-progress task keeps its lock and an earlier start; a later start is clamped', () => {
    const early = zonedEpoch('2026-11-01', '09:00', USER_TIME_ZONE);
    const started = task({ status: 'in_progress', estimateLockedMin: 20, startedAt: early });
    expect(plan([started], [row()])[0]!.next).toMatchObject({
      estimateLockedMin: 20,
      estimateSource: 'revised',
      startedAt: early,
    });
    const late = task({ status: 'in_progress', estimateLockedMin: 30, startedAt: NOW });
    const next = plan([late], [row()])[0]!.next!;
    expect(next.startedAt).toBe(next.completedAt);
  });

  it('an estimate given on an unscoped task is the lock, as complete_task’s retro', () => {
    const next = plan([task({ estimateMin: null })], [row('t', { estimateMin: 25 })])[0]!.next!;
    expect(next).toMatchObject({ estimateLockedMin: 25, estimateSource: 'retro' });
  });

  it('dated today before noon, it finishes now, never in the future', () => {
    const morning = zonedEpoch(TODAY, '09:00', USER_TIME_ZONE);
    const [r] = planBackfill([task()], [row('t', { completedDay: TODAY })], TODAY, morning);
    expect(r!.next!.completedAt).toBe(morning);
    expect(r!.next!.startedAt).toBe(morning);
  });

  it('a stale failed-sync note goes with the finish, as transitionOne’s would', () => {
    const [r] = plan([task({ gcalSyncError: 'calendar sync failed' })], [row()]);
    expect(r!.next!.gcalSyncError).toBeNull();
  });

  it('today is allowed, tomorrow is not', () => {
    expect(plan([task()], [row('t', { completedDay: TODAY })])[0]!.next!.status).toBe('done');
    expect(() => plan([task()], [row('t', { completedDay: '2026-11-20' })])).toThrow(/after today/);
  });

  it('refuses every shape with side effects, naming the row and the way round it', () => {
    const refusals: [Partial<Task>, RegExp][] = [
      [{ rollId: 'r' }, /Roll rep/],
      [{ seriesId: 's' }, /recurring occurrence/],
      [{ gcalEventId: 'e' }, /calendar event/],
      [{ place: 'store' }, /errand/],
      [{ parentId: 'p' }, /is a part/],
      [{ status: 'cancelled' }, /cancelled/],
    ];
    for (const [over, msg] of refusals) {
      expect(() => plan([task(over)], [row()])).toThrow(msg);
      expect(() => plan([task(over)], [row()])).toThrow(/^Row 1 \(t\)/);
    }
    expect(() => plan([task({ parentId: 'p' })], [row()])).toThrow(/complete_task/);
  });

  it('bounds the batch: empty and over the cap are refused', () => {
    expect(() => plan([], [])).toThrow(/at least one/);
    const many = Array.from({ length: BACKFILL_MAX + 1 }, (_, i) => task({ id: `t${i}` }));
    expect(() =>
      plan(
        many,
        many.map((t) => row(t.id)),
      ),
    ).toThrow(/at most 100/);
    const max = many.slice(0, BACKFILL_MAX);
    expect(
      plan(
        max,
        max.map((t) => row(t.id)),
      ),
    ).toHaveLength(BACKFILL_MAX);
  });

  it('a done and backfilled task is skipped (a rerun); a garbage row is refused', () => {
    const landed = task({ status: 'done', backfilled: true, estimateLockedMin: 30 });
    expect(plan([landed], [row()])[0]!.next).toBeNull();
    expect(() => plan([task()], [null])).toThrow(/Row 1 \(undefined\): not found/);
  });
  it('a note is appended after a blank line; on no notes it is the notes', () => {
    const next = (over: Partial<Task>, note: unknown) =>
      plan([task(over)], [row('t', { note })])[0]!.next!;
    expect(next({ notes: 'Scoped it.' }, '  Shipped it.\r\n')).toMatchObject({
      notes: 'Scoped it.\n\nShipped it.',
      status: 'done',
    });
    expect(next({ notes: null }, 'Shipped it.').notes).toBe('Shipped it.');
    const legacy = task();
    delete (legacy as Partial<Task>).notes; // a row from before the field
    expect(plan([legacy], [row('t', { note: 'Shipped it.' })])[0]!.next!.notes).toBe('Shipped it.');
  });

  it('a blank, null or absent note leaves the notes as they were', () => {
    for (const note of ['  \n ', null, undefined])
      expect(plan([task({ notes: 'Scoped it.' })], [row('t', { note })])[0]!.next!.notes).toBe(
        'Scoped it.',
      );
  });

  it('the notes after the append are capped: exactly the limit lands, one over refuses the batch', () => {
    const existing = 'x'.repeat(TASK_NOTES_MAX - 10); // + "\n\n" + 8 = the limit
    const fits = plan([task({ notes: existing })], [row('t', { note: 'y'.repeat(8) })])[0]!;
    expect(fits.next!.notes).toHaveLength(TASK_NOTES_MAX);
    const tasks = [task({ id: 'ok' }), task({ notes: existing })];
    expect(() =>
      plan(tasks, [row('ok', { note: 'fine' }), row('t', { note: 'y'.repeat(9) })]),
    ).toThrow(
      /^Row 2 \(t\): the note would take its notes to 5,001 characters — the limit is 5,000$/,
    );
  });

  it('refuses a note that is not text, or over the cap alone, naming the row', () => {
    expect(() => plan([task()], [row('t', { note: 5 as unknown as string })])).toThrow(
      /^Row 1 \(t\): note must be text/,
    );
    expect(() => plan([task()], [row('t', { note: 'y'.repeat(TASK_NOTES_MAX + 1) })])).toThrow(
      /^Row 1 \(t\): note is limited to 5,000 characters/,
    );
  });

  it('a skipped row never takes its note, even one that would no longer fit', () => {
    const full = 'x'.repeat(TASK_NOTES_MAX);
    const landed = task({ status: 'done', backfilled: true, estimateLockedMin: 30, notes: full });
    const [r] = plan([landed], [row('t', { note: 'Shipped it.' })]);
    expect(r!.next).toBeNull();
    expect(r!.task.notes).toBe(full);
    // the note's own checks come first, as actualMin's: a bad note refuses even a row that would skip
    expect(() => plan([landed], [row('t', { note: 5 })])).toThrow(
      /^Row 1 \(t\): note must be text/,
    );
  });

  it('a note never lets a shape with side effects through', () => {
    for (const over of [{ parentId: 'p' }, { gcalEventId: 'e' }] as Partial<Task>[])
      expect(() => plan([task(over)], [row('t', { note: 'Shipped it.' })])).toThrow(
        /is a part|calendar event/,
      );
    const tasks = [task({ id: 'p' }), task({ parentId: 'p' })];
    expect(() => plan(tasks, [row('p', { note: 'Shipped it.' })])).toThrow(/has parts/);
  });
});

describe('withBackfilled', () => {
  const done = task({
    status: 'done',
    estimateLockedMin: 30,
    actualAccruedMin: 40,
    completedAt: 5,
  });
  it('sets and clears on a done point; the completion never moves', () => {
    const on = withBackfilled(done, [done], true, NOW);
    expect(on).toMatchObject({ backfilled: true, completedAt: 5, updatedAt: NOW });
    expect(withBackfilled(on, [on], false, NOW).backfilled).toBe(false);
    expect(withBackfilled(on, [on], true, NOW + 1)).toBe(on); // no change → no write
  });
  it('refuses an open task, an errand, a parent and a non-boolean', () => {
    expect(() => withBackfilled(task(), [], true, NOW)).toThrow(/done task/);
    const errand = { ...done, place: 'store' };
    expect(() => withBackfilled(errand, [errand], true, NOW)).toThrow(/done task/);
    const kid = task({ id: 'k', parentId: 't' });
    expect(() => withBackfilled(done, [done, kid], true, NOW)).toThrow(/done task/);
    expect(() => withBackfilled(done, [done], 'yes' as never, NOW)).toThrow(/true or false/);
  });
});
