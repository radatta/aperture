import type { InputHTMLAttributes, Ref } from 'react';
import { cx } from '../../lib/cx';
import { Text } from '../Text';

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  // React 19 takes ref as a plain prop; the task editor focuses a field when its dialog opens.
  ref?: Ref<HTMLInputElement>;
}

// Date/time inputs' native picker chrome (glyphs, the calendar popup) follows the app theme on its own:
// `color-scheme` inherits from `:root[data-theme]` (tokens.css), the one theme mechanism. No Tailwind
// dark-variant override here: that follows the OS (prefers-color-scheme), not the app, and put a light
// picker on the dark app at night on a light-mode phone (styles/theme.test.ts keeps it out).
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
          'placeholder:text-ink-muted outline-none transition',
          'focus:border-teal focus:bg-panel',
          'disabled:cursor-not-allowed disabled:border-dashed disabled:opacity-60',
          className,
        )}
        {...rest}
      />
    </label>
  );
}
