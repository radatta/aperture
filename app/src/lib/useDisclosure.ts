import { useCallback, useEffect, useRef, useState } from 'react';

// Open/close state for a form that replaces its own trigger button.
//
// The catch: the trigger unmounts while the form is open, so closing remounts it as a fresh DOM
// node and focus lands nowhere — a keyboard user ends up at the top of the document. Same contract
// the overflow Menu already holds: whatever dismisses a thing hands focus back to what opened it.
// Refocus only after a close the user asked for, never on first mount.
export interface Disclosure {
  open: boolean;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onOpen: () => void;
  onClose: () => void;
}

// Is the user navigating by keyboard — did they Tab since their last click/tap? Returning focus by
// script inherits :focus-visible from whatever had focus before (a textarea always has it; Safari never
// moves focus to a clicked button), so without this the trigger wears the keyboard ring after a mouse
// user types in the modal and closes it — by button, backdrop, or Esc. Typing and Esc aren't navigation;
// only Tab is. Module-level: input modality is global to the page (reset in test/setup.ts).
let keyboardNav = false;
let listening = false;
function trackModality() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('pointerdown', () => (keyboardNav = false), true);
  window.addEventListener('keydown', (e) => e.key === 'Tab' && (keyboardNav = true), true);
}
export const resetInputModality = () => {
  keyboardNav = false;
};

// Focus without the ring: marks the element so index.css hides its outline until it blurs, or until a
// key is pressed on it (Tab away, Enter to reopen) — then the ring is wanted again.
function focusQuietly(el: HTMLElement) {
  el.setAttribute('data-focus-quiet', '');
  const clear = () => {
    el.removeAttribute('data-focus-quiet');
    el.removeEventListener('blur', clear);
    el.removeEventListener('keydown', clear);
  };
  el.addEventListener('blur', clear);
  el.addEventListener('keydown', clear);
  el.focus();
}

export function useDisclosure(): Disclosure {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);

  useEffect(trackModality, []);
  useEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    const el = triggerRef.current;
    if (!el) return;
    if (keyboardNav) el.focus();
    else focusQuietly(el);
  }, [open]);

  const onOpen = useCallback(() => setOpen(true), []);
  const onClose = useCallback(() => {
    refocus.current = true;
    setOpen(false);
  }, []);

  return { open, triggerRef, onOpen, onClose };
}
