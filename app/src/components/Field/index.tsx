import type { InputHTMLAttributes } from 'react';
import { cx } from '../../lib/cx';
import { Text } from '../Text';

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export function Field({ label, className, ...rest }: FieldProps) {
  return (
    <label className="flex flex-col gap-1">
      {label && (
        <Text size="sm" tone="muted">
          {label}
        </Text>
      )}
      <input
        className={cx(
          'rounded-xl border border-line bg-surface px-3 py-2 text-ink',
          'placeholder:text-ink-subtle outline-none transition',
          'focus:border-teal focus:bg-panel',
          className,
        )}
        {...rest}
      />
    </label>
  );
}
