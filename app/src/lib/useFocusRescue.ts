import { useEffect } from 'react';
import type { RefObject } from 'react';
import { revealFocus } from './focus';

// A page-level backstop for the focus-return contract (CONVENTIONS): when the element that had focus
// inside `rootRef` is removed — a banner that clears, a dialog that unmounts its opener — or sits in a
// <dialog> that closed without unmounting, and focus has fallen to <body> (or stayed on it, as engines
// that don't restore focus on close do), hand it to `fallback()`. A button merely disabled while it
// saves is NOT lost: it gets focus back itself. Checked a frame later, so a component's own
// focus-return (an effect, a layout effect) always wins; this only catches what nothing else did.
export function useFocusRescue(
  rootRef: RefObject<HTMLElement | null>,
  fallback: () => HTMLElement | null,
): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let last: Element | null = null;
    let frame = 0;
    const onFocusIn = (e: FocusEvent) => {
      last = e.target as Element;
    };
    const check = () => {
      frame = 0;
      const active = document.activeElement;
      const closed = last !== null && last.closest('dialog:not([open])') !== null;
      const gone = last !== null && (!last.isConnected || closed);
      const lost = active === null || active === document.body || (closed && active === last);
      if (gone && lost) {
        last = null;
        revealFocus(fallback());
      }
    };
    const mo = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(check);
    });
    root.addEventListener('focusin', onFocusIn);
    mo.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open'],
    });
    return () => {
      root.removeEventListener('focusin', onFocusIn);
      mo.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [rootRef, fallback]);
}
