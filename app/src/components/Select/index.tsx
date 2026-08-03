import type { SelectHTMLAttributes } from 'react';
import { cx } from '../../lib/cx';
import { Text } from '../Text';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: SelectOption[];
  placeholder?: string;
}

export function Select({ label, options, placeholder, className, ...rest }: SelectProps) {
  return (
    <label className="flex flex-col gap-1">
      {label && (
        <Text size="sm" tone="muted">
          {label}
        </Text>
      )}
      <select
        className={cx(
          'rounded-xl border border-line bg-surface px-3 py-2 text-ink',
          'outline-none transition focus:border-teal',
          className,
        )}
        {...rest}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
