import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string; // used as aria-label + tooltip when the label is icon-only
}

export interface ModeToggleProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  className?: string;
  'aria-labelledby'?: string; // names the group when a visible label sits outside it
}

// Segmented control — the active segment uses the seafoam highlight from the reference. Backs the
// capture bar [Log | Task | Idea], the home mode switch, and the Tasks tabs.
export function ModeToggle<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  className,
  'aria-labelledby': labelledBy,
}: ModeToggleProps<T>) {
  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      className={cx(
        'inline-flex shrink-0 gap-0.5 rounded-xl border border-line bg-surface p-0.5',
        className,
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            aria-label={o.title}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cx(
              'flex items-center justify-center rounded-[0.625rem] transition',
              size === 'sm' ? 'px-2.5 py-1 text-sm' : 'px-3 py-1.5 text-sm',
              active
                ? 'bg-teal-soft font-medium text-ink shadow-[inset_0_0_0_1px_var(--teal-soft)]'
                : 'text-ink-muted hover:bg-panel hover:text-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
