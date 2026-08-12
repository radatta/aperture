import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';

// Grows a textarea to fit its content, up to `maxRows`, then lets it scroll. Measured from the
// element's own line-height so it stays correct if the type scale changes.
// Runs in a layout effect so the height is right in the same frame the character appears —
// a useEffect here shows one frame of the old height on every keystroke.
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxRows = 6,
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const style = window.getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight) || 24;
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const max = lineHeight * maxRows + padding;
    el.style.height = 'auto'; // collapse first, or scrollHeight can only ever grow
    const next = Math.min(el.scrollHeight, max);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [ref, value, maxRows]);
}
