import { describe, expect, it } from 'vitest';
import { renderReport, statusLine, type RowResult, type RunResult } from './report';

const base: RunResult = {
  runId: '2026-10-13T12-00-00-full',
  tier: 'full',
  expectedSha: 'a'.repeat(40),
  startSha: 'a'.repeat(40),
  endSha: 'a'.repeat(40),
  status: 'PASS',
  codes: [],
  coverage: [],
  steps: [{ scenario: 'smoke', step: 'home', title: 'Home renders', status: 'pass', ms: 1200 }],
  created: [{ id: 't1', via: 'ui:createTask', final: 'deleted' }],
  swept: [],
  unrecorded: [],
  orphanIntents: [],
  blockedDeletes: [],
  consoleErrors: [],
  throttled: [],
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

  it('names every throttled call, which the console lines cannot', () => {
    const md = renderReport({
      ...base,
      consoleErrors: ['Failed to load resource: the server responded with a status of 429 ()'],
      throttled: ['/api/listTasks', '/api/getDay'],
    });
    expect(md).toContain('## Throttled (429)\n\n- `/api/listTasks`\n- `/api/getDay`\n');
  });

  it('renders a pass', () => {
    expect(renderReport(base)).toMatchInlineSnapshot(`
      "# Dev check — PASS

      Run \`2026-10-13T12-00-00-full\` · tier full · 61.0s
      Build: expected \`aaaaaaa\`, start \`aaaaaaa\`, end \`aaaaaaa\`
      Leftovers: **0**

      ## Feature coverage

      No feature rows in this run — smoke proves the harness.

      ## Steps

      | Scenario | Step | Result | Time | Detail |
      | --- | --- | --- | --- | --- |
      | smoke | Home renders | pass | 1.2s |  |

      ## Data

      - \`t1\` via ui:createTask → **deleted**

      ## Console errors

      None.

      ## Throttled (429)

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

  describe('feature coverage', () => {
    const row = (over: Partial<RowResult>): RowResult => ({
      scenario: 'ad',
      row: 'r',
      entry: 'ui',
      kind: 'nominal',
      what: 'Delete',
      status: 'pass',
      provenBy: 'steps del (ui)',
      ...over,
    });
    const rows = [
      row({ what: 'Delete | Cancel' }),
      row({
        row: 'o',
        kind: 'edge',
        status: 'off-dev',
        what: 'S3 fails',
        provenBy: 'off dev: a.test.ts › says so',
        note: 'a.test.ts › says so',
      }),
      row({
        row: 'y',
        entry: 'mcp',
        status: 'needs-you',
        what: 'MCP delete',
        provenBy: 'needs you: next PR',
        note: 'next PR',
      }),
    ];

    it('leads with the table, before the steps, pipes escaped', () => {
      const md = renderReport({ ...base, coverage: rows });
      expect(md.indexOf('## Feature coverage')).toBeLessThan(md.indexOf('## Steps'));
      expect(md).toContain(
        'Proven on dev **1** · off dev **1** · needs you **1** · not proven **0**',
      );
      expect(md).toContain('| ad | Delete \\| Cancel | nominal | ui | steps del (ui) | pass |');
      expect(md).toContain(
        '| ad | S3 fails | edge | ui | off dev: a.test.ts › says so | off dev |',
      );
      expect(md).not.toContain('### Not proven on dev');
    });

    it('lists what the user need not test (off dev annotated) and what needs them', () => {
      const md = renderReport({ ...base, coverage: rows });
      expect(md).toContain(
        "### You don't need to test\n\n- ad: Delete | Cancel\n- ad: S3 fails — covered off dev by a.test.ts › says so\n",
      );
      expect(md).toContain('### Needs you\n\n- ad: MCP delete — next PR\n');
    });

    it('names what was not proven, and the step that failed', () => {
      const md = renderReport({
        ...base,
        coverage: [
          row({ status: 'fail', failedSteps: ['del'] }),
          row({ row: 's', status: 'skipped', what: 'Reload' }),
        ],
      });
      expect(md).toContain('not proven **2**');
      expect(md).toContain(
        '### Not proven on dev\n\n- ad: Delete — step del failed\n- ad: Reload — its steps never ran\n',
      );
      expect(md).toContain("### You don't need to test\n\nNothing yet.");
    });

    it('a FAIL run’s lists carry its verdict; a build change mid-run names why a row is unproven', () => {
      const md = renderReport({
        ...base,
        status: 'FAIL',
        codes: ['DEV_CHANGED_MID_RUN'],
        coverage: [row({ status: 'skipped', note: 'dev’s build changed mid-run' })],
      });
      expect(md).toContain('- ad: Delete — dev’s build changed mid-run');
      expect(md).toContain('_This run is FAIL: these hold only if it counts as green');
      expect(renderReport({ ...base, coverage: rows })).not.toContain('_This run is');
    });

    it('names the scenarios’ commit only when it differs from the build', () => {
      expect(renderReport({ ...base, scenarioSha: base.expectedSha })).not.toContain(
        'scenarios from',
      );
      expect(renderReport({ ...base, scenarioSha: 'b'.repeat(40) })).toContain(
        'end `aaaaaaa` · scenarios from `bbbbbbb`',
      );
      expect(renderReport({ ...base, scenarioSha: `${'a'.repeat(40)}-dirty` })).toContain(
        'scenarios from `aaaaaaa-dirty`',
      );
    });
  });
});
