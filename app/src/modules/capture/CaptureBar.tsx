import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, SyntheticEvent } from 'react';
import {
  hasTaskTokens,
  parseFailText,
  parseTaskLine,
  toCreateInput,
  todayKey,
  tokenAtCaret,
} from '@aperture/shared';
import type { CreateTaskInput } from '@aperture/shared';
import { cx } from '../../lib/cx';
import { Text } from '../../components/Text';
import { ModeToggle } from '../../components/ModeToggle';
import { SendIcon, SparkleIcon } from '../../components/icons';
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
import { useQuickParse } from './useQuickParse';
import {
  newCaptureId,
  outboxAdd,
  outboxParkStale,
  outboxRemove,
  readParked,
  writeParked,
  type Parked,
} from './captureOutbox';
import { previewLine, savedSummary } from './parsePreview';

const RECEIPT_MS = 1800;
// A quick add's receipt carries what was parsed — more to read than "Logged", so it stays longer.
const PARSED_RECEIPT_MS = 4000;

// A parked capture couldn't go straight back into the field: its save failed while the field held a newer
// one, it was left unsent when the app last closed, or Put back displaced it. It stays under the bar (up
// to three lines; Put back shows all of it), in storage too (captureOutbox.ts), until put back or
// discarded — a capture is never dropped behind the user's back.
const PARKED_LABEL: Record<Parked['why'], string> = {
  failed: 'Couldn’t save:',
  restored: 'Unsent when the app closed — it may have saved, check first:',
  'set-aside': 'Set aside:',
};

// Why a submit was refused. Each keeps the text and says so — a refused capture is never silent. The
// visible notice is just "Not saved" (the mode row is ~375px on a phone); the reason is in the preview row.
type Blocked = 'invalid' | 'categories' | 'categories-failed';

