import type { ComponentType } from 'react';
import { Link } from 'react-router';
import {
  contraindicationFor,
  EXERCISES,
  filterByCondition,
  filterByStage,
  groupByCategory,
  measurementLabel,
  STAGE_LABELS,
  type Category,
  type Condition,
  type ExerciseDefinition,
  type Stage,
} from '@aperture/shared/flux';
import {
  ActivityIcon,
  ChevronRightIcon,
  MoveIcon,
  TargetIcon,
  TimerIcon,
  WarningIcon,
} from '../../components/icons';
import { EmptyState } from '../../components/EmptyState';
import { Text } from '../../components/Text';
import { cx } from '../../lib/cx';

// flux-track's library: condition chips, four categories, one card per exercise. Aperture adds the stage
// chips (the data was always there) and makes each card a real link to /flux/<id>.

const CATEGORY_ICON: Record<Category, ComponentType<{ className?: string }>> = {
  'Active Range of Motion': ActivityIcon,
  'Stretches & Holds': MoveIcon,
  'Guided & Isometric': TimerIcon,
  Sensorimotor: TargetIcon,
};

const CONDITIONS: { value: Condition | null; label: string }[] = [
  { value: null, label: 'All' },
  { value: 'herniatedDisc', label: 'Herniated disc' },
  { value: 'sprainStrain', label: 'Sprain / strain' },
  { value: 'general', label: 'General neck pain' },
];

const STAGES: { value: Stage | null; label: string }[] = [
  { value: null, label: 'Any stage' },
  ...(['acute', 'subacute', 'chronic'] as const).map((s) => ({ value: s, label: STAGE_LABELS[s] })),
];

export function ExerciseLibrary({
  condition,
  onConditionChange,
  stage,
  onStageChange,
}: {
  condition: Condition | null;
  onConditionChange: (c: Condition | null) => void;
  stage: Stage | null;
  onStageChange: (s: Stage | null) => void;
}) {
  const groups = groupByCategory(filterByStage(filterByCondition(EXERCISES, condition), stage));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Chips
          label="Condition"
          options={CONDITIONS}
          value={condition}
          onChange={onConditionChange}
        />
        <Chips label="Stage" options={STAGES} value={stage} onChange={onStageChange} />
      </div>

      {groups.length === 0 && (
        <EmptyState title="No exercises match this condition and stage.">
          Pick “Any stage” to see more.
        </EmptyState>
      )}

      {groups.map((group) => {
        const Icon = CATEGORY_ICON[group.category];
        return (
          <section key={group.category} className="flex flex-col gap-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold tracking-wide text-ink-muted uppercase">
              <Icon className="text-teal" />
              {group.category}
              <span className="rounded-full bg-panel-2 px-2 py-0.5 text-[11px] font-medium tracking-normal normal-case">
                {group.items.length}
              </span>
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {group.items.map((ex) => (
                <ExerciseCard key={ex.id} ex={ex} condition={condition} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function Chips<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T | null; label: string }[];
  value: T | null;
  onChange: (v: T | null) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.label}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={cx(
              'rounded-full px-3.5 py-1.5 text-sm font-medium transition',
              active
                ? 'bg-teal text-surface'
                : 'border border-line text-ink-muted hover:bg-panel-2 hover:text-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function ExerciseCard({ ex, condition }: { ex: ExerciseDefinition; condition: Condition | null }) {
  const contra = contraindicationFor(ex, condition);
  return (
    <Link
      to={`/flux/${ex.id}`}
      className="group flex min-h-[136px] flex-col rounded-2xl border border-line bg-panel p-4 transition hover:-translate-y-0.5 hover:border-line-strong motion-reduce:transform-none"
    >
      <span className="flex items-start justify-between gap-2">
        <Text weight="medium" className="leading-tight">
          {ex.name}
        </Text>
        <ChevronRightIcon className="shrink-0 text-ink-muted transition group-hover:translate-x-0.5 group-hover:text-teal" />
      </span>
      <Text as="p" size="xs" tone="muted" className="mt-1.5 line-clamp-2 leading-relaxed">
        {ex.instructions}
      </Text>
      <span className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
        <MeasurementBadge ex={ex} />
        {ex.provocative && <EndRangeBadge />}
        {contra && (
          <Badge className="inline-flex items-center gap-1 bg-panel-2 text-danger">
            <WarningIcon size={12} /> Caution
          </Badge>
        )}
      </span>
    </Link>
  );
}

const MEASUREMENT_TONE: Record<ExerciseDefinition['measurement'], string> = {
  measured: 'bg-teal-soft text-ink',
  approximate: 'bg-panel-2 text-ink-muted',
  guided: 'bg-gold-soft text-ink',
};

export function MeasurementBadge({ ex }: { ex: ExerciseDefinition }) {
  return <Badge className={MEASUREMENT_TONE[ex.measurement]}>{measurementLabel(ex)}</Badge>;
}

export function EndRangeBadge() {
  return <Badge className="bg-panel-2 text-ink-muted">End-range</Badge>;
}

function Badge({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className={cx('rounded-md px-1.5 py-0.5 text-[11px] font-medium', className)}>
      {children}
    </span>
  );
}
