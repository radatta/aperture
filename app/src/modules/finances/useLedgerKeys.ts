import { useEffect, useLayoutEffect, useRef } from 'react';
import { isTypingTarget } from '../../lib/keys';

// The All tab's page shortcuts: 1–4 arm (or disarm) a brush, "/" focuses search, Escape disarms. None
// fire while typing, with a modifier, or over an open dialog, menu or confirm. "/" is claimed in the capture phase so
// CaptureBar (bubble, checks defaultPrevented) leaves it to search on this tab only; Escape listens in
// the bubble phase so a menu or the search box (both preventDefault their own Escape) wins.
export function useLedgerKeys(handlers: {
  digit: (n: number) => boolean; // 1-based; true = handled
  slash: () => void;
  escape: () => boolean; // true = handled
}) {
  const ref = useRef(handlers);
  useLayoutEffect(() => {
    ref.current = handlers;
  });
  useEffect(() => {
    // An open menu or the remove-bank confirm owns the keys too, not just a <dialog>.
    const blocked = (e: KeyboardEvent) =>
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      document.querySelector('dialog[open]') !== null ||
      (e.target instanceof Element &&
        e.target.closest('[role="menu"],[role="alertdialog"]') !== null);
    function onCapture(e: KeyboardEvent) {
      if (e.defaultPrevented || e.repeat || blocked(e) || isTypingTarget(e.target)) return;
      if (e.key === '/') {
        e.preventDefault();
        ref.current.slash();
        return;
      }
      const n = Number(e.key);
      if (/^[1-9]$/.test(e.key) && ref.current.digit(n)) e.preventDefault();
    }
    function onBubble(e: KeyboardEvent) {
      if (e.key !== 'Escape' || e.defaultPrevented || blocked(e)) return;
      if (ref.current.escape()) e.preventDefault();
    }
    window.addEventListener('keydown', onCapture, true);
    window.addEventListener('keydown', onBubble);
    return () => {
      window.removeEventListener('keydown', onCapture, true);
      window.removeEventListener('keydown', onBubble);
    };
  }, []);
}
