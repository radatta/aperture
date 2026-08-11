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

export function useDisclosure(): Disclosure {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);

  useEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    triggerRef.current?.focus();
  }, [open]);

  const onOpen = useCallback(() => setOpen(true), []);
  const onClose = useCallback(() => {
    refocus.current = true;
    setOpen(false);
  }, []);

  return { open, triggerRef, onOpen, onClose };
}
