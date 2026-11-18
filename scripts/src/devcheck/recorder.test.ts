import { describe, expect, it } from 'vitest';
import { idsFromCreateResponse, isCreateRequest, methodOf } from './recorder';

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
    expect(idsFromCreateResponse('splitTask', split, (o, p) => o === 'o' && p === 'p')).toEqual([
      'p',
      'f',
    ]);
    expect(idsFromCreateResponse('splitTask', split)).toEqual(['f']);
  });

  it('records a series added on the Recurring tab, never an edit of one', () => {
    expect(idsFromCreateResponse('upsertSeries', { id: 's1', title: 'Weekly report' })).toEqual([
      's1',
    ]);
    const body = (input: unknown) => JSON.stringify({ args: [input] });
    expect(isCreateRequest('upsertSeries', body({ title: 'Weekly report' }))).toBe(true);
    expect(isCreateRequest('upsertSeries', body({ id: 's1', title: 'Weekly report' }))).toBe(false);
  });

  it('records a place added in Settings, never an edit of an existing one', () => {
    expect(idsFromCreateResponse('upsertPlace', { id: 'p1', slug: 'shop' })).toEqual(['p1']);
    const body = (input: unknown) => JSON.stringify({ args: [input] });
    expect(isCreateRequest('upsertPlace', body({ name: 'Shop' }))).toBe(true);
    expect(isCreateRequest('upsertPlace', body({ id: 'p1', name: 'Shop' }))).toBe(false);
    // unreadable: not recorded (the end-of-run check reports a place that appeared)
    expect(isCreateRequest('upsertPlace', null)).toBe(false);
    expect(isCreateRequest('upsertPlace', 'not json')).toBe(false);
    expect(isCreateRequest('createTask', null)).toBe(true);
    expect(isCreateRequest('listPlaces', body({}))).toBe(false);
    // A category added in Settings follows the same rule (the areas scenario).
    expect(idsFromCreateResponse('upsertCategory', { id: 'c1', label: 'X' })).toEqual(['c1']);
    expect(isCreateRequest('upsertCategory', body({ label: 'X', isWork: true }))).toBe(true);
    expect(isCreateRequest('upsertCategory', body({ id: 'c1', label: 'X', isWork: true }))).toBe(
      false,
    );
    expect(isCreateRequest('upsertCategory', null)).toBe(false);
    // A mock logged or planned on the Today card too; "Log it" on a planned one names its id, an edit.
    expect(idsFromCreateResponse('upsertMock', { id: 'm1', status: 'done' })).toEqual(['m1']);
    expect(isCreateRequest('upsertMock', body({ scores: { code: 3, solve: 2 } }))).toBe(true);
    expect(isCreateRequest('upsertMock', body({ id: 'm1', status: 'done' }))).toBe(false);
  });

  it('records a push device Settings’ Enable subscribed, by the id the server answered with', () => {
    expect(isCreateRequest('subscribePush', JSON.stringify({ args: [{}] }))).toBe(true);
    expect(idsFromCreateResponse('subscribePush', { id: 'd1', label: 'x' })).toEqual(['d1']);
    expect(idsFromCreateResponse('subscribePush', { error: 'nope' })).toEqual([]);
    expect(isCreateRequest('unsubscribePush', JSON.stringify({ args: ['d1'] }))).toBe(false);
  });

  it('records a log entry the capture bar created, by the id the server answered with', () => {
    expect(isCreateRequest('createLogEntry', JSON.stringify({ args: ['x', '2026-11-05'] }))).toBe(
      true,
    );
    expect(idsFromCreateResponse('createLogEntry', { id: 'L1', day: '2026-11-05' })).toEqual([
      'L1',
    ]);
    expect(isCreateRequest('updateLogEntry', JSON.stringify({ args: ['L1', 'y'] }))).toBe(false);
  });

  it('records a capture token Settings minted by its info.id — never the plaintext beside it', () => {
    expect(isCreateRequest('mintScopedToken', JSON.stringify({ args: ['capture', 'phone'] }))).toBe(
      true,
    );
    const answer = { token: `apc_${'x'.repeat(43)}`, info: { id: 'K1', hint: 'xxxx' } };
    expect(idsFromCreateResponse('mintScopedToken', answer)).toEqual(['K1']);
    expect(idsFromCreateResponse('mintScopedToken', { error: 'At most 5 tokens' })).toEqual([]);
    expect(idsFromCreateResponse('mintScopedToken', null)).toEqual([]);
    expect(isCreateRequest('revokeScopedToken', JSON.stringify({ args: ['K1'] }))).toBe(false);
  });

  it('ignores other methods and malformed bodies', () => {
    expect(idsFromCreateResponse('listTasks', [{ id: 'a' }])).toEqual([]);
    expect(idsFromCreateResponse('createTask', null)).toEqual([]);
    expect(idsFromCreateResponse('createTasks', { id: 'a' })).toEqual([]);
  });
});
