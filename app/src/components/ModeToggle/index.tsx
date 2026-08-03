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
  className?: string;
}

// Segmented control — the active segment uses the seafoam highlight from the reference. Backs the
// capture bar [Log | Task | Idea] and the home mode switch.
export function ModeToggle<T extends string>({
  options,
  value,
  onChange,
  className,
}: ModeToggleProps<T>) {
  return (
    <div className={cx('inline-flex gap-1 rounded-xl border border-line bg-surface p-1', className)}>
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
              'flex items-center rounded-lg px-3 py-1.5 text-sm transition',
              active ? 'bg-teal-soft text-ink' : 'text-ink-muted hover:text-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
