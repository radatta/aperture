// The run's report: status line first (PASS / FAIL: <codes> / CRASH), then what ran, against which build,
// what it created and what's left. report.md is for reading (Claude reads it, then the screenshots);
// report.json is the same result for tooling.
import type { ReasonCode } from './errors';
import type { EntryPoint, RowKind } from './scenario';

// needs-you: the step said so itself (scenario.ts needsYou) — nothing broke, the user has to do something
// first; the scenario's later steps carry it too, since they never ran because of it.
export type StepStatus = 'pass' | 'fail' | 'skipped' | 'needs-you';

export interface StepResult {
  scenario: string;
  step: string;
  title: string;
  status: StepStatus;
  ms: number;
  error?: string;
  note?: string; // needs-you: the reason
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
  note?: string; // the off-dev test, the needs-you reason, or why a passing row isn't proven
}

export interface CreatedRecord {
  id: string;
  via: string;
  title?: string;
  final: 'deleted' | 'gone' | 'left';
}

// A harness failure with what it said — the deploy wait, a sign-in, the build check, cleanup. A step's failure
// is in its row instead, so STEP_FAILED never appears here.
export interface Failure {
  code: ReasonCode;
  message: string;
}

export interface RunResult {
  runId: string;
  tier: string;
  feature: string[]; // scenario ids whose rows are this feature's ([] = none named)
  expectedSha: string;
  scenarioSha?: string; // the commit the scenarios came from — differs from expectedSha on a scenario-only check
  startSha?: string;
  endSha?: string;
  deployUrl?: string;
  status: 'PASS' | 'FAIL' | 'CRASH';
  codes: ReasonCode[];
  failures: Failure[]; // the harness's own failures, with their detail (codes stays the dedup'd list)
  coverage: RowResult[]; // every selected scenario's rows, in order
  steps: StepResult[];
  created: CreatedRecord[];
  swept: string[];
  unrecorded: string[]; // there before the run and unknown to the ledger — reported, never deleted
  appeared?: string[]; // appeared DURING the run, unknown to the ledger — a missed create path; fails the run
  orphanIntents: string[]; // API creates that may have landed without their id — check by hand
  blockedDeletes: string[]; // ledger ids NOT deleted because the server showed parts the ledger doesn't know
  failedDeletes: string[]; // `<id>: <error>` — a removal (still pending, the sweep retries) or read-back that threw; the loop went on
  consoleErrors: string[];
  throttled: string[]; // every HTTP 429 the page got, in order: `/api/<method>`, else the path — names what never ran
  injected: string[]; // failures the harness itself served (ctx.intercept): `/api/<method> → 429|dropped`
  shots: string[];
  durationMs: number;
  crash?: string;
}

