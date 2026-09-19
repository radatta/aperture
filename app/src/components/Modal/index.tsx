import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';

// The app's modal primitive — a native <dialog> driven by showModal(). The browser gives us the top
// layer (renders over the z-30 bottom dock with no z-index juggling), focus containment, Escape, and a
// ::backdrop for free — a hand-rolled focus trap is exactly the "subtle correctness" we don't own.
// React state stays the source of truth: `open` drives showModal()/close(), and onCancel (Escape) is
// intercepted so the DOM and state never drift. No backdrop-click close — there's a paste inside.
export interface ModalProps {
  open: boolean;
  onClose: () => void;
  label: string; // aria-label for the dialog
  children: ReactNode;
}

export function Modal({ open, onClose, label, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault(); // Escape → our close, so React state stays authoritative
        onClose();
      }}
      className={cx(
        'w-[min(100vw-2rem,42rem)] max-h-[85vh] overflow-auto rounded-2xl',
        'border border-line bg-panel p-5 text-ink shadow-xl',
        'backdrop:bg-ink/40',
      )}
    >
      {children}
    </dialog>
  );
}
