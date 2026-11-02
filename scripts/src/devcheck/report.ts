// The run's report: status line first (PASS / FAIL: <codes> / CRASH), then what ran, against which build,
// what it created and what's left. report.md is for reading (Claude reads it, then the screenshots);
// report.json is the same result for tooling.
import type { ReasonCode } from './errors';
import type { EntryPoint, RowKind } from './scenario';

export type StepStatus = 'pass' | 'fail' | 'skipped';

export interface StepResult {
  scenario: string;
  step: string;
  title: string;
  status: StepStatus;
  ms: number;
  error?: string;
  shot?: string;
}

export type RowStatus = 'pass' | 'fail' | 'skipped' | 'off-dev' | 'needs-you';

export interface RowResult {
  scenario: string;
  row: string;
  entry: EntryPoint;
  kind: RowKind;
  what: string;
  status: RowStatus;
  provenBy: string; // "steps a (ui), b (api)" | "off dev: <file> › <test>" | "needs you: <reason>"
  failedSteps?: string[];
}

export interface CreatedRecord {
  id: string;
  via: string;
  title?: string;
  final: 'deleted' | 'gone' | 'left';
}

export interface RunResult {
  runId: string;
  tier: string;
  expectedSha: string;
  scenarioSha?: string; // the commit the scenarios came from — differs from expectedSha on a scenario-only check
  startSha?: string;
  endSha?: string;
  deployUrl?: string;
  status: 'PASS' | 'FAIL' | 'CRASH';
  codes: ReasonCode[];
  coverage: RowResult[]; // every selected scenario's rows, in order
  steps: StepResult[];
  created: CreatedRecord[];
  swept: string[];
  unrecorded: string[]; // there before the run and unknown to the ledger — reported, never deleted
  appeared?: string[]; // appeared DURING the run, unknown to the ledger — a missed create path; fails the run
  orphanIntents: string[]; // API creates that may have landed without their id — check by hand
  blockedDeletes: string[]; // ledger ids NOT deleted because the server showed parts the ledger doesn't know
  consoleErrors: string[];
  throttled: string[]; // every HTTP 429 the page got, in order: `/api/<method>`, else the path — names what never ran
  shots: string[];
  durationMs: number;
  crash?: string;
}

export const statusLine = (r: RunResult): string =>
  r.status === 'FAIL' ? `FAIL: ${[...new Set(r.codes)].join(', ')}` : r.status;

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const ROW_LABEL: Record<RowStatus, string> = {
  pass: 'pass',
  fail: 'fail',
  skipped: 'skipped',
  'off-dev': 'off dev',
  'needs-you': 'needs you',
};

// The feature's rows first, so the report says what was proven before how the steps went. The two lists
// paste into report-<branch>.md and the CC done notes as they are.
function renderCoverage(rows: RowResult[]): string[] {
  const lines = ['', '## Feature coverage', ''];
  if (!rows.length) return [...lines, 'No feature rows in this run — smoke proves the harness.'];
  const n = (...st: RowStatus[]) => rows.filter((x) => st.includes(x.status)).length;
  const item = (x: RowResult) => `- ${x.scenario}: ${x.what}`;
  lines.push(
    `Proven on dev **${n('pass')}** · off dev **${n('off-dev')}** · needs you **${n('needs-you')}** · not proven **${n('fail', 'skipped')}**`,
    '',
    '| Scenario | Row | Kind | Entry | Proven by | Result |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (x) =>
        `| ${x.scenario} | ${cell(x.what)} | ${x.kind} | ${x.entry} | ${cell(x.provenBy)} | ${ROW_LABEL[x.status]} |`,
    ),
  );
  const unproven = rows.filter((x) => x.status === 'fail' || x.status === 'skipped');
  if (unproven.length)
    lines.push(
      '',
      '### Not proven on dev',
      '',
      ...unproven.map(
        (x) =>
          `${item(x)} — ${x.failedSteps?.length ? `step ${x.failedSteps.join(', ')} failed` : 'its steps never ran'}`,
      ),
    );
  const done = rows.filter((x) => x.status === 'pass' || x.status === 'off-dev');
  lines.push(
    '',
    "### You don't need to test",
    '',
    ...(done.length
      ? done.map((x) =>
          x.status === 'off-dev'
            ? `${item(x)} — covered off dev by ${x.provenBy.slice('off dev: '.length)}`
            : item(x),
        )
      : ['Nothing yet.']),
  );
  const you = rows.filter((x) => x.status === 'needs-you');
  lines.push(
    '',
    '### Needs you',
    '',
    ...(you.length
      ? you.map((x) => `${item(x)} — ${x.provenBy.slice('needs you: '.length)}`)
      : ['Nothing.']),
  );
  return lines;
}

