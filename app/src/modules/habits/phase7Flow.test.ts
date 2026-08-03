import { beforeEach, describe, expect, it } from 'vitest';
import { createStubClient } from '../../data/stubClient';

beforeEach(() => globalThis.localStorage?.clear());

function client() {
  return createStubClient({ seed: false, storageKey: `p7-${Math.random()}` });
}

describe('inbox triage', () => {
  it('moves an idea out of the open list on triage', async () => {
    const api = client();
    const idea = await api.createIdea('write the thing');
    expect((await api.listIdeas('open')).map((i) => i.id)).toContain(idea.id);
    await api.triageIdea(idea.id, 'triaged');
    expect((await api.listIdeas('open')).map((i) => i.id)).not.toContain(idea.id);
  });

  it('triage-to-task creates a backlog task from the idea text', async () => {
    const api = client();
    const idea = await api.createIdea('refactor the parser');
    const task = await api.createTask({ title: idea.text });
    await api.triageIdea(idea.id, 'triaged');
    expect(task.status).toBe('backlog');
    expect(task.title).toBe('refactor the parser');
  });
});

describe('habit checks — idempotent + repair-friendly', () => {
  it('checking is unique per (habit, date) and a past day is editable', async () => {
    const api = client();
    const h = await api.upsertHabit({ name: 'Read', categoryId: null, cadencePerWeek: 5 });
    await api.checkHabit(h.id, '2026-08-03');
    await api.checkHabit(h.id, '2026-08-03'); // idempotent — no duplicate
    const yesterday = await api.checkHabit(h.id, '2026-08-02'); // repair a missed day
    expect(yesterday).toBeDefined();
    const checks = await api.listHabitChecks({ from: '2026-08-01', to: '2026-08-09' });
    const mine = checks.filter((c) => c.habitId === h.id);
    expect(mine).toHaveLength(2); // one per date, no dupes
    await api.uncheckHabit(h.id, '2026-08-03');
    const after = (await api.listHabitChecks({ from: '2026-08-01', to: '2026-08-09' })).filter(
      (c) => c.habitId === h.id,
    );
    expect(after).toHaveLength(1);
  });
});
