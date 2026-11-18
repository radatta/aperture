import { describe, expect, it } from 'vitest';
import {
  SERIES_OFFSET_ERROR,
  SERIES_TIME_ERROR,
  SERIES_TIME_NEEDS_DUE_ERROR,
  SERIES_TIME_SMALL_HOURS_ERROR,
  SERIES_UNTIL_ERROR,
  occurrenceDueDay,
  occurrenceFields,
  occurrencePlanned,
  seriesCadence,
  seriesDueOn,
  seriesHasOccurrence,
} from './recurrence';
import type { Task, TaskPlan, TaskSeries } from './types';

const base = { userId: 'u', createdAt: 0, updatedAt: 0, deletedAt: null };
const series = (over: Partial<TaskSeries> = {}): TaskSeries => ({
  ...base,
  id: 's1',
  title: 'Weekly report',
  categoryId: null,
  defaultEstimateMin: 60,
  rule: { kind: 'daily' },
  active: true,
  anchorDate: '2026-08-01',
  dueOffsetDays: null,
  until: null,
  ...over,
});
const task = (over: Partial<Task>): Task => ({
  ...base,
  id: 't',
  ...occurrenceFields(series(), '2026-08-04'),
  ...over,
});
const plan = (taskId: string, day: string): TaskPlan => ({
  ...base,
  id: `p-${taskId}`,
  taskId,
  day,
  plannedMinutes: 60,
  order: 1,
});

describe('seriesDueOn with until', () => {
  it('spawns through the until day, nothing after', () => {
    const s = series({ until: '2026-08-05' });
    expect(seriesDueOn(s, '2026-08-05')).toBe(true);
    expect(seriesDueOn(s, '2026-08-06')).toBe(false);
  });
  it('an until before the anchor never spawns; legacy rows (no field) are open-ended', () => {
    expect(seriesDueOn(series({ until: '2026-07-31' }), '2026-08-01')).toBe(false);
    const legacy = series();
    delete (legacy as Partial<TaskSeries>).until;
    expect(seriesDueOn(legacy, '2030-01-01')).toBe(true);
  });
  it('the rule still applies inside the window', () => {
    const s = series({ rule: { kind: 'weekly', daysOfWeek: [2] }, until: '2026-08-31' });
    expect(seriesDueOn(s, '2026-08-04')).toBe(true); // a Tuesday
    expect(seriesDueOn(s, '2026-08-05')).toBe(false);
  });
});

describe('occurrenceDueDay', () => {
  it('none without an offset (legacy undefined too), the day itself at 0, later by the offset', () => {
    expect(occurrenceDueDay(series(), '2026-08-04')).toBeNull();
    const legacy = series();
    delete (legacy as Partial<TaskSeries>).dueOffsetDays;
    expect(occurrenceDueDay(legacy, '2026-08-04')).toBeNull();
    expect(occurrenceDueDay(series({ dueOffsetDays: 0 }), '2026-08-04')).toBe('2026-08-04');
    expect(occurrenceDueDay(series({ dueOffsetDays: 1 }), '2026-08-31')).toBe('2026-09-01');
  });
  it('occurrenceFields stamps seriesDay and the due day, untimed and planned', () => {
    const f = occurrenceFields(series({ dueOffsetDays: 2 }), '2026-08-04');
    expect(f).toMatchObject({
      status: 'planned',
      seriesId: 's1',
      seriesDay: '2026-08-04',
      dueDay: '2026-08-06',
      dueTime: null,
      estimateMin: 60,
      reflection: null,
    });
  });
  it('a timed series: offset ≥ 1 spawns planned with the deadline; offset 0 spawns unplanned (D8)', () => {
    expect(
      occurrenceFields(series({ dueOffsetDays: 1, dueTime: '14:00' }), '2026-08-04'),
    ).toMatchObject({
      status: 'planned',
      seriesDay: '2026-08-04',
      dueDay: '2026-08-05',
      dueTime: '14:00',
    });
    expect(
      occurrenceFields(series({ dueOffsetDays: 0, dueTime: '14:00' }), '2026-08-04'),
    ).toMatchObject({ status: 'backlog', dueDay: '2026-08-04', dueTime: '14:00' });
    expect(occurrencePlanned(series({ dueOffsetDays: 1, dueTime: '14:00' }))).toBe(true);
    expect(occurrencePlanned(series({ dueOffsetDays: 0, dueTime: '14:00' }))).toBe(false);
    expect(occurrencePlanned(series({ dueOffsetDays: 0 }))).toBe(true);
    expect(occurrencePlanned(series())).toBe(true);
  });
  it('a stray time with no offset never makes a timed occurrence; a legacy row reads untimed', () => {
    expect(occurrenceFields(series({ dueTime: '14:00' }), '2026-08-04')).toMatchObject({
      status: 'planned',
      dueDay: null,
      dueTime: null,
    });
    const legacy = series({ dueOffsetDays: 1 });
    delete (legacy as Partial<TaskSeries>).dueTime;
    expect(occurrenceFields(legacy, '2026-08-04').dueTime).toBeNull();
  });
});

