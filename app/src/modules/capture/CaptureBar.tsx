import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, SyntheticEvent } from 'react';
import {
  hasTaskTokens,
  parseFailText,
  parseTaskLine,
  toCreateInput,
  fmtDueDay,
  isTimed,
  todayKey,
  tokenAtCaret,
} from '@aperture/shared';
import type { CreateTaskInput, Task } from '@aperture/shared';
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
import { usePlaces } from '../../data/hooks/usePlaces';
import { isTypingTarget } from '../../lib/keys';
import { TaskTokenChips } from '../tasks/TaskTokenChips';
import { useAutoGrow } from './useAutoGrow';
import { applySuggestion, completeTokens, suggestionsFor, type Suggestion } from './suggestions';
import { TokenSuggestions } from './TokenSuggestions';
import {
  CAPTURE_MODES,
  cycleMode,
  placeholderFor,
  receiptFor,
  type CaptureDest,
  type CaptureMode,
} from './mode';
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
import { looksSensitive } from '../log/sensitive';
import { LockIcon } from '../../components/icons';
import { PreviewCategory } from './PreviewCategory';

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

// The grammar's own words (shared bulkTasks.ts) for what may wait while you're still typing it.
const SEP = ' | ';
const EMPTY_TOKENS = "nothing after ' | '";
const UNKNOWN_PLACE = "no place '";
const UNKNOWN_CATEGORY = "no category '";

// Why a submit was refused. Each keeps the text and says so — a refused capture is never silent. The
// visible notice is just "Not saved" (the mode row is ~375px on a phone); the reason is in the preview row.
// 'held': a warning the typing rule was still holding back — the first press shows it, the next saves.
type Blocked = 'invalid' | 'categories' | 'categories-failed' | 'places' | 'places-failed' | 'held';
const HELD_AGAIN = 'Enter or Save again to save without it';
const NUDGE_ASK = 'Looks sensitive — make it private?';
const NUDGE_HELD = 'Looks sensitive — Enter again saves it as is';

