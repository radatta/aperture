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
const TEST_FILE = /\.test\.tsx?$/;
// A runnable it()/test() with this title, opening its line — not it.skip/it.todo, a describe, a commented-out
// test or a bare string. Known limit: an it() inside a describe.skip still matches.
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const testCall = (title: string) =>
  new RegExp(`^\\s*(it|test)\\(\\s*(['"\`])${escape(title)}\\2`, 'm');

// Every problem as "<scenario>: <what>"; empty means every matrix holds.
export function matrixProblems(scenarios: Scenario[], root: string, fs: MatrixFs): string[] {
  const out: string[] = [];
  for (const sc of scenarios) {
    const p = (msg: string) => out.push(`${sc.id}: ${msg}`);
    if (!sc.rows.length && !MATRIX_EXEMPT.includes(sc.id)) p('declares no rows');
    for (const id of dupes(sc.rows.map((r) => r.id))) p(`row ${id} is declared twice`);
    for (const id of dupes(sc.steps.map((s) => s.id))) p(`step ${id} is declared twice`);
    const slow = sc.steps.filter((s) => s.cost === 'slow');
    if (slow.length && !sc.slowPaths?.some((g) => g.trim()))
      p(`step ${slow.map((s) => s.id).join(', ')} is slow but the scenario declares no slowPaths`);
    if (!slow.length && sc.slowPaths) p('declares slowPaths but no slow step');
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
        else if (!TEST_FILE.test(file)) p(`row ${row.id} names ${file}, which isn't a test file`);
        else if (!fs.exists(join(root, file)))
          p(`row ${row.id} names a test file that doesn't exist: ${file}`);
        else if (!testCall(test).test(fs.read(join(root, file))))
          p(`row ${row.id}: no it()/test() titled "${test}" in ${file}`);
        if (by.length)
          p(
            `row ${row.id} is off dev but step ${by.map((s) => s.id).join(', ')} proves it — if dev can produce it, prove it on dev`,
          );
        // "same path as <row>" (DEV-CHECK.md → Rows) must name a row of this scenario that dev proves.
        const same = /^same path as ([\w-]+)/.exec(why);
        if (same) {
          const target = sc.rows.find((r) => r.id === same[1]);
          const proven = sc.steps.some((s) => s.proves?.includes(same[1]!));
          if (!target || target.offDev || target.needsYou !== undefined || !proven)
            p(
              `row ${row.id} is off dev as the same path as ${same[1]}, which dev doesn't prove here`,
            );
        }
      } else if (!by.some((s) => s.entry === row.entry))
        p(
          `row ${row.id} (${row.entry}) has no proving step through ${row.entry}${by.length ? ` — only ${by.map((s) => `${s.id} (${s.entry})`).join(', ')}` : ''}`,
        );
    }
  }
  return out;
}

// Each row's result: off dev and needs you as declared; a step-proven row passes only when every step
// naming it passed, fails when any failed, reads needs-you when a step said so at run time (scenario.ts
// needsYou — the rest passed or were left unrun by it), and is skipped otherwise (a step that never ran
// proves nothing). A slow step the run deferred drops out of that; a row whose proving steps were ALL
// deferred — or every one through the row's own entry point (a ui row never rests on its api step alone) — is
// `deferred` (DEV-CHECK.md → Slow tier). `buildChanged` (DEV_CHANGED_MID_RUN) leaves no row proven: its steps may have driven
// another build.
export function coverageOf(sc: Scenario, steps: StepResult[], buildChanged = false): RowResult[] {
  return sc.rows.map((row) => {
    const base = { scenario: sc.id, row: row.id, entry: row.entry, kind: row.kind, what: row.what };
    if (row.offDev) {
      const note = `${row.offDev.file} › ${row.offDev.test}`;
      return { ...base, status: 'off-dev', provenBy: `off dev: ${note}`, note };
    }
    if (row.needsYou !== undefined)
      return {
        ...base,
        status: 'needs-you',
        provenBy: `needs you: ${row.needsYou}`,
        note: row.needsYou,
      };
    const by = sc.steps.filter((s) => s.proves?.includes(row.id));
    const all = by.map(
      (s): Pick<StepResult, 'status' | 'note'> =>
        steps.find((r) => r.scenario === sc.id && r.step === s.id) ?? { status: 'skipped' },
    );
    const ran = by.map((s, i) => ({ s, r: all[i]! })).filter((x) => x.r.status !== 'deferred');
    const ownDeferred = ran.length < all.length && !ran.some((x) => x.s.entry === row.entry);
    if (all.length && (all.every((x) => x.status === 'deferred') || ownDeferred))
      return {
        ...base,
        status: 'deferred',
        provenBy: `steps ${by.map((s) => `${s.id} (${s.entry})`).join(', ')}`,
        note: all.find((x) => x.status === 'deferred')?.note ?? 'slow tier',
      };
    const results = ran.map((x) => x.r);
    const statuses = results.map((r) => r.status);
    const status = statuses.includes('fail')
      ? 'fail'
      : statuses.length && statuses.every((x) => x === 'pass')
        ? 'pass'
        : statuses.includes('needs-you') && statuses.every((x) => x === 'pass' || x === 'needs-you')
          ? 'needs-you'
          : 'skipped';
    const failed = ran.filter((x) => x.r.status === 'fail').map((x) => x.s.id);
    const reason = results.find((r) => r.status === 'needs-you')?.note;
    return {
      ...base,
      status: buildChanged && status === 'pass' ? 'skipped' : status,
      provenBy: by.length
        ? `steps ${by.map((s) => `${s.id} (${s.entry})`).join(', ')}`
        : 'no proving step',
      ...(failed.length ? { failedSteps: failed } : {}),
      ...(buildChanged && status === 'pass' ? { note: 'dev’s build changed mid-run' } : {}),
      ...(status === 'needs-you' ? { note: reason ?? 'a step said needs you' } : {}),
    };
  });
}
