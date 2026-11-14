import { describe, expect, it } from 'vitest';
import {
  PLACE_DIGEST_TITLES_MAX,
  placeDigestOf,
  placeDigestText,
  placeError,
  placeLensPath,
  placeTasks,
  slugify,
} from './places';
import type { Task } from './types';

const task = (over: Partial<Task>): Task =>
  ({
    id: 't',
    status: 'backlog',
    place: 'grocer',
    deletedAt: null,
    createdAt: 1,
    ...over,
  }) as Task;

describe('slugify', () => {
  it('lowercases, folds accents and dashes everything else', () => {
    expect(slugify('Grocer')).toBe('grocer');
    expect(slugify("Thrift Jo's")).toBe('thrift-jo-s');
    expect(slugify('  Café  Olé! ')).toBe('cafe-ole');
    expect(slugify('x'.repeat(40))).toHaveLength(32);
    expect(slugify('!!!')).toBe('');
  });
});

describe('placeError', () => {
  it('names, slugs and uniqueness', () => {
    expect(placeError('Grocer', 'grocer', [])).toBeNull();
    expect(placeError(' ', 'grocer', [])).toMatch(/needs a name/);
    expect(placeError('x'.repeat(41), 'x', [])).toMatch(/at most 40/);
    expect(placeError('Grocer', 'Grocer', [])).toMatch(/lowercase/);
    expect(placeError('Grocer', '-x', [])).toMatch(/lowercase/);
    expect(placeError('Grocer', 'grocer', [{ slug: 'grocer' }])).toMatch(/already uses/);
  });
});

describe('placeDigest', () => {
  it('lists open alive errands on that list, oldest first', () => {
    const tasks = [
      task({ id: 'b', title: 'tape', createdAt: 2 }),
      task({ id: 'a', title: 'batteries', createdAt: 1 }),
      task({ id: 'c', title: 'done one', status: 'done' }),
      task({ id: 'd', title: 'gone', deletedAt: 5 }),
      task({ id: 'e', title: 'elsewhere', place: 'tackle' }),
      task({ id: 'f', title: 'stamps', status: 'in_progress', createdAt: 3 }),
    ];
    expect(placeTasks('grocer', tasks).map((t) => t.id)).toEqual(['a', 'b', 'f']);
    expect(placeDigestOf({ name: 'Grocer', slug: 'grocer' }, tasks)).toEqual({
      place: 'Grocer',
      slug: 'grocer',
      count: 3,
      titles: ['batteries', 'tape', 'stamps'],
      text: 'Grocer · 3 — batteries, tape, stamps',
    });
  });
  it('lists the items: a parent with open parts gives way to them, one with only finished parts stays', () => {
    const tasks = [
      task({ id: 'p', title: 'party', createdAt: 1 }),
      task({ id: 'p1', title: 'cups', parentId: 'p', createdAt: 2 }),
      task({ id: 'p2', title: 'ice', parentId: 'p', createdAt: 3, status: 'done' }),
      task({ id: 'q', title: 'dinner', createdAt: 4 }),
      task({ id: 'q1', title: 'rice', parentId: 'q', createdAt: 5, status: 'cancelled' }),
      task({ id: 'q2', title: 'beans', parentId: 'q', createdAt: 6, deletedAt: 7 }),
      task({ id: 'r', title: 'loose', createdAt: 8 }),
    ];
    expect(placeTasks('grocer', tasks).map((t) => t.id)).toEqual(['p1', 'q', 'r']);
    expect(placeDigestOf({ name: 'Grocer', slug: 'grocer' }, tasks).count).toBe(3);
  });
  it('an empty list has empty text, so the Shortcut skips the banner', () => {
    expect(placeDigestText('Grocer', [])).toBe('');
  });
  it(`lists at most ${PLACE_DIGEST_TITLES_MAX} titles, then +N more`, () => {
    const titles = Array.from({ length: 14 }, (_, i) => `t${i}`);
    const text = placeDigestText('Grocer', titles);
    expect(text).toMatch(/^Grocer · 14 — t0, /);
    expect(text).toMatch(/t11 \+2 more$/);
  });
  it('links the Places lens', () => {
    expect(placeLensPath('thrift-jos')).toBe('/tasks?lens=places&place=thrift-jos');
  });
});
