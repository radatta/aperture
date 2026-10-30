import { useSyncExternalStore } from 'react';
import type { RecordFluxSetInput } from '@aperture/shared';
import type { FluxSetDraft } from './useFluxEngine';

// Flux's crash- and offline-safety, per device (docs/areas/flux, D49). A finished set is written here
// BEFORE it's sent, and removed only once the server has it — so a dropped connection or a closed app
// never loses one. Unlike capture's outbox nothing needs the user to put it back: the payload is complete
// and the save is idempotent on its id, so entries are just retried; a failure stays visible
// (UnsavedSetsStrip) until it's saved or discarded. Storage can be absent or throw (private mode, a full
// quota), so every access is guarded, and a refused write keeps the list in memory instead: the set is
// still retried and still shown — it just won't survive closing the app, and the strip says so.

export const FLUX_OUTBOX_KEY = 'aperture.flux.outbox';

export interface FluxOutboxEntry {
  readonly input: RecordFluxSetInput;
  readonly at: number; // epoch ms first queued
  readonly error: string | null; // the last failed attempt's message
  readonly refused?: boolean; // the set itself is invalid (fluxSetError) — retrying can't save it
}

const listeners = new Set<() => void>();
// The list, when storage refused to hold it (this tab only). Takes over every read until a write sticks.
let memory: FluxOutboxEntry[] | null = null;

function storedRaw(): string {
  try {
    return globalThis.localStorage?.getItem(FLUX_OUTBOX_KEY) ?? '';
  } catch {
    return '';
  }
}
function rawRead(): string {
  if (memory) return memory.length ? JSON.stringify(memory) : '';
  return storedRaw();
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
    const ls = globalThis.localStorage;
    if (!ls) throw new Error('no storage');
    // Back from memory: another tab may have queued sets in storage meanwhile — keep them. (One this tab
    // removed while in memory can come back too; resending it is harmless, the save is idempotent.)
    let out = list;
    if (memory) {
      const ids = new Set(list.map((e) => e.input.id));
      out = [...list, ...parse(storedRaw()).filter((e) => !ids.has(e.input.id))];
    }
    if (out.length) ls.setItem(FLUX_OUTBOX_KEY, JSON.stringify(out));
    else ls.removeItem(FLUX_OUTBOX_KEY);
    memory = null;
  } catch {
    memory = [...list];
  }
  listeners.forEach((l) => l());
}

// True while the queued sets live only in this tab's memory (storage refused them).
export const outboxInMemoryOnly = (): boolean => (memory?.length ?? 0) > 0;

export const readOutbox = (): FluxOutboxEntry[] => parse(rawRead());

export function outboxAdd(input: RecordFluxSetInput, at: number): void {
  const list = readOutbox();
  if (list.some((e) => e.input.id === input.id)) return;
  write([...list, { input, at, error: null }]);
}
export const outboxRemove = (id: string): void =>
  write(readOutbox().filter((e) => e.input.id !== id));
export const outboxMarkError = (id: string, error: string, refused = false): void =>
  write(readOutbox().map((e) => (e.input.id === id ? { ...e, error, refused } : e)));

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
  // Where the list lives is part of what the strip says, so a move between memory and storage with the
  // same contents is still a change.
  const key = `${memory ? 'm' : 's'}:${raw}`;
  if (key !== cache.raw) cache = { raw: key, list: parse(raw) };
  return cache.list;
}
export const useOutboxEntries = (): FluxOutboxEntry[] => useSyncExternalStore(subscribe, snapshot);

// Tests share one module graph (app/src/test/setup.ts).
export function resetFluxOutboxStore(): void {
  memory = null;
  cache = { raw: '', list: [] };
}