// The global capture bar — PRODUCT's #1 mechanic. Always present, bottom-docked for thumb reach.
// Default Log; Tab cycles the mode; Enter submits; after submit it clears and stays focused, keeping
// the current mode. It never asks for structure — no estimate/category/due field exists here by design.
// Task mode is quick add (docs/areas/tasks/quick-add.md): you type it the way you'd say it (`aperture,
// fix login bug due fri 30m`) and Haiku reads the structure out of it. Enter (Auto) clears at once and
// saves what the parse returns; Review (✨ / ⌘Enter) shows the parse first and a second press saves exactly
// that. A failed parse saves the line as typed and says so — never silently, never lost.
// A line with ' | ' skips the model: it takes one line of the bulk grammar (`memo | ~30 #Admin`), and a red
// error refuses the submit and keeps the text (docs/areas/tasks/bulk-add.md).
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
    parked?: boolean; // a failed save whose text went to the parked list (the field was busy)
    restored?: boolean; // an unsent capture from a closed session was parked
    parsed?: string; // a quick add's readback (savedSummary)
    unparsed?: string; // why a quick add saved as typed (parseFailText)
    at: number;
  } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const previewId = useId();
  const parseId = useId();
  const quick = useQuickParse();
  const clearPreview = quick.clear;
  const parkedId = useId();
  const [parked, setParked] = useState<Parked[]>(() => readParked());
  // Storage first, synchronously — a failed save's outbox entry is removed right after it parks, and the
  // effect below only mirrors on the next commit.
  const park = (p: Omit<Parked, 'id'>) => {
    const entry = { ...p, id: newCaptureId(Date.now()) };
    writeParked([...readParked(), entry]);
    setParked((list) => [...list, entry]);
  };
  useEffect(() => writeParked(parked), [parked]);
  // This page's own outbox entries: their creates are still running here, so the sweep never parks them.
  const ownSent = useRef(new Set<string>());
  // What the field holds right now, for a save that fails seconds later (Auto waits on the parse first):
  // its restore must not overwrite a newer capture typed meanwhile.
  const textRef = useRef(text);
  useLayoutEffect(() => {
    textRef.current = text;
  });

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
  // A Review's preview — only while the field still holds exactly the text it was parsed from.
  // A parse resolves "tmw" against its day, so one made before the 4am rollover is dropped after it.
  const previewed = mode === 'task' && !line ? quick.previewFor(text.trim()) : null;
  const preview = previewed?.result?.ok && previewed.result.today !== today ? null : previewed;
  // A refusal notice tracks the live state: once the cause is gone (categories arrived, mode switched,
  // line fixed) it goes too, and its text always names the current cause.
  const shown = receipt?.blocked && !block ? null : receipt;
  useEffect(() => {
    if (!block) setReceipt((r) => (r?.blocked ? null : r));
  }, [block]);

  useAutoGrow(inputRef, text);

  // A capture left unsent when the app last closed comes back, parked and announced, never silently. On
  // launch, and again when an entry too young to take (another tab's may still be saving) comes of age,
  // or the app returns to the foreground — a relaunch within seconds mustn't hide it until some later day.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sweep = () => {
      clearTimeout(timer);
      const { moved, retryInMs } = outboxParkStale(Date.now(), ownSent.current);
      if (moved.length) {
        setParked((list) => [...list, ...moved.filter((m) => !list.some((x) => x.id === m.id))]);
        setReceipt({ mode: 'task', restored: true, at: Date.now() });
      }
      if (retryInMs !== null) timer = setTimeout(sweep, retryInMs + 50);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') sweep();
    };
    sweep();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // A preview belongs to the mode it was made in; switching away drops it.
  useEffect(() => clearPreview(), [mode, clearPreview]);

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
    if (!receipt || receipt.failed || receipt.blocked || receipt.restored) return;
    const ms = receipt.parsed || receipt.unparsed ? PARSED_RECEIPT_MS : RECEIPT_MS;
    const id = setTimeout(() => setReceipt(null), ms);
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
    const goesToday = submitted === 'task' && toToday;
    // The field clears optimistically so capture stays instant — which means a failed write would
    // otherwise destroy the thought outright: the creates roll back, the entry disappears from the
    // list, and the text is already gone from the field. Capture is the #1 mechanic and the whole
    // premise is that it's safe to hand it something, so a failure puts the text back and says so.
    // Promises (mutateAsync), not mutate's per-call callbacks: those fire only for the LATEST mutate, so
    // a failed capture followed by a quick second one would never restore — and quick add's parse puts
    // a second or more between Enter and the write, which made that window wide open.
    // Back into the field only while it's empty: a newer capture typed meanwhile is never overwritten —
    // the failed one is parked below instead, in full, and the receipt says where it went.
    const restore = () => {
      if (textRef.current.trim()) {
        park({ text: value, mode: submitted, toToday: goesToday, why: 'failed' });
        setReceipt({ mode: submitted, failed: true, parked: true, at: Date.now() });
        return;
      }
      textRef.current = value; // a second failure in the same tick must see the field as taken
      setText(value);
      setCaret(value.length);
      setMode(submitted);
      setToToday(goesToday); // the retry goes where the first attempt was headed, and nowhere else
      setReceipt({ mode: submitted, failed: true, at: Date.now() });
    };
    const done = () => setReceipt({ mode: submitted, at: Date.now() });
    if (submitted === 'task' && line) saveTask(toCreateInput(line), goesToday, restore, null, {});
    else if (submitted === 'task') {
      // Quick add (Auto): saves the shown preview if there is one, else waits on the parse — a Review
      // still in flight for this text is reused, never asked twice. A failed parse saves the line raw.
      // Until the create settles the capture is also in the outbox, so closing the app can't lose it.
      const reviewed = quick.previewFor(value)?.result;
      const sent = outboxAdd({ text: value, mode: 'task', toToday: goesToday, at: Date.now() });
      ownSent.current.add(sent);
      const settled = () => {
        outboxRemove(sent);
        ownSent.current.delete(sent);
      };
      void (reviewed ? Promise.resolve(reviewed) : quick.parse(value))
        .then((r) =>
          r.ok
            ? saveTask(r.input, goesToday, restore, settled, {
                parsed: savedSummary(r.input, r.categoryLabel, r.today, r.dropped),
              })
            : saveTask({ title: value }, goesToday, restore, settled, {
                unparsed: parseFailText(r),
              }),
        )
        .catch(() => {
          settled();
          restore();
        });
    } else if (submitted === 'log') void createLog.mutateAsync(value).then(done, restore);
    else void createIdea.mutateAsync(value).then(done, restore);
    quick.clear();
    setText('');
    setCaret(0);
    setToToday(false);
    // Stay in the current mode after a submit — if you're logging tasks or ideas, the next capture is
    // almost always the same kind, so snapping back to Log every time just made you re-pick it.
    inputRef.current?.focus();
  }

  function saveTask(
    input: CreateTaskInput,
    goesToday: boolean,
    restore: () => void,
    settled: (() => void) | null,
    note: { parsed?: string; unparsed?: string },
  ) {
    const saved = goesToday
      ? createToday(input).then(
          (r) =>
            setReceipt({
              mode: 'task',
              dest: { today: true, planned: r.planned },
              ...note,
              at: Date.now(),
            }),
          restore,
        )
      : createTask
          .mutateAsync(input)
          .then(() => setReceipt({ mode: 'task', ...note, at: Date.now() }), restore);
    if (settled) void saved.finally(settled);
  }

  // Put a parked capture back in the field; whatever the field held trades places with it (set aside,
  // not lost).
  function putBack(p: Parked) {
    const current = text.trim();
    setParked((list) => [
      ...list.filter((x) => x.id !== p.id),
      ...(current
        ? [{ id: newCaptureId(Date.now()), text, mode, toToday, why: 'set-aside' as const }]
        : []),
    ]);
    textRef.current = p.text;
    setText(p.text);
    setCaret(p.text.length);
    setMode(p.mode);
    setToToday(p.toToday);
    inputRef.current?.focus();
  }

  // Review: the first press parses into a preview; a press while the preview shows saves exactly it, and
  // a press on a failed one parses again (Enter still saves it as typed). A ' | ' line has no model step —
  // its grammar preview is already showing — so a press saves it.
  function review() {
    const value = text.trim();
    if (mode !== 'task' || !value) return;
    const p = quick.previewFor(value);
    if (line || p?.result?.ok) submit();
    else if (!p || p.result) quick.review(value); // null result = a parse already running: wait for it
    inputRef.current?.focus();
  }
  const reviewLabel = !preview?.result
    ? 'Review before saving'
    : preview.result.ok
      ? 'Save reviewed task'
      : 'Retry parse';

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
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (mode === 'task') review();
      else submit();
    } else if (e.key === 'Enter' && !e.shiftKey) {
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
          {!shown && <Hint suggesting={suggestions.length > 0} task={mode === 'task'} />}
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
          aria-describedby={line ? previewId : preview ? parseId : undefined}
          aria-invalid={invalid || undefined}
          className={cx(
            'min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-ink outline-none',
            'placeholder:text-ink-muted',
          )}
        />
        {/* No ✨ on a ' | ' line: it has no model step (⌘Enter still saves it, like Enter). */}
        {mode === 'task' && !line && (
          <button
            type="button"
            // Keep focus (and the phone keyboard) in the field, like the suggestion chips do.
            onMouseDown={(e) => e.preventDefault()}
            onClick={review}
            disabled={!text.trim()}
            aria-label={reviewLabel}
            title={`${reviewLabel} (⌘Enter)`}
            className={cx(
              'mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition',
              preview?.result?.ok
                ? 'border-teal bg-teal-soft text-teal ring-1 ring-teal'
                : text.trim()
                  ? 'border-teal text-teal hover:bg-teal-soft'
                  : 'border-line text-ink-subtle',
            )}
          >
            <SparkleIcon size={16} />
          </button>
        )}
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
      {/* Live, unlike the grammar row: it changes only on a Review press, so it speaks once per parse
          (busy while parsing, so "Reading it…" isn't read first). */}
      {preview && (
        <div
          id={parseId}
          aria-live="polite"
          aria-busy={preview.result === null || undefined}
          className="flex max-h-24 flex-col gap-0.5 overflow-auto px-2 pt-1"
        >
          {preview.result === null ? (
            <Text size="xs" tone="muted">
              Reading it…
            </Text>
          ) : preview.result.ok ? (
            <>
              <div className="flex flex-wrap items-baseline gap-2">
                <Text size="xs" weight="medium" className="break-words">
                  {preview.result.input.title}
                </Text>
                {preview.result.categoryLabel === null && (
                  <Text size="xs" tone="muted">
                    no category
                  </Text>
                )}
                <TaskTokenChips line={previewLine(preview.result)} today={preview.result.today} />
              </div>
              {preview.result.input.notes && (
                <Text size="xs" tone="muted" className="line-clamp-2 break-words">
                  {preview.result.input.notes}
                </Text>
              )}
              {preview.result.dropped.map((w, i) => (
                <Text key={`d${i}`} size="xs" tone="gold" className="break-words">
                  {w}
                </Text>
              ))}
            </>
          ) : (
            <Text size="xs" tone="gold" className="break-words">
              Couldn’t parse ({parseFailText(preview.result)}) — Retry parse, or Enter saves it as
              typed
            </Text>
          )}
        </div>
      )}
      {/* What a quick add saved, readable on a phone (the receipt above truncates), so it wraps. Hidden
          from screen readers: the receipt's live region already announced the same summary. It gives
          way as soon as you start the next capture or switch modes. */}
      {!text && mode === 'task' && (shown?.parsed || shown?.unparsed) && (
        <Text
          size="xs"
          tone={shown.parsed ? 'teal' : 'gold'}
          aria-hidden
          className="block break-words px-2 pt-1"
        >
          {shown.parsed ?? `Saved as typed — couldn’t parse (${shown.unparsed})`}
        </Text>
      )}
      {/* Each row's text describes its two buttons, so with several parked a screen reader can tell
          their "Put back"s apart. Buttons are padded toward a thumb-sized target. */}
      {parked.map((p) => (
        <div key={p.id} className="flex items-start gap-1 pl-2 pt-1">
          <Text
            id={`${parkedId}-${p.id}`}
            size="xs"
            tone={p.why === 'set-aside' ? 'muted' : 'danger'}
            className="line-clamp-3 min-w-0 flex-1 break-words py-1.5"
          >
            {PARKED_LABEL[p.why]} “{p.text}”
          </Text>
          <button
            type="button"
            onClick={() => putBack(p)}
            aria-describedby={`${parkedId}-${p.id}`}
            className="min-h-8 shrink-0 rounded-md px-2 text-xs text-teal hover:underline"
          >
            Put back
          </button>
          <button
            type="button"
            aria-label="Discard"
            aria-describedby={`${parkedId}-${p.id}`}
            onClick={() => setParked((list) => list.filter((x) => x.id !== p.id))}
            className="min-h-8 min-w-8 shrink-0 rounded-md text-sm text-ink-muted hover:text-ink"
          >
            ×
          </button>
        </div>
      ))}
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
function Hint({ suggesting, task }: { suggesting: boolean; task: boolean }) {
  return (
    <Text size="xs" tone="muted" className="hidden pr-1 sm:block">
      {suggesting
        ? 'Tab accepts · Enter saves · Shift+Tab switches'
        : task
          ? 'Enter saves · ⌘Enter reviews · Tab switches'
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
    parked?: boolean;
    restored?: boolean;
    parsed?: string;
    unparsed?: string;
  };
}) {
  if (receipt.blocked)
    return (
      <Text size="xs" tone="danger" className="block truncate pr-1">
        Not saved<span className="sr-only">: {reason}</span>
      </Text>
    );
  if (receipt.restored)
    return (
      <Text size="xs" tone="danger" className="block truncate pr-1">
        Unsent capture kept below the box.
      </Text>
    );
  if (receipt.failed && receipt.parked)
    return (
      <Text size="xs" tone="danger" className="block truncate pr-1">
        Couldn&apos;t save — kept below the box.
      </Text>
    );
  if (receipt.failed)
    return (
      <Text size="xs" tone="danger" className="block truncate pr-1">
        Couldn&apos;t save — your text is back in the box.
      </Text>
    );
  const r = receiptFor(receipt.mode, receipt.dest);
  // Not a failure — the task is saved — but it isn't what you meant, so it reads gold, not teal.
  if (receipt.unparsed)
    return (
      <Text size="xs" tone="gold" className="block truncate pr-1">
        Saved unparsed → {r.label}
        <span className="sr-only">: couldn&apos;t parse ({receipt.unparsed}), saved as typed</span>
      </Text>
    );
  if (receipt.parsed)
    return (
      <Text size="xs" tone="teal" className="block truncate pr-1">
        {r.text} → {r.label}
        <span className="sr-only">: {receipt.parsed}</span>
      </Text>
    );
  return (
    <Text size="xs" tone="teal" className="block truncate pr-1">
      {r.text} → {r.label}
    </Text>
  );
}
