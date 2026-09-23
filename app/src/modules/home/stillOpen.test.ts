import { describe, expect, it } from 'vitest';
import type { Task, TaskPlan, TaskStatus } from '@aperture/shared';
import { stillOpen } from './stillOpen';

const row = (id: string, status: TaskStatus) => ({
  plan: { id: `p-${id}`, taskId: id } as TaskPlan,
  task: { id, status } as Task,
});

describe('stillOpen', () => {
  const rows = [
    row('planned', 'planned'),
    row('started', 'in_progress'),
    row('backlog', 'backlog'),
    row('done', 'done'),
    row('dropped', 'cancelled'),
  ];

  it('keeps unfinished rows only', () => {
    expect(stillOpen(rows, new Set(), new Set()).map((r) => r.task.id)).toEqual([
      'planned',
      'started',
      'backlog',
    ]);
  });

  it('drops what is already on tomorrow, and what was left this session', () => {
    const out = stillOpen(rows, new Set(['planned']), new Set(['backlog']));
    expect(out.map((r) => r.task.id)).toEqual(['started']);
  });
});
