import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { isTimed } from '@aperture/shared';
import type { Task, TaskPlan } from '@aperture/shared';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Text } from '../../components/Text';
import { PlusIcon } from '../../components/icons';
import { useRowAction } from '../../lib/useRowAction';
import { partsOf, partsSummary } from '@aperture/shared';
import { useAddToDay } from '../../data/hooks/useAddToDay';
import { useTransitionTask } from '../../data/hooks/useTasks';
import {
  applyQuery,
  COLLAPSE_AT,
  isNarrowing,
  labelOfFrom,
  matchedInNotes,
  resetToLens,
} from './query';
import type { Place, QueryCtx, TaskGroup, TaskQuery } from './query';
import { useCollapsedGroups } from './useTaskQuery';
import { GroupHeader } from './GroupHeader';
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
  onRetry,
}: {
  place: Place;
  query: TaskQuery;
  onQueryChange: (q: TaskQuery) => void;
  tasks: Task[];
  plans: TaskPlan[];
  ctx: QueryCtx;
  pending: boolean;
  error: boolean;
  onRetry?: () => void; // the failed read's refetch
}) {
  const { addToDay, unplan } = useAddToDay();
  const transition = useTransitionTask();
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
  const labelOf = labelOfFrom(ctx.categories);

  // Every branch renders inside the same focusable wrapper: when the last row leaves, focus still
  // has somewhere to land.
  const wrap = (children: ReactNode) => (
    <div ref={listRef} tabIndex={-1} className="flex flex-col gap-4 outline-none">
      <div role="status">
        {action.failed && (
          <Text size="sm" tone="danger">
            {action.message ?? 'Couldn’t save that — try again.'}
          </Text>
        )}
      </div>
      {children}
    </div>
  );

  if (result.count === 0) {
    if (result.searching)
      return wrap(
        <EmptyState
          pending={pending}
          error={error}
          onRetry={onRetry}
          title={`Nothing matches “${query.text.trim()}”.`}
        >
          Search covers titles, category names, and notes.
        </EmptyState>,
      );
    if (narrowing)
      return wrap(
        <EmptyState
          pending={pending}
          error={error}
          onRetry={onRetry}
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
        </EmptyState>,
      );
    const empty = EMPTY[place === 'today' ? 'backlog' : place];
    return wrap(
      <EmptyState pending={pending} error={error} onRetry={onRetry} title={empty.title}>
        {empty.body}
      </EmptyState>,
    );
  }

  const row = (task: Task) => {
    const plan = planByTask.get(task.id);
    const open = task.status !== 'done' && task.status !== 'cancelled';
    const busy = action.isBusy(task.id);
    const parts = partsOf(tasks, task.id);
    // A parent is never planned (parts.ts): its one action is Mark done, once every part is dealt with.
    // A finished task's row is history (capacity, Big 3): never offer to unplan it. A timed task's day
    // is its time (lenses.md D13): nothing to add or unplan — its card already says when.
    const actions = parts.length ? (
      open && partsSummary(parts).allDone ? (
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            // explain: a part reopened elsewhere is refused by name (parts.ts partOpenError)
            action.run(task.id, () => transition.mutateAsync({ id: task.id, to: 'done' }), true)
          }
        >
          Mark done
        </Button>
      ) : undefined
    ) : isTimed(task) ? undefined : plan && open ? (
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
        <PlusIcon size={13} />
        {/* Icon-only on phones: the title needs the room; the aria-label names it. */}
        <span className="max-sm:hidden">Today</span>
      </Button>
    ) : undefined;
    const notesHit = result.searching && matchedInNotes(task, query.text, labelOf);
    // Outside a search, a parent carries its parts (query.ts foldParts left them out of the list).
    const showParts = !result.searching && place !== 'done';
    return (
      <TaskCard
        key={task.id}
        task={task}
        actions={actions}
        notesHit={notesHit}
        showParts={showParts}
      />
    );
  };

  const groups = place === 'done' ? capGroups(result.groups, limit) : result.groups;
  const shown = groups.reduce((n, g) => n + g.tasks.length, 0);

  return wrap(
    <>
      {groups.map((g) => {
        // Ungrouped: no header.
        if (g.key === 'all')
          return (
            <div key={g.key} className="flex flex-col gap-2">
              {g.tasks.map(row)}
            </div>
          );
        const key = `${place}:${g.key}`;
        const big = g.tasks.length >= COLLAPSE_AT;
        const isOpen = narrowing || !collapsed.isCollapsed(key, big);
        return (
          <section key={g.key} aria-label={g.label} className="flex flex-col gap-2">
            <GroupHeader
              label={g.label}
              count={g.tasks.length}
              isOpen={isOpen}
              onToggle={narrowing ? undefined : () => collapsed.toggle(key, big)}
            />
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
    </>,
  );
}
