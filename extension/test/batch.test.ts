import { describe, expect, it } from 'vitest';
import { lib } from './load';

const { createBatcher } = lib('batch');
const snap = (code: string) => ({ id: code, type: 'snapshot', at: 0, payload: { code } });
const ev = (type: string, id = type) => ({ id, type, at: 0, payload: {} });
const ids = (events: Array<{ id: string }>) => events.map((e) => e.id);

describe('batch', () => {
  it('sends at most one snapshot per 30 s window, the latest one, and the pending one before a run or submit and on hide', () => {
    const b = createBatcher();
    expect(b.push(snap('v1'), 0)).toBe('later');
    expect(b.dueAt()).toBe(30_000);
    b.push(snap('v2'), 10_000);
    b.push(snap('v3'), 29_000);
    expect(b.drain(29_999)).toEqual([]);
    expect(ids(b.drain(30_000))).toEqual(['v3']); // trailing: the window's latest code
    expect(b.dueAt()).toBeNull();

    // A new window opens at the next snapshot; a submit takes the pending snapshot with it, first.
    b.push(snap('v4'), 40_000);
    expect(b.push(ev('submit'), 41_000)).toBe('now');
    expect(ids(b.flush())).toEqual(['v4', 'submit']);
    expect(b.drain(70_000)).toEqual([]);

    // Hide (or a nav) flushes whatever waits.
    b.push(snap('v5'), 80_000);
    b.push(ev('note'), 80_500);
    expect(ids(b.flush())).toEqual(['v5', 'note']);
    expect(b.flush()).toEqual([]);
  });

  it('coalesces other events for 3 s, apart from the snapshot window', () => {
    const b = createBatcher();
    b.push(snap('v1'), 0);
    expect(b.push(ev('timer', 't1'), 1000)).toBe('later');
    b.push(ev('replay', 'r1'), 2000);
    expect(b.dueAt()).toBe(4000);
    expect(ids(b.drain(4000))).toEqual(['t1', 'r1']);
    expect(b.dueAt()).toBe(30_000);
    expect(b.push(ev('run'), 5000)).toBe('now');
  });
});
