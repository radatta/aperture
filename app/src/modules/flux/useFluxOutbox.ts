import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { RecordFluxSetInput } from '@aperture/shared';
import { fluxSetError } from '@aperture/shared/flux';
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
// Observable, because a send starting changes what the strip may offer (Discard waits) even though the
// outbox itself hasn't changed.
const inFlight = new Set<string>();
const sendListeners = new Set<() => void>();
let sendVersion = 0;
function setSending(id: string, on: boolean): void {
  if (on) inFlight.add(id);
  else inFlight.delete(id);
  sendVersion++;
  sendListeners.forEach((l) => l());
}
function subscribeSends(l: () => void): () => void {
  sendListeners.add(l);
  return () => sendListeners.delete(l);
}
// Re-renders the caller whenever a send starts or ends; returns isSending.
export function useSending(): (id: string) => boolean {
  useSyncExternalStore(subscribeSends, () => sendVersion);
  return isSending;
}
// The http client has no timeout, and a send that never answers would hold its id in flight — so Retry,
// `online` and the next save would all skip it. Give up on it after this; a late answer is harmless (the
// save is idempotent, the next send gets the stored row).
const SEND_TIMEOUT_MS = 20_000;
function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('No answer from the server')), SEND_TIMEOUT_MS);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
export const isSending = (id: string): boolean => inFlight.has(id);
export const resetFluxOutboxSends = (): void => inFlight.clear(); // tests (app/src/test/setup.ts)

// The Flux outbox's actions (D49): save queues a set then sends it; flush resends every queued set; a
// failure keeps the entry and records why. Every send is idempotent on the set's id. A set the shared
// validation refuses is marked so — the server would refuse it the same way, so it isn't retried.
export function useFluxOutbox() {
  const api = useApi();
  const qc = useQueryClient();
  const entries = useOutboxEntries();

  // The caller has claimed `input.id` in inFlight; this releases it.
  const deliver = useCallback(
    async (input: RecordFluxSetInput): Promise<boolean> => {
      try {
        const refused = fluxSetError(input);
        if (refused) {
          outboxMarkError(input.id, refused, true);
          return false;
        }
        await withTimeout(api.recordFluxSet(input));
        outboxRemove(input.id);
        void qc.invalidateQueries({ queryKey: qk.fluxSetsAll() });
        return true;
      } catch (err) {
        outboxMarkError(input.id, err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setSending(input.id, false);
      }
    },
    [api, qc],
  );

  const send = useCallback(
    async (input: RecordFluxSetInput): Promise<boolean> => {
      if (inFlight.has(input.id)) return false;
      setSending(input.id, true);
      return deliver(input);
    },
    [deliver],
  );

  const flush = useCallback(async () => {
    for (const e of readOutbox()) if (!e.refused) await send(e.input);
  }, [send]);

  // Claimed before it's queued, so the strip never shows a first send still on its way. A save that gets
  // through means the connection is back — send whatever was waiting too.
  const save = useCallback(
    async (input: RecordFluxSetInput) => {
      if (inFlight.has(input.id)) return;
      setSending(input.id, true);
      outboxAdd(input, Date.now());
      if ((await deliver(input)) && readOutbox().length) await flush();
    },
    [deliver, flush],
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
