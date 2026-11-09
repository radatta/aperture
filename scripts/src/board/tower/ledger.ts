// Devcheck runs from each dev slot's ledger (scripts/src/devcheck/ledger.ts writes it): `run-start` / `run-end`
// pairs by run id, and the dead-row TTL proof's count (queue.json → proofs.deadRows).
import { clean, parseTime } from './fmt.ts';

export type Run = {
  run: string;
  start: number | null;
  end: number | null;
  status: string | null;
  full: boolean;
  slot: 'dev' | 'devb'; // which dev slot's ledger it came from (ledger.<slot>.jsonl)
};

// Folds one slot's ledger records into `runs` (keyed slot:id, kept in start order); other ops are ignored.
export function foldRuns(
  runs: Map<string, Run>,
  records: unknown[],
  slot: Run['slot'] = 'dev',
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
    if (r.op === 'run-start') run.start = t;
    else {
      run.end = t;
      run.status = typeof r.status === 'string' ? clean(r.status) : null;
    }
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
