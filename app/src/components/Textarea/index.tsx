import { useLayoutEffect, useRef } from 'react';
import type { Ref, TextareaHTMLAttributes } from 'react';
import { cx } from '../../lib/cx';
import { Text } from '../Text';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  // React 19 takes ref as a plain prop; bulk-add focuses the textarea when its modal opens.
  ref?: Ref<HTMLTextAreaElement>;
  // Grow with the text instead of scrolling inside a fixed box, up to 40dvh (then it scrolls).
  autogrow?: boolean;
}

// The multi-line sibling of Field — same box treatment, vertically resizable. The story editor needs
// three of them (Situation / Action / Result), which is exactly when a one-off inlined <textarea> should
// become a primitive.
export function Textarea({ label, className, rows = 4, autogrow, ref, ...rest }: TextareaProps) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const setRef = (el: HTMLTextAreaElement | null) => {
    inner.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };

  // Height follows content: collapse to auto, then take scrollHeight (padding included) plus the
  // border, since the box is border-box. Runs before paint, so there's no one-frame jump.
  useLayoutEffect(() => {
    const el = inner.current;
    if (!autogrow || !el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [autogrow, rest.value]);

  return (
    <label className="flex flex-col gap-1">
      {label && (
        <Text size="sm" tone="muted">
          {label}
        </Text>
      )}
      <textarea
        ref={setRef}
        rows={rows}
        className={cx(
          'rounded-xl border border-line bg-surface px-3 py-2 text-ink',
          'placeholder:text-ink-muted outline-none transition',
          'focus:border-teal focus:bg-panel',
          autogrow ? 'max-h-[40dvh] resize-none overflow-y-auto' : 'resize-y',
          className,
        )}
        {...rest}
      />
    </label>
  );
}
