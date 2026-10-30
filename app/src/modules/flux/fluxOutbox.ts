import { useSyncExternalStore } from 'react';
import type { RecordFluxSetInput } from '@aperture/shared';
import type { FluxSetDraft } from './useFluxEngine';

// Flux's crash- and offline-safety, per device (docs/areas/flux, D49). A finished set is written here
// BEFORE it's sent, and removed only once the server has it — so a dropped connection or a closed app
// never loses one. Unlike capture's outbox nothing needs the user to put it back: the payload is complete
// and the save is idempotent on its id, so entries are just retried; a failure stays visible
// (UnsavedSetsStrip) until it's saved or discarded. Storage can be absent or throw (private mode, cleared
// site data), so every access is guarded — a failure only loses the guard, never the set being sent.

export const FLUX_OUTBOX_KEY = 'aperture.flux.outbox';

export interface FluxOutboxEntry {
  readonly input: RecordFluxSetInput;
  readonly at: number; // epoch ms first queued
  readonly error: string | null; // the last failed attempt's message
}

const listeners = new Set<() => void>();

function rawRead(): string {
  try {
    return globalThis.localStorage?.getItem(FLUX_OUTBOX_KEY) ?? '';
  } catch {
    return '';
  }
}
function parse(raw: string): FluxOutboxEntry[] {
  try {
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list)
      ? (list as FluxOutboxEntry[]).filter((e) => typeof e?.input?.id === 'string')
      : [];
  } catch {
    return [];
  }
}
function write(list: readonly FluxOutboxEntry[]): void {
  try {
    if (list.length) globalThis.localStorage?.setItem(FLUX_OUTBOX_KEY, JSON.stringify(list));
    else globalThis.localStorage?.removeItem(FLUX_OUTBOX_KEY);
  } catch {
    // no storage — the set still goes out; it just isn't guarded against a closed app
  }
  listeners.forEach((l) => l());
}

export const readOutbox = (): FluxOutboxEntry[] => parse(rawRead());

export function outboxAdd(input: RecordFluxSetInput, at: number): void {
  const list = readOutbox();
  if (list.some((e) => e.input.id === input.id)) return;
  write([...list, { input, at, error: null }]);
}
export const outboxRemove = (id: string): void =>
  write(readOutbox().filter((e) => e.input.id !== id));
export const outboxMarkError = (id: string, error: string): void =>
  write(readOutbox().map((e) => (e.input.id === id ? { ...e, error } : e)));

// The set as the server takes it: the stage's draft plus its id, its day and the rep it counted toward.
export function draftToInput(
  draft: FluxSetDraft,
  keys: { id: string; day: string; repTaskId: string | null },
): RecordFluxSetInput {
  return {
    id: keys.id,
    day: keys.day,
    exerciseId: draft.exerciseId,
    kind: draft.kind,
    side: draft.side,
    condition: draft.condition,
    count: draft.count,
    avgPeakDeg: draft.avgPeakDeg ?? null,
    avgErrorDeg: draft.avgErrorDeg ?? null,
    rom: draft.rom,
    calibrated: draft.calibrated,
    delegate: draft.delegate,
    durationSec: draft.durationSec,
    completedAt: draft.completedAt,
    repTaskId: keys.repTaskId,
  };
}

// Live entries for React — other tabs' writes arrive through the storage event.
function subscribe(l: () => void): () => void {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => e.key === FLUX_OUTBOX_KEY && l();
  globalThis.addEventListener?.('storage', onStorage);
  return () => {
    listeners.delete(l);
    globalThis.removeEventListener?.('storage', onStorage);
  };
}
let cache: { raw: string; list: FluxOutboxEntry[] } = { raw: '', list: [] };
function snapshot(): FluxOutboxEntry[] {
  const raw = rawRead();
  if (raw !== cache.raw) cache = { raw, list: parse(raw) };
  return cache.list;
}
export const useOutboxEntries = (): FluxOutboxEntry[] => useSyncExternalStore(subscribe, snapshot);
