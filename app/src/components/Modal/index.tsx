import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';

// The app's modal primitive — a native <dialog> driven by showModal(). The browser gives us the top
// layer (renders over the z-30 bottom dock with no z-index juggling), focus containment, Escape, and a
// ::backdrop for free — a hand-rolled focus trap is exactly the "subtle correctness" we don't own.
// React state stays the source of truth: `open` drives showModal()/close(), and onCancel (Escape) is
// intercepted so the DOM and state never drift. Backdrop-click close is opt-in (`closeOnBackdrop`) —
// off by default so a paste-heavy dialog (bulk add) can't be dismissed by a stray click; the task
// editor turns it on and guards it behind an unsaved-changes confirm.
export interface ModalProps {
  open: boolean;
  onClose: () => void;
  label: string; // aria-label for the dialog
  closeOnBackdrop?: boolean;
  // Where focus starts. 'content' (default): the browser's first focusable element, or a
  // `data-autofocus` child. 'dialog': the dialog itself, for a surface opened to read — a focused
  // field raises the on-screen keyboard on iOS.
  initialFocus?: 'content' | 'dialog';
  children: ReactNode;
}

export function Modal({
  open,
  onClose,
  label,
  closeOnBackdrop = false,
  initialFocus = 'content',
  children,
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  // Backdrop close fires only when BOTH the press and the release land on the dialog itself — so a
  // text selection that starts inside a field and drags out to release on the backdrop never closes.
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      // `autofocus` on the dialog itself makes showModal() focus the dialog and never a field inside
      // it. Set imperatively: React drops autoFocus on a <dialog>.
      el.toggleAttribute('autofocus', initialFocus === 'dialog');
      el.showModal();
      // Engines predating that step focus the first field anyway; move it back to the dialog.
      if (initialFocus === 'dialog') el.focus();
      // The browser focuses the first focusable element; a dialog can name a better start instead
      // (e.g. the checked option of a radio group) with `data-autofocus`.
      else el.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    } else if (!open && el.open) el.close();
  }, [open, initialFocus]);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      // Focusable as a container for initialFocus='dialog'; no ring on it, as with the app's other
      // tabIndex={-1} containers — the first Tab draws it on the first field.
      tabIndex={initialFocus === 'dialog' ? -1 : undefined}
      onCancel={(e) => {
        e.preventDefault(); // Escape → our close, so React state stays authoritative
        onClose();
      }}
      onMouseDown={
        closeOnBackdrop ? (e) => (pressedBackdrop.current = e.target === ref.current) : undefined
      }
      onClick={
        closeOnBackdrop
          ? (e) => {
              // A click whose target is the <dialog> itself is the backdrop — content sits in inner
              // elements, so their clicks have a different target. Require the press to have landed
              // there too (see pressedBackdrop) so a drag-out release doesn't dismiss.
              if (e.target === ref.current && pressedBackdrop.current) onClose();
            }
          : undefined
      }
      className={cx(
        // m-auto restores the UA `dialog:modal { margin:auto }` that Tailwind Preflight's universal
        // `margin:0` zeroes — without it the fixed-width box pins to the top-left instead of centering.
        // dvh, not vh: mobile vh is the toolbar-collapsed height, so 85vh runs under the browser chrome;
        // overscroll-contain keeps a scroll at the dialog's edge from rubber-banding the page behind.
        'm-auto w-[min(100vw-2rem,42rem)] max-h-[85dvh] overflow-auto overscroll-contain rounded-2xl',
        'border border-line bg-panel p-5 text-ink shadow-xl',
        'backdrop:bg-ink/40',
        initialFocus === 'dialog' && 'outline-none',
      )}
    >
      {children}
    </dialog>
  );
}
