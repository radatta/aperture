// Devcheck runs from each dev slot's ledgers (scripts/src/devcheck/ledger.ts writes them; slot A has one per test user): `run-start` / `run-end`
// pairs by run id, and the dead-row TTL proof's count (queue.json → proofs.deadRows).
import { clean, parseTime } from './fmt.ts';

export type Run = {
  run: string;
  start: number | null;
  end: number | null;
  status: string | null;
  full: boolean;
  slot: 'dev' | 'devb'; // which dev slot's ledger it came from (ledger.<slot>.jsonl, and slot A's ledger.dev.web.jsonl)
};

// Slot A's run has a line pair per lane (one ledger per test user: scripts/src/devcheck/lanes.ts), under one id: it's
// in flight while any lane is, ends with the last lane's end, and reads the worst lane's status. Open lanes are a set
// keyed by ledger (`from`), so a ledger read again from the top (replaced, purged by hand) never opens a run twice.
// In serial mode the run reads ended for the moment between the iPhone lane's run-end and the browser lane's
// run-start; every reader is per frame and the dev lock still holds merges, so one frame's blip is accepted.
const lanesOf = new WeakMap<Run, { open: Set<string>; end: number | null }>();
const RANK: Record<string, number> = { PASS: 0, FAIL: 1, CRASH: 2 }; // anything else reads worse than a crash
const worse = (a: string | null, b: string | null) =>
  a === null ? b : b === null ? a : (RANK[b] ?? 3) > (RANK[a] ?? 3) ? b : a;

// Folds one ledger's records into `runs` (keyed slot:id, kept in start order); other ops are ignored. `from` names
// the ledger (its path): one lane each.
export function foldRuns(
  runs: Map<string, Run>,
  records: unknown[],
  slot: Run['slot'] = 'dev',
  from: string = slot,
): void {
  for (const raw of records) {
    const r = raw as { op?: unknown; run?: unknown; t?: unknown; status?: unknown };
    if ((r?.op !== 'run-start' && r?.op !== 'run-end') || typeof r.run !== 'string') continue;
    const t = parseTime(r.t);
    const id = clean(r.run);
    const key = `${slot}:${id}`;
    let run = runs.get(key);
    if (!run) {
      run = { run: id, start: null, end: null, status: null, full: id.endsWith('-full'), slot };
      runs.set(key, run);
    }
    const l = lanesOf.get(run) ?? { open: new Set<string>(), end: null };
    lanesOf.set(run, l);
    if (r.op === 'run-start') {
      l.open.add(from);
      run.start = run.start === null || t === null ? (run.start ?? t) : Math.min(run.start, t);
    } else {
      l.open.delete(from);
      l.end = l.end === null || t === null ? (l.end ?? t) : Math.max(l.end, t);
      run.status = worse(run.status, typeof r.status === 'string' ? clean(r.status) : null);
    }
    run.end = l.open.size ? null : l.end;
  }
}

export type Proof = { since: number; target: number; excludedRuns: string[] };
export type ProofCount = { passed: number; failed: number; target: number; since: number };

// Full runs on slot A that ended PASS since `since`, minus the hub's exclusions (a purge, a cap hit: the ledger can't
// tell). Slot A only: the proof is about dev's table, and devb's rows live in another.
export function ttlProof(runs: Run[], p: Proof): ProofCount {
  const x = new Set(p.excludedRuns);
  const inWindow = runs.filter(
    (r) => r.slot === 'dev' && r.full && r.end !== null && r.end >= p.since && !x.has(r.run),
  );
  return {
    passed: inWindow.filter((r) => r.status === 'PASS').length,
    failed: inWindow.filter((r) => r.status !== 'PASS').length,
    target: p.target,
    since: p.since,
  };
}
