import { useEffect, useState } from 'react';
import type { RefObject } from 'react';

// Keeps a fixed-bottom dock above the on-screen keyboard (and iOS's ˄ ˅ ✓ form bar) while focus is
// inside it. Returns whether it's currently lifted.
//
// iOS Safari doesn't resize the page for the keyboard: a `fixed; bottom: 0` element stays pinned to
// the layout viewport's bottom, which is BEHIND the keyboard, and iOS only pans far enough to show
// the caret — so anything in the dock below the caret (capture's token chips and preview row) was
// hidden. `interactive-widget=resizes-content` would fix it, but iOS ignores it. The lift is the gap
// between visualViewport's bottom and `window.innerHeight` — the viewable area Safari anchors a
// fixed element to. Not `documentElement.clientHeight`: in a Safari tab that is the static ICB with
// the toolbars shown, so once they collapse the gap read short and the chips row sat behind the
// keyboard. The standalone PWA has no toolbars and the two are equal there.
//
// - Only while focus is in the dock: lifting for a page field's keyboard would put the dock over it.
// - Not when pinch-zoomed: the same gap opens with no keyboard at all.
// - `bottom` and `max-height` are written straight onto the element, not through React state —
//   scroll fires continuously during a pan, and re-rendering the shell per event lags a frame.
// - max-height = the visible strip, clipped from the top (the dock is `justify-end`), so in landscape
//   a tall dock (timers) loses its top rather than pushing the capture field off-screen and making iOS
//   re-pan on every keystroke.
export function useKeyboardInset(dockRef: RefObject<HTMLElement | null>): boolean {
  const [lifted, setLifted] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    const el = dockRef.current;
    if (!vv || !el) return;
    const measure = () => {
      const focused = el.contains(document.activeElement);
      const zoomed = Math.abs(vv.scale - 1) > 0.01;
      const gap = Math.round(window.innerHeight - (vv.offsetTop + vv.height));
      const inset = focused && !zoomed && gap > 1 ? gap : 0;
      el.style.bottom = inset ? `${inset}px` : '';
      el.style.maxHeight = inset ? `${Math.floor(vv.height)}px` : '';
      setLifted(inset > 0);
    };
    measure();
    vv.addEventListener('resize', measure);
    vv.addEventListener('scroll', measure);
    // Document-level: during a focusout activeElement is <body>, and a focusin elsewhere on the page
    // doesn't reach the dock — both must drop the lift.
    document.addEventListener('focusin', measure);
    document.addEventListener('focusout', measure);
    return () => {
      vv.removeEventListener('resize', measure);
      vv.removeEventListener('scroll', measure);
      document.removeEventListener('focusin', measure);
      document.removeEventListener('focusout', measure);
      el.style.bottom = '';
      el.style.maxHeight = '';
    };
  }, [dockRef]);
  return lifted;
}