describe('seriesHasOccurrence', () => {
  it('by seriesDay, whatever the plan rows and status', () => {
    const s = series();
    const t = task({ status: 'backlog' });
    expect(seriesHasOccurrence(s, '2026-08-04', [t], [])).toBe(true);
    expect(seriesHasOccurrence(s, '2026-08-05', [t], [])).toBe(false);
  });
  it("another series' occurrence on the day doesn't count", () => {
    expect(seriesHasOccurrence(series(), '2026-08-04', [task({ seriesId: 's2' })], [])).toBe(false);
  });
  it('a pre-field occurrence (no seriesDay) is known by its plan row on the day', () => {
    const legacy = task({ seriesDay: undefined });
    expect(seriesHasOccurrence(series(), '2026-08-04', [legacy], [plan('t', '2026-08-04')])).toBe(
      true,
    );
    expect(seriesHasOccurrence(series(), '2026-08-04', [legacy], [])).toBe(false);
    expect(seriesHasOccurrence(series(), '2026-08-04', [legacy], [plan('x', '2026-08-04')])).toBe(
      false,
    );
  });
});

describe('seriesCadence', () => {
  it('omitted fields are null; valid ones pass through', () => {
    expect(seriesCadence({}, 4)).toEqual({ dueOffsetDays: null, until: null, dueTime: null });
    expect(seriesCadence({ dueOffsetDays: 0, until: '2026-11-30' }, 4)).toEqual({
      dueOffsetDays: 0,
      until: '2026-11-30',
      dueTime: null,
    });
    expect(seriesCadence({ dueOffsetDays: 1, dueTime: '14:00' }, 4)).toEqual({
      dueOffsetDays: 1,
      until: null,
      dueTime: '14:00',
    });
  });
  it('a negative or fractional offset, or a malformed until, throws', () => {
    expect(() => seriesCadence({ dueOffsetDays: -1 }, 4)).toThrow(SERIES_OFFSET_ERROR);
    expect(() => seriesCadence({ dueOffsetDays: 1.5 }, 4)).toThrow(SERIES_OFFSET_ERROR);
    expect(() => seriesCadence({ until: '2026-2-5' }, 4)).toThrow(SERIES_UNTIL_ERROR);
    expect(() => seriesCadence({ until: '2026-02-30' }, 4)).toThrow(SERIES_UNTIL_ERROR);
  });
  it('a malformed time, or a time with no due offset, throws (D8)', () => {
    for (const t of ['25:00', '2pm', '14:00:00', '9:00', ''])
      expect(() => seriesCadence({ dueOffsetDays: 1, dueTime: t }, 4)).toThrow(SERIES_TIME_ERROR);
    expect(() =>
      seriesCadence({ dueOffsetDays: 1, dueTime: 1400 as unknown as string }, 4),
    ).toThrow(SERIES_TIME_ERROR);
    expect(() => seriesCadence({ dueTime: '14:00' }, 4)).toThrow(SERIES_TIME_NEEDS_DUE_ERROR);
    expect(() => seriesCadence({ dueOffsetDays: null, dueTime: '14:00' }, 4)).toThrow(
      SERIES_TIME_NEEDS_DUE_ERROR,
    );
  });
  it('same day before the day start throws; the next day, or after the start, is fine (D8)', () => {
    expect(() => seriesCadence({ dueOffsetDays: 0, dueTime: '02:00' }, 4)).toThrow(
      SERIES_TIME_SMALL_HOURS_ERROR,
    );
    expect(seriesCadence({ dueOffsetDays: 0, dueTime: '04:00' }, 4).dueTime).toBe('04:00');
    expect(seriesCadence({ dueOffsetDays: 1, dueTime: '02:00' }, 4).dueTime).toBe('02:00');
    expect(seriesCadence({ dueOffsetDays: 0, dueTime: '02:00' }, 0).dueTime).toBe('02:00');
  });
});
