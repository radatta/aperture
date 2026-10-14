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
    // the follow-up is always new; the parent only when the split task was ours (deleting a parent
    // deletes its parts, so an unrecorded original under it must keep the parent off the ledger)
    const split = { parent: { id: 'p' }, original: { id: 'o' }, followUp: { id: 'f' } };
    expect(idsFromCreateResponse('splitTask', split, (id) => id === 'o')).toEqual(['p', 'f']);
    expect(idsFromCreateResponse('splitTask', split)).toEqual(['f']);
  });

  it('ignores other methods and malformed bodies', () => {
    expect(idsFromCreateResponse('listTasks', [{ id: 'a' }])).toEqual([]);
    expect(idsFromCreateResponse('createTask', null)).toEqual([]);
    expect(idsFromCreateResponse('createTasks', { id: 'a' })).toEqual([]);
  });
});
