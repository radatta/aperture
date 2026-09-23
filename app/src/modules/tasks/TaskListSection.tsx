import { useRef, useState } from 'react';
import type { Task, TaskPlan } from '@aperture/shared';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Text } from '../../components/Text';
import { ChevronRightIcon, PlusIcon } from '../../components/icons';
import { cx } from '../../lib/cx';
import { useRowAction } from '../../lib/useRowAction';
import { useAddToDay } from '../../data/hooks/useAddToDay';
import { applyQuery, isNarrowing, resetToLens } from './query';
import type { Place, QueryCtx, TaskGroup, TaskQuery } from './query';
import { useCollapsedGroups } from './useTaskQuery';
import { TaskCard } from './TaskCard';

// History grows forever; show it a page at a time.
const DONE_PAGE = 50;

// Today has its own renderer (TodayLens) — it only reaches this component while searching.
const EMPTY: Record<Exclude<Place, 'today'>, { title: string; body: string }> = {
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

// Cap the rows across all groups (Done's paging holds however it's grouped).
function capGroups(groups: TaskGroup[], limit: number): TaskGroup[] {
  let left = limit;
  return groups
    .map((g) => {
      const tasks = g.tasks.slice(0, Math.max(0, left));
      left -= tasks.length;
      return { ...g, tasks };
    })
    .filter((g) => g.tasks.length > 0);
}

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
  const listRef = useRef<HTMLDivElement>(null);
  const action = useRowAction(listRef);
  // Paging belongs to one query: a new search (or lens) starts back at the first page.
  const [page, setPage] = useState({ key: '', limit: DONE_PAGE });
  const pageKey = `${place}|${query.text}`;
  const limit = page.key === pageKey ? page.limit : DONE_PAGE;

  const result = applyQuery(tasks, place, query, ctx);
  // Search and narrowing filters open every group; a sort or grouping change doesn't.
  const narrowing = isNarrowing(query);
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
    if (narrowing)
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
    const empty = EMPTY[place === 'today' ? 'backlog' : place];
    return (
      <EmptyState pending={pending} error={error} title={empty.title}>
        {empty.body}
      </EmptyState>
    );
  }

  const row = (task: Task) => {
    const plan = planByTask.get(task.id);
    const open = task.status !== 'done' && task.status !== 'cancelled';
    const busy = action.isBusy(task.id);
    const actions = plan ? (
      <Button
        variant="quiet"
        size="sm"
        disabled={busy}
        onClick={() => action.run(task.id, () => unplan(plan, task))}
      >
        Unplan
      </Button>
    ) : open && task.status !== 'in_progress' ? (
      <Button
        variant="ghost"
        size="sm"
        className="gap-1"
        disabled={busy}
        aria-label={`Add ${task.title} to today`}
        onClick={() => action.run(task.id, () => addToDay(task))}
      >
        <PlusIcon size={13} /> Today
      </Button>
    ) : undefined;
    return <TaskCard key={task.id} task={task} actions={actions} />;
  };

  const groups = place === 'done' ? capGroups(result.groups, limit) : result.groups;
  const shown = groups.reduce((n, g) => n + g.tasks.length, 0);

  return (
    <div ref={listRef} tabIndex={-1} className="flex flex-col gap-4 outline-none">
      <div role="status">
        {action.failed && (
          <Text size="sm" tone="danger">
            Couldn&apos;t save that — try again.
          </Text>
        )}
      </div>
      {groups.map((g) => {
        // Ungrouped: no header.
        if (g.key === 'all')
          return (
            <div key={g.key} className="flex flex-col gap-2">
              {g.tasks.map(row)}
            </div>
          );
        const key = `${place}:${g.key}`;
        const isOpen = narrowing || !collapsed.isCollapsed(key, g.tasks.length);
        return (
          <section key={g.key} aria-label={g.label} className="flex flex-col gap-2">
            {narrowing ? (
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
      {shown < result.count && (
        <Button
          variant="quiet"
          size="sm"
          className="self-start"
          onClick={() => setPage({ key: pageKey, limit: limit + DONE_PAGE })}
        >
          Show {Math.min(DONE_PAGE, result.count - shown)} more
        </Button>
      )}
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
