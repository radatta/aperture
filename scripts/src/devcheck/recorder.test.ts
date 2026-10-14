import { describe, expect, it } from 'vitest';
import { idsFromCreateResponse, methodOf } from './recorder';

describe('recorder', () => {
  it('reads the method from an /api/ URL', () => {
    expect(methodOf('https://dev.aperture.rahuldatta.dev/api/createTask')).toBe('createTask');
    expect(methodOf('https://dev.aperture.rahuldatta.dev/assets/x.js')).toBeUndefined();
  });

  it('takes ids from each create response shape', () => {
    expect(idsFromCreateResponse('createTask', { id: 'a' })).toEqual(['a']);
    expect(idsFromCreateResponse('createTasks', [{ id: 'a' }, { id: 'b' }])).toEqual(['a', 'b']);
    // a split makes a new parent (standalone) and always a new follow-up; the original isn't new
    expect(
      idsFromCreateResponse('splitTask', {
        parent: { id: 'p' },
        original: { id: 'o' },
        followUp: { id: 'f' },
      }),
    ).toEqual(['p', 'f']);
  });

  it('ignores other methods and malformed bodies', () => {
    expect(idsFromCreateResponse('listTasks', [{ id: 'a' }])).toEqual([]);
    expect(idsFromCreateResponse('createTask', null)).toEqual([]);
    expect(idsFromCreateResponse('createTasks', { id: 'a' })).toEqual([]);
  });
});
