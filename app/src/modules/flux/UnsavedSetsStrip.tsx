import { useState } from 'react';
import { Button } from '../../components/Button';
import { Text } from '../../components/Text';
import { useFluxOutbox } from './useFluxOutbox';

// Sets still waiting in the outbox (D49) — never a quiet failure. Retry resends them all; Discard is the
// only other way out, and it asks first: a discarded set is gone.
export function UnsavedSetsStrip() {
  const { entries, flush, discard } = useFluxOutbox();
  const [confirming, setConfirming] = useState(false);
  const [retrying, setRetrying] = useState(false);
  if (entries.length === 0) return null;
  const n = entries.length;
  const sets = `${n} ${n === 1 ? 'set' : 'sets'}`;
  const lastError = entries.find((e) => e.error)?.error ?? null;

  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-xl border border-danger/40 bg-surface px-4 py-3"
    >
      <Text as="p" size="sm" weight="medium" tone="danger">
        {sets} not saved yet
      </Text>
      <Text as="p" size="xs" tone="muted">
        {lastError
          ? `Kept on this device and retried when you're back online. Last try: ${lastError}`
          : 'Kept on this device until it saves.'}
      </Text>
      {confirming ? (
        <div
          role="alertdialog"
          aria-label={`Discard ${sets}?`}
          className="flex flex-wrap items-center gap-2"
        >
          <Text size="xs">Discard {sets}? They won&apos;t be saved anywhere.</Text>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              entries.forEach((e) => discard(e.input.id));
              setConfirming(false);
            }}
          >
            Discard
          </Button>
          <Button variant="quiet" size="sm" onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={retrying}
            onClick={async () => {
              setRetrying(true);
              await flush();
              setRetrying(false);
            }}
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </Button>
          <Button variant="quiet" size="sm" onClick={() => setConfirming(true)}>
            Discard
          </Button>
        </div>
      )}
    </div>
  );
}
