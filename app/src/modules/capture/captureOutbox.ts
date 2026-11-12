import type { CaptureMode } from './mode';

// Capture's crash-safety, per device (docs/areas/tasks/quick-add.md). Two localStorage lists:
//   outbox — each Auto capture from Enter until its create settles. Auto clears the field at once and then
//            waits on the parse, so for a few seconds the capture exists nowhere else; closing the app (a
//            PWA swipe-away) would lose it silently.
//   parked — captures shown under the capture bar until put back or discarded: a failed save the field
//            had no room for, an outbox entry left over from a closed session, a set-aside draft. Kept
//            here, not just in React state, so closing the app again can't lose them either.
// An outbox entry moves to `parked` in one write (outboxParkStale), never through memory. Storage can be
// absent or throw (private mode, cleared site data), so every access is guarded; a failure only loses
// the guard, never the capture already on screen.

export const CAPTURE_OUTBOX_KEY = 'aperture:captureOutbox';
export const CAPTURE_PARKED_KEY = 'aperture:captureParked';
// Younger than this, another open tab's entry may still be in flight (parse ≤ 10s + the create).
export const OUTBOX_STALE_MS = 30_000;

export interface OutboxEntry {
  id: string;
  text: string;
  mode: CaptureMode;
  toToday: boolean;
  at: number;
}

export interface Parked {
  id: string;
  text: string;
  mode: CaptureMode;
  toToday: boolean;
  isPrivate?: boolean; // a private log's lock comes back with it on Put back
  why: 'failed' | 'restored' | 'set-aside';
}

function read<T>(key: string): T[] {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list)
      ? (list as T[]).filter((e) => typeof (e as { text?: unknown }).text === 'string')
      : [];
  } catch {
    return [];
  }
}
function write<T>(key: string, list: T[]): void {
  try {
    if (list.length) globalThis.localStorage?.setItem(key, JSON.stringify(list));
    else globalThis.localStorage?.removeItem(key);
  } catch {
    // no storage — what's on screen is still there
  }
}

export const newCaptureId = (at: number): string =>
  `${at}-${Math.random().toString(36).slice(2, 8)}`;

export function outboxAdd(e: Omit<OutboxEntry, 'id'>): string {
  const id = newCaptureId(e.at);
  write(CAPTURE_OUTBOX_KEY, [...read<OutboxEntry>(CAPTURE_OUTBOX_KEY), { ...e, id }]);
  return id;
}

export const outboxRemove = (id: string): void =>
  write(
    CAPTURE_OUTBOX_KEY,
    read<OutboxEntry>(CAPTURE_OUTBOX_KEY).filter((e) => e.id !== id),
  );

export const readParked = (): Parked[] => read<Parked>(CAPTURE_PARKED_KEY);
export const writeParked = (list: Parked[]): void => write(CAPTURE_PARKED_KEY, list);

// Move outbox entries that can't still be in flight to `parked`, in one write each way: not this page's
// own (`own` — its slow create is still running) and older than OUTBOX_STALE_MS (another tab's may be).
// Returns what moved, and when to look again for entries too young to take yet (null = none waiting).
export function outboxParkStale(
  now: number,
  own: ReadonlySet<string>,
): { moved: Parked[]; retryInMs: number | null } {
  const all = read<OutboxEntry>(CAPTURE_OUTBOX_KEY);
  const foreign = all.filter((e) => !own.has(e.id));
  const stale = foreign.filter((e) => now - e.at >= OUTBOX_STALE_MS);
  const young = foreign.filter((e) => now - e.at < OUTBOX_STALE_MS);
  const moved = stale.map((e): Parked => ({
    id: e.id,
    text: e.text,
    mode: e.mode,
    toToday: e.toToday,
    why: 'restored',
  }));
  if (moved.length) {
    const parked = readParked();
    writeParked([...parked, ...moved.filter((m) => !parked.some((p) => p.id === m.id))]);
    write(
      CAPTURE_OUTBOX_KEY,
      all.filter((e) => !stale.includes(e)),
    );
  }
  const retryInMs = young.length
    ? Math.max(0, Math.min(...young.map((e) => OUTBOX_STALE_MS - (now - e.at))))
    : null;
  return { moved, retryInMs };
}
