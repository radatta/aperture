import { returnFocus } from '../../lib/useDisclosure';

// Where focus goes when the control holding it is about to leave the page (a deleted row, a strip that
// saved or was discarded) — never the page heading the shell falls back to, which costs a keyboard user
// every earlier stop again.

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

// Focusable elements after `el` in document order, outside it — candidates, since some may be hidden
// (the stage hides the capture bar), and only trying to focus one tells.
export function focusablesAfter(el: Element): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (c) => !el.contains(c) && el.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

// Is focus lost — nowhere, or parked by the page's focus rescue (a tabindex=-1 heading), or still in the
// thing that left? Then moving it is a repair; otherwise the user has moved on and keeps their place.
function focusLost(from: Element | null): boolean {
  const a = document.activeElement;
  if (!a || a === document.body) return true;
  if (from?.contains(a)) return true;
  return a.getAttribute('tabindex') === '-1' && !a.matches(FOCUSABLE);
}

// Hand focus to the first candidate that takes it, the way a closing disclosure does (ring only for a
// keyboard user) — but only if focus was lost with `from`.
export function moveFocus(candidates: readonly (HTMLElement | null)[], from: Element | null): void {
  if (!focusLost(from)) return;
  for (const c of candidates) {
    if (!c?.isConnected) continue;
    returnFocus(c);
    if (document.activeElement === c) return;
  }
}
