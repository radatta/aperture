import { describe, it, expect } from 'vitest';
import type { Task, TaskSeries } from '@aperture/shared';
import {
  byDueHint,
  plannedDefault,
  remainingMin,
  ruleSummary,
  scopeLabel,
  seriesSummary,
  SPLIT_MIN_REMAINDER,
  statusLabel,
  suggestedBuffer,
  splitDefaults,
} from './taskMath';

const task = (over: Partial<Task>): Task => ({
  id: 't',
  userId: 'local',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  title: 'x',
  status: 'backlog',
  categoryId: null,
  dueDay: null,
  dueTime: null,
  notes: null,
  reflection: null,
  seriesId: null,
  rollId: null,
  estimateMin: null,
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
});

describe('suggestedBuffer', () => {
  it('is a flat +25%, rounded', () => {
    expect(suggestedBuffer(60)).toBe(15);
    expect(suggestedBuffer(45)).toBe(11);
  });
});

describe('plannedDefault', () => {
  it('is estimate + buffer, treating nulls as 0', () => {
    expect(plannedDefault(task({ estimateMin: 60, bufferMin: 15 }))).toBe(75);
    expect(plannedDefault(task({ estimateMin: 30, bufferMin: null }))).toBe(30);
    expect(plannedDefault(task({}))).toBe(0);
  });
});

describe('remainingMin', () => {
  it('uses the working estimate (a mid-task rescope moves it), minus accrued, floored at 0', () => {
    expect(
      remainingMin(task({ estimateMin: 90, estimateLockedMin: 60, actualAccruedMin: 20 })),
    ).toBe(70);
    expect(remainingMin(task({ estimateMin: 60, actualAccruedMin: 90 }))).toBe(0);
    expect(remainingMin(task({ estimateMin: 45, actualAccruedMin: 0 }))).toBe(45);
    expect(remainingMin(task({ estimateMin: null, estimateLockedMin: 60 }))).toBe(0);
  });
});

describe('splitDefaults', () => {
  it('never defaults to 0 minutes on this part, or to a fraction of one on the rest', () => {
    expect(splitDefaults(task({ estimateMin: 5, actualAccruedMin: 0 }), 'keep').thisPart).toBe(1);
    expect(splitDefaults(task({ estimateMin: 45, actualAccruedMin: 12.37 }), 'done').rest).toBe(33);
  });

  it('done: the rest is what is left of the working estimate, floored', () => {
    expect(splitDefaults(task({ estimateMin: 45, actualAccruedMin: 12 }), 'done').rest).toBe(33);
    expect(splitDefaults(task({ estimateMin: 45, actualAccruedMin: 80 }), 'done').rest).toBe(
      SPLIT_MIN_REMAINDER,
    );
  });

  it('keep: what is left is shared, so the parts add up to the estimate', () => {
    expect(splitDefaults(task({ estimateMin: 60, actualAccruedMin: 0 }), 'keep')).toEqual({
      thisPart: 30,
      rest: 30,
    });
    expect(splitDefaults(task({ estimateMin: 45, actualAccruedMin: 12 }), 'keep')).toEqual({
      thisPart: 28,
      rest: 17,
    });
  });

  it('keep never sets this part below the time already logged', () => {
    expect(splitDefaults(task({ estimateMin: 60, actualAccruedMin: 80 }), 'keep')).toEqual({
      thisPart: 80,
      rest: SPLIT_MIN_REMAINDER,
    });
  });

  it('is null when nothing was scoped', () => {
    expect(splitDefaults(task({ estimateMin: null }), 'keep')).toEqual({
      thisPart: null,
      rest: null,
    });
  });
});

