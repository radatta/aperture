import { useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { RecordFluxSetInput } from '@aperture/shared';
import { useApi } from '../../data/api-context';
import { qk } from '../../data/queryKeys';
import {
  outboxAdd,
  outboxMarkError,
  outboxRemove,
  readOutbox,
  useOutboxEntries,
} from './fluxOutbox';

// Sets being sent right now, across every mounted copy of the hook — a flush and a save of the same set
// (or two triggers at once) send it once.
const inFlight = new Set<string>();

// The Flux outbox's actions (D49): save queues a set then sends it; flush resends every queued set; a
// failure keeps the entry and records why. Every send is idempotent on the set's id.
export function useFluxOutbox() {
  const api = useApi();
  const qc = useQueryClient();
  const entries = useOutboxEntries();

  const send = useCallback(
    async (input: RecordFluxSetInput): Promise<boolean> => {
      if (inFlight.has(input.id)) return false;
      inFlight.add(input.id);
      try {
        await api.recordFluxSet(input);
        outboxRemove(input.id);
        void qc.invalidateQueries({ queryKey: qk.fluxSetsAll() });
        return true;
      } catch (err) {
        outboxMarkError(input.id, err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        inFlight.delete(input.id);
      }
    },
    [api, qc],
  );

  const flush = useCallback(async () => {
    for (const e of readOutbox()) await send(e.input);
  }, [send]);

  // A save that gets through means the connection is back — send whatever was waiting too.
  const save = useCallback(
    async (input: RecordFluxSetInput) => {
      outboxAdd(input, Date.now());
      if ((await send(input)) && readOutbox().length) await flush();
    },
    [send, flush],
  );

  return { entries, save, flush, discard: outboxRemove };
}

// The Flux layout's retry: whatever a closed app or a dropped connection left queued goes out on the
// first visit, and again whenever the device comes back online.
export function useFluxOutboxFlush(): void {
  const { flush } = useFluxOutbox();
  useEffect(() => {
    void flush();
    const onOnline = () => void flush();
    globalThis.addEventListener?.('online', onOnline);
    return () => globalThis.removeEventListener?.('online', onOnline);
  }, [flush]);
}