// The global capture bar — PRODUCT's #1 mechanic. Always present, bottom-docked for thumb reach.
// Default Log; Tab cycles the mode; Enter submits; after submit it clears and stays focused, keeping
// the current mode. It never asks for structure — no estimate/category/due field exists here by design.
// Task mode is quick add (docs/areas/tasks/quick-add.md): you type it the way you'd say it (`aperture,
// fix login bug due fri 30m`) and Sonnet reads the structure out of it — review first (the maintainer,
// 2026-11-17): the first Enter / Send shows the parse (Send outlined), the button fills when it lands, and the
// second press saves exactly that. ✨ (on by default, one-shot off) skips the model for the next save, and
// ⌘Enter saves now — the shown parse, or the line as typed. A failed parse keeps the text and says why: Send
// parses again, or "Save as typed" — never silently, never lost.
// A line with ' | ' skips the model: it takes one line of the bulk grammar (`memo | ~30 #Admin`), and a red
// error refuses the submit and keeps the text (docs/areas/tasks/bulk-add.md).
// Once you've typed `#`, `~`, `@` or `due:` there, chips offer completions; a tap (or Tab) types the literal
// token, so the grammar is unchanged — and nothing appears until you start a token, so it never asks.
//
// The field is a growing textarea, not an input, and the mode toggle sits on its own row: on a
// phone a segmented [Log|Task|Idea] plus a single-line input left ~22 characters of a sentence
// visible, so you could never read back the thought you were mid-way through writing.
// `trailing` sits at the right of the mode row — AppShell docks the idle Focus control there.
// `hidden` (a route that drops the bar, lib/routeHandle.ts) hides it without unmounting, so a draft —
// or text a failed save restores — is still there when you come back.
export function CaptureBar({
  trailing,
  hidden = false,
}: {
  trailing?: ReactNode;
  hidden?: boolean;
}) {
  const { data: settings } = useSettings();
  const dayStartHour = settings?.dayStartHour ?? 4;
  const today = todayKey(dayStartHour);
  const [mode, setMode] = useState<CaptureMode>('log');
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  // Set by an accepted suggestion; applied after the new value renders (see the layout effect). The
  // nonce, not `text`, triggers it — an accept that changes nothing must still place the caret.
  const pendingCaret = useRef<number | null>(null);
  const [placeNonce, setPlaceNonce] = useState(0);
  // One-shot: "→ today" applies to the next task only, then resets — so it can never silently keep
  // filling today's plan after the moment you meant it for.
  const [toToday, setToToday] = useState(false);
  // One-shot too: "private" applies to the next log entry only (docs/areas/log). Sticky, it would quietly
  // keep hiding entries from Claude long after the one you meant.
  const [privateNext, setPrivateNext] = useState(false);
  // One-shot as well, the other way round: ✨ (read with AI) is on for every task, and turning it off lets the
  // next save skip the model — it's on again after, so the parse can't stay off unnoticed.
  const [aiNext, setAiNext] = useState(true);
  // The "Make private?" nudge, per draft: × dismisses it, and a sensitive line's first Enter is held once
  // (the nudge says so) — the second saves it as typed. It never marks anything private on its own.
  const [nudge, setNudge] = useState({ dismissed: false, held: false });
  // `at` is a nonce: two captures in a row in the same mode would otherwise set an identical value,
  // React would bail out of the re-render, the dismiss effect would never re-run, and the second
  // confirmation would vanish after the FIRST timer's remainder.
  const [receipt, setReceipt] = useState<{
    mode: CaptureMode;
    dest?: CaptureDest;
    failed?: boolean;
    blocked?: Blocked;
    parked?: boolean; // a failed save whose text went to the parked list (the field was busy)
    restored?: boolean; // an unsent capture from a closed session was parked
    parsed?: string; // a quick add's readback (savedSummary)
    isPrivate?: boolean; // a log saved private
    nudged?: boolean; // a sensitive log's first Enter, held by the nudge
    at: number;
  } | null>(null);
  // A 'held' refusal's promise — the next press saves — kept apart from the receipt, which a late one (an
  // earlier capture's save, a parked failure, the outbox sweep) may replace at any moment. `text` is the
  // field's value when it refused: while the field still holds exactly that, the warning stays shown and
  // the next press saves. Editing the text, Put back or a mode change drops it.
  const [heldAck, setHeldAck] = useState<{ text: string; warning: string } | null>(null);
  const changeMode = (m: CaptureMode | ((m: CaptureMode) => CaptureMode)) => {
    setMode(m);
    setHeldAck(null);
    setPrivateNext(false);
    setNudge({ dismissed: false, held: false });
    clearPreview(); // a preview belongs to the mode it was made in
  };
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
  // What the field holds right now, for a save that fails seconds later: its restore must not overwrite a
  // newer capture typed meanwhile.
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
  // The same rule for an @place line: wait for the roster, never save it off its list unseen.
  const { data: placeData, isError: placesFailed } = usePlaces();
  const placesLoaded = placeData !== undefined;
  const placeRefs = useMemo(
    () => (placeData ?? []).map((p) => ({ slug: p.slug, name: p.name })),
    [placeData],
  );

  // Trailing whitespace holding a newline is dropped (invisible, so a "single line" error would
  // confuse); a bare trailing space is kept so "milk | " reads as an empty token region. A half-typed
  // #label / @place is completed to its one match, or refused while it has several (completeTokens).
  const line = useMemo(
    () =>
      mode === 'task' && hasTaskTokens(text)
        ? completeTokens(
            parseTaskLine(text.replace(/\s*\n\s*$/, ''), catRefs, placeRefs),
            catRefs,
            placeRefs,
          )
        : null,
    [mode, text, catRefs, placeRefs],
  );
  const token = useMemo(
    () => (mode === 'task' && hasTaskTokens(text) ? tokenAtCaret(text, caret) : null),
    [mode, text, caret],
  );
  // Before categories load catRefs is empty, so `#` offers nothing — the preview row already says
  // "Loading categories…" for that line.
  const suggestions = useMemo(
    () => (token ? suggestionsFor(token, { cats: catRefs, places: placeRefs, today }) : []),
    [token, catRefs, placeRefs, today],
  );

  // Before categories load, a real #label would parse as unknown and land uncategorised — wait instead.
  const awaitingCategories = line !== null && line.categoryLabel !== null && !categoriesLoaded;
  const awaitingPlaces = line !== null && line.placeSlug !== null && !placesLoaded;
  const awaiting = awaitingCategories || awaitingPlaces;
  const invalid = line !== null && line.errors.length > 0;
  const block: Blocked | null = invalid
    ? 'invalid'
    : awaitingCategories
      ? categoriesFailed
        ? 'categories-failed'
        : 'categories'
      : awaitingPlaces
        ? placesFailed
          ? 'places-failed'
          : 'places'
        : null;
  // The one reason a screen reader hears on a refused submit — the preview row isn't announced.
  const blockReason = invalid
    ? line.errors[0]!
    : awaitingCategories
      ? categoriesFailed
        ? 'Couldn’t load categories — remove the #label to save without one'
        : 'Loading categories…'
      : placesFailed
        ? 'Couldn’t load places — remove the @place to save without one'
        : 'Loading places…';
  const awaitingFailed = awaitingCategories ? categoriesFailed : placesFailed;
  // A Review's preview — only while the field still holds exactly the text it was parsed from.
  // A parse resolves "tmw" against its day, so one made before the 4am rollover is dropped after it.
  const livePreview = (value: string) => {
    const p = quick.previewFor(value);
    return p?.result?.ok && p.result.today !== today ? null : p;
  };
  const preview = mode === 'task' && !line ? livePreview(text.trim()) : null;
  // A refusal notice tracks the live state: once the cause is gone (categories arrived, mode switched,
  // line fixed) it goes too, and its text always names the current cause. A 'held' one stays while its
  // promise does (heldAck) and the line still warns.
  const acked =
    heldAck !== null &&
    heldAck.text === text &&
    !!line?.warnings.includes(heldAck.warning) &&
    !block;
  const nudgeShown = mode === 'log' && !privateNext && !nudge.dismissed && looksSensitive(text);
  const nudgeId = useId();
  const shown =
    receipt?.blocked && !block && !(receipt.blocked === 'held' && acked) ? null : receipt;
  // What you're still typing at the caret doesn't flash a complaint mid-word. It still blocks a save, and
  // shows once one is refused — or once the caret leaves it (or the field). Three cases:
  const typing = focused && !shown?.blocked && !acked;
  const tokenKind = token?.kind ?? null;
  // - the token speaks through its chips: its own refusal (a bare "@", "~" or "due:", a partial that
  //   starts several) — every chip-bearing kind, since each one's parse error carries that kind;
  const typingKind = typing && suggestions.length > 0 ? tokenKind : null;
  // - a #/@ token's gold "no category" / "no place" warning waits too — the next letter may make it a
  //   match;
  const typingWarn =
    typing && (tokenKind === 'category' || tokenKind === 'place') ? tokenKind : null;
  // - "milk | " with the caret right after the separator: the token is the next thing you type.
  const sepAt = text.indexOf(SEP);
  const typingAfterSep =
    typing &&
    sepAt !== -1 &&
    caret >= sepAt + SEP.length &&
    text.slice(sepAt + SEP.length).trim() === '';
  const quietError = (e: string, i: number) =>
    line?.errorKinds[i]?.kind === typingKind || (typingAfterSep && e.startsWith(EMPTY_TOKENS));
  const quietWarning = (w: string) =>
    (typingWarn === 'place' && w.startsWith(UNKNOWN_PLACE)) ||
    (typingWarn === 'category' && w.startsWith(UNKNOWN_CATEGORY));
  useEffect(() => {
    if (!block) setReceipt((r) => (r?.blocked && !(r.blocked === 'held' && acked) ? null : r));
  }, [block, acked]);

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

  // "/" focuses capture from anywhere, unless you're already typing or a page claimed it first (the
  // Finances All tab's search, in the capture phase).
  useEffect(() => {
    if (hidden) return; // don't swallow "/" to focus a field you can't see
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== '/' || e.defaultPrevented) return;
      if (isTypingTarget(document.activeElement)) return;
      e.preventDefault();
      inputRef.current?.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hidden]);

  // The receipt is a transient acknowledgement, not state anyone can act on — clear it on a timer,
  // and on unmount so a route change mid-fade can't set state on a dead component. A failure notice
  // stays put: it's telling you your text was restored and needs another try.
  useEffect(() => {
    if (!receipt || receipt.failed || receipt.blocked || receipt.restored) return;
    const ms = receipt.parsed ? PARSED_RECEIPT_MS : RECEIPT_MS;
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
    // A warning still held back at the caret would save unseen — the receipt says only where it went. So
    // the first press refuses and shows it (typing ends with a refusal); the next one saves without it.
    const held = acked ? undefined : line?.warnings.find(quietWarning);
    if (held) {
      setHeldAck({ text, warning: held });
      setReceipt({ mode: submitted, blocked: 'held', at: Date.now() });
      return;
    }
    if (nudgeShown && !nudge.held) {
      setNudge((n) => ({ ...n, held: true }));
      setReceipt({ mode: submitted, nudged: true, at: Date.now() });
      return;
    }
    setHeldAck(null);
    const nudgeAtSubmit = nudge;
    const aiAtSubmit = aiNext;
    setNudge({ dismissed: false, held: false });
    const goesToday = submitted === 'task' && toToday;
    const goesPrivate = submitted === 'log' && privateNext;
    setPrivateNext(false);
    // The field clears optimistically so capture stays instant — which means a failed write would
    // otherwise destroy the thought outright: the creates roll back, the entry disappears from the
    // list, and the text is already gone from the field. Capture is the #1 mechanic and the whole
    // premise is that it's safe to hand it something, so a failure puts the text back and says so.
    // Promises (mutateAsync), not mutate's per-call callbacks: those fire only for the LATEST mutate, so
    // a failed capture followed by a quick second one would never restore — and quick add's parse puts
    // a second or more between Enter and the write, which made that window wide open.
    // Back into the field only while it's empty: a newer capture typed meanwhile is never overwritten —
    // the failed one is parked below instead, in full, and the receipt says where it went.
    const reviewedPreview = submitted === 'task' && !line ? livePreview(value) : null;
    const restore = () => {
      if (textRef.current.trim()) {
        park({
          text: value,
          mode: submitted,
          toToday: goesToday,
          isPrivate: goesPrivate,
          why: 'failed',
        });
        setReceipt({ mode: submitted, failed: true, parked: true, at: Date.now() });
        return;
      }
      textRef.current = value; // a second failure in the same tick must see the field as taken
      setText(value);
      setCaret(value.length);
      changeMode(submitted);
      setToToday(goesToday); // the retry goes where the first attempt was headed, and nowhere else
      setPrivateNext(goesPrivate); // and stays as private as it was
      // The nudge already had its say on this draft: the retry is one Enter, and a × stays dismissed.
      setNudge({ dismissed: nudgeAtSubmit.dismissed, held: true });
      setReceipt({ mode: submitted, failed: true, at: Date.now() });
      setAiNext(aiAtSubmit); // ✨ as it was at the save: an as-typed save retries as typed (a parked one doesn't keep it)
      // The reviewed parse comes back with it, tapped chip and all: the retry saves what was reviewed, unparsed.
      if (reviewedPreview?.result?.ok) quick.reinstate(reviewedPreview);
    };
    const done = () => setReceipt({ mode: submitted, at: Date.now() });
    if (submitted === 'task' && line) saveTask(toCreateInput(line), goesToday, restore, null, {});
    else if (submitted === 'task') {
      // Quick add saves exactly the shown parse — or, with ✨ off, after a failed parse, or on ⌘Enter, the line
      // as typed. It never parses here: that was the first press (send). The field clears before the create
      // settles, so until it does the capture is also in the outbox: closing the app can't lose it.
      const r = reviewedPreview?.result?.ok ? reviewedPreview.result : null;
      const sent = outboxAdd({ text: value, mode: 'task', toToday: goesToday, at: Date.now() });
      ownSent.current.add(sent);
      const settled = () => {
        outboxRemove(sent);
        ownSent.current.delete(sent);
      };
      saveTask(
        r ? r.input : { title: value },
        goesToday,
        restore,
        settled,
        r
          ? {
              parsed: savedSummary(
                r.input,
                r.categoryLabel,
                r.today,
                r.dropped,
                dayStartHour,
                r.placeName,
              ),
            }
          : {},
      );
    } else if (submitted === 'log')
      void createLog
        .mutateAsync({ text: value, isPrivate: goesPrivate })
        .then(
          () => setReceipt({ mode: submitted, isPrivate: goesPrivate, at: Date.now() }),
          restore,
        );
    else void createIdea.mutateAsync(value).then(done, restore);
    quick.clear();
    setText('');
    setCaret(0);
    setToToday(false);
    setAiNext(true);
    // Stay in the current mode after a submit — if you're logging tasks or ideas, the next capture is
    // almost always the same kind, so snapping back to Log every time just made you re-pick it.
    inputRef.current?.focus();
  }

  function saveTask(
    input: CreateTaskInput,
    goesToday: boolean,
    restore: () => void,
    settled: (() => void) | null,
    note: { parsed?: string },
  ) {
    // An errand's receipt names its store: the roster's name, else the slug as typed (never "backlog").
    const placeName = (t: Task) =>
      t.place ? (placeData?.find((p) => p.slug === t.place)?.name ?? `@${t.place}`) : undefined;
    const saved = goesToday
      ? createToday(input).then(
          (r) =>
            setReceipt({
              mode: 'task',
              dest: {
                today: true,
                planned: r.planned,
                ...(r.timed && r.task.dueDay
                  ? { timedOn: fmtDueDay(r.task.dueDay, today, r.task.dueTime, { dayStartHour }) }
                  : {}),
                placeName: placeName(r.task),
              },
              ...note,
              at: Date.now(),
            }),
          restore,
        )
      : createTask.mutateAsync(input).then(
          // A timed task isn't backlog: its time is its place, so the receipt says when.
          (t) =>
            setReceipt({
              mode: 'task',
              dest: {
                today: false,
                planned: false,
                ...(isTimed(t) && {
                  timedOn: fmtDueDay(t.dueDay!, today, t.dueTime, { dayStartHour }),
                }),
                placeName: placeName(t),
              },
              ...note,
              at: Date.now(),
            }),
          restore,
        );
    if (settled) void saved.finally(settled);
  }

  // Put a parked capture back in the field; whatever the field held trades places with it (set aside,
  // not lost).
  function putBack(p: Parked) {
    const current = text.trim();
    setParked((list) => [
      ...list.filter((x) => x.id !== p.id),
      ...(current
        ? [
            {
              id: newCaptureId(Date.now()),
              text,
              mode,
              toToday,
              isPrivate: mode === 'log' && privateNext,
              why: 'set-aside' as const,
            },
          ]
        : []),
    ]);
    textRef.current = p.text;
    setText(p.text);
    setCaret(p.text.length);
    changeMode(p.mode);
    setToToday(p.toToday);
    setPrivateNext(p.mode === 'log' && p.isPrivate === true);
    // A failed save already had the nudge's say, as restore() keeps it: one Enter retries.
    if (p.why === 'failed') setNudge({ dismissed: false, held: true });
    // The field holds other text now: a refusal of what it held goes with it.
    setReceipt((r) => (r?.blocked ? null : r));
    inputRef.current?.focus();
  }

  // Enter / Send. A task line in natural language, with ✨ on, is review first: the first press parses into a
  // preview; a press while it shows saves exactly it, and a press on a failed one parses again ("Save as typed"
  // under it, or ⌘Enter, saves it raw). A press while the parse runs waits for it. Anything else — another mode,
  // a ' | ' line (no model step: its grammar preview already shows), ✨ off — saves.
  function send() {
    const value = text.trim();
    if (!value) return;
    if (mode !== 'task' || line || !aiNext) return submit();
    const p = livePreview(value);
    if (p?.result?.ok) submit();
    else if (!p || p.result) quick.review(value); // null result = a parse already running: wait for it
    inputRef.current?.focus();
  }
  const reviewing = mode === 'task' && !line && aiNext;
  const sendLabel = !reviewing
    ? `Save ${mode}`
    : !preview?.result
      ? 'Review before saving'
      : preview.result.ok
        ? 'Save reviewed task'
        : 'Retry parse';
  // The button fills once there's something to save: a parse that landed, or anything that saves on its press.
  const sendReady = reviewing ? !!preview?.result?.ok : !!text.trim() && !invalid && !awaiting;

  function update(value: string) {
    setText(value);
    setHeldAck(null);
    if (!value.trim()) setNudge({ dismissed: false, held: false }); // a new draft gets its own nudge
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
    // An IME's committing Enter must never submit the half-composed line. WebKit has fired that
    // keydown after compositionend with isComposing false for years (bug 165004, fixed 2026-04,
    // reverted 2026-10); keyCode 229 is the signal that holds either way. Enter falls through
    // without preventDefault so the IME commits.
    const composing = e.nativeEvent.isComposing || e.keyCode === 229;
    // Shift+Enter is a newline — the log takes multi-line entries now that the field can show them.
    // ⌘/Ctrl+Enter saves now: a task's shown parse, or its line as typed — never a parse first.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      if (composing) return;
      e.preventDefault();
      submit();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      if (composing) return;
      e.preventDefault();
      send();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      // Tab takes the first chip while chips show; Shift+Tab always switches mode (the escape hatch).
      if (composing) return; // don't replace text an IME is still composing
      if (!e.shiftKey && suggestions.length > 0) accept(suggestions[0]!);
      else changeMode((m) => cycleMode(m, e.shiftKey ? -1 : 1));
    } else if (e.key === 'Escape') {
      inputRef.current?.blur();
    }
  }

  return (
    <div
      hidden={hidden}
      className="pointer-events-auto rounded-2xl border border-line bg-panel-2 p-2 shadow-[var(--shadow-dock)]"
    >
      <div className="flex items-center justify-between gap-2 pb-1.5">
        {/* No control in the bar takes focus from the field: a blur would reveal a held-back warning,
            grow the bar and move the button out from under the tap (the first tap would be lost). */}
        <div className="flex shrink-0 items-center gap-1.5" onMouseDown={(e) => e.preventDefault()}>
          <ModeToggle<CaptureMode>
            size="sm"
            options={CAPTURE_MODES.map((m) => ({
              value: m,
              label: m[0]!.toUpperCase() + m.slice(1),
            }))}
            value={mode}
            onChange={changeMode}
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
          {mode === 'log' && (
            <button
              type="button"
              aria-pressed={privateNext}
              title="Keep this entry out of Claude's reach — the next log entry only"
              onClick={() => setPrivateNext((v) => !v)}
              className={cx(
                'flex items-center gap-1 whitespace-nowrap rounded-lg border px-2 py-1 text-xs transition',
                privateNext
                  ? 'border-teal bg-teal-soft text-ink'
                  : 'border-line text-ink-muted hover:text-ink',
              )}
            >
              <LockIcon size={12} />
              private
            </button>
          )}
        </div>
        {/* Live region wraps the receipt ONLY. With the hint inside it, the hint re-entered the
            region when the receipt expired and every capture ended with the keyboard hint being
            read aloud 1.8s later. */}
        <div className="flex min-w-0 items-center gap-1">
          <div aria-live="polite" role="status" className="min-w-0">
            {shown && (
              <Receipt
                key={shown.at}
                receipt={shown}
                reason={
                  shown.blocked === 'held' && acked && heldAck
                    ? `${heldAck.warning} — ${HELD_AGAIN}`
                    : blockReason
                }
              />
            )}
          </div>
          {!shown && (
            <Hint
              suggesting={suggestions.length > 0}
              task={mode === 'task'}
              reviewing={reviewing}
            />
          )}
          {/* On a phone the row can't hold both, so it gives way to a receipt there (a failure
              notice stays until the next capture). Desktop has room for both. */}
          <div
            className={cx('shrink-0', shown && 'max-sm:hidden')}
            onMouseDown={(e) => e.preventDefault()}
          >
            {trailing}
          </div>
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
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          // Relabels the phone's return key (iOS 13.4+); a label only — Enter sends in every mode (a task's
          // first one reads it) — and static, since iOS ignores runtime changes to it.
          enterKeyHint="send"
          placeholder={placeholderFor(mode, toToday)}
          aria-label={`Capture ${mode}`}
          aria-describedby={line ? previewId : preview ? parseId : nudgeShown ? nudgeId : undefined}
          aria-invalid={invalid || undefined}
          className={cx(
            'min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-ink outline-none',
            'placeholder:text-ink-muted',
          )}
        />
        {/* No ✨ on a ' | ' line: it has no model step. On by default; off saves the next task as typed. */}
        {mode === 'task' && !line && (
          <button
            type="button"
            // Keep focus (and the phone keyboard) in the field, like the suggestion chips do.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              // Off means as typed: a parse already showing goes, or the next press would save it.
              if (aiNext) clearPreview();
              setAiNext(!aiNext);
            }}
            aria-pressed={aiNext}
            aria-label="Read with AI"
            title={
              aiNext
                ? 'Read with AI: Send shows the parse first — tap to save the next task as typed'
                : 'Off: the next task saves as typed — tap to read it with AI'
            }
            className={cx(
              'mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition',
              aiNext
                ? 'border-teal bg-teal-soft text-teal'
                : 'border-line text-ink-subtle hover:text-ink',
            )}
          >
            <SparkleIcon size={16} />
          </button>
        )}
        <button
          type="button"
          // Keep focus in the field: a blur here would show a held-back warning mid-press, the bar would
          // grow under the finger, and the click would land elsewhere. It's still a plain button for keys.
          // mousedown, not pointerdown: cancelling pointerdown drops the click of a WebKit touch tap.
          onMouseDown={(e) => e.preventDefault()}
          onClick={send}
          disabled={!text.trim()}
          // Refused, not disabled: a tap must still say why (a dead button on iPhone is silent).
          aria-disabled={invalid || awaiting || undefined}
          aria-label={sendLabel}
          title={reviewing ? `${sendLabel} (⌘Enter saves now)` : undefined}
          className={cx(
            'mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition',
            sendReady
              ? 'border-teal bg-teal text-surface hover:opacity-90'
              : reviewing && text.trim()
                ? 'border-teal text-teal hover:bg-teal-soft' // outlined until the parse lands: commit, then push
                : 'border-line text-ink-subtle',
          )}
        >
          <SendIcon size={16} />
        </button>
      </div>
      <TokenSuggestions items={suggestions} onPick={accept} />
      {/* Live, unlike the grammar row: it changes on a Review press, so it speaks once per parse (busy
          while parsing, so "Reading it…" isn't read first), and when the chip's tap fills the category.
          Children don't shrink: past the cap it scrolls, rather than squeezing the notes away. */}
      {preview && (
        <div
          id={parseId}
          aria-live="polite"
          aria-busy={preview.result === null || undefined}
          className="flex max-h-24 flex-col gap-0.5 overflow-auto px-2 pt-1 *:shrink-0"
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
                {(preview.result.categoryLabel === null || preview.tookSuggestion) && (
                  <PreviewCategory
                    title={preview.result.input.title}
                    notes={preview.result.input.notes}
                    taken={preview.tookSuggestion ? preview.result.categoryLabel : null}
                    onTake={(id, label, byKeyboard) => {
                      quick.takeCategory(preview.text, id, label);
                      // The chip goes: Enter or Space keeps focus in the field, not on <body>.
                      if (byKeyboard) inputRef.current?.focus();
                    }}
                  />
                )}
                <TaskTokenChips
                  line={previewLine(
                    preview.tookSuggestion
                      ? { ...preview.result, categoryLabel: null } // shown in the chip's slot
                      : preview.result,
                  )}
                  today={preview.result.today}
                  dayStartHour={dayStartHour}
                />
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
            <div className="flex flex-wrap items-baseline gap-x-2">
              <Text size="xs" tone="gold" className="min-w-0 break-words">
                Couldn’t parse ({parseFailText(preview.result)}) — Send tries again
              </Text>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={submit}
                className="min-h-11 shrink-0 rounded-md border border-teal px-3 text-xs text-teal hover:bg-teal-soft"
              >
                Save as typed
              </button>
            </div>
          )}
        </div>
      )}
      {/* What a quick add saved, readable on a phone (the receipt above truncates), so it wraps. Hidden
          from screen readers: the receipt's live region already announced the same summary. It gives
          way as soon as you start the next capture or switch modes. */}
      {!text && mode === 'task' && shown?.parsed && (
        <Text size="xs" tone="teal" aria-hidden className="block break-words px-2 pt-1">
          {shown.parsed}
        </Text>
      )}
      {/* Not a live region either: the field points here, and a held Enter announces through the receipt. */}
      {nudgeShown && (
        <div className="flex flex-wrap items-center gap-1 pl-2 pt-1">
          <LockIcon size={12} className="shrink-0 text-gold" />
          <Text id={nudgeId} size="xs" tone="gold" className="min-w-0 flex-1 break-words py-1.5">
            {nudge.held ? NUDGE_HELD : NUDGE_ASK}
          </Text>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setPrivateNext(true)}
            className="min-h-8 shrink-0 rounded-md px-2 text-xs text-teal hover:underline"
          >
            Make private
          </button>
          <button
            type="button"
            aria-label="Not this one"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setNudge((n) => ({ ...n, dismissed: true }))}
            className="min-h-8 min-w-8 shrink-0 rounded-md text-sm text-ink-muted hover:text-ink"
          >
            ×
          </button>
        </div>
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
            onMouseDown={(e) => e.preventDefault()}
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
            onMouseDown={(e) => e.preventDefault()}
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
          {line.errors.map((e, i) =>
            quietError(e, i) ? null : (
              <Text key={`e${i}`} size="xs" tone="danger" className="break-words">
                {e}
              </Text>
            ),
          )}
          {/* While categories (or places) load, the "no category" warning would be a lie — say what's
              happening. */}
          {awaiting ? (
            <Text size="xs" tone={awaitingFailed ? 'danger' : 'muted'}>
              {blockReason}
            </Text>
          ) : (
            line.warnings.map((w, i) =>
              quietWarning(w) ? null : (
                <Text key={`w${i}`} size="xs" tone="gold" className="break-words">
                  {w}
                </Text>
              ),
            )
          )}
          {acked && (
            <Text size="xs" tone="gold" className="break-words">
              {HELD_AGAIN}.
            </Text>
          )}
        </div>
      )}
    </div>
  );
}

