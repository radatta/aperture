import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { todayKey } from '@aperture/shared';
import { cx } from '../../lib/cx';
import { Text } from '../../components/Text';
import { ModeToggle } from '../../components/ModeToggle';
import { SendIcon } from '../../components/icons';
import { useSettings } from '../../data/hooks/useSettings';
import { useCreateLogEntry } from '../../data/hooks/useLog';
import { useCreateTask } from '../../data/hooks/useTasks';
import { useAddToDay } from '../../data/hooks/useAddToDay';
import { useCreateIdea } from '../../data/hooks/useIdeas';
import { useAutoGrow } from './useAutoGrow';
import { CAPTURE_MODES, cycleMode, placeholderFor, receiptFor, type CaptureMode } from './mode';

const RECEIPT_MS = 1800;

// The global capture bar — PRODUCT's #1 mechanic. Always present, bottom-docked for thumb reach.
// Default Log; Tab cycles the mode; Enter submits; after submit it clears and stays focused, keeping
// the current mode. It never asks for structure — no estimate/category/due field exists here by design.
//
// The field is a growing textarea, not an input, and the mode toggle sits on its own row: on a
// phone a segmented [Log|Task|Idea] plus a single-line input left ~22 characters of a sentence
// visible, so you could never read back the thought you were mid-way through writing.
// `trailing` sits at the right of the mode row — AppShell docks the idle Focus control there.
export function CaptureBar({ trailing }: { trailing?: ReactNode }) {
  const { data: settings } = useSettings();
  const today = todayKey(settings?.dayStartHour ?? 4);
  const [mode, setMode] = useState<CaptureMode>('log');
  const [text, setText] = useState('');
  // One-shot: "→ today" applies to the next task only, then resets — so it can never silently keep
  // filling today's plan after the moment you meant it for.
  const [toToday, setToToday] = useState(false);
  // `at` is a nonce: two captures in a row in the same mode would otherwise set an identical value,
  // React would bail out of the re-render, the dismiss effect would never re-run, and the second
  // confirmation would vanish after the FIRST timer's remainder.
  const [receipt, setReceipt] = useState<{
    mode: CaptureMode;
    dest?: { today: boolean; planned: boolean };
    failed?: boolean;
    at: number;
  } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const createLog = useCreateLogEntry(today);
  const createTask = useCreateTask();
  const { createToday } = useAddToDay();
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
  // and on unmount so a route change mid-fade can't set state on a dead component. A failure notice
  // stays put: it's telling you your text was restored and needs another try.
  useEffect(() => {
    if (!receipt || receipt.failed) return;
    const id = setTimeout(() => setReceipt(null), RECEIPT_MS);
    return () => clearTimeout(id);
  }, [receipt]);

  function submit() {
    const value = text.trim();
    if (!value) return;
    const submitted = mode;
    const today = submitted === 'task' && toToday;
    // The field clears optimistically so capture stays instant — which means a failed write would
    // otherwise destroy the thought outright: the creates roll back, the entry disappears from the
    // list, and the text is already gone from the field. Capture is the #1 mechanic and the whole
    // premise is that it's safe to hand it something, so a failure puts the text back and says so.
    const handlers = {
      onSuccess: () => setReceipt({ mode: submitted, at: Date.now() }),
      onError: () => {
        setText((current) => (current === '' ? value : current));
        setMode(submitted);
        if (today) setToToday(true); // the retry should go where the first attempt was headed
        setReceipt({ mode: submitted, failed: true, at: Date.now() });
      },
    };
    if (today)
      createToday(value).then(
        (r) =>
          setReceipt({
            mode: submitted,
            dest: { today: true, planned: r.planned },
            at: Date.now(),
          }),
        handlers.onError,
      );
    else if (submitted === 'log') createLog.mutate(value, handlers);
    else if (submitted === 'task') createTask.mutate(value, handlers);
    else createIdea.mutate(value, handlers);
    setText('');
    setToToday(false);
    // Stay in the current mode after a submit — if you're logging tasks or ideas, the next capture is
    // almost always the same kind, so snapping back to Log every time just made you re-pick it.
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
    <div className="pointer-events-auto rounded-2xl border border-line bg-panel-2 p-2 shadow-[var(--shadow-dock)]">
      <div className="flex items-center justify-between gap-2 pb-1.5">
        <div className="flex shrink-0 items-center gap-1.5">
          <ModeToggle<CaptureMode>
            size="sm"
            options={CAPTURE_MODES.map((m) => ({
              value: m,
              label: m[0]!.toUpperCase() + m.slice(1),
            }))}
            value={mode}
            onChange={setMode}
          />
          {mode === 'task' && (
            <button
              type="button"
              aria-pressed={toToday}
              title="Put this task on today's plan"
              onClick={() => setToToday((v) => !v)}
              className={cx(
                'whitespace-nowrap rounded-lg border px-2 py-1 text-xs transition',
                toToday
                  ? 'border-teal bg-teal-soft text-ink'
                  : 'border-line text-ink-muted hover:text-ink',
              )}
            >
              → today
            </button>
          )}
        </div>
        {/* Live region wraps the receipt ONLY. With the hint inside it, the hint re-entered the
            region when the receipt expired and every capture ended with the keyboard hint being
            read aloud 1.8s later. */}
        <div className="flex min-w-0 items-center gap-1">
          <div aria-live="polite" role="status" className="min-w-0">
            {receipt && <Receipt receipt={receipt} />}
          </div>
          {!receipt && <Hint />}
          {trailing}
        </div>
      </div>
      <div className="flex items-end gap-2">
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholderFor(mode, toToday)}
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

// Plain text, not a link. It disappears after ~1.8s, so as a link it was a target no keyboard user
// could ever reach — and the nav already carries a permanent route to all three destinations. It
// says where the thought went; getting there is the nav's job.
function Receipt({
  receipt,
}: {
  receipt: { mode: CaptureMode; dest?: { today: boolean; planned: boolean }; failed?: boolean };
}) {
  if (receipt.failed)
    return (
      <Text size="xs" tone="danger" className="block truncate pr-1">
        Couldn&apos;t save — your text is back in the box.
      </Text>
    );
  const r = receiptFor(receipt.mode, receipt.dest);
  return (
    <Text size="xs" tone="teal" className="block truncate pr-1">
      {r.text} → {r.label}
    </Text>
  );
}