export function renderReport(r: RunResult): string {
  const left = r.created.filter((c) => c.final === 'left');
  const lines = [
    `# Dev check — ${statusLine(r)}`,
    '',
    `Run \`${r.runId}\` · tier ${r.tier} · ${sec(r.durationMs)}`,
    `Build: expected \`${r.expectedSha.slice(0, 7)}\`, start \`${r.startSha?.slice(0, 7) ?? '—'}\`, end \`${r.endSha?.slice(0, 7) ?? '—'}\`${r.deployUrl ? ` · [deploy run](${r.deployUrl})` : ''}${r.scenarioSha && r.scenarioSha !== r.expectedSha ? ` · scenarios from \`${r.scenarioSha.slice(0, 7)}\`` : ''}`,
    `Leftovers: **${left.length}**${left.length ? ` (${left.map((c) => c.id).join(', ')})` : ''}`,
  ];
  if (r.crash) lines.push('', `**Crash:** ${r.crash}`);
  lines.push(...renderCoverage(r.coverage));
  lines.push(
    '',
    '## Steps',
    '',
    '| Scenario | Step | Result | Time | Detail |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const s of r.steps)
    lines.push(
      `| ${s.scenario} | ${cell(s.title)} | ${s.status} | ${sec(s.ms)} | ${cell(s.error ?? '')}${s.shot ? ` ![](shots/${s.shot})` : ''} |`,
    );
  lines.push('', '## Data', '');
  if (!r.created.length) lines.push('Created nothing.');
  for (const c of r.created)
    lines.push(`- \`${c.id}\` via ${c.via}${c.title ? ` — ${c.title}` : ''} → **${c.final}**`);
  if (r.swept.length) lines.push(`- Swept from earlier runs: ${r.swept.join(', ')}`);
  if (r.unrecorded.length)
    lines.push(
      `- **Not in the ledger** (reported, never deleted — check by hand): ${r.unrecorded.join(', ')}`,
    );
  if (r.appeared?.length)
    lines.push(
      `- **Appeared during the run, not in the ledger** (a create path the recorder missed — not deleted): ${r.appeared.join(', ')}`,
    );
  if (r.blockedDeletes.length)
    lines.push(
      `- **Not deleted — it has parts the ledger doesn't know** (a delete would cascade into them): ${r.blockedDeletes.join('; ')}`,
    );
  if (r.orphanIntents.length)
    lines.push(
      `- **Possible leak** (create sent, id never recorded): ${r.orphanIntents.join('; ')}`,
    );
  lines.push(
    '',
    '## Console errors',
    '',
    ...(r.consoleErrors.length ? r.consoleErrors.map((e) => `- ${cell(e)}`) : ['None.']),
  );
  // A 429 is Lambda refusing to start the function, so the call never ran (docs/ops/DEV-CHECK.md → Known 429s). Chromium's
  // console line for it carries no URL; this names each one.
  lines.push(
    '',
    '## Throttled (429)',
    '',
    ...(r.throttled.length ? r.throttled.map((t) => `- \`${cell(t)}\``) : ['None.']),
  );
  lines.push(
    '',
    '## Screenshots',
    '',
    ...(r.shots.length ? r.shots.map((s) => `- [${s}](shots/${s})`) : ['None.']),
  );
  return lines.join('\n') + '\n';
}
