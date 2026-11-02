// The coverage matrix: checked at load (matrixProblems — a row nothing proves is MATRIX_GAP before any
// deploy wait), then scored from the run's step results (coverageOf). Rules: docs/ops/DEV-CHECK.md → Rows.
import { join } from 'node:path';
import type { RowResult, StepResult } from './report';
import { STEP_ENTRIES, type Scenario } from './scenario';

export interface MatrixFs {
  exists(path: string): boolean;
  read(path: string): string;
}

export const MATRIX_EXEMPT = ['smoke']; // proves the harness, not a feature

const dupes = (xs: string[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];

// Every problem as "<scenario>: <what>"; empty means every matrix holds.
export function matrixProblems(scenarios: Scenario[], root: string, fs: MatrixFs): string[] {
  const out: string[] = [];
  for (const sc of scenarios) {
    const p = (msg: string) => out.push(`${sc.id}: ${msg}`);
    if (!sc.rows.length && !MATRIX_EXEMPT.includes(sc.id)) p('declares no rows');
    for (const id of dupes(sc.rows.map((r) => r.id))) p(`row ${id} is declared twice`);
    for (const id of dupes(sc.steps.map((s) => s.id))) p(`step ${id} is declared twice`);
    for (const s of sc.steps) {
      if (!STEP_ENTRIES.includes(s.entry))
        p(`step ${s.id} claims entry ${s.entry}, which no step can drive yet`);
      for (const id of s.proves ?? [])
        if (!sc.rows.some((r) => r.id === id)) p(`step ${s.id} proves unknown row ${id}`);
    }
    for (const row of sc.rows) {
      const by = sc.steps.filter((s) => s.proves?.includes(row.id));
      if (row.offDev && row.needsYou !== undefined)
        p(`row ${row.id} is both off dev and needs you`);
      if (row.needsYou !== undefined) {
        if (!row.needsYou.trim()) p(`row ${row.id} needs you but gives no reason`);
        if (by.length)
          p(`row ${row.id} needs you but step ${by.map((s) => s.id).join(', ')} proves it`);
      } else if (row.offDev) {
        const { file, test, why } = row.offDev;
        if (!file.trim() || !test.trim() || !why.trim())
          p(`row ${row.id} is off dev but its file, test or why is empty`);
        else if (!fs.exists(join(root, file)))
          p(`row ${row.id} names a test file that doesn't exist: ${file}`);
        else if (!fs.read(join(root, file)).includes(test))
          p(`row ${row.id}: test "${test}" not found in ${file}`);
        if (by.length)
          p(
            `row ${row.id} is off dev but step ${by.map((s) => s.id).join(', ')} proves it — if dev can produce it, prove it on dev`,
          );
      } else if (!by.some((s) => s.entry === row.entry))
        p(
          `row ${row.id} (${row.entry}) has no proving step through ${row.entry}${by.length ? ` — only ${by.map((s) => `${s.id} (${s.entry})`).join(', ')}` : ''}`,
        );
    }
  }
  return out;
}

// Each row's result: off dev and needs you as declared; a step-proven row passes only when every step
// naming it passed, fails when any failed, and is skipped otherwise (a step that never ran proves nothing).
export function coverageOf(sc: Scenario, steps: StepResult[]): RowResult[] {
  return sc.rows.map((row) => {
    const base = { scenario: sc.id, row: row.id, entry: row.entry, kind: row.kind, what: row.what };
    if (row.offDev)
      return {
        ...base,
        status: 'off-dev',
        provenBy: `off dev: ${row.offDev.file} › ${row.offDev.test}`,
      };
    if (row.needsYou !== undefined)
      return { ...base, status: 'needs-you', provenBy: `needs you: ${row.needsYou}` };
    const by = sc.steps.filter((s) => s.proves?.includes(row.id));
    const results = by.map(
      (s) => steps.find((r) => r.scenario === sc.id && r.step === s.id)?.status ?? 'skipped',
    );
    const status = results.includes('fail')
      ? 'fail'
      : results.length && results.every((x) => x === 'pass')
        ? 'pass'
        : 'skipped';
    const failed = by.filter((_, i) => results[i] === 'fail').map((s) => s.id);
    return {
      ...base,
      status,
      provenBy: `steps ${by.map((s) => `${s.id} (${s.entry})`).join(', ')}`,
      ...(failed.length ? { failedSteps: failed } : {}),
    };
  });
}