describe('byDueHint', () => {
  it('orders dated tasks ascending, undated last, and keeps undated in incoming order', () => {
    const input = [
      task({ id: 'no1' }),
      task({ id: 'far', dueDay: '2026-06-20' }),
      task({ id: 'no2' }),
      task({ id: 'soon', dueDay: '2026-06-10' }),
    ];
    expect(byDueHint(input).map((t) => t.id)).toEqual(['soon', 'far', 'no1', 'no2']);
  });
  it('within a day: timed by time, then untimed (old rows without dueTime count as untimed)', () => {
    const legacy = { ...task({ id: 'legacy', dueDay: '2026-06-10' }) } as Task;
    delete (legacy as { dueTime?: unknown }).dueTime;
    const input = [
      task({ id: 'next', dueDay: '2026-06-11', dueTime: '08:00' }),
      legacy,
      task({ id: 'eve', dueDay: '2026-06-10', dueTime: '17:00' }),
      task({ id: 'untimed', dueDay: '2026-06-10' }),
      task({ id: 'morn', dueDay: '2026-06-10', dueTime: '09:00' }),
    ];
    expect(byDueHint(input).map((t) => t.id)).toEqual(['morn', 'eve', 'legacy', 'untimed', 'next']);
  });
  it('treats an undefined dueDay (pre-migration rows) as undated', () => {
    const legacy = { ...task({ id: 'legacy' }) } as Task;
    delete (legacy as { dueDay?: unknown }).dueDay;
    const out = byDueHint([legacy, task({ id: 'dated', dueDay: '2026-06-10' })]);
    expect(out.map((t) => t.id)).toEqual(['dated', 'legacy']);
  });
  it('does not mutate the input array', () => {
    const input = [
      task({ id: 'a', dueDay: '2026-06-20' }),
      task({ id: 'b', dueDay: '2026-06-10' }),
    ];
    const before = input.map((t) => t.id);
    byDueHint(input);
    expect(input.map((t) => t.id)).toEqual(before);
  });
});

describe('ruleSummary', () => {
  it('summarizes each rule kind', () => {
    expect(ruleSummary({ kind: 'daily' })).toBe('Every day');
    expect(ruleSummary({ kind: 'weekdays' })).toBe('Weekdays');
    expect(ruleSummary({ kind: 'weekly', daysOfWeek: [1, 3, 5] })).toBe('Mon, Wed, Fri');
    expect(ruleSummary({ kind: 'everyN', interval: 3 })).toBe('Every 3 days');
  });
});

describe('seriesSummary', () => {
  const series = (over: Partial<TaskSeries>): TaskSeries => ({
    id: 's',
    userId: 'local',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    title: 'Pre-lab',
    categoryId: null,
    defaultEstimateMin: 60,
    rule: { kind: 'weekly', daysOfWeek: [2] },
    active: true,
    anchorDate: '2026-09-01',
    dueOffsetDays: null,
    until: null,
    ...over,
  });
  it('the rule alone without a cadence (a legacy row too)', () => {
    expect(seriesSummary(series({}), '2026-11-04')).toBe('Tue');
    const legacy = series({});
    delete (legacy as Partial<TaskSeries>).dueOffsetDays;
    delete (legacy as Partial<TaskSeries>).until;
    expect(seriesSummary(legacy, '2026-11-04')).toBe('Tue');
  });
  it('the due offset in words, and until / ended by today', () => {
    expect(seriesSummary(series({ dueOffsetDays: 0 }), '2026-11-04')).toBe('Tue · due same day');
    expect(seriesSummary(series({ dueOffsetDays: 1, until: '2026-12-05' }), '2026-11-04')).toBe(
      'Tue · due next day · until Dec 5',
    );
    expect(seriesSummary(series({ dueOffsetDays: 3, until: '2026-11-03' }), '2026-11-04')).toBe(
      'Tue · due in 3 days · ended Nov 3',
    );
    expect(seriesSummary(series({ until: '2026-11-04' }), '2026-11-04')).toBe('Tue · until Nov 4');
    expect(seriesSummary(series({ until: '2027-03-20' }), '2026-11-04')).toBe(
      'Tue · until Mar 20, 2027',
    );
  });
});

describe('statusLabel', () => {
  it('labels each status, "Dropped" for cancelled', () => {
    expect(statusLabel('backlog')).toBe('Backlog');
    expect(statusLabel('planned')).toBe('Planned');
    expect(statusLabel('in_progress')).toBe('In progress');
    expect(statusLabel('done')).toBe('Done');
    expect(statusLabel('cancelled')).toBe('Dropped');
  });
});

describe('scopeLabel', () => {
  it('Scope until estimated, Rescope while open (even started), Details once finished', () => {
    expect(scopeLabel(task({ estimateMin: null }))).toBe('Scope');
    expect(scopeLabel(task({ estimateMin: 30, estimateLockedMin: null }))).toBe('Rescope');
    expect(
      scopeLabel(task({ status: 'in_progress', estimateMin: 30, estimateLockedMin: 30 })),
    ).toBe('Rescope');
    expect(scopeLabel(task({ status: 'done', estimateMin: 30, estimateLockedMin: 30 }))).toBe(
      'Details',
    );
  });
});
