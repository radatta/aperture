import { useEffect, useState } from 'react';
import { Text } from '../../components/Text';
import { Button } from '../../components/Button';
import { PlusIcon } from '../../components/icons';
import { useDisclosure } from '../../lib/useDisclosure';
import { useCategories } from '../../data/hooks/useCategories';
import { useDay } from '../../data/hooks/useDay';
import { usePlansForDay } from '../../data/hooks/usePlans';
import { useAllTasks } from '../../data/hooks/useTasks';
import { LensStrip } from '../../modules/tasks/LensStrip';
import { QueryControls } from '../../modules/tasks/QueryControls';
import { TaskListSection } from '../../modules/tasks/TaskListSection';
import { TaskModalHost } from '../../modules/tasks/TaskModalHost';
import { TodayLens } from '../../modules/tasks/TodayLens';
import { PlacesLens } from '../../modules/tasks/PlacesLens';
import { RecurringSection } from '../../modules/tasks/RecurringSection';
import { CalibrationSection } from '../../modules/calibration/CalibrationSection';
import { BulkAddDialog } from '../../modules/tasks/BulkAddDialog';
import { errandsByPlace, foldParts, normalize, placer } from '../../modules/tasks/query';
import type { QueryCtx } from '../../modules/tasks/query';
import { useTaskQuery } from '../../modules/tasks/useTaskQuery';

const RECEIPT_MS = 2400;

// The tasks deep view (PRODUCT §4a) as lenses over one list: Today (the plan pass), Week (due in the
// next 7 days), Places (errands by store), Backlog, Done — each open task lives in exactly one — plus
// Recurring and Calibration.
// Typing in search looks across every open task. Bulk add lives in the header, visible on every lens.
export function TasksPage() {
  const { lens, place, focusPlace, query, setQuery, setLens, today, dayStartHour } = useTaskQuery();
  const bulk = useDisclosure();
  // `at` is a nonce so two adds in a row re-arm the fade (same trick as the capture receipt).
  const [receipt, setReceipt] = useState<{ count: number; placed: number; at: number } | null>(
    null,
  );

  // Whichever lens opens first: getDay(today) materializes today's recurring occurrences and sweeps
  // stale planned tasks back to the backlog before any lens reads the list.
  useDay(today);
  const tasksQ = useAllTasks();
  const plansQ = usePlansForDay(today);
  const tasks = tasksQ.data ?? [];
  const plans = plansQ.data ?? [];
  // Where a task lives depends on today's plan too: until both have loaded, placing tasks would put
  // today's work under Week/Backlog. An error counts only when there's nothing to show.
  const pending = tasksQ.isPending || plansQ.isPending;
  const error = (tasksQ.isError && !tasksQ.data) || (plansQ.isError && !plansQ.data);
  const { data: categories = [] } = useCategories();
  const ctx: QueryCtx = {
    today,
    planOrder: new Map(plans.map((p) => [p.taskId, p.order])),
    categories,
    dayStartHour,
  };
  // Cards, not tasks: a part folded under its parent's card in the same place isn't counted twice. Places
  // counts the digest's items instead (errandsByPlace) — what its lens shows and the Shortcut reads out.
  const counts = { today: 0, week: 0, places: 0 };
  if (!pending) {
    const place = placer(tasks, ctx);
    for (const p of ['today', 'week'] as const)
      counts[p] = foldParts(tasks.filter((t) => place(t) === p)).length;
    for (const list of errandsByPlace(tasks, ctx).values()) counts.places += list.length;
  }
  const isList =
    lens === 'today' ||
    lens === 'week' ||
    lens === 'places' ||
    lens === 'backlog' ||
    lens === 'done';
  const retry = () => {
    if (tasksQ.isError) void tasksQ.refetch();
    if (plansQ.isError) void plansQ.refetch();
  };
  const searching = normalize(query.text) !== '';

  useEffect(() => {
    if (!receipt) return;
    const id = setTimeout(() => setReceipt(null), RECEIPT_MS);
    return () => clearTimeout(id);
  }, [receipt]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <Text as="h1" size="2xl" weight="semibold">
          Tasks
        </Text>
        <div className="flex items-center gap-3">
          {receipt && (
            <Text size="sm" tone="teal">
              {bulkReceipt(receipt)}
            </Text>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            ref={bulk.triggerRef}
            onClick={bulk.onOpen}
          >
            <PlusIcon size={14} /> Bulk add
          </Button>
        </div>
      </div>
      <LensStrip lens={lens} counts={counts} onChange={setLens} />
      {isList && <QueryControls place={place} query={query} onChange={setQuery} />}
      {/* The task modal lives here, above the rows, so Save can keep it open while a row moves. */}
      <TaskModalHost className="flex flex-col gap-4">
        {lens === 'today' && !searching ? (
          <TodayLens tasks={tasks} onOpenWeek={() => setLens('week')} />
        ) : lens === 'places' && !searching ? (
          <PlacesLens
            tasks={pending || error ? [] : tasks}
            ctx={ctx}
            focus={focusPlace}
            pending={pending}
            error={error}
            onRetry={retry}
          />
        ) : isList ? (
          <TaskListSection
            place={place}
            query={query}
            onQueryChange={setQuery}
            tasks={pending || error ? [] : tasks}
            plans={plans}
            ctx={ctx}
            pending={pending}
            error={error}
            onRetry={retry}
          />
        ) : null}
        {lens === 'recurring' && <RecurringSection />}
        {lens === 'calibration' && <CalibrationSection />}
      </TaskModalHost>
      <BulkAddDialog
        open={bulk.open}
        onClose={bulk.onClose}
        onAdded={(added) => setReceipt({ ...added, at: Date.now() })}
      />
    </div>
  );
}

// Where a bulk add went: errands wait on the Places lens, the rest in the Backlog.
function bulkReceipt({ count, placed }: { count: number; placed: number }): string {
  if (placed === 0) return `Added ${count} to Backlog`;
  if (placed === count) return `Added ${count} to Places`;
  return `Added ${count} — ${placed} to Places`;
}
