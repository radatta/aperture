import { describe, expect, it } from 'vitest';
import type { Ctx } from '../scenario';
import { GARDEN, KITCHEN, name } from './category-suggest';
import { categorySuggestIos } from './category-suggest-ios';

// A partition: categories and tasks, written through the fake API the seed step sees.
function partition() {
  const cats: { id: string; label: string }[] = [];
  const tasks: { id: string; title: string; categoryId?: string }[] = [];
  const ctx = {
    nonce: 'n1',
    log: () => undefined,
    api: {
      reads: { listCategories: async () => cats, listTasks: async () => tasks },
      writes: {
        upsertCategory: async ({ label }: { label: string }) => {
          const c = { id: `c${cats.length + 1}`, label };
          cats.push(c);
          return c;
        },
        createTask: async (t: { title: string; categoryId?: string }) => {
          const x = { id: `t${tasks.length + 1}`, ...t };
          tasks.push(x);
          return x;
        },
      },
    },
  } as unknown as Ctx;
  return { cats, tasks, ctx };
}
const seed = categorySuggestIos.steps.find((s) => s.id === 'seed')!;

describe('category-suggest-ios', () => {
  it('seeds Garden and Kitchen history in a partition that has none (the iPhone lane’s)', async () => {
    const p = partition();
    await seed.run(p.ctx);
    expect(p.cats.map((c) => c.label)).toEqual(['Garden', 'Kitchen']);
    expect(p.tasks).toHaveLength(GARDEN.length + KITCHEN.length);
    expect(p.tasks.filter((t) => t.categoryId === 'c1').map((t) => t.title)).toEqual(
      GARDEN.map((t) => name(p.ctx, t)),
    );
  });

  it('skips the seed where category-suggest already seeded this run (a one-user run): one Garden only', async () => {
    const p = partition();
    await seed.run(p.ctx); // category-suggest's own seed has the same shape and titles
    await seed.run(p.ctx);
    expect(p.cats.map((c) => c.label)).toEqual(['Garden', 'Kitchen']);
    expect(p.tasks).toHaveLength(GARDEN.length + KITCHEN.length);
  });

  it('an earlier run’s leftover Garden neither stops this run’s seed nor hides it', async () => {
    const p = partition();
    await seed.run({ ...p.ctx, nonce: 'old' } as Ctx);
    await seed.run(p.ctx);
    await seed.run(p.ctx); // seeded now, behind the leftover Garden listed first
    expect(p.cats.filter((c) => c.label === 'Garden')).toHaveLength(2);
  });

  it('runs in the iPhone lane, every step slow, after category-suggest', () => {
    expect(categorySuggestIos.user).toBe('iphone');
    expect(categorySuggestIos.steps.every((s) => s.cost === 'slow')).toBe(true);
    expect(categorySuggestIos.order).toBeGreaterThan(260);
  });
});
