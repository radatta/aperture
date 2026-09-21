import type { InputHTMLAttributes, Ref } from 'react';
import { cx } from '../../lib/cx';
import { Text } from '../Text';

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  // React 19 takes ref as a plain prop; the task editor focuses a field when its dialog opens.
  ref?: Ref<HTMLInputElement>;
}

export function Field({ label, className, ...rest }: FieldProps) {
  // Date/time inputs render native picker chrome (glyphs, the calendar popup) — tie its light/dark to
  // the app theme here so no caller has to remember, and a dark-theme picker isn't dark-on-dark.
  const nativePicker =
    rest.type === 'date' || rest.type === 'time' || rest.type === 'datetime-local';
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
          'placeholder:text-ink-muted outline-none transition',
          'focus:border-teal focus:bg-panel',
          nativePicker && '[color-scheme:light] dark:[color-scheme:dark]',
          className,
        )}
        {...rest}
      />
    </label>
  );
}
