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
    place: 'safeway',
    deletedAt: null,
    createdAt: 1,
    ...over,
  }) as Task;

describe('slugify', () => {
  it('lowercases, folds accents and dashes everything else', () => {
    expect(slugify('Safeway')).toBe('safeway');
    expect(slugify("Trader Joe's")).toBe('trader-joe-s');
    expect(slugify('  Café  Olé! ')).toBe('cafe-ole');
    expect(slugify('x'.repeat(40))).toHaveLength(32);
    expect(slugify('!!!')).toBe('');
  });
});

describe('placeError', () => {
  it('names, slugs and uniqueness', () => {
    expect(placeError('Safeway', 'safeway', [])).toBeNull();
    expect(placeError(' ', 'safeway', [])).toMatch(/needs a name/);
    expect(placeError('x'.repeat(41), 'x', [])).toMatch(/at most 40/);
    expect(placeError('Safeway', 'Safeway', [])).toMatch(/lowercase/);
    expect(placeError('Safeway', '-x', [])).toMatch(/lowercase/);
    expect(placeError('Safeway', 'safeway', [{ slug: 'safeway' }])).toMatch(/already uses/);
  });
});

describe('placeDigest', () => {
  it('lists open alive errands on that list, oldest first', () => {
    const tasks = [
      task({ id: 'b', title: 'nails', createdAt: 2 }),
      task({ id: 'a', title: 'shampoo', createdAt: 1 }),
      task({ id: 'c', title: 'done one', status: 'done' }),
      task({ id: 'd', title: 'gone', deletedAt: 5 }),
      task({ id: 'e', title: 'elsewhere', place: 'target' }),
      task({ id: 'f', title: 'syrup', status: 'in_progress', createdAt: 3 }),
    ];
    expect(placeTasks('safeway', tasks).map((t) => t.id)).toEqual(['a', 'b', 'f']);
    expect(placeDigestOf({ name: 'Safeway', slug: 'safeway' }, tasks)).toEqual({
      place: 'Safeway',
      slug: 'safeway',
      count: 3,
      titles: ['shampoo', 'nails', 'syrup'],
      text: 'Safeway · 3 — shampoo, nails, syrup',
    });
  });
  it('an empty list has empty text, so the Shortcut skips the banner', () => {
    expect(placeDigestText('Safeway', [])).toBe('');
  });
  it(`lists at most ${PLACE_DIGEST_TITLES_MAX} titles, then +N more`, () => {
    const titles = Array.from({ length: 14 }, (_, i) => `t${i}`);
    const text = placeDigestText('Safeway', titles);
    expect(text).toMatch(/^Safeway · 14 — t0, /);
    expect(text).toMatch(/t11 \+2 more$/);
  });
  it('links the Places lens', () => {
    expect(placeLensPath('trader-joes')).toBe('/tasks?lens=places&place=trader-joes');
  });
});
