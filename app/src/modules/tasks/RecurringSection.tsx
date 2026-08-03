import { useState } from 'react';
import { todayKey } from '@aperture/shared';
import type { RecurrenceRule, TaskSeries } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Field } from '../../components/Field';
import { Select } from '../../components/Select';
import { Text } from '../../components/Text';
import { useCategories } from '../../data/hooks/useCategories';
import { useDeactivateSeries, useSeries, useUpsertSeries } from '../../data/hooks/useSeries';
import { useSettings } from '../../data/hooks/useSettings';
import { CategoryTag } from './CategoryTag';
import { ruleSummary } from './taskMath';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
type Kind = RecurrenceRule['kind'];

// Recurring tasks: each occurrence is a real task (its own estimate/actual → its own calibration
// point), materialized lazily when its day loads. This tab creates/lists the templates.
export function RecurringSection() {
  const { data: series = [] } = useSeries();
  const active = series.filter((s) => s.active);
  return (
    <div className="flex flex-col gap-4">
      <SeriesForm />
      <div className="flex flex-col gap-2">
        <Text size="xs" tone="muted" weight="medium" className="uppercase tracking-wider">
          Active series
        </Text>
        {active.length === 0 ? (
          <Text tone="subtle" size="sm">
            No recurring tasks yet.
          </Text>
        ) : (
          active.map((s) => <SeriesRow key={s.id} series={s} />)
        )}
      </div>
    </div>
  );
}

function SeriesRow({ series }: { series: TaskSeries }) {
  const deactivate = useDeactivateSeries();
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Text weight="medium" className="truncate">
            {series.title}
          </Text>
          <div className="flex items-center gap-2">
            <CategoryTag categoryId={series.categoryId} />
            <Text size="xs" tone="muted">
              {ruleSummary(series.rule)}
            </Text>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => deactivate.mutate(series.id)}>
          Stop
        </Button>
      </div>
    </Card>
  );
}

function SeriesForm() {
  const { data: settings } = useSettings();
  const { data: cats = [] } = useCategories();
  const upsert = useUpsertSeries();

  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<Kind>('weekdays');
  const [interval, setInterval] = useState('2');
  const [days, setDays] = useState<number[]>([1, 3, 5]);
  const [estimate, setEstimate] = useState('');
  const [categoryId, setCategoryId] = useState('');

  function buildRule(): RecurrenceRule {
    if (kind === 'daily') return { kind: 'daily' };
    if (kind === 'weekdays') return { kind: 'weekdays' };
    if (kind === 'weekly') return { kind: 'weekly', daysOfWeek: days };
    return { kind: 'everyN', interval: Math.max(1, Number(interval) || 1) };
  }

  async function create() {
    if (!title.trim()) return;
    await upsert.mutateAsync({
      title: title.trim(),
      categoryId: categoryId || null,
      defaultEstimateMin: estimate === '' ? null : Number(estimate),
      rule: buildRule(),
      anchorDate: todayKey(settings?.dayStartHour ?? 4),
    });
    setTitle('');
    setEstimate('');
  }

  return (
    <Card>
      <div className="flex flex-col gap-3">
        <Text size="sm" weight="medium">
          New recurring task
        </Text>
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-56"
            placeholder="Standup, review inbox…"
          />
          <Select
            label="Repeats"
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
            options={[
              { value: 'daily', label: 'Every day' },
              { value: 'weekdays', label: 'Weekdays' },
              { value: 'weekly', label: 'Weekly (pick days)' },
              { value: 'everyN', label: 'Every N days' },
            ]}
            className="w-44"
          />
          {kind === 'everyN' && (
            <Field
              label="N"
              type="number"
              min={1}
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
              className="w-20"
            />
          )}
          <Field
            label="Estimate (min)"
            type="number"
            min={0}
            value={estimate}
            onChange={(e) => setEstimate(e.target.value)}
            className="w-28"
          />
          <Select
            label="Category"
            placeholder="Uncategorized"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            options={cats.map((c) => ({ value: c.id, label: c.label }))}
            className="w-40"
          />
        </div>
        {kind === 'weekly' && (
          <div className="flex flex-wrap gap-1.5">
            {DOW.map((d, i) => {
              const on = days.includes(i);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setDays((cur) => (on ? cur.filter((x) => x !== i) : [...cur, i]))
                  }
                  className={
                    'rounded-lg border px-2.5 py-1 text-xs transition ' +
                    (on
                      ? 'border-teal bg-teal-soft text-ink'
                      : 'border-line text-ink-muted hover:text-ink')
                  }
                >
                  {d}
                </button>
              );
            })}
          </div>
        )}
        <div>
          <Button size="sm" onClick={create} disabled={!title.trim() || upsert.isPending}>
            Add series
          </Button>
        </div>
      </div>
    </Card>
  );
}
