import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { todayKey } from '@aperture/shared';
import { cx } from '../../lib/cx';
import { Text } from '../../components/Text';
import { ModeToggle } from '../../components/ModeToggle';
import { SendIcon } from '../../components/icons';
import { useSettings } from '../../data/hooks/useSettings';
import { useCreateLogEntry } from '../../data/hooks/useLog';
import { useCreateTask } from '../../data/hooks/useTasks';
import { useCreateIdea } from '../../data/hooks/useIdeas';
import { useAutoGrow } from './useAutoGrow';
import { CAPTURE_MODES, cycleMode, placeholderFor, receiptFor, type CaptureMode } from './mode';

const RECEIPT_MS = 1800;

// The global capture bar — PRODUCT's #1 mechanic. Always present, bottom-docked for thumb reach.
// Default Log; Tab cycles the mode; Enter submits; after submit it clears, stays focused, and snaps
// back to Log. It never asks for structure — no estimate/category/due field exists here by design.
//
// The field is a growing textarea, not an input, and the mode toggle sits on its own row: on a
// phone a segmented [Log|Task|Idea] plus a single-line input left ~22 characters of a sentence
// visible, so you could never read back the thought you were mid-way through writing.
export function CaptureBar() {
  const { data: settings } = useSettings();
  const today = todayKey(settings?.dayStartHour ?? 4);
  const [mode, setMode] = useState<CaptureMode>('log');
  const [text, setText] = useState('');
  const [receipt, setReceipt] = useState<CaptureMode | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const createLog = useCreateLogEntry(today);
  const createTask = useCreateTask();
  const createIdea = useCreateIdea();

  useAutoGrow(inputRef, text);

  // "/" focuses capture from anywhere, unless you're already typing.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== '/') return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      inputRef.current?.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The receipt is a transient acknowledgement, not state anyone can act on — clear it on a timer,
  // and on unmount so a route change mid-fade can't set state on a dead component.
  useEffect(() => {
    if (!receipt) return;
    const id = setTimeout(() => setReceipt(null), RECEIPT_MS);
    return () => clearTimeout(id);
  }, [receipt]);

  function submit() {
    const value = text.trim();
    if (!value) return;
    if (mode === 'log') createLog.mutate(value);
    else if (mode === 'task') createTask.mutate(value);
    else createIdea.mutate(value);
    setReceipt(mode);
    setText('');
    setMode('log');
    inputRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Shift+Enter is a newline — the log takes multi-line entries now that the field can show them.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      setMode((m) => cycleMode(m, e.shiftKey ? -1 : 1));
    } else if (e.key === 'Escape') {
      inputRef.current?.blur();
    }
  }

  return (
    <div className="rounded-2xl border border-line bg-panel-2 p-2 shadow-[var(--shadow-dock)]">
      <div className="flex items-center justify-between gap-2 pb-1.5">
        <ModeToggle<CaptureMode>
          size="sm"
          options={CAPTURE_MODES.map((m) => ({
            value: m,
            label: m[0]!.toUpperCase() + m.slice(1),
          }))}
          value={mode}
          onChange={setMode}
        />
        {receipt ? <Receipt mode={receipt} /> : <Hint />}
      </div>
      <div className="flex items-end gap-2">
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholderFor(mode)}
          aria-label={`Capture ${mode}`}
          className={cx(
            'min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-ink outline-none',
            'placeholder:text-ink-muted',
          )}
        />
        <button
          type="button"
          onClick={submit}
          disabled={!text.trim()}
          aria-label={`Save ${mode}`}
          className={cx(
            'mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition',
            text.trim()
              ? 'bg-teal text-surface hover:opacity-90'
              : 'border border-line text-ink-subtle',
          )}
        >
          <SendIcon size={16} />
        </button>
      </div>
    </div>
  );
}

// Desktop-only keyboard affordance — on a phone there's no Tab key and the hint is just clutter,
// which is also why the Send button is never hidden.
function Hint() {
  return (
    <Text size="xs" tone="muted" className="hidden pr-1 sm:block">
      Tab switches · Enter saves · Shift+Enter new line
    </Text>
  );
}

function Receipt({ mode }: { mode: CaptureMode }) {
  const r = receiptFor(mode);
  return (
    <Link to={r.to} className="pr-1">
      <Text size="xs" tone="teal">
        {r.text} → {r.label}
      </Text>
    </Link>
  );
}
