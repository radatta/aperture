import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, SyntheticEvent } from 'react';
import {
  hasTaskTokens,
  parseTaskLine,
  toCreateInput,
  todayKey,
  tokenAtCaret,
} from '@aperture/shared';
import { cx } from '../../lib/cx';
import { Text } from '../../components/Text';
import { ModeToggle } from '../../components/ModeToggle';
import { SendIcon } from '../../components/icons';
import { useSettings } from '../../data/hooks/useSettings';
import { useCreateLogEntry } from '../../data/hooks/useLog';
import { useCreateTask } from '../../data/hooks/useTasks';
import { useAddToDay } from '../../data/hooks/useAddToDay';
import { useCreateIdea } from '../../data/hooks/useIdeas';
import { useActiveCategories } from '../../data/hooks/useCategories';
import { isTypingTarget } from '../../lib/keys';
import { TaskTokenChips } from '../tasks/TaskTokenChips';
import { useAutoGrow } from './useAutoGrow';
import { applySuggestion, suggestionsFor, type Suggestion } from './suggestions';
import { TokenSuggestions } from './TokenSuggestions';
import { CAPTURE_MODES, cycleMode, placeholderFor, receiptFor, type CaptureMode } from './mode';

const RECEIPT_MS = 1800;

// Why a submit was refused. Each keeps the text and says so — a refused capture is never silent. The
// visible notice is just "Not saved" (the mode row is ~375px on a phone); the reason is in the preview row.
type Blocked = 'invalid' | 'categories' | 'categories-failed';

