import { useEffect, useState } from 'react';
import { fmtDueDay, todayKey } from '@aperture/shared';
import type { Task, TaskPlan } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { Field } from '../../components/Field';
import { MiniBar } from '../../components/MiniBar';
import { Text } from '../../components/Text';
import { fmtDuration } from '../../lib/format';
import { useBacklog } from '../../data/hooks/useBacklog';
import { useDay, useSetCapacity } from '../../data/hooks/useDay';
import { usePlansForDay, useRemovePlan, useUpsertPlan } from '../../data/hooks/usePlans';
import { useSettings } from '../../data/hooks/useSettings';
import { useAllTasks, useTransitionTask } from '../../data/hooks/useTasks';
import { plannedVsAvailable } from '../calibration/calibration';
import { CategoryTag } from './CategoryTag';
import { TaskCard } from './TaskCard';
import { byDueHint, plannedDefault } from './taskMath';

// The morning plan pass (PRODUCT §3 ☀️): set the day's capacity, pull backlog tasks in, and see
// planned hours vs available — under-scoping caught here, before it becomes stress.
export function PlanSection() {
  const { data: settings } = useSettings();
  const day = todayKey(settings?.dayStartHour ?? 4);

  const { data: dayRec } = useDay(day);
  const { data: plans = [], isPending: plansPending } = usePlansForDay(day);
  const { data: allTasks = [] } = useAllTasks();
  const { data: backlog = [], isPending: backlogPending } = useBacklog();

  const setCapacity = useSetCapacity(day);
  const upsertPlan = useUpsertPlan();
  const removePlan = useRemovePlan();
  const transition = useTransitionTask();

  const taskById = new Map(allTasks.map((t) => [t.id, t]));
  const plannedRows = plans
    .map((plan) => ({ plan, task: taskById.get(plan.taskId) }))
    .filter((r): r is { plan: TaskPlan; task: Task } => !!r.task);
  const plannedMin = plans.reduce((s, p) => s + p.plannedMinutes, 0);
  const pva = plannedVsAvailable(plannedMin, dayRec?.capacityHours ?? null);

  async function addToDay(taskId: string) {
    const task = taskById.get(taskId);
    if (!task) return;
    await upsertPlan.mutateAsync({
      taskId,
      day,
      plannedMinutes: plannedDefault(task) || task.estimateMin || 30,
      order: plans.length,
    });
    if (task.status === 'backlog') await transition.mutateAsync({ id: taskId, to: 'planned' });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-col gap-3">
          <CapacityField
            key={dayRec?.id ?? day}
            initial={dayRec?.capacityHours ?? null}
            onSave={(h) => setCapacity.mutate(h)}
          />
          {pva.availableMin === null ? (
            <Text size="sm" tone="muted">
              {fmtDuration(plannedMin)} planned. Set your available hours to see if you&apos;re
              over-scoping.
            </Text>
          ) : (
            <div className="flex flex-col gap-2">
              <MiniBar plannedMin={pva.plannedMin} availableMin={pva.availableMin} />
              <Text size="sm" tone={pva.over ? 'gold' : 'muted'} tabular>
                {fmtDuration(plannedMin)} planned into a {fmtDuration(pva.availableMin)} day
                {pva.over ? ` · ${fmtDuration(pva.overByMin)} over` : ''}
              </Text>
            </div>
          )}
        </div>
      </Card>

      <div className="flex flex-col gap-2">
        <Text size="xs" tone="muted" weight="medium" className="uppercase tracking-wider">
          Planned today
        </Text>
        {plannedRows.length === 0 ? (
          // Every list here defaults to [], so length alone can't tell "empty" from "still
          // loading" or "failed" — EmptyState is the one place that knows the difference.
          <EmptyState
            pending={plansPending}
            title={
              backlogPending || backlog.length > 0
                ? 'Nothing planned yet.'
                : 'Nothing planned, and the backlog is empty.'
            }
          >
            {backlogPending || backlog.length > 0
              ? 'Pull something in from the backlog below.'
              : 'Capture a task from the bar below to start.'}
          </EmptyState>
        ) : (
          plannedRows.map(({ plan, task }) => (
            <TaskCard
              key={plan.id}
              task={task}
              actions={
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={async () => {
                    await removePlan.mutateAsync(plan.id);
                    if (task.status === 'planned')
                      await transition.mutateAsync({ id: task.id, to: 'backlog' });
                  }}
                >
                  Unplan
                </Button>
              }
            />
          ))
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Text size="xs" tone="muted" weight="medium" className="uppercase tracking-wider">
          Backlog
        </Text>
        {backlog.length === 0 ? (
          <Text tone="muted" size="sm">
            Backlog is clear — nothing waiting on you.
          </Text>
        ) : (
          byDueHint(backlog).map((task) => (
            <Card key={task.id} className="px-3.5 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <Text weight="medium" className="truncate">
                    {task.title}
                  </Text>
                  <div className="flex items-center gap-2">
                    <CategoryTag categoryId={task.categoryId} />
                    {task.estimateMin != null && (
                      <Text size="xs" tone="muted" tabular>
                        {fmtDuration(task.estimateMin)} est
                      </Text>
                    )}
                    {task.dueDay && (
                      <Text size="xs" tone="subtle">
                        {fmtDueDay(task.dueDay, day)}
                      </Text>
                    )}
                  </div>
                </div>
                <Button size="sm" className="shrink-0" onClick={() => addToDay(task.id)}>
                  Add to today
                </Button>
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}

// The typical shapes of a day. The over-scoping catch only fires once capacity is set, and an
// empty number box asking for a decimal is the most skippable control on the page — one tap gets
// you to the number that makes the whole morning pass work.
const CAPACITY_PRESETS = [2, 4, 6, 8];

// Manual hours-available (v1 capacity is a number, not calendar-derived). Saves on blur/Enter.
function CapacityField({
  initial,
  onSave,
}: {
  initial: number | null;
  onSave: (h: number | null) => void;
}) {
  const [value, setValue] = useState(initial?.toString() ?? '');
  useEffect(() => setValue(initial?.toString() ?? ''), [initial]);
  const commit = () => onSave(value === '' ? null : Number(value));

  function pick(h: number) {
    setValue(String(h));
    onSave(h);
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field
        label="Hours available today"
        type="number"
        min={0}
        step={0.5}
        inputMode="decimal"
        placeholder="—"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        className="w-32"
      />
      <div className="flex gap-1.5 pb-0.5">
        {CAPACITY_PRESETS.map((h) => (
          <Button
            key={h}
            variant={Number(value) === h ? 'primary' : 'ghost'}
            size="sm"
            aria-pressed={Number(value) === h}
            // Keep focus in the input: otherwise clicking a preset blurs it, firing commit() with
            // the old typed value on top of pick()'s write — two racing capacity mutations for one
            // tap, and over HTTP the stale one can land last.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(h)}
          >
            {h}h
          </Button>
        ))}
      </div>
    </div>
  );
}
