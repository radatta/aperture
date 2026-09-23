import { useState } from 'react';
import type { Task, TaskPlan } from '@aperture/shared';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Text } from '../../components/Text';
import { ChevronRightIcon, PlusIcon } from '../../components/icons';
import { cx } from '../../lib/cx';
import { useAddToDay } from '../../data/hooks/useAddToDay';
import { applyQuery, isFiltering, resetToLens } from './query';
import type { Place, QueryCtx, TaskQuery } from './query';
import { useCollapsedGroups } from './useTaskQuery';
import { TaskCard } from './TaskCard';

// History grows forever; show it a page at a time.
const DONE_PAGE = 50;

const EMPTY: Record<Place, { title: string; body: string }> = {
  today: { title: 'Nothing planned yet.', body: 'Pull something in from Week or the backlog.' },
  week: {
    title: 'Nothing due in the next 7 days.',
    body: 'That’s real slack — the backlog is still there if you want it.',
  },
  backlog: {
    title: 'Backlog is clear.',
    body: 'Switch the bar below to Task and type a title — you scope it later, in the plan pass.',
  },
  done: {
    title: 'Nothing finished yet.',
    body: 'Finished and dropped tasks collect here as history.',
  },
};

// One renderer for every list lens and for search: the query decides the tasks and the groups, this
// draws them. Each row gets the one plan action that fits where the task lives.
export function TaskListSection({
  place,
  query,
  onQueryChange,
  tasks,
  plans,
  ctx,
  pending,
  error,
}: {
  place: Place;
  query: TaskQuery;
  onQueryChange: (q: TaskQuery) => void;
  tasks: Task[];
  plans: TaskPlan[];
  ctx: QueryCtx;
  pending: boolean;
  error: boolean;
}) {
  const { addToDay, unplan } = useAddToDay();
  const collapsed = useCollapsedGroups();
  const [limit, setLimit] = useState(DONE_PAGE);
  const result = applyQuery(tasks, place, query, ctx);
  const filtering = isFiltering(query, place, ctx.categories);
  const planByTask = new Map(plans.map((p) => [p.taskId, p]));

  if (result.count === 0) {
    if (result.searching)
      return (
        <EmptyState
          pending={pending}
          error={error}
          title={`Nothing matches “${query.text.trim()}”.`}
        >
          Search covers titles and category names.
        </EmptyState>
      );
    if (filtering)
      return (
        <EmptyState
          pending={pending}
          error={error}
          title="Nothing matches."
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onQueryChange(resetToLens(query, place))}
            >
              Reset to lens
            </Button>
          }
        >
          Try fewer filters.
        </EmptyState>
      );
    return (
      <EmptyState pending={pending} error={error} title={EMPTY[place].title}>
        {EMPTY[place].body}
      </EmptyState>
    );
  }

  const row = (task: Task) => {
    const plan = planByTask.get(task.id);
    const open = task.status !== 'done' && task.status !== 'cancelled';
    const actions = plan ? (
      <Button variant="quiet" size="sm" onClick={() => unplan(plan, task)}>
        Unplan
      </Button>
    ) : open && task.status !== 'in_progress' ? (
      <Button
        variant="ghost"
        size="sm"
        className="gap-1"
        aria-label={`Add ${task.title} to today`}
        onClick={() => addToDay(task)}
      >
        <PlusIcon size={13} /> Today
      </Button>
    ) : undefined;
    return <TaskCard key={task.id} task={task} actions={actions} />;
  };

  return (
    <div className="flex flex-col gap-4">
      {result.groups.map((g) => {
        // Ungrouped: no header. The Done lens pages its (ever-growing) history.
        if (g.key === 'all') {
          const shown = place === 'done' ? g.tasks.slice(0, limit) : g.tasks;
          return (
            <div key={g.key} className="flex flex-col gap-2">
              {shown.map(row)}
              {shown.length < g.tasks.length && (
                <Button
                  variant="quiet"
                  size="sm"
                  className="self-start"
                  onClick={() => setLimit((n) => n + DONE_PAGE)}
                >
                  Show {Math.min(DONE_PAGE, g.tasks.length - shown.length)} more
                </Button>
              )}
            </div>
          );
        }
        const key = `${place}:${g.key}`;
        // A search or filter shows every hit — collapsing would hide the very thing you asked for.
        const isOpen = filtering || !collapsed.isCollapsed(key, g.tasks.length);
        return (
          <section key={g.key} className="flex flex-col gap-2">
            {filtering ? (
              <GroupLabel label={g.label} count={g.tasks.length} />
            ) : (
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => collapsed.toggle(key, g.tasks.length)}
                className="flex items-center gap-1 self-start text-ink-muted transition hover:text-ink"
              >
                <ChevronRightIcon size={13} className={cx('transition', isOpen && 'rotate-90')} />
                <GroupLabel label={g.label} count={g.tasks.length} />
              </button>
            )}
            {isOpen && g.tasks.map(row)}
          </section>
        );
      })}
    </div>
  );
}

function GroupLabel({ label, count }: { label: string; count: number }) {
  return (
    <Text size="xs" tone="muted" weight="medium" className="uppercase tracking-wider">
      {label} · {count}
    </Text>
  );
}
