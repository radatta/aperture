// Dev-lock waits and holds on the board's history (docs/ops/SESSION-BOARD.md → Dev-lock events): one `kind: "devlock"`
// line in history/events-<UTC day>.jsonl per wait-start, wait-end, acquired (waitSec) and released (heldSec), the
// same envelope as lib.sh's sb_append, so a wait for a dev slot is measured rather than read off lane reports.
// Best effort, like the lock cache: no board (CI, the Mac) or any read or write error → nothing, never a failed bot
// command. A wait spans processes (the refusal, a background `lock wait`, the next deploy-dev), so its start is read
// back from history, today's and yesterday's files.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionNames } from '../board/sessions.ts';
import { isExpired } from './lock.ts';
import type { Holder, LockHeld, LockState, Slot, WaitOutcome } from './lock.ts';

// A wait whose last start or end is older than this is abandoned (MAX_WAIT_MIN 55 plus slack): every `lock wait`
// ends with a wait-end, so chained re-waits after an exit 75 stay one wait.
export const OPEN_WAIT_MS = 60 * 60_000;

type Base = { v: 1; t: string; kind: 'devlock'; name: string | null; branch: string };
export type WaitStart = Base & {
  action: 'wait-start';
  slots: Slot[];
  behind: { slot: Slot; branch: string }[]; // the live holders it queued behind
  main: Slot[]; // slots main's Deploy run was still to land on
  via: 'refused' | 'wait';
};
export type WaitEnd = Base & {
  action: 'wait-end';
  outcome: Exclude<WaitOutcome, 'ours'>;
  slot: Slot;
  slots: Slot[];
  main?: true;
  waitedSec: number; // this `lock wait` process alone
};
export type Acquired = Base & {
  action: 'acquired';
  slot: Slot;
  sha: string;
  takenAt: string; // the hold's start; `t` can be later when the first row was lost
  waitSec: number; // from the open wait's start, 0 when there was none
  waitFrom?: string;
};
export type Released = Base & {
  action: 'released';
  slot: Slot;
  sha: string;
  takenAt: string | null; // null: a lock an older bot wrote
  heldSec: number | null;
  lapsed?: true; // released after its expiry: heldSec stops at expiresAt
  by: 'release' | 'deploy-dev';
};
export type DevlockEvent = WaitStart | WaitEnd | Acquired | Released;

// sb_now's shape: UTC, whole seconds.
const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const file = (dir: string, ms: number) => join(dir, 'history', `events-${day(ms)}.jsonl`);
const sec = (ms: number) => Math.max(0, Math.round(ms / 1000));

export function readLockEvents(dir: string | null, nowMs: number): DevlockEvent[] {
  if (!dir) return [];
  const out: DevlockEvent[] = [];
  for (const ms of [nowMs - 86400_000, nowMs]) {
    let text: string;
    try {
      text = readFileSync(file(dir, ms), 'utf8');
    } catch {
      continue;
    }
    for (const l of text.split('\n')) {
      if (!l.includes('"devlock"')) continue; // the job and lease rows, unparsed
      try {
        const e = JSON.parse(l) as DevlockEvent;
        if (
          e?.kind === 'devlock' &&
          typeof e.t === 'string' &&
          typeof e.branch === 'string' &&
          typeof e.action === 'string'
        )
          out.push(e);
      } catch {
        // a torn line
      }
    }
  }
  return out.sort((a, b) => a.t.localeCompare(b.t));
}

// The branch's open wait: its latest wait-start with no acquired after it, whose last start or end is recent.
export function openWait(events: DevlockEvent[], branch: string, nowMs: number): WaitStart | null {
  const mine = events.filter((e) => e.branch === branch);
  const i = mine.findLastIndex((e) => e.action === 'wait-start');
  const start = mine[i] as WaitStart | undefined;
  if (!start) return null;
  const after = mine.slice(i);
  if (after.some((e) => e.action === 'acquired')) return null;
  const last = after.filter((e) => e.action === 'wait-start' || e.action === 'wait-end').at(-1);
  return last && nowMs - Date.parse(last.t) <= OPEN_WAIT_MS ? start : null;
}

// Each slot's latest take, for `lock status`.
export const lastTakes = (events: DevlockEvent[]): Partial<Record<Slot, Acquired>> =>
  Object.fromEntries(
    events.flatMap((e) => (e.action === 'acquired' ? [[e.slot, e]] : [])),
  ) as Partial<Record<Slot, Acquired>>;

