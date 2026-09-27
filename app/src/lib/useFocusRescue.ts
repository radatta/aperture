import { useEffect } from 'react';
import type { RefObject } from 'react';
import { revealFocus } from './focus';

// A page-level backstop for the focus-return contract (CONVENTIONS): when the element that had focus
// inside `rootRef` is removed — a banner that clears, a dialog that unmounts its opener — or turns
// disabled, or sits in a <dialog> that closed without unmounting, and focus has fallen to <body>,
// hand it to `fallback()`. Checked a frame later, so a component's own
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
      const gone =
        last !== null &&
        (!last.isConnected ||
          (last as HTMLButtonElement).disabled === true ||
          last.closest('dialog:not([open])') !== null);
      // Fallen to <body>, or still parked on the dead control (some engines keep focus on a button
      // that turned disabled, or inside a <dialog> that closed).
      const lost = active === null || active === document.body || active === last;
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
      attributeFilter: ['open', 'disabled'],
    });
    return () => {
      root.removeEventListener('focusin', onFocusIn);
      mo.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [rootRef, fallback]);
}