const STATUS_DETAIL_MAX = 200;
// `FAIL: <codes>` exactly for a step-only failure (a step's text is in its row; readers match the bare line), then the harness
// failures' detail on one line — their one-liners name their cause, so the code isn't repeated here.
export function statusLine(r: RunResult): string {
  if (r.status !== 'FAIL') return r.status;
  const line = `FAIL: ${[...new Set(r.codes)].join(', ')}`;
  if (!r.failures.length) return line;
  const detail = r.failures.map((f) => f.message.replace(/\s*\n\s*/g, ' ').trim()).join(' · ');
  return `${line} — ${detail.length > STATUS_DETAIL_MAX ? `${detail.slice(0, STATUS_DETAIL_MAX - 1)}…` : detail}`;
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const ROW_LABEL: Record<RowStatus, string> = {
  pass: 'pass',
  fail: 'fail',
  skipped: 'skipped',
  'off-dev': 'off dev',
  'needs-you': 'needs you',
};

const item = (x: RowResult) => `- ${x.scenario}: ${x.what}`;
const isUnproven = (x: RowResult) => x.status === 'fail' || x.status === 'skipped';
const counts = (rs: RowResult[], lead = 'Proven on dev') => {
  const n = (...st: RowStatus[]) => rs.filter((x) => st.includes(x.status)).length;
  return `${lead} **${n('pass')}** · off dev **${n('off-dev')}** · needs you **${n('needs-you')}** · not proven **${rs.filter(isUnproven).length}**`;
};
const table = (rs: RowResult[]) => [
  '| Scenario | Row | Kind | Entry | Proven by | Result |',
  '| --- | --- | --- | --- | --- | --- |',
  ...rs.map(
    (x) =>
      `| ${x.scenario} | ${cell(x.what)} | ${x.kind} | ${x.entry} | ${cell(x.provenBy)} | ${ROW_LABEL[x.status]} |`,
  ),
];
function notProven(rs: RowResult[], h: string): string[] {
  const un = rs.filter(isUnproven);
  if (!un.length) return [];
  return [
    '',
    `${h} Not proven on dev`,
    '',
    ...un.map(
      (x) =>
        `${item(x)} — ${x.failedSteps?.length ? `step ${x.failedSteps.join(', ')} failed` : (x.note ?? 'its steps never ran')}`,
    ),
  ];
}
// The two lists report-<branch>.md and the CC done notes paste. They stand on a FAIL too, but never without the
// run's verdict beside them.
function pasteLists(rs: RowResult[], h: string, status: RunResult['status']): string[] {
  const done = rs.filter((x) => x.status === 'pass' || x.status === 'off-dev');
  const you = rs.filter((x) => x.status === 'needs-you');
  return [
    '',
    `${h} You don't need to test`,
    '',
    ...(status !== 'PASS'
      ? [`_This run is ${status}: these hold only once a run passes._`, '']
      : []),
    ...(done.length
      ? done.map((x) =>
          x.status === 'off-dev' ? `${item(x)} — covered off dev by ${x.note}` : item(x),
        )
      : ['Nothing yet.']),
    '',
    `${h} Needs you`,
    '',
    ...(you.length ? you.map((x) => `${item(x)} — ${x.note}`) : ['Nothing.']),
  ];
}

// The feature's rows first, so the report says what was proven before how the steps went — and apart from
// every other scenario's, so the paste lists never carry another feature's rows.
function renderCoverage(
  rows: RowResult[],
  status: RunResult['status'],
  feature: string[],
): string[] {
  const lines = ['', '## Feature coverage', ''];
  if (!rows.length) return [...lines, 'No feature rows in this run — smoke proves the harness.'];
  if (!feature.length)
    return [
      ...lines,
      '_No `--feature` named: these rows are every scenario in the run, so there is nothing to paste as “You don’t need to test” / “Needs you” — a branch with no scenario of its own reports “no feature rows”._',
      '',
      counts(rows),
      '',
      ...table(rows),
      ...notProven(rows, '###'),
    ];
  // selectFeature guarantees each feature scenario ran and declares rows; never paste an empty section anyway.
  const mine = rows.filter((x) => feature.includes(x.scenario));
  if (!mine.length)
    return [
      ...lines,
      `No rows of ${feature.join(', ')} in this run — nothing proven, nothing to paste.`,
    ];
  const others = rows.filter((x) => !feature.includes(x.scenario));
  lines.push(
    `### This feature: ${feature.join(', ')}`,
    '',
    counts(mine),
    '',
    ...table(mine),
    ...notProven(mine, '####'),
    ...pasteLists(mine, '####', status),
  );
  if (others.length)
    lines.push(
      '',
      '### Other scenarios (regression)',
      '',
      '_Their lists belong to their own features — nothing here is this feature’s paste. A row not proven here is a regression to triage (CLAUDE.md → phase 9) unless its reason says otherwise._',
      '',
      ...[...new Set(others.map((x) => x.scenario))].map(
        (id) =>
          `- ${id}: ${counts(
            others.filter((x) => x.scenario === id),
            'proven on dev',
          )}`,
      ),
      ...notProven(others, '####'),
    );
  return lines;
}

export function renderReport(r: RunResult): string {
  const left = r.created.filter((c) => c.final === 'left');
  const lines = [
    `# Dev check — ${statusLine(r)}`,
    '',
    `Run \`${r.runId}\` · tier ${r.tier} · ${sec(r.durationMs)}`,
    `Build: expected \`${r.expectedSha.slice(0, 7)}\`, start \`${r.startSha?.slice(0, 7) ?? '—'}\`, end \`${r.endSha?.slice(0, 7) ?? '—'}\`${r.deployUrl ? ` · [deploy run](${r.deployUrl})` : ''}${r.scenarioSha && r.scenarioSha !== r.expectedSha ? ` · scenarios from \`${r.scenarioSha.slice(0, 7)}${r.scenarioSha.endsWith('-dirty') ? '-dirty' : ''}\`` : ''}`,
    `Leftovers: **${left.length}**${left.length ? ` (${left.map((c) => c.id).join(', ')})` : ''}`,
  ];
  if (r.failures.length)
    lines.push('', ...r.failures.map((f) => `**Failed:** ${f.code} — ${f.message}`));
  if (r.crash) lines.push('', `**Crash:** ${r.crash}`);
  lines.push(...renderCoverage(r.coverage, r.status, r.feature));
  lines.push(
    '',
    '## Steps',
    '',
    '| Scenario | Step | Result | Time | Detail |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const s of r.steps)
    lines.push(
      `| ${s.scenario} | ${cell(s.title)} | ${s.status === 'needs-you' ? 'needs you' : s.status} | ${sec(s.ms)} | ${cell(s.error ?? s.note ?? '')}${s.shot ? ` ![](shots/${s.shot})` : ''} |`,
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
  if (r.failedDeletes.length)
    lines.push(
      `- **Removal or read-back threw** (the rest were still cleaned; a failed removal stays pending for the next run's sweep): ${r.failedDeletes.join('; ')}`,
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
  // A 429 is Lambda refusing to start the function, so the call never ran (docs/ops/DEV-CHECK.md → Throttles (429)). Chromium's
  // console line for it carries no URL; this names each one.
  lines.push(
    '',
    '## Throttled (429)',
    '',
    ...(r.throttled.length ? r.throttled.map((t) => `- \`${cell(t)}\``) : ['None.']),
  );
  // A scenario's own injected failures (ctx.intercept) — kept apart from real throttles, so neither reads as the other.
  lines.push(
    '',
    '## Injected by the harness',
    '',
    ...(r.injected.length ? r.injected.map((t) => `- \`${cell(t)}\``) : ['None.']),
  );
  lines.push(
    '',
    '## Screenshots',
    '',
    ...(r.shots.length ? r.shots.map((s) => `- [${s}](shots/${s})`) : ['None.']),
  );
  return lines.join('\n') + '\n';
}
