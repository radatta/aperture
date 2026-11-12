import { useEffect, useRef } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { cx } from '../../lib/cx';

// The app's modal primitive — a native <dialog> driven by showModal(). The browser gives us the top
// layer (renders over the z-30 bottom dock with no z-index juggling), focus containment, Escape, and a
// ::backdrop for free — a hand-rolled focus trap is exactly the "subtle correctness" we don't own.
// React state stays the source of truth: `open` drives showModal()/close(), and onCancel (Escape) is
// intercepted so the DOM and state never drift. Backdrop-click close is opt-in (`closeOnBackdrop`) —
// off by default so a paste-heavy dialog (bulk add) can't be dismissed by a stray click; the task
// editor turns it on and guards it behind an unsaved-changes confirm.
// A backdrop press: on the <dialog> itself AND outside its box. The target test alone isn't enough —
// the dialog's own padding is part of the element, so a tap in that gutter would close it.
function onBackdrop(e: MouseEvent<HTMLDialogElement>) {
  if (e.target !== e.currentTarget) return false;
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  label: string; // aria-label for the dialog
  closeOnBackdrop?: boolean;
  // Where focus starts. 'content' (default): the browser's first focusable element, or a
  // `data-autofocus` child. 'dialog': the dialog itself, for a surface opened to read — a focused
  // field raises the on-screen keyboard on iOS — or whose first control acts on a stray Enter.
  initialFocus?: 'content' | 'dialog';
  // Names what the open dialog shows. A change (the task modal switching task) is a new thing in the
  // same dialog: back to the top, and focus placed as on open.
  contentKey?: string;
  children: ReactNode;
}

export function Modal({
  open,
  onClose,
  label,
  closeOnBackdrop = false,
  initialFocus = 'content',
  contentKey,
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
      // The browser focuses the first focusable element; a dialog can name a better start instead
      // (e.g. the checked option of a radio group) with `data-autofocus`. Named as `autofocus` for the
      // showModal() call, so the browser lands there directly — never first on an earlier field, which
      // on iOS starts raising the keyboard.
      const start =
        initialFocus === 'content' ? el.querySelector<HTMLElement>('[data-autofocus]') : null;
      start?.setAttribute('autofocus', '');
      try {
        el.showModal();
      } finally {
        start?.removeAttribute('autofocus'); // React owns data-autofocus; don't leave a stale twin
      }
      // Engines predating that step focus the first field anyway; move it back to the dialog / start.
      if (initialFocus === 'dialog') el.focus();
      else start?.focus();
    } else if (!open && el.open) el.close();
  }, [open, initialFocus]);

  // Declared after the open effect, so on first open it repeats that focus harmlessly.
  useEffect(() => {
    const el = ref.current;
    if (contentKey === undefined || !el?.open) return;
    el.scrollTop = 0;
    if (initialFocus === 'dialog') el.focus();
    else el.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, [contentKey, initialFocus]);

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
      onMouseDown={closeOnBackdrop ? (e) => (pressedBackdrop.current = onBackdrop(e)) : undefined}
      // Require the press to have landed on the backdrop too (see pressedBackdrop) so a drag-out
      // release doesn't dismiss.
      onClick={
        closeOnBackdrop
          ? (e) => {
              if (pressedBackdrop.current && onBackdrop(e)) onClose();
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
