import { useEffect, useRef, useState } from 'react';
import { isTimed } from '@aperture/shared';
import type { Task } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { Field } from '../../components/Field';
import { MiniBar } from '../../components/MiniBar';
import { Text } from '../../components/Text';
import { PlusIcon } from '../../components/icons';
import { fmtDuration } from '../../lib/format';
import { useRowAction } from '../../lib/useRowAction';
import { useAddToDay } from '../../data/hooks/useAddToDay';
import { useDay, useSetCapacity } from '../../data/hooks/useDay';
import { doneToday } from './doneToday';
import { GroupHeader } from './GroupHeader';
import { TaskCard } from './TaskCard';
import { useCollapsedGroups } from './useTaskQuery';
import { useTodayPlan } from './useTodayPlan';

// The Today lens — the morning plan pass (PRODUCT §3 ☀️): set the day's capacity and see planned
// hours vs available, over today's work: the timed tasks whose time falls today ("By time", by clock —
// their time put them here, so nothing to unplan; lenses.md D13), then today's plan in its own order.
// Pulling work in happens from Week and Backlog (or Home's "+ Add"); this lens is the plan itself. Finished work leaves the plan list for a
// collapsed "Done today" group at the bottom (lenses.md D11); its rows stay, so capacity still counts it.
export function TodayLens({ tasks, onOpenWeek }: { tasks: Task[]; onOpenWeek: () => void }) {
  const { day, dayStartHour, rows, plannedMin, pva, isPending, isError } = useTodayPlan();
  const { data: dayRec } = useDay(day);
  const setCapacity = useSetCapacity(day);
  const { addToDay, unplan } = useAddToDay();
  const listRef = useRef<HTMLDivElement>(null);
  const action = useRowAction(listRef);
  const collapsed = useCollapsedGroups();

  const { open, done } = doneToday(rows, tasks, day, dayStartHour);
  const allDone = open.length === 0 && rows.some(({ task }) => task.status === 'done');
  const doneOpen = !collapsed.isCollapsed(DONE_KEY, true);
  const onPlan = new Set(rows.map((r) => r.task.id));
  // Started but not on today's plan — still today's business, one tier down.
  const offPlan = tasks.filter((t) => t.status === 'in_progress' && !onPlan.has(t.id));
  const byTime = open.filter((r) => r.byTime);
  const planned = open.filter((r) => !r.byTime);

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

      <div ref={listRef} tabIndex={-1} className="flex flex-col gap-2 outline-none">
        {/* With timed rows, "By time" leads and "Planned today" heads the plan below it. */}
        {byTime.length === 0 && (
          <Text size="xs" tone="muted" weight="medium" className="uppercase tracking-wider">
            Planned today
          </Text>
        )}
        <div role="status">
          {action.failed && (
            <Text size="sm" tone="danger">
              Couldn&apos;t save that — try again.
            </Text>
          )}
        </div>
        {allDone ? (
          <EmptyState
            title="Everything planned is done."
            action={
              <Button variant="ghost" size="sm" onClick={onOpenWeek}>
                Open Week
              </Button>
            }
          >
            Pull more in from Week if there&apos;s day left.
          </EmptyState>
        ) : open.length === 0 ? (
          <EmptyState
            pending={isPending}
            error={isError}
            title="Nothing planned yet."
            action={
              <Button variant="ghost" size="sm" onClick={onOpenWeek}>
                Open Week
              </Button>
            }
          >
            Pull something in from Week or the backlog.
          </EmptyState>
        ) : (
          <>
            {byTime.length > 0 && (
              <Text size="xs" tone="muted" weight="medium" className="uppercase tracking-wider">
                By time
              </Text>
            )}
            {byTime.map(({ task }) => (
              <TaskCard key={task.id} task={task} />
            ))}
            {byTime.length > 0 && planned.length > 0 && (
              <Text
                size="xs"
                tone="muted"
                weight="medium"
                className="mt-2 uppercase tracking-wider"
              >
                Planned today
              </Text>
            )}
            {planned.map(({ plan, task }) => (
              <TaskCard
                key={plan!.id}
                task={task}
                actions={
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={action.isBusy(task.id)}
                    onClick={() => action.run(task.id, () => unplan(plan!, task))}
                  >
                    Unplan
                  </Button>
                }
              />
            ))}
          </>
        )}
      </div>

      {offPlan.length > 0 && (
        <div className="flex flex-col gap-2">
          <Text size="xs" tone="muted" weight="medium" className="uppercase tracking-wider">
            In progress · not planned today
          </Text>
          {offPlan.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              actions={
                // A timed task's day is its time: nothing to add (lenses.md D13).
                !isTimed(task) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1"
                    disabled={action.isBusy(task.id)}
                    aria-label={`Add ${task.title} to today`}
                    onClick={() => action.run(task.id, () => addToDay(task))}
                  >
                    <PlusIcon size={13} />
                    {/* Icon-only on phones: the title needs the room; the aria-label names it. */}
                    <span className="max-sm:hidden">Today</span>
                  </Button>
                )
              }
            />
          ))}
        </div>
      )}

      {done.length > 0 && (
        <section aria-label="Done today" className="flex flex-col gap-2">
          <GroupHeader
            label="Done today"
            count={done.length}
            isOpen={doneOpen}
            onToggle={() => collapsed.toggle(DONE_KEY, true)}
          />
          {doneOpen && done.map((task) => <TaskCard key={task.id} task={task} />)}
        </section>
      )}
    </div>
  );
}

// Its collapsed choice lives with the list lenses' groups (useCollapsedGroups); it starts collapsed.
// Can't clash with a list group's `${place}:${key}`: a search from Today never shows the done place.
const DONE_KEY = 'today:done';

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
