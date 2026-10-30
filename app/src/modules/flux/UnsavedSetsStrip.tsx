import { useEffect, useReducer, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Text } from '../../components/Text';
import { useDisclosure } from '../../lib/useDisclosure';
import { outboxInMemoryOnly } from './fluxOutbox';
import { focusablesAfter, moveFocus } from './focus';
import { useFluxOutbox, useSending } from './useFluxOutbox';

// A first send gets this long before its set counts as "not saved" — every save goes through the outbox,
// and a normal one shouldn't flash a red strip (or be read out) on its way to the server.
const GRACE_MS = 8_000;

// Sets still waiting in the outbox (D49) — never a quiet failure. Retry resends them all; Discard is the
// only other way out, and it asks first: a discarded set is gone. The question lands focus on Keep, so
// a second Enter can't discard unread; Keep or Escape hands focus back to Discard (useDisclosure). When
// the strip leaves (saved, discarded), focus moves on to whatever follows it. The status region is always
// mounted (empty when nothing waits), so a screen reader hears the strip arrive.
export function UnsavedSetsStrip() {
  const { entries, flush, discard } = useFluxOutbox();
  const { open: confirming, triggerRef, onOpen, onClose } = useDisclosure();
  const [retrying, setRetrying] = useState(false);
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const stripRef = useRef<HTMLDivElement>(null);
  // Was focus inside the strip when it emptied? Removing the focused button fires no blur, so this stays
  // true through that; it goes false only when focus moves somewhere real outside the strip.
  const hadFocus = useRef(false);
  const sending = useSending();
  const now = Date.now();
  const shown = entries.filter(
    (e) => e.error !== null || !sending(e.input.id) || now - e.at >= GRACE_MS,
  );
  // A send still inside its grace: look again when the earliest one's grace is up (re-armed until none
  // are left — a timer can fire early against Date.now()); a reply re-renders sooner.
  const graceLeft = entries
    .filter((e) => !shown.includes(e))
    .map((e) => e.at + GRACE_MS - now)
    .reduce((a, b) => Math.min(a, b), Infinity);
  useEffect(() => {
    if (graceLeft === Infinity) return;
    const t = setTimeout(tick, Math.max(graceLeft, 0));
    return () => clearTimeout(t);
  }, [graceLeft]); // each tick re-renders with a fresh `now`, so a new graceLeft re-arms it

  const n = shown.length;
  // The strip emptied (saved, discarded, or a flush in the background): a question left open would come
  // back with the next failure, already asking; and focus that was in the strip moves on past it.
  const lastN = useRef(n);
  useEffect(() => {
    const was = lastN.current;
    lastN.current = n;
    if (n > 0) return;
    if (confirming) onClose();
    if (was > 0 && hadFocus.current && stripRef.current)
      moveFocus(focusablesAfter(stripRef.current), stripRef.current);
    hadFocus.current = false;
  }, [n, confirming, onClose]);
  // Retry leaves while the strip stays (only refused sets are left to show): Discard is next.
  const showsRetry = shown.some((e) => !e.refused);
  const hadRetry = useRef(showsRetry);
  useEffect(() => {
    const was = hadRetry.current;
    hadRetry.current = showsRetry;
    if (!was || showsRetry || n === 0 || !hadFocus.current || !stripRef.current) return;
    moveFocus([triggerRef.current, ...focusablesAfter(stripRef.current)], stripRef.current);
  }, [showsRetry, n, triggerRef]);
  // A set on its way (a Retry, or a background flush on `online`) can't be discarded: it may still land,
  // against "won't be saved anywhere". aria-disabled, so a focused button keeps focus meanwhile.
  const busy = retrying || shown.some((e) => sending(e.input.id));
  const sets = `${n} ${n === 1 ? 'set' : 'sets'}`;
  const it = n === 1 ? 'it' : 'them';
  const saves = n === 1 ? 'it saves' : 'they save';
  const refused = shown.filter((e) => e.refused);
  const savable = shown.length - refused.length;
  const lastError = shown.find((e) => e.error && !e.refused)?.error ?? null;
  const lastTry = lastError ? ` Last try: ${lastError}` : '';
  // Every line that's true at once: a refused set doesn't hide a storage warning for the rest.
  const lines = [
    refused.length > 0 &&
      `${refused.length === n ? 'Can’t' : `${refused.length} can’t`} be saved: ${refused[0]!.error}`,
    savable > 0 &&
      (outboxInMemoryOnly()
        ? `This device can’t store ${it} — keep Flux open until ${saves}.${lastTry}`
        : lastError
          ? `Kept on this device and retried when you’re back online.${lastTry}`
          : `Kept on this device until ${saves}.`),
  ].filter((l): l is string => typeof l === 'string');
  const next = () => (stripRef.current ? focusablesAfter(stripRef.current) : []);

  return (
    // Empty, the strip is an sr-only shell (out of the layout) holding the live region.
    <div
      ref={stripRef}
      onFocusCapture={() => (hadFocus.current = true)}
      onBlurCapture={(e) => {
        const strip = e.currentTarget;
        const to = e.relatedTarget;
        if (to instanceof Node) {
          if (!strip.contains(to)) hadFocus.current = false;
          return;
        }
        // Nowhere named (a tap on the page in Safari, the window losing focus — or the button being
        // removed): look again once it settles. A removed button is gone from the page, and keeps it.
        const from = e.target;
        setTimeout(() => {
          if (from.isConnected && !strip.contains(document.activeElement)) hadFocus.current = false;
        });
      }}
      className={
        n === 0
          ? 'sr-only'
          : 'flex flex-col gap-2 rounded-xl border border-danger/40 bg-surface px-4 py-3'
      }
    >
      <div role="status" className="flex flex-col gap-2">
        {n > 0 && (
          <>
            <Text as="p" size="sm" weight="medium" tone="danger">
              {sets} not saved yet
            </Text>
            {lines.map((l) => (
              <Text key={l} as="p" size="xs" tone="muted">
                {l}
              </Text>
            ))}
          </>
        )}
      </div>
      {n === 0 ? null : confirming ? (
        <div
          key="confirm"
          role="alertdialog"
          aria-label={`Discard ${sets}?`}
          className="flex flex-wrap items-center gap-2"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            onClose();
          }}
        >
          <Text size="xs">
            {busy
              ? 'Still sending — you can discard once it answers.'
              : shown.some((e) => e.unanswered)
                ? // A timed-out try is still out there; the client can't know if it landed.
                  `Discard ${sets}? A try that timed out may still reach the server — otherwise ${n === 1 ? 'it won’t' : 'they won’t'} be saved anywhere.`
                : `Discard ${sets}? They won’t be saved anywhere.`}
          </Text>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              aria-disabled={busy || undefined}
              onClick={() => {
                if (busy) return;
                const to = next();
                shown.forEach((e) => discard(e.input.id));
                onClose(); // a new failure later starts at Retry, not mid-question
                moveFocus(to, stripRef.current);
              }}
            >
              Discard
            </Button>
            <Button autoFocus variant="quiet" size="sm" onClick={onClose}>
              Keep
            </Button>
          </div>
        </div>
      ) : (
        <div key="actions" className="flex gap-2">
          {showsRetry && (
            <Button
              size="sm"
              aria-disabled={busy || undefined}
              onClick={async () => {
                if (busy) return;
                setRetrying(true);
                await flush();
                setRetrying(false);
              }}
            >
              {busy ? 'Retrying…' : 'Retry'}
            </Button>
          )}
          <Button
            ref={triggerRef}
            variant="quiet"
            size="sm"
            aria-disabled={busy || undefined}
            onClick={() => !busy && onOpen()}
          >
            Discard
          </Button>
        </div>
      )}
    </div>
  );
}
