// The devcheck's half of heavy.sh's job event (docs/ops/SESSION-BOARD.md → Perf fields → `devcheck`): where a run's
// time went — the pipeline's phases, each scenario's total and the slowest steps. Written to heavy.sh's
// HEAVY_DETAIL_DIR when the run is under heavy.sh; every step's own time stays in report.json, which a full run's
// hundreds of steps would bloat the event history with.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResult } from './report';

export const SLOWEST = 10;

export interface DevcheckDetail {
  tier: string;
  status: RunResult['status'];
  ms: { total: number } & Partial<NonNullable<RunResult['phases']>>;
  scenarios: Record<string, { ms: number; steps: number; failed: number }>;
  slow: { step: string; ms: number }[];
  report: string;
}

export function devcheckDetail(r: RunResult, report: string): DevcheckDetail {
  const scenarios: DevcheckDetail['scenarios'] = {};
  for (const s of r.steps) {
    const x = (scenarios[s.scenario] ??= { ms: 0, steps: 0, failed: 0 });
    x.ms += s.ms;
    if (s.ms > 0) x.steps++; // a step that ran (skipped, deferred and inherited needs-you rows take no time)
    if (s.status === 'fail') x.failed++;
  }
  const slow = r.steps
    .filter((s) => s.ms > 0)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, SLOWEST)
    .map((s) => ({ step: `${s.scenario}-${s.step}`, ms: s.ms }));
  return {
    tier: r.tier,
    status: r.status,
    ms: { total: r.durationMs, ...r.phases },
    scenarios,
    slow,
    report,
  };
}

// Best effort: a perf field never costs a run its report or exit code.
export function writeHeavyDetail(
  r: RunResult,
  report: string,
  dir = process.env.HEAVY_DETAIL_DIR,
): void {
  if (!dir) return;
  try {
    writeFileSync(join(dir, 'devcheck.json'), `${JSON.stringify(devcheckDetail(r, report))}\n`);
  } catch {
    // the dir went away (heavy.sh killed) or is unwritable: the event goes without it
  }
}