// Local time, with the date when it isn't today (the window holds yesterday's UTC file too).
export function takeLine(a: Acquired | undefined, slot: Slot, nowMs: number): string | null {
  if (!a) return null;
  const at = new Date(Number.isNaN(Date.parse(a.takenAt)) ? a.t : a.takenAt);
  const when = `${at.toDateString() === new Date(nowMs).toDateString() ? '' : `${at.toLocaleDateString('en-CA')} `}${at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  const wait = !a.waitSec
    ? 'no wait'
    : a.waitSec < 60
      ? `waited ${a.waitSec} s`
      : `waited ${Math.round(a.waitSec / 60)} min`;
  return `  last take of ${slot}: ${a.branch} at ${when} — ${wait}`;
}

export interface LockLog {
  refused(branch: string, err: LockHeld, mainSlots: Slot[]): void;
  blocked(
    branch: string,
    reads: { slot: Slot; cur: LockState | null }[],
    main: Slot[],
    slots: readonly Slot[],
    startedMs: number,
  ): void;
  waitEnd(
    branch: string,
    r: { outcome: WaitOutcome; slot: Slot; main?: boolean },
    slots: readonly Slot[],
    startedMs: number,
  ): void;
  changed(h: Holder | null, slot: Slot, by?: Released['by']): void;
  released(h: Holder | null, slot: Slot, by: Released['by']): void;
}

// The writer. Every method swallows its own errors: the board is advisory.
export function lockLog(dir: string | null, now: () => number): LockLog {
  const seen = new Set<string>(); // acquired rows this process wrote or found
  const last: Partial<Record<Slot, Holder>> = {}; // each slot's holder as this process last saw it change
  const safe =
    <A extends unknown[]>(f: (...a: A) => void) =>
    (...a: A) => {
      try {
        f(...a);
      } catch {
        // an unwritable or vanished board
      }
    };
  const append = (e: Omit<Base, 'v' | 't' | 'kind' | 'name'> & Record<string, unknown>) => {
    if (!dir || !existsSync(dir)) return; // never creates a board
    const ms = now();
    const row = {
      v: 1,
      t: stamp(ms),
      kind: 'devlock',
      name: sessionNames(dir)[e.branch] ?? null,
      ...e,
    };
    mkdirSync(join(dir, 'history'), { recursive: true });
    appendFileSync(file(dir, ms), JSON.stringify(row) + '\n');
  };
  // asOf: when this wait began (a lock wait's own start), so a slow first read never splits it
  const start = (branch: string, rest: Omit<WaitStart, keyof Base | 'action'>, asOf = now()) => {
    if (openWait(readLockEvents(dir, now()), branch, asOf)) return; // still the same wait
    append({ action: 'wait-start', branch, ...rest });
  };
  const released = (h: Holder | null, slot: Slot, by: Released['by']) => {
    if (!h) return;
    const ms = now();
    const lapsed = isExpired(h, ms);
    const from = Date.parse(h.takenAt ?? '');
    const until = lapsed ? Date.parse(h.expiresAt) : ms;
    append({
      action: 'released',
      branch: h.branch,
      slot,
      sha: h.sha,
      takenAt: h.takenAt ?? null,
      heldSec: Number.isNaN(from) || Number.isNaN(until) ? null : sec(until - from),
      ...(lapsed ? { lapsed: true } : {}),
      by,
    });
  };
  return {
    refused: safe((branch, err, mainSlots) =>
      start(branch, {
        slots: err.held.map((x) => x.slot),
        behind: err.held.flatMap((x) =>
          x.holder ? [{ slot: x.slot, branch: x.holder.branch }] : [],
        ),
        main: mainSlots,
        via: 'refused',
      }),
    ),
    blocked: safe((branch, reads, main, slots, startedMs) => {
      const ms = now();
      start(
        branch,
        {
          slots: [...slots],
          behind: reads.flatMap(({ slot, cur }) =>
            cur?.holder && cur.holder.branch !== branch && !isExpired(cur.holder, ms)
              ? [{ slot, branch: cur.holder.branch }]
              : [],
          ),
          main: [...main],
          via: 'wait',
        },
        startedMs,
      );
    }),
    waitEnd: safe((branch, r, slots, startedMs) => {
      if (r.outcome === 'ours') return; // its acquired closed the wait already
      // Open as of this wait's own start: a lock wait inside an open wait writes nothing until it ends, so judged at
      // the end, a long gap before it plus its own 55 minutes would read as abandoned and split the wait.
      if (!openWait(readLockEvents(dir, now()), branch, startedMs)) return;
      append({
        action: 'wait-end',
        branch,
        outcome: r.outcome,
        slot: r.slot,
        slots: [...slots],
        ...(r.main ? { main: true } : {}),
        waitedSec: sec(now() - startedMs),
      });
    }),
    // Every lock change (deploy-dev's onLock, lock acquire): a new takenAt is a new hold; renew and a live re-take
    // keep it, so they write nothing. null is a release of the holder last seen here.
    changed: safe((h, slot, by = 'deploy-dev') => {
      if (!h) {
        released(last[slot] ?? null, slot, by);
        delete last[slot];
        return;
      }
      last[slot] = h;
      if (!h.takenAt) return; // an older bot's lock: a new hold can't be told from a renew
      const key = `${h.branch}\t${slot}\t${h.takenAt}`;
      if (seen.has(key)) return;
      seen.add(key);
      const events = readLockEvents(dir, now());
      if (
        events.some(
          (e) =>
            e.action === 'acquired' &&
            e.branch === h.branch &&
            e.slot === slot &&
            e.takenAt === h.takenAt,
        )
      )
        return;
      const w = openWait(events, h.branch, now());
      append({
        action: 'acquired',
        branch: h.branch,
        slot,
        sha: h.sha,
        takenAt: h.takenAt,
        waitSec: w ? sec(now() - Date.parse(w.t)) : 0,
        ...(w ? { waitFrom: w.t } : {}),
      });
    }),
    released: safe(released),
  };
}
