import { describe, expect, it } from 'vitest';
import type { Task } from '@aperture/shared';
import { applyWrites, LOCAL_WRITE_TTL_MS, mergeTasks } from './taskCache';

const t = (id: string, updatedAt: number, over: Partial<Task> = {}): Task =>
  ({ id, createdAt: Number(id.slice(1)), updatedAt, title: id, ...over }) as Task;
const local = (entries: [string, { at: number; task: Task | null }][]) => new Map(entries);

describe('mergeTasks', () => {
  it('a newer local copy beats a stale server read; the server catching up prunes it', () => {
    const mem = local([['t1', { at: 0, task: t('t1', 20, { title: 'mine' }) }]]);
    expect(mergeTasks([t('t1', 10)], mem, 1)[0]!.title).toBe('mine');
    expect(mem.has('t1')).toBe(true);
    expect(mergeTasks([t('t1', 20, { title: 'server' })], mem, 2)[0]!.title).toBe('server');
    expect(mem.has('t1')).toBe(false);
  });

  it('another device’s later write wins over ours', () => {
    const mem = local([['t1', { at: 0, task: t('t1', 20, { title: 'mine' }) }]]);
    expect(mergeTasks([t('t1', 30, { title: 'theirs' })], mem, 1)[0]!.title).toBe('theirs');
    expect(mem.has('t1')).toBe(false);
  });

  it('a task the read hasn’t caught up to is kept within the TTL, dropped after', () => {
    const mem = local([['t2', { at: 0, task: t('t2', 5) }]]);
    expect(mergeTasks([t('t1', 1)], mem, LOCAL_WRITE_TTL_MS).map((x) => x.id)).toEqual([
      't2',
      't1',
    ]);
    expect(mergeTasks([t('t1', 1)], mem, LOCAL_WRITE_TTL_MS + 1).map((x) => x.id)).toEqual(['t1']);
    expect(mem.size).toBe(0);
  });

  it('a task deleted here stays gone within the TTL, and comes back after (a lost delete heals)', () => {
    const mem = local([['t1', { at: 0, task: null }]]);
    expect(mergeTasks([t('t1', 1)], mem, 10)).toEqual([]);
    expect(mergeTasks([t('t1', 1)], mem, LOCAL_WRITE_TTL_MS + 1).map((x) => x.id)).toEqual(['t1']);
  });
});

describe('applyWrites', () => {
  it('replaces by id, inserts newest-created first, removes; an older write never replaces', () => {
    const list = [t('t2', 5), t('t1', 5)];
    expect(applyWrites(list, [t('t1', 9, { title: 'new' })], [])![1]!.title).toBe('new');
    expect(applyWrites(list, [t('t1', 4, { title: 'old' })], [])![1]!.title).toBe('t1');
    expect(applyWrites(list, [t('t3', 1)], ['t2'])!.map((x) => x.id)).toEqual(['t3', 't1']);
  });

  it('no list loaded stays no list — never a one-row list', () => {
    expect(applyWrites(undefined, [t('t1', 1)], [])).toBeUndefined();
  });
});