// The global capture bar — PRODUCT's #1 mechanic. Always present, bottom-docked for thumb reach.
// Default Log; Tab cycles the mode; Enter submits; after submit it clears and stays focused, keeping
// the current mode. It never asks for structure — no estimate/category/due field exists here by design.
// Task mode optionally takes one line of the bulk grammar after ' | ' (`memo | ~30 #Admin`); without the
// separator nothing is parsed. A red error refuses the submit and keeps the text (docs/areas/tasks/bulk-add.md).
// Once you've typed `#`, `~` or `due:` there, chips offer completions; a tap (or Tab) types the literal
// token, so the grammar is unchanged — and nothing appears until you start a token, so it never asks.
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
  const [caret, setCaret] = useState(0);
  // Set by an accepted suggestion; applied after the new value renders (see the layout effect). The
  // nonce, not `text`, triggers it — an accept that changes nothing must still place the caret.
  const pendingCaret = useRef<number | null>(null);
  const [placeNonce, setPlaceNonce] = useState(0);
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
    blocked?: Blocked;
    at: number;
  } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const previewId = useId();

  const createLog = useCreateLogEntry(today);
  const createTask = useCreateTask();
  const { createToday } = useAddToDay();
  const createIdea = useCreateIdea();
  const { data: categoryData, isError: categoriesFailed } = useActiveCategories();
  // Loaded = we have a list. Not isSuccess: a failed background refetch flips status to error while
  // keeping good data, and that must not refuse a #label line.
  const categoriesLoaded = categoryData !== undefined;
  const categories = useMemo(() => categoryData ?? [], [categoryData]);
  const catRefs = useMemo(
    () => categories.map((c) => ({ id: c.id, label: c.label })),
    [categories],
  );

  // Trailing whitespace holding a newline is dropped (invisible, so a "single line" error would
  // confuse); a bare trailing space is kept so "milk | " reads as an empty token region.
  const line = useMemo(
    () =>
      mode === 'task' && hasTaskTokens(text)
        ? parseTaskLine(text.replace(/\s*\n\s*$/, ''), catRefs)
        : null,
    [mode, text, catRefs],
  );
  const token = useMemo(
    () => (mode === 'task' && hasTaskTokens(text) ? tokenAtCaret(text, caret) : null),
    [mode, text, caret],
  );
  // Before categories load catRefs is empty, so `#` offers nothing — the preview row already says
  // "Loading categories…" for that line.
  const suggestions = useMemo(
    () => (token ? suggestionsFor(token, { cats: catRefs, today }) : []),
    [token, catRefs, today],
  );

  // Before categories load, a real #label would parse as unknown and land uncategorised — wait instead.
  const awaitingCategories = line !== null && line.categoryLabel !== null && !categoriesLoaded;
  const invalid = line !== null && line.errors.length > 0;
  const block: Blocked | null = invalid
    ? 'invalid'
    : awaitingCategories
      ? categoriesFailed
        ? 'categories-failed'
        : 'categories'
      : null;
  // The one reason a screen reader hears on a refused submit — the preview row isn't announced.
  const blockReason = invalid
    ? line.errors[0]!
    : categoriesFailed
      ? 'Couldn’t load categories — remove the #label to save without one'
      : 'Loading categories…';
  // A refusal notice tracks the live state: once the cause is gone (categories arrived, mode switched,
  // line fixed) it goes too, and its text always names the current cause.
  const shown = receipt?.blocked && !block ? null : receipt;
  useEffect(() => {
    if (!block) setReceipt((r) => (r?.blocked ? null : r));
  }, [block]);

  useAutoGrow(inputRef, text);

  // "/" focuses capture from anywhere, unless you're already typing or a page claimed it first (the
  // Finances All tab's search, in the capture phase).
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== '/' || e.defaultPrevented) return;
      if (isTypingTarget(document.activeElement)) return;
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
    if (!receipt || receipt.failed || receipt.blocked) return;
    const id = setTimeout(() => setReceipt(null), RECEIPT_MS);
    return () => clearTimeout(id);
  }, [receipt]);

  function submit() {
    const value = text.trim();
    if (!value) return;
    const submitted = mode;
    if (block) {
      setReceipt({ mode: submitted, blocked: block, at: Date.now() });
      return;
    }
    const input = line ? toCreateInput(line) : value;
    const goesToday = submitted === 'task' && toToday;
    // The field clears optimistically so capture stays instant — which means a failed write would
    // otherwise destroy the thought outright: the creates roll back, the entry disappears from the
    // list, and the text is already gone from the field. Capture is the #1 mechanic and the whole
    // premise is that it's safe to hand it something, so a failure puts the text back and says so.
    const handlers = {
      onSuccess: () => setReceipt({ mode: submitted, at: Date.now() }),
      onError: () => {
        setText((current) => (current === '' ? value : current));
        setCaret(value.length);
        setMode(submitted);
        if (goesToday) setToToday(true); // the retry should go where the first attempt was headed
        setReceipt({ mode: submitted, failed: true, at: Date.now() });
      },
    };
    if (goesToday)
      createToday(input).then(
        (r) =>
          setReceipt({
            mode: submitted,
            dest: { today: true, planned: r.planned },
            at: Date.now(),
          }),
        handlers.onError,
      );
    else if (submitted === 'log') createLog.mutate(value, handlers);
    else if (submitted === 'task') createTask.mutate(input, handlers);
    else createIdea.mutate(value, handlers);
    setText('');
    setCaret(0);
    setToToday(false);
    // Stay in the current mode after a submit — if you're logging tasks or ideas, the next capture is
    // almost always the same kind, so snapping back to Log every time just made you re-pick it.
    inputRef.current?.focus();
  }

  function update(value: string) {
    setText(value);
    if (receipt?.blocked) setReceipt(null);
  }

  const syncCaret = (e: SyntheticEvent<HTMLTextAreaElement>) =>
    setCaret(e.currentTarget.selectionStart ?? 0);

  function accept(s: Suggestion) {
    if (!token) return;
    const r = applySuggestion(text, token, s);
    pendingCaret.current = r.caret;
    update(r.text);
    setPlaceNonce((n) => n + 1);
  }

  // Place the caret once the accepted value is in the DOM (a controlled update would otherwise leave
  // it at the end), and refocus in case a click moved focus despite the chip's mousedown guard.
  useLayoutEffect(() => {
    const el = inputRef.current;
    const p = pendingCaret.current;
    if (!el || p === null) return;
    pendingCaret.current = null;
    if (document.activeElement !== el) el.focus();
    el.setSelectionRange(p, p);
    setCaret(p);
  }, [placeNonce]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Shift+Enter is a newline — the log takes multi-line entries now that the field can show them.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      // Tab takes the first chip while chips show; Shift+Tab always switches mode (the escape hatch).
      if (e.nativeEvent.isComposing) return; // don't replace text an IME is still composing
      if (!e.shiftKey && suggestions.length > 0) accept(suggestions[0]!);
      else setMode((m) => cycleMode(m, e.shiftKey ? -1 : 1));
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
              <span aria-hidden>→ </span>today
            </button>
          )}
        </div>
        {/* Live region wraps the receipt ONLY. With the hint inside it, the hint re-entered the
            region when the receipt expired and every capture ended with the keyboard hint being
            read aloud 1.8s later. */}
        <div className="flex min-w-0 items-center gap-1">
          <div aria-live="polite" role="status" className="min-w-0">
            {shown && <Receipt key={shown.at} receipt={shown} reason={blockReason} />}
          </div>
          {!shown && <Hint suggesting={suggestions.length > 0} />}
          {/* On a phone the row can't hold both, so it gives way to a receipt there (a failure
              notice stays until the next capture). Desktop has room for both. */}
          <div className={cx('shrink-0', shown && 'max-sm:hidden')}>{trailing}</div>
        </div>
      </div>
      <div className="flex items-end gap-2">
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          onChange={(e) => {
            update(e.target.value);
            syncCaret(e);
          }}
          onSelect={syncCaret}
          onKeyUp={syncCaret}
          onKeyDown={onKeyDown}
          placeholder={placeholderFor(mode, toToday)}
          aria-label={`Capture ${mode}`}
          aria-describedby={line ? previewId : undefined}
          aria-invalid={invalid || undefined}
          className={cx(
            'min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-ink outline-none',
            'placeholder:text-ink-muted',
          )}
        />
        <button
          type="button"
          onClick={submit}
          disabled={!text.trim()}
          // Refused, not disabled: a tap must still say why (a dead button on iPhone is silent).
          aria-disabled={invalid || awaitingCategories || undefined}
          aria-label={`Save ${mode}`}
          className={cx(
            'mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition',
            text.trim() && !invalid && !awaitingCategories
              ? 'bg-teal text-surface hover:opacity-90'
              : 'border border-line text-ink-subtle',
          )}
        >
          <SendIcon size={16} />
        </button>
      </div>
      <TokenSuggestions items={suggestions} onPick={accept} />
      {/* Not a live region — it would chatter on every keystroke. The field points here via
          aria-describedby, and a refused submit announces once through the receipt. */}
      {line && (
        <div id={previewId} className="flex max-h-24 flex-col gap-0.5 overflow-auto px-2 pt-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <TaskTokenChips line={line} />
          </div>
          {line.errors.map((e, i) => (
            <Text key={`e${i}`} size="xs" tone="danger" className="break-words">
              {e}
            </Text>
          ))}
          {/* While categories load, the "no category" warning would be a lie — say what's happening. */}
          {awaitingCategories ? (
            <Text size="xs" tone={categoriesFailed ? 'danger' : 'muted'}>
              {blockReason}
            </Text>
          ) : (
            line.warnings.map((w, i) => (
              <Text key={`w${i}`} size="xs" tone="gold" className="break-words">
                {w}
              </Text>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// Desktop-only keyboard affordance — on a phone there's no Tab key and the hint is just clutter,
// which is also why the Send button is never hidden.
function Hint({ suggesting }: { suggesting: boolean }) {
  return (
    <Text size="xs" tone="muted" className="hidden pr-1 sm:block">
      {suggesting
        ? 'Tab accepts · Enter saves · Shift+Tab switches'
        : 'Tab switches · Enter saves · Shift+Enter new line'}
    </Text>
  );
}

// Plain text, not a link. It disappears after ~1.8s, so as a link it was a target no keyboard user
// could ever reach — and the nav already carries a permanent route to all three destinations. It
// says where the thought went; getting there is the nav's job.
function Receipt({
  receipt,
  reason,
}: {
  reason: string;
  receipt: {
    mode: CaptureMode;
    dest?: { today: boolean; planned: boolean };
    failed?: boolean;
    blocked?: Blocked;
  };
}) {
  if (receipt.blocked)
    return (
      <Text size="xs" tone="danger" className="block truncate pr-1">
        Not saved<span className="sr-only">: {reason}</span>
      </Text>
    );
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
