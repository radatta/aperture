import { beforeEach, describe, expect, it } from 'vitest';
import { createStubClient } from './stubClient';

beforeEach(() => globalThis.localStorage?.clear());

function client() {
  return createStubClient({ seed: false, storageKey: `pconc-${Math.random()}` });
}

describe('concurrent focus timers', () => {
  it('runs several labeled work sessions at once', async () => {
    const api = client();
    const a = await api.startSession({ taskId: null, categoryId: null, kind: 'work', label: 'CC: refactor' });
    const b = await api.startSession({ taskId: null, categoryId: null, kind: 'work', label: 'CC: tests' });
    expect(a.id).not.toBe(b.id);

    const running = await api.listRunningSessions();
    expect(running).toHaveLength(2);
    expect(running.map((s) => s.label).sort()).toEqual(['CC: refactor', 'CC: tests']);
  });

  it('dedups per task — re-focusing a running task returns the same timer, not a duplicate', async () => {
    const api = client();
    const cat = await api.upsertCategory({ label: 'Work', isWork: true });
    const task = await api.createTask({ title: 'Ship it', categoryId: cat.id });

    const first = await api.startSession({ taskId: task.id, categoryId: null, kind: 'work', label: null });
    const again = await api.startSession({ taskId: task.id, categoryId: null, kind: 'work', label: null });
    expect(again.id).toBe(first.id);
    expect(await api.listRunningSessions()).toHaveLength(1);
  });

  it('does NOT dedup ad-hoc (task-less) focuses', async () => {
    const api = client();
    await api.startSession({ taskId: null, categoryId: null, kind: 'work', label: 'one' });
    await api.startSession({ taskId: null, categoryId: null, kind: 'work', label: 'two' });
    expect(await api.listRunningSessions()).toHaveLength(2);
  });

  it('stopping one timer leaves the others running', async () => {
    const api = client();
    const a = await api.startSession({ taskId: null, categoryId: null, kind: 'work', label: 'a' });
    await api.startSession({ taskId: null, categoryId: null, kind: 'work', label: 'b' });

    await api.stopSession(a.id, 'completed');
    const running = await api.listRunningSessions();
    expect(running).toHaveLength(1);
    expect(running[0]!.label).toBe('b');
  });

  it('preserves the label across a heartbeat', async () => {
    const api = client();
    const s = await api.startSession({ taskId: null, categoryId: null, kind: 'work', label: 'keep me' });
    const beat = await api.heartbeatSession(s.id);
    expect(beat.label).toBe('keep me');
  });
});
