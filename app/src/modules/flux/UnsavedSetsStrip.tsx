import { useEffect, useReducer, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Text } from '../../components/Text';
import { useDisclosure } from '../../lib/useDisclosure';
import { outboxInMemoryOnly, readOutbox } from './fluxOutbox';
import { focusablesAfter, moveFocus } from './focus';
import { isSending, useFluxOutbox } from './useFluxOutbox';

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
  const now = Date.now();
  const shown = entries.filter(
    (e) => e.error !== null || !isSending(e.input.id) || now - e.at >= GRACE_MS,
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
          <Text size="xs">Discard {sets}? They won&apos;t be saved anywhere.</Text>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
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
          {shown.some((e) => !e.refused) && (
            <Button
              size="sm"
              disabled={retrying}
              onClick={async () => {
                const to = next();
                const from = stripRef.current;
                setRetrying(true);
                await flush();
                setRetrying(false);
                if (readOutbox().length === 0) moveFocus(to, from); // all saved: the buttons left
              }}
            >
              {retrying ? 'Retrying…' : 'Retry'}
            </Button>
          )}
          <Button
            ref={triggerRef}
            variant="quiet"
            size="sm"
            disabled={retrying} // a set discarded mid-send would still save
            onClick={onOpen}
          >
            Discard
          </Button>
        </div>
      )}
    </div>
  );
}
