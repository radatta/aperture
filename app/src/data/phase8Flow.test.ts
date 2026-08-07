import { beforeEach, describe, expect, it } from 'vitest';
import { createStubClient } from './stubClient';

beforeEach(() => globalThis.localStorage?.clear());

function client() {
  return createStubClient({ seed: false, storageKey: `p8-${Math.random()}` });
}

describe('category isWork flip + backfill', () => {
  it('flips isWork and optionally reclassifies past sessions', async () => {
    const api = client();
    const cat = await api.upsertCategory({ label: 'Side project', isWork: true });
    const task = await api.createTask({ title: 't', categoryId: cat.id });
    const session = await api.startSession({
      day: '2026-08-04',
      taskId: task.id,
      categoryId: null,
      kind: 'work',
    });
    expect(session.wasWork).toBe(true); // snapshot at write time

    const noBackfill = await api.setCategoryWork(cat.id, false, false);
    expect(noBackfill.category.isWork).toBe(false);
    expect(noBackfill.backfilled).toBe(0);
    expect((await api.findRunningSession())!.wasWork).toBe(true); // history untouched

    const withBackfill = await api.setCategoryWork(cat.id, true, true);
    expect(withBackfill.backfilled).toBe(1);
    expect((await api.findRunningSession())!.wasWork).toBe(true);
  });
});

describe('delete category reassigns referrers first', () => {
  it('moves referencing tasks to the target, then removes the category', async () => {
    const api = client();
    const a = await api.upsertCategory({ label: 'A', isWork: true });
    const b = await api.upsertCategory({ label: 'B', isWork: true });
    const task = await api.createTask({ title: 't', categoryId: a.id });

    await api.deleteCategory(a.id, b.id);
    expect((await api.listCategories()).map((c) => c.id)).not.toContain(a.id);
    expect((await api.getTask(task.id))!.categoryId).toBe(b.id); // reassigned, not orphaned
  });

  it('refuses to delete a referenced category without a reassignment target', async () => {
    const api = client();
    const a = await api.upsertCategory({ label: 'A', isWork: true });
    await api.createTask({ title: 't', categoryId: a.id });
    await expect(api.deleteCategory(a.id, null)).rejects.toThrow();
  });
});

describe('settings + export', () => {
  it('updates settings and exports a data snapshot', async () => {
    const api = client();
    const updated = await api.updateSettings({ dayStartHour: 5, pomodoroWorkMin: 50 });
    expect(updated.dayStartHour).toBe(5);
    expect(updated.pomodoroWorkMin).toBe(50);

    await api.createLogEntry('exportable', '2026-08-04');
    const data = (await api.exportData()) as { logEntries: { text: string }[] };
    expect(data.logEntries.some((l) => l.text === 'exportable')).toBe(true);
  });
});
