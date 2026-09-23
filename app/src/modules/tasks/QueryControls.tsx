import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Select } from '../../components/Select';
import { Text } from '../../components/Text';
import { cx } from '../../lib/cx';
import { useDisclosure } from '../../lib/useDisclosure';
import { useActiveCategories, useCategories } from '../../data/hooks/useCategories';
import { overrideChips, resetToLens, SORT_LABEL, STATUS_LABEL } from './query';
import type { DueBucket, Place, SortKey, StatusChip, TaskQuery } from './query';

const DUE_LABEL: Record<DueBucket, string> = {
  any: 'Any',
  today: 'Today',
  week: 'This week',
  dated: 'Dated',
  undated: 'No date',
};
// Only the options that can match on each lens: every Week task is due this week, no Backlog task is.
const DUE_OPTIONS: Record<Place, DueBucket[]> = {
  today: [],
  week: ['any', 'today'],
  backlog: ['any', 'dated', 'undated'],
  done: ['any', 'dated', 'undated'],
};

// Search box + "Filter" disclosure + the chips for whatever differs from the lens preset. On Today
// it's search only: the plan's order is the point there, so there's nothing to sort or group.
export function QueryControls({
  place,
  query,
  onChange,
}: {
  place: Place;
  query: TaskQuery;
  onChange: (q: TaskQuery) => void;
}) {
  const { data: categories = [] } = useCategories();
  const panel = useDisclosure();
  const searchOnly = place === 'today';
  const chips = searchOnly ? [] : overrideChips(query, place, categories);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          type="search"
          value={query.text}
          onChange={(e) => onChange({ ...query, text: e.target.value })}
          onKeyDown={(e) => e.key === 'Escape' && query.text && onChange({ ...query, text: '' })}
          placeholder="Search tasks…"
          aria-label="Search tasks"
          className={cx(
            'min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 py-2 text-ink',
            'placeholder:text-ink-muted outline-none transition focus:border-teal focus:bg-panel',
          )}
        />
        {!searchOnly && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            ref={panel.triggerRef}
            aria-expanded={panel.open}
            aria-controls={panel.open ? 'task-filters' : undefined}
            onClick={panel.open ? panel.onClose : panel.onOpen}
          >
            {chips.length ? `Filter · ${chips.length}` : 'Filter'}
          </Button>
        )}
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <button
              key={c.id}
              type="button"
              aria-label={`Remove filter: ${c.label}`}
              onClick={() => onChange(c.remove(query))}
              className="rounded-full border border-line px-2.5 py-1 text-xs text-ink-muted transition hover:text-ink"
            >
              {c.label} ×
            </button>
          ))}
          <Button variant="quiet" size="sm" onClick={() => onChange(resetToLens(query, place))}>
            Clear
          </Button>
        </div>
      )}
      {panel.open && (
        <FilterPanel place={place} query={query} onChange={onChange} onDone={panel.onClose} />
      )}
    </div>
  );
}

// Inline, not a modal: filtering is looking at the list while you narrow it.
function FilterPanel({
  place,
  query,
  onChange,
  onDone,
}: {
  place: Place;
  query: TaskQuery;
  onChange: (q: TaskQuery) => void;
  onDone: () => void;
}) {
  const { data: active = [] } = useActiveCategories();
  // Status only splits history (every open task off Today is backlog or planned-for-later).
  const statuses: StatusChip[] = place === 'done' ? ['done', 'cancelled'] : [];
  // Escape closes the panel wherever focus is — clicking panel text (or a chip, in Safari) leaves
  // focus on <body>, out of reach of a handler on the panel itself. The search box keeps Escape
  // for clearing, and an open dialog owns it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (document.querySelector('dialog[open]')) return;
      if (e.target instanceof HTMLElement && e.target.getAttribute('aria-label') === 'Search tasks')
        return;
      onDone();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDone]);

  const toggle = <T,>(list: T[], v: T) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  return (
    <Card id="task-filters" className="flex flex-col gap-3">
      <Row label="Category">
        {active.map((c) => (
          <Chip
            key={c.id}
            on={query.categories.includes(c.id)}
            onClick={() => onChange({ ...query, categories: toggle(query.categories, c.id) })}
          >
            {c.label}
          </Chip>
        ))}
        <Chip
          on={query.categories.includes('')}
          onClick={() => onChange({ ...query, categories: toggle(query.categories, '') })}
        >
          No category
        </Chip>
      </Row>
      <Row label="Due">
        {DUE_OPTIONS[place].map((d) => (
          <Chip
            key={d}
            on={query.due === d}
            ariaLabel={`Due: ${DUE_LABEL[d]}`}
            onClick={() => onChange({ ...query, due: d })}
          >
            {DUE_LABEL[d]}
          </Chip>
        ))}
      </Row>
      {statuses.length > 0 && (
        <Row label="Status">
          {statuses.map((s) => (
            <Chip
              key={s}
              on={query.statuses.includes(s)}
              // "Status: …" keeps the accessible name distinct from the lens pill of the same word.
              ariaLabel={`Status: ${STATUS_LABEL[s]}`}
              onClick={() => onChange({ ...query, statuses: toggle(query.statuses, s) })}
            >
              {STATUS_LABEL[s]}
            </Chip>
          ))}
        </Row>
      )}
      <div className="flex flex-wrap gap-3">
        <Select
          label="Sort"
          value={query.sort}
          onChange={(e) => onChange({ ...query, sort: e.target.value as SortKey })}
          options={Object.entries(SORT_LABEL).map(([value, label]) => ({ value, label }))}
        />
        <Select
          label="Group"
          value={query.groupBy === 'none' ? 'none' : 'category'}
          onChange={(e) =>
            onChange({ ...query, groupBy: e.target.value === 'none' ? 'none' : 'category' })
          }
          options={[
            { value: 'category', label: 'Category' },
            { value: 'none', label: 'None' },
          ]}
        />
      </div>
      <div className="flex gap-2">
        <Button variant="quiet" size="sm" onClick={() => onChange(resetToLens(query, place))}>
          Reset to lens
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Close
        </Button>
      </div>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1.5">
      <Text size="sm" tone="muted">
        {label}
      </Text>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Chip({
  on,
  onClick,
  ariaLabel,
  children,
}: {
  on: boolean;
  onClick: () => void;
  ariaLabel?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={ariaLabel}
      onClick={onClick}
      className={cx(
        'rounded-lg border px-2.5 py-1 text-xs transition',
        on ? 'border-teal bg-teal-soft text-ink' : 'border-line text-ink-muted hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}
