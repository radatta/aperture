import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MATRIX_EXEMPT, matrixProblems } from '../matrix';
import { SCENARIOS } from './index';

// The gate's half of MATRIX_GAP: a scenario whose rows don't hold fails CI before any devcheck runs.
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const realFs = { exists: existsSync, read: (p: string) => readFileSync(p, 'utf8') };

describe('SCENARIOS', () => {
  it('every coverage matrix holds against the repo', () => {
    expect(matrixProblems(SCENARIOS, ROOT, realFs)).toEqual([]);
  });

  it('only smoke declares no rows', () => {
    expect(SCENARIOS.filter((s) => !s.rows.length).map((s) => s.id)).toEqual(MATRIX_EXEMPT);
  });

  it('every off-dev row names a test that is really there', () => {
    for (const row of SCENARIOS.flatMap((s) => s.rows).filter((r) => r.offDev))
      expect(readFileSync(`${ROOT}${row.offDev!.file}`, 'utf8')).toContain(row.offDev!.test);
  });
});
