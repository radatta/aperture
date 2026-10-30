// Runs in fetch-dev-logs.yml under the dev-only logs role: pulls one time window of the allowlisted dev Lambda
// log groups into ./dev-logs/<group>.log for the workflow to upload as an artifact (docs/ops/CI-BOT.md).
// Inputs arrive as env (START, END, LOG_GROUPS, FILTER, QUERY, KEY) and are re-validated here — the dispatch is
// the bot's, but this step must not trust it. QUERY set → Logs Insights per group; else filter-log-events
// (FILTER optional). Needs the `aws` CLI; region from AWS_REGION (configure-aws-credentials).
// Usage (CI only): node scripts/aws/fetch-dev-logs.mjs
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseLogsRequest } from '../src/bot/logs-spec.ts';

const env = process.env;
const req = parseLogsRequest({
  start: env.START ?? '',
  end: env.END ?? '',
  groups: env.LOG_GROUPS ?? '',
  key: env.KEY ?? '',
});
const MAX_EVENTS = 20000;
const OUT = 'dev-logs';
mkdirSync(OUT, { recursive: true });

const aws = (args) =>
  JSON.parse(
    execFileSync('aws', [...args, '--output', 'json'], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    }) || '{}',
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(Number(ms)).toISOString();

async function insights(group) {
  const { queryId } = aws([
    'logs',
    'start-query',
    '--log-group-name',
    group,
    '--start-time',
    String(Math.floor(req.startMs / 1000)),
    '--end-time',
    String(Math.ceil(req.endMs / 1000)),
    '--query-string',
    env.QUERY,
    '--limit',
    '10000',
  ]);
  for (let i = 0; i < 60; i++) {
    const res = aws(['logs', 'get-query-results', '--query-id', queryId]);
    if (res.status === 'Complete')
      return res.results.map((row) =>
        JSON.stringify(Object.fromEntries(row.map((f) => [f.field, f.value]))),
      );
    if (['Failed', 'Cancelled', 'Timeout'].includes(res.status))
      throw new Error(`Insights query ${res.status}`);
    await sleep(2000);
  }
  aws(['logs', 'stop-query', '--query-id', queryId]);
  throw new Error('Insights query still running after 120 s — stopped');
}

function filtered(group) {
  const args = [
    'logs',
    'filter-log-events',
    '--log-group-name',
    group,
    '--start-time',
    String(req.startMs),
    '--end-time',
    String(req.endMs),
    '--max-items',
    String(MAX_EVENTS),
  ];
  if (env.FILTER) args.push('--filter-pattern', env.FILTER);
  const { events = [] } = aws(args); // the CLI follows nextToken itself, up to --max-items
  return events.map((e) => `${iso(e.timestamp)} ${e.logStreamName} ${e.message.trimEnd()}`);
}

const summary = [
  `### dev logs \`${req.key}\``,
  '',
  `${iso(req.startMs)} → ${iso(req.endMs)}${env.QUERY ? ' (Insights)' : env.FILTER ? ` filter \`${env.FILTER}\`` : ''}`,
  '',
  '| group | lines |',
  '|---|---|',
];
let failed = false;
for (const [i, name] of req.groupNames.entries()) {
  const file = `${OUT}/${req.groups[i]}.log`;
  try {
    const lines = env.QUERY ? await insights(name) : filtered(name);
    writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '');
    summary.push(`| ${name} | ${lines.length}${lines.length >= MAX_EVENTS ? ' (capped)' : ''} |`);
    console.log(`${name}: ${lines.length} lines`);
  } catch (err) {
    // A group that was never written to doesn't exist yet — say so, keep the other groups.
    const msg = String(err.stderr ?? err.message ?? err)
      .trim()
      .split('\n')
      .pop();
    writeFileSync(file, `(fetch failed: ${msg})\n`);
    summary.push(`| ${name} | failed: ${msg} |`);
    console.error(`${name}: ${msg}`);
    if (!/ResourceNotFoundException/.test(msg)) failed = true;
  }
}
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
if (failed) process.exitCode = 1;
