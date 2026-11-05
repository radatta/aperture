import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { Ref, TextareaHTMLAttributes } from 'react';
import { cx } from '../../lib/cx';
import { Text } from '../Text';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  // React 19 takes ref as a plain prop; bulk-add focuses the textarea when its modal opens.
  ref?: Ref<HTMLTextAreaElement>;
  // Grow with the text instead of scrolling inside a fixed box, up to 40dvh (30dvh on a phone, so Save
  // stays in reach), then scroll.
  autogrow?: boolean;
}

// The multi-line sibling of Field — same box treatment, vertically resizable. The story editor needs
// three of them (Situation / Action / Result), which is exactly when a one-off inlined <textarea> should
// become a primitive.
export function Textarea({ label, className, rows = 4, autogrow, ref, ...rest }: TextareaProps) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  // Stable per `ref`, so React doesn't detach and reattach the caller's ref on every render.
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      inner.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );

  // Height follows content: collapse to auto, then take scrollHeight (padding included) plus the
  // border, since the box is border-box. Runs before paint, so there's no one-frame jump.
  // A box with no layout yet — inside a <dialog> whose showModal() runs in the modal's effect, after
  // this one — measures 0: it keeps its rows' height instead of collapsing to its padding, and measures
  // again once it has a width (and on any width change: a rotation rewraps the text).
  const measure = useCallback(() => {
    const el = inner.current;
    if (!autogrow || !el) return;
    el.style.height = 'auto';
    if (!el.scrollHeight) return void (el.style.height = '');
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [autogrow]);
  useLayoutEffect(measure, [measure, rest.value]);
  useEffect(() => {
    const el = inner.current;
    if (!autogrow || !el || typeof ResizeObserver === 'undefined') return;
    let width = el.offsetWidth;
    const observer = new ResizeObserver(() => {
      if (el.offsetWidth === width) return; // its own height change, not a new layout
      width = el.offsetWidth;
      measure();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [autogrow, measure]);

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
          autogrow ? 'max-h-[30dvh] resize-none overflow-y-auto sm:max-h-[40dvh]' : 'resize-y',
          className,
        )}
        {...rest}
      />
    </label>
  );
}
