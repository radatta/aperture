import { describe, expect, it } from 'vitest';
import { renderReport, statusLine, type RunResult } from './report';

const base: RunResult = {
  runId: '2026-10-13T12-00-00-full',
  tier: 'full',
  expectedSha: 'a'.repeat(40),
  startSha: 'a'.repeat(40),
  endSha: 'a'.repeat(40),
  status: 'PASS',
  codes: [],
  steps: [{ scenario: 'smoke', step: 'home', title: 'Home renders', status: 'pass', ms: 1200 }],
  created: [{ id: 't1', via: 'ui:createTask', final: 'deleted' }],
  swept: [],
  unrecorded: [],
  orphanIntents: [],
  blockedDeletes: [],
  consoleErrors: [],
  shots: ['smoke-home-home-light.png'],
  durationMs: 61_000,
};

describe('report', () => {
  it('leads with the status line', () => {
    expect(renderReport(base).split('\n')[0]).toBe('# Dev check — PASS');
    expect(
      statusLine({ ...base, status: 'FAIL', codes: ['STEP_FAILED', 'LEFTOVERS', 'STEP_FAILED'] }),
    ).toBe('FAIL: STEP_FAILED, LEFTOVERS');
  });

  it('renders a pass', () => {
    expect(renderReport(base)).toMatchInlineSnapshot(`
      "# Dev check — PASS

      Run \`2026-10-13T12-00-00-full\` · tier full · 61.0s
      Build: expected \`aaaaaaa\`, start \`aaaaaaa\`, end \`aaaaaaa\`
      Leftovers: **0**

      ## Steps

      | Scenario | Step | Result | Time | Detail |
      | --- | --- | --- | --- | --- |
      | smoke | Home renders | pass | 1.2s |  |

      ## Data

      - \`t1\` via ui:createTask → **deleted**

      ## Console errors

      None.

      ## Screenshots

      - [smoke-home-home-light.png](shots/smoke-home-home-light.png)
      "
    `);
  });

  it('shows failures, leftovers, unrecorded tasks and pipes escaped', () => {
    const md = renderReport({
      ...base,
      status: 'FAIL',
      codes: ['STEP_FAILED', 'LEFTOVERS'],
      steps: [
        {
          scenario: 'cap',
          step: 's',
          title: 'a | b',
          status: 'fail',
          ms: 10,
          error: 'no\nmatch',
          shot: 'x.png',
        },
      ],
      created: [{ id: 't9', via: 'ui:createTask', final: 'left' }],
      unrecorded: ['u1'],
    });
    expect(md).toContain('# Dev check — FAIL: STEP_FAILED, LEFTOVERS');
    expect(md).toContain('Leftovers: **1** (t9)');
    expect(md).toContain('| cap | a \\| b | fail | 0.0s | no match ![](shots/x.png) |');
    expect(md).toContain('**Not in the ledger** (reported, never deleted — check by hand): u1');
  });
});