// Desktop-only keyboard affordance — on a phone there's no Tab key and the hint is just clutter,
// which is also why the Send button is never hidden.
function Hint({
  suggesting,
  task,
  reviewing,
}: {
  suggesting: boolean;
  task: boolean;
  reviewing: boolean;
}) {
  return (
    <Text size="xs" tone="muted" className="hidden pr-1 sm:block">
      {suggesting
        ? task && reviewing
          ? 'Tab accepts · Enter reads it, again saves'
          : 'Tab accepts · Enter saves · Shift+Tab switches'
        : task
          ? reviewing
            ? 'Enter reads it, again saves · ⌘Enter saves now'
            : 'Enter saves · Tab switches'
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
    dest?: CaptureDest;
    failed?: boolean;
    blocked?: Blocked;
    parked?: boolean;
    restored?: boolean;
    parsed?: string;
    isPrivate?: boolean;
    nudged?: boolean;
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
  if (receipt.nudged)
    return (
      <Text size="xs" tone="gold" className="block truncate pr-1">
        Not saved yet<span className="sr-only">: {NUDGE_HELD}</span>
      </Text>
    );
  const r = receiptFor(receipt.mode, receipt.dest, { isPrivate: receipt.isPrivate });
  // On a phone the row leaves the receipt ~115px, so a long one ("due tomorrow 4pm, by its time",
  // "backlog (couldn’t plan it)") takes a second line there, never losing the part that says where.
  const wrap = 'block truncate pr-1 max-sm:line-clamp-2 max-sm:whitespace-normal';
  return (
    <Text size="xs" tone="teal" className={wrap}>
      {r.text} → {r.label}
      {receipt.parsed && <span className="sr-only">: {receipt.parsed}</span>}
    </Text>
  );
}
