import { useEffect, useId, useRef, useState } from 'react';
import { cx } from '../../lib/cx';
import { MoreIcon } from '../icons';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  tone?: 'default' | 'danger';
}

// A tiny overflow menu. Hand-rolled rather than pulled in: it needs exactly one trigger, outside
// -click + Escape to close, and arrow-key navigation — a headless-UI dependency for that is not the
// trade CONVENTIONS asks for.
//
// Rows used to carry every lifecycle action as a full button (Scope / Start / Split / Cancel), so a
// five-task backlog was a wall of twenty equally-loud controls. The one you'd actually press stays
// visible; the rest live in here.
//
// role="menu" is a promise to assistive tech that Up/Down/Home/End work, so they do: focus lands on
// the first item when the menu opens, arrows move between items, and closing — by Escape, by
// selecting, or by clicking away — always hands focus back to the trigger. These actions used to be
// plain in-row buttons; a keyboard user must not end up dumped at the top of the document.
export function Menu({ items, label = 'More actions' }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();

  function close(returnFocus = true) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  // Focus the first item on open so the arrow keys have somewhere to start.
  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      // A click outside is a pointer gesture — yanking focus back to the trigger there would be
      // the surprising move, so only dismiss.
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function move(from: number, delta: number) {
    const next = (from + delta + items.length) % items.length;
    itemRefs.current[next]?.focus();
  }

  function onItemKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, i: number) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(i, 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(i, -1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      itemRefs.current[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      itemRefs.current[items.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(e) => e.key === 'ArrowDown' && !open && setOpen(true)}
        className={cx(
          'flex h-8 w-8 items-center justify-center rounded-xl transition',
          open ? 'bg-panel-2 text-ink' : 'text-ink-subtle hover:bg-panel-2 hover:text-ink',
        )}
      >
        <MoreIcon size={16} />
      </button>
      {open && (
        <div
          id={id}
          role="menu"
          aria-label={label}
          className="absolute right-0 z-40 mt-1 min-w-40 overflow-hidden rounded-xl border border-line bg-panel-2 py-1 shadow-[var(--shadow-pop)]"
        >
          {items.map((it, i) => (
            <button
              key={it.label}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              onKeyDown={(e) => onItemKeyDown(e, i)}
              onClick={() => {
                close();
                it.onSelect();
              }}
              className={cx(
                'block w-full px-3 py-1.5 text-left text-sm transition hover:bg-teal-soft',
                it.tone === 'danger' ? 'text-danger' : 'text-ink',
              )}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
