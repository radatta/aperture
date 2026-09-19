import type { Ref, TextareaHTMLAttributes } from 'react';
import { cx } from '../../lib/cx';
import { Text } from '../Text';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  // React 19 takes ref as a plain prop; bulk-add focuses the textarea when its modal opens.
  ref?: Ref<HTMLTextAreaElement>;
}

// The multi-line sibling of Field — same box treatment, vertically resizable. The story editor needs
// three of them (Situation / Action / Result), which is exactly when a one-off inlined <textarea> should
// become a primitive.
export function Textarea({ label, className, rows = 4, ...rest }: TextareaProps) {
  return (
    <label className="flex flex-col gap-1">
      {label && (
        <Text size="sm" tone="muted">
          {label}
        </Text>
      )}
      <textarea
        rows={rows}
        className={cx(
          'resize-y rounded-xl border border-line bg-surface px-3 py-2 text-ink',
          'placeholder:text-ink-muted outline-none transition',
          'focus:border-teal focus:bg-panel',
          className,
        )}
        {...rest}
      />
    </label>
  );
}
