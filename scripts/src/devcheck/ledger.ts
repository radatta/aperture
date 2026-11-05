// The id ledger: append-only JSONL of every task id the dev check created, taken from the server's create
// response — never from a title or a marker word (an AI rewrites titles). Cleanup deletes only ledger ids;
// api.ts refuses any other. One file shared by every run and worktree, so a crashed run's leftovers are
// swept by the next one. A line is fsync'd before the call that depends on it returns.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export type LedgerOp =
  | 'run-start'
  | 'intent' // about to create via the API — a crash before `created` is reported, never silently lost
  | 'created'
  | 'refused' // the server refused the create before any write (a param error) — the intent is resolved, nothing to clean
  | 'deleted'
  | 'gone' // the server already had no such task (deleted with its parent, or by hand)
  | 'swept' // a previous run's leftover, cleaned by this one
  | 'run-end';

export interface LedgerEntry {
  t: string;
  run: string;
  op: LedgerOp;
  id?: string;
  via?: string; // 'api:createTask', 'ui:createTask', 'ui:splitTask', 'api:subscribePush' (a push device), …
  title?: string; // for the human report only — never matched on
  status?: string; // run-end: PASS / FAIL / CRASH
}

export interface Ledger {
  append(entry: Omit<LedgerEntry, 't'>): void;
  read(): LedgerEntry[];
  has(id: string): boolean;
}

export function parseLedger(text: string): LedgerEntry[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LedgerEntry);
}

// Ids created and not yet resolved (deleted, gone or swept) — what a cleanup must still handle.
export function pendingIds(entries: LedgerEntry[]): string[] {
  const created: string[] = [];
  const resolved = new Set<string>();
  for (const e of entries) {
    if (!e.id) continue;
    if (e.op === 'created' && !created.includes(e.id)) created.push(e.id);
    if (e.op === 'deleted' || e.op === 'gone' || e.op === 'swept') resolved.add(e.id);
  }
  return created.filter((id) => !resolved.has(id));
}

// An `intent` with no `created` (or `refused`) after it in the same run: the create may have landed with its
// id unknown.
export function orphanIntents(entries: LedgerEntry[]): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const [i, e] of entries.entries()) {
    if (e.op !== 'intent') continue;
    const followed = entries
      .slice(i + 1)
      .some(
        (n) =>
          n.run === e.run &&
          (n.op === 'created' || n.op === 'refused') &&
          n.via === e.via &&
          n.title === e.title,
      );
    if (!followed) out.push(e);
  }
  return out;
}

export function openLedger(path: string, now: () => Date = () => new Date()): Ledger {
  mkdirSync(dirname(path), { recursive: true });
  const read = (): LedgerEntry[] => {
    try {
      return parseLedger(readFileSync(path, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  };
  return {
    append(entry) {
      const fd = openSync(path, 'a', 0o600);
      try {
        writeSync(fd, JSON.stringify({ t: now().toISOString(), ...entry }) + '\n');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    read,
    has: (id) => read().some((e) => e.op === 'created' && e.id === id),
  };
}
