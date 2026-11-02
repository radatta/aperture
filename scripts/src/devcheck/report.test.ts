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
  feature: [],
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
    const feat = { ...base, feature: ['ad'] };
    const NO_LIST_HEADINGS = /^#+ (You don't need to test|Needs you)$/m;
    const pv = [
      row({ scenario: 'pv', row: 'p1', what: 'PV pass' }),
      row({ scenario: 'pv', row: 'p2', status: 'needs-you', what: 'PV camera', note: 'camera' }),
      row({ scenario: 'pv', row: 'p3', status: 'fail', what: 'PV esc', failedSteps: ['x'] }),
    ];
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
      const md = renderReport({ ...feat, coverage: rows });
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
      const md = renderReport({ ...feat, coverage: rows });
      expect(md).toContain(
        "#### You don't need to test\n\n- ad: Delete | Cancel\n- ad: S3 fails — covered off dev by a.test.ts › says so\n",
      );
      expect(md).toContain('#### Needs you\n\n- ad: MCP delete — next PR\n');
    });

    it('names what was not proven, and the step that failed', () => {
      const md = renderReport({
        ...feat,
        coverage: [
          row({ status: 'fail', failedSteps: ['del'] }),
          row({ row: 's', status: 'skipped', what: 'Reload' }),
        ],
      });
      expect(md).toContain('not proven **2**');
      expect(md).toContain(
        '#### Not proven on dev\n\n- ad: Delete — step del failed\n- ad: Reload — its steps never ran\n',
      );
      expect(md).toContain("#### You don't need to test\n\nNothing yet.");
    });

    it('a FAIL run’s lists carry its verdict; a build change mid-run names why a row is unproven', () => {
      const md = renderReport({
        ...feat,
        status: 'FAIL',
        codes: ['DEV_CHANGED_MID_RUN'],
        coverage: [row({ status: 'skipped', note: 'dev’s build changed mid-run' })],
      });
      expect(md).toContain('- ad: Delete — dev’s build changed mid-run');
      expect(md).toContain('_This run is FAIL: these hold only if it counts as green');
      expect(renderReport({ ...feat, coverage: rows })).not.toContain('_This run is');
    });

    it('the FAIL verdict sits only in this feature’s lists — never under Other or without a feature', () => {
      const md = renderReport({ ...feat, status: 'FAIL', coverage: [...rows, ...pv] });
      expect(md.split('_This run is FAIL').length - 1).toBe(1);
      expect(md.indexOf('_This run is FAIL')).toBeLessThan(md.indexOf('### Other'));
      expect(renderReport({ ...base, status: 'FAIL', coverage: rows })).not.toContain(
        '_This run is',
      );
    });

    it('a feature with no rows in the run pastes nothing', () => {
      const md = renderReport({ ...base, feature: ['zz'], coverage: rows });
      expect(md).toContain('No rows of zz in this run — nothing proven, nothing to paste.');
      expect(md).not.toMatch(NO_LIST_HEADINGS);
    });

    it('heads the feature’s rows with its name', () => {
      expect(renderReport({ ...feat, coverage: rows })).toContain(
        '## Feature coverage\n\n### This feature: ad\n\nProven on dev **1**',
      );
    });

    it('without a feature there are no paste lists — the note, the table and Not proven only', () => {
      const md = renderReport({
        ...base,
        coverage: [...rows, row({ row: 'f', status: 'fail', failedSteps: ['x'] })],
      });
      expect(md).toContain('_No `--feature` named: these rows are every scenario in the run');
      expect(md).toContain('| ad | Delete \\| Cancel |');
      expect(md).toContain('### Not proven on dev\n\n- ad: Delete — step x failed');
      expect(md).not.toMatch(NO_LIST_HEADINGS);
    });

    it('other scenarios collapse to counts and Not proven, and never into the feature’s lists', () => {
      const md = renderReport({ ...feat, coverage: [...rows, ...pv] });
      expect(md).toContain('### Other scenarios (regression)');
      expect(md).toContain(
        '- pv: proven on dev **1** · off dev **0** · needs you **1** · not proven **1**',
      );
      expect(md).toContain('#### Not proven on dev\n\n- pv: PV esc — step x failed');
      const mine = md.slice(md.indexOf('### This feature'), md.indexOf('### Other'));
      expect(mine).not.toContain('pv:');
      expect(md).not.toContain('| pv |');
      expect(md.indexOf('### This feature')).toBeLessThan(md.indexOf('### Other'));
    });

    it('no Other scenarios block when only the feature ran', () => {
      expect(renderReport({ ...feat, coverage: rows })).not.toContain('### Other scenarios');
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
