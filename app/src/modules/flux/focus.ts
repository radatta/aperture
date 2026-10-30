import { returnFocus } from '../../lib/useDisclosure';

// Where focus goes when the control holding it is about to leave the page (a deleted row, a strip that
// saved or was discarded) — never the page heading the shell falls back to, which costs a keyboard user
// every earlier stop again.

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// The first focusable element after `el` in document order, outside it.
export function focusableAfter(el: Element): HTMLElement | null {
  for (const c of document.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (!el.contains(c) && el.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING)
      return c;
  return null;
}

// Hand focus to `to` once it's in the page, the way a closing disclosure does (ring only for a keyboard
// user). A no-op when the target is gone too.
export function moveFocus(to: HTMLElement | null): void {
  if (to?.isConnected) returnFocus(to);
}
