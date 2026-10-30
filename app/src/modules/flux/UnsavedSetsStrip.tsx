import { useEffect, useReducer, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Text } from '../../components/Text';
import { useDisclosure } from '../../lib/useDisclosure';
import { outboxInMemoryOnly } from './fluxOutbox';
import { focusableAfter, moveFocus } from './focus';
import { isSending, useFluxOutbox } from './useFluxOutbox';

// A first send gets this long before its set counts as "not saved" — every save goes through the outbox,
// and a normal one shouldn't flash a red strip (or be read out) on its way to the server.
const GRACE_MS = 8_000;

// Sets still waiting in the outbox (D49) — never a quiet failure. Retry resends them all; Discard is the
// only other way out, and it asks first: a discarded set is gone. The question lands focus on Keep, so
// a second Enter can't discard unread; Keep or Escape hands focus back to Discard (useDisclosure). When
// the strip leaves (saved, discarded), focus moves on to whatever follows it.
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
  const settling = entries.length > shown.length;
  // A send still inside its grace: look again once it's up (a reply re-renders sooner).
  useEffect(() => {
    if (!settling) return;
    const t = setTimeout(tick, GRACE_MS);
    return () => clearTimeout(t);
  }, [settling, entries]);

  if (shown.length === 0) return null;
  const n = shown.length;
  const sets = `${n} ${n === 1 ? 'set' : 'sets'}`;
  const refused = shown.find((e) => e.refused)?.error ?? null;
  const lastError = shown.find((e) => e.error)?.error ?? null;
  const lastTry = lastError ? ` Last try: ${lastError}` : '';
  const detail = refused
    ? `Can’t be saved: ${refused}`
    : outboxInMemoryOnly()
      ? `This device can’t store ${n === 1 ? 'it' : 'them'} — keep Flux open until ${n === 1 ? 'it saves' : 'they save'}.${lastTry}`
      : lastError
        ? `Kept on this device and retried when you’re back online.${lastTry}`
        : `Kept on this device until ${n === 1 ? 'it saves' : 'they save'}.`;
  const next = () => (stripRef.current ? focusableAfter(stripRef.current) : null);

  return (
    <div
      ref={stripRef}
      className="flex flex-col gap-2 rounded-xl border border-danger/40 bg-surface px-4 py-3"
    >
      <div role="status" className="flex flex-col gap-2">
        <Text as="p" size="sm" weight="medium" tone="danger">
          {sets} not saved yet
        </Text>
        <Text as="p" size="xs" tone="muted">
          {detail}
        </Text>
      </div>
      {confirming ? (
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
                moveFocus(to);
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
                setRetrying(true);
                await flush();
                setRetrying(false);
                if (!stripRef.current?.isConnected) moveFocus(to);
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
