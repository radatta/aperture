import { describe, it, expect } from 'vitest';
import type { Task } from '@aperture/shared';
import { plannedDefault, remainingMin, ruleSummary, suggestedBuffer } from './taskMath';

const task = (over: Partial<Task>): Task => ({
  id: 't',
  userId: 'local',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  title: 'x',
  status: 'backlog',
  categoryId: null,
  seriesId: null,
  estimateMin: null,
  bufferMin: null,
  estimateLockedMin: null,
  actualAccruedMin: 0,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
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
  it('uses the frozen estimate once locked, minus accrued, floored at 0', () => {
    expect(remainingMin(task({ estimateLockedMin: 60, actualAccruedMin: 20 }))).toBe(40);
    expect(remainingMin(task({ estimateLockedMin: 60, actualAccruedMin: 90 }))).toBe(0);
    expect(remainingMin(task({ estimateMin: 45, actualAccruedMin: 0 }))).toBe(45);
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
