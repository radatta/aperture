import type { CaptureMode } from './mode';

// Quick add's Auto clears the field at once, then waits on the parse before the create goes out — so for
// a few seconds the capture exists only in memory, and closing the app (a PWA swipe-away) would lose it
// silently. Each Auto capture is written here on Enter and removed when its create settles; a leftover
// entry on the next launch comes back to the capture bar, marked as possibly saved. Per-device on
// purpose: it guards one device's in-flight window, nothing more. Storage can be absent or throw
// (private mode, cleared site data), so every access is guarded and a failure only loses the guard.

export const CAPTURE_OUTBOX_KEY = 'aperture:captureOutbox';
// Older than this, an entry can't still be in flight in another open tab (parse ≤ 10s + the create).
export const OUTBOX_STALE_MS = 30_000;

export interface OutboxEntry {
  id: string;
  text: string;
  mode: CaptureMode;
  toToday: boolean;
  at: number;
}

function read(): OutboxEntry[] {
  try {
    const raw = globalThis.localStorage?.getItem(CAPTURE_OUTBOX_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? (list as OutboxEntry[]) : [];
  } catch {
    return [];
  }
}
function write(list: OutboxEntry[]): void {
  try {
    if (list.length) globalThis.localStorage?.setItem(CAPTURE_OUTBOX_KEY, JSON.stringify(list));
    else globalThis.localStorage?.removeItem(CAPTURE_OUTBOX_KEY);
  } catch {
    // no storage — the in-memory restore paths still apply
  }
}

export function outboxAdd(e: Omit<OutboxEntry, 'id'>): string {
  const id = `${e.at}-${Math.random().toString(36).slice(2, 8)}`;
  write([...read(), { ...e, id }]);
  return id;
}

export const outboxRemove = (id: string): void => write(read().filter((e) => e.id !== id));

// Entries left over from an earlier session (old enough not to be another tab's in-flight save), taken
// out of storage — the caller now owns showing them.
export function outboxTakeStale(now: number): OutboxEntry[] {
  const all = read();
  const stale = all.filter((e) => now - e.at >= OUTBOX_STALE_MS && typeof e.text === 'string');
  if (stale.length) write(all.filter((e) => !stale.includes(e)));
  return stale;
}
