// The run's report: status line first (PASS / FAIL: <codes> / CRASH), then what ran, against which build,
// what it created and what's left. report.md is for reading (Claude reads it, then the screenshots);
// report.json is the same result for tooling.
import type { ReasonCode } from './errors';

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
  startSha?: string;
  endSha?: string;
  deployUrl?: string;
  status: 'PASS' | 'FAIL' | 'CRASH';
  codes: ReasonCode[];
  steps: StepResult[];
  created: CreatedRecord[];
  swept: string[];
  unrecorded: string[]; // there before the run and unknown to the ledger — reported, never deleted
  appeared?: string[]; // appeared DURING the run, unknown to the ledger — a missed create path; fails the run
  orphanIntents: string[]; // API creates that may have landed without their id — check by hand
  blockedDeletes: string[]; // ledger ids NOT deleted because the server showed parts the ledger doesn't know
  consoleErrors: string[];
  shots: string[];
  durationMs: number;
  crash?: string;
}

export const statusLine = (r: RunResult): string =>
  r.status === 'FAIL' ? `FAIL: ${[...new Set(r.codes)].join(', ')}` : r.status;

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function renderReport(r: RunResult): string {
  const left = r.created.filter((c) => c.final === 'left');
  const lines = [
    `# Dev check — ${statusLine(r)}`,
    '',
    `Run \`${r.runId}\` · tier ${r.tier} · ${sec(r.durationMs)}`,
    `Build: expected \`${r.expectedSha.slice(0, 7)}\`, start \`${r.startSha?.slice(0, 7) ?? '—'}\`, end \`${r.endSha?.slice(0, 7) ?? '—'}\`${r.deployUrl ? ` · [deploy run](${r.deployUrl})` : ''}`,
    `Leftovers: **${left.length}**${left.length ? ` (${left.map((c) => c.id).join(', ')})` : ''}`,
  ];
  if (r.crash) lines.push('', `**Crash:** ${r.crash}`);
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
  lines.push(
    '',
    '## Screenshots',
    '',
    ...(r.shots.length ? r.shots.map((s) => `- [${s}](shots/${s})`) : ['None.']),
  );
  return lines.join('\n') + '\n';
}
