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
  | 'reported' // a killed earlier run's orphan intent (`of` names that run), shown once in a report
  | 'run-end';

export interface LedgerEntry {
  t: string;
  run: string;
  op: LedgerOp;
  id?: string;
  via?: string; // 'api:createTask', 'ui:createTask', 'ui:splitTask', 'api:subscribePush' (a push device), …
  title?: string; // for the human report only — never matched on
  status?: string; // run-end: PASS / FAIL / CRASH
  of?: string; // reported: the run whose intent it was
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

// Ids created and not yet resolved (deleted, gone or swept) — what a cleanup must still handle. In ledger
// order: an id created again after it was resolved is pending again (a push device's id is its endpoint's
// hash, and the dev check reuses its endpoints, so a later run revives the same device). Creation order.
export function pendingIds(entries: LedgerEntry[]): string[] {
  const pending = new Map<string, boolean>();
  for (const e of entries) {
    if (!e.id) continue;
    if (e.op === 'created') pending.set(e.id, true);
    if (e.op === 'deleted' || e.op === 'gone' || e.op === 'swept') pending.set(e.id, false);
  }
  return [...pending].filter(([, p]) => p).map(([id]) => id);
}

// An `intent` with no `created` (or `refused`) after it in the same run: the create may have landed with its
// id unknown. One to one, in order: each answer resolves the oldest open intent of its via and title, so a
// dropped create retried under the same title still reads as an orphan (the retry's answer is the retry's).
export function orphanIntents(entries: LedgerEntry[]): LedgerEntry[] {
  const open = new Map<string, LedgerEntry[]>();
  const orphans = new Set<LedgerEntry>();
  for (const e of entries) {
    const k = `${e.run}\n${e.via}\n${e.title}`;
    if (e.op === 'intent') {
      orphans.add(e);
      const q = open.get(k);
      if (q) q.push(e);
      else open.set(k, [e]);
    } else if (e.op === 'created' || e.op === 'refused') {
      const first = open.get(k)?.shift();
      if (first) orphans.delete(first);
    }
  }
  return entries.filter((e) => orphans.has(e));
}

// A killed earlier run's orphan intents (its `run-end` never came, so no report named them), less those a
// later run already `reported`.
export function earlierOrphans(entries: LedgerEntry[], runId: string): LedgerEntry[] {
  const byRun = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    const own = byRun.get(e.run);
    if (own) own.push(e);
    else byRun.set(e.run, [e]);
  }
  const key = (run: string | undefined, e: LedgerEntry) => `${run}\n${e.via}\n${e.title}`;
  const seen = new Set(entries.filter((e) => e.op === 'reported').map((e) => key(e.of, e)));
  const out: LedgerEntry[] = [];
  for (const [run, own] of byRun) {
    if (run === runId || own.some((e) => e.op === 'run-end')) continue;
    out.push(...orphanIntents(own).filter((e) => !seen.has(key(run, e))));
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
