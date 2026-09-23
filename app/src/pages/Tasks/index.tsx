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
import { TodayLens } from '../../modules/tasks/TodayLens';
import { RecurringSection } from '../../modules/tasks/RecurringSection';
import { CalibrationSection } from '../../modules/calibration/CalibrationSection';
import { BulkAddDialog } from '../../modules/tasks/BulkAddDialog';
import { normalize, placeOf } from '../../modules/tasks/query';
import type { QueryCtx } from '../../modules/tasks/query';
import { useTaskQuery } from '../../modules/tasks/useTaskQuery';

const RECEIPT_MS = 2400;

// The tasks deep view (PRODUCT §4a) as lenses over one list: Today (the plan pass), Week (due in the
// next 7 days), Backlog, Done — each open task lives in exactly one — plus Recurring and Calibration.
// Typing in search looks across every open task. Bulk add lives in the header, visible on every lens.
export function TasksPage() {
  const { lens, place, query, setQuery, setLens, today } = useTaskQuery();
  const bulk = useDisclosure();
  // `at` is a nonce so two adds in a row re-arm the fade (same trick as the capture receipt).
  const [receipt, setReceipt] = useState<{ count: number; at: number } | null>(null);

  // Whichever lens opens first: getDay(today) materializes today's recurring occurrences and sweeps
  // stale planned tasks back to the backlog before any lens reads the list.
  useDay(today);
  const { data: tasks = [], isPending, isError } = useAllTasks();
  const { data: plans = [] } = usePlansForDay(today);
  const { data: categories = [] } = useCategories();
  const ctx: QueryCtx = {
    today,
    planOrder: new Map(plans.map((p) => [p.taskId, p.order])),
    categories,
  };
  const counts = { today: 0, week: 0 };
  for (const t of tasks) {
    const p = placeOf(t, today, ctx.planOrder);
    if (p === 'today' || p === 'week') counts[p]++;
  }
  const isList = lens === 'today' || lens === 'week' || lens === 'backlog' || lens === 'done';
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
              Added {receipt.count} to Backlog
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
      {lens === 'today' && !searching ? (
        <TodayLens tasks={tasks} onOpenWeek={() => setLens('week')} />
      ) : isList ? (
        <TaskListSection
          place={place}
          query={query}
          onQueryChange={setQuery}
          tasks={tasks}
          plans={plans}
          ctx={ctx}
          pending={isPending}
          error={isError}
        />
      ) : null}
      {lens === 'recurring' && <RecurringSection />}
      {lens === 'calibration' && <CalibrationSection />}
      <BulkAddDialog
        open={bulk.open}
        onClose={bulk.onClose}
        onAdded={(count) => setReceipt({ count, at: Date.now() })}
      />
    </div>
  );
}
