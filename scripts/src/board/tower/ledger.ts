// Devcheck runs from the dev ledger (scripts/src/devcheck/ledger.ts writes it): `run-start` / `run-end`
// pairs by run id, and the dead-row TTL proof's count (queue.json → proofs.deadRows).
import { parseTime } from './fmt.ts';

export type Run = {
  run: string;
  start: number | null;
  end: number | null;
  status: string | null;
  full: boolean;
};

// Folds ledger records into `runs` (by id, kept in start order); other ops are ignored.
export function foldRuns(runs: Map<string, Run>, records: unknown[]): void {
  for (const raw of records) {
    const r = raw as { op?: unknown; run?: unknown; t?: unknown; status?: unknown };
    if ((r?.op !== 'run-start' && r?.op !== 'run-end') || typeof r.run !== 'string') continue;
    const t = parseTime(r.t);
    let run = runs.get(r.run);
    if (!run) {
      run = { run: r.run, start: null, end: null, status: null, full: r.run.endsWith('-full') };
      runs.set(r.run, run);
    }
    if (r.op === 'run-start') run.start = t;
    else {
      run.end = t;
      run.status = typeof r.status === 'string' ? r.status : null;
    }
  }
}

export type Proof = { since: number; target: number; excludedRuns: string[] };
export type ProofCount = { passed: number; failed: number; target: number; since: number };

// Full runs that ended PASS since `since`, minus the hub's exclusions (a purge, a cap hit: the ledger can't tell).
export function ttlProof(runs: Run[], p: Proof): ProofCount {
  const x = new Set(p.excludedRuns);
  const inWindow = runs.filter(
    (r) => r.full && r.end !== null && r.end >= p.since && !x.has(r.run),
  );
  return {
    passed: inWindow.filter((r) => r.status === 'PASS').length,
    failed: inWindow.filter((r) => r.status !== 'PASS').length,
    target: p.target,
    since: p.since,
  };
}
