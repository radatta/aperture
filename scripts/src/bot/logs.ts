// `pnpm bot logs [--since 30m | --start ISO --end ISO] [--groups bff,mcp] [--filter P] [--query Q]`
// Dispatches fetch-dev-logs.yml (dev groups only — logs-spec.ts) and downloads its artifact into
// localNotes/devlogs/<key>/. Loop guard: at most 10 fetches an hour per worktree, then it stops and says so —
// Actions minutes are the real budget (docs/ops/CI-BOT.md → Dev logs).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Api } from './api.ts';
import { REPO_SLUG } from './config.ts';
import type { Clock, Run } from './dispatch.ts';
import { dispatchAndWait } from './dispatch.ts';
import { featureBranch, runKey } from './git.ts';
import { heldSlot } from './lock.ts';
import { parseLogsRequest } from './logs-spec.ts';
import type { Run as Sh } from './sh.ts';

export const MAX_FETCHES_PER_HOUR = 10;
const HOUR = 60 * 60_000;

export interface LogsArgs {
  since?: string;
  start?: string;
  end?: string;
  groups?: string;
  filter?: string;
  query?: string;
}

// `30m`, `2h`, `90s` → ms.
export function parseSince(s: string): number {
  const m = /^(\d+)\s*([smh])$/.exec(s.trim());
  if (!m?.[1] || !m[2]) throw new Error(`--since takes 90s / 30m / 2h (got "${s}")`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: HOUR }[m[2] as 's' | 'm' | 'h'];
}

// Refuses the (max+1)th fetch inside a rolling hour; records the ones it lets through.
export function checkLoopGuard(file: string, nowMs: number, max = MAX_FETCHES_PER_HOUR): void {
  const recent = existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { at: number }).at)
        .filter((t) => nowMs - t < HOUR)
    : [];
  if (recent.length >= max) {
    const wait = Math.ceil((Math.min(...recent) + HOUR - nowMs) / 60_000);
    throw new Error(
      `${recent.length} dev-log fetches in the last hour (limit ${max}) — stop and tell the user; the next slot opens in ${wait} min`,
    );
  }
}

export async function fetchLogs(
  sh: Sh,
  api: Api,
  token: string,
  clock: Clock,
  args: LogsArgs,
  root: string,
  log: (s: string) => void = console.log,
): Promise<string> {
  const now = clock.now();
  const end = args.end ?? new Date(now).toISOString();
  const start =
    args.start ?? new Date(Date.parse(end) - parseSince(args.since ?? '30m')).toISOString();
  let label = 'logs'; // a detached checkout (e.g. /workspace on main) may still read logs
  try {
    label = featureBranch(sh);
  } catch {
    // keep the generic label
  }
  const key = runKey(label, now);
  // No --groups: the slot this branch holds a lock on (slot B's groups carry `-devb`), else slot A's.
  let groups = args.groups;
  if (groups === undefined) {
    const slot = label === 'logs' ? null : await heldSlot(api, label).catch(() => null);
    groups = slot === 'devb' ? 'bff-devb,mcp-devb' : 'bff,mcp';
    if (slot === 'devb')
      log(`${label} holds the devb lock — reading devb's groups (--groups to choose)`);
  }
  const req = parseLogsRequest({ start, end, groups, key }, now); // before spending a run
  const dir = join(root, 'localNotes', 'devlogs');
  mkdirSync(dir, { recursive: true });
  const ledger = join(dir, 'fetches.jsonl');
  checkLoopGuard(ledger, now);
  appendFileSync(ledger, `${JSON.stringify({ at: now, key, groups: req.groups })}\n`);

  const run: Run = await dispatchAndWait(api, clock, {
    workflow: 'fetch-dev-logs.yml',
    inputs: {
      start,
      end,
      groups: req.groups.join(','),
      filter: args.filter ?? '',
      query: args.query ?? '',
    },
    key,
    title: (k) => `dev-logs ${k}`,
    timeoutMs: 10 * 60_000,
    log,
  });
  // The artifact carries the run's own key (a cancelled-and-retried run has `-r`).
  const runKeyUsed = run.display_title.replace(/^dev-logs /, '');
  const out = join(dir, runKeyUsed);
  try {
    sh(
      'gh',
      [
        'run',
        'download',
        String(run.id),
        '-R',
        REPO_SLUG,
        '-n',
        `dev-logs-${runKeyUsed}`,
        '-D',
        out,
      ],
      { env: { ...process.env, GH_TOKEN: token } },
    );
  } catch (err) {
    throw new Error(
      `fetch-dev-logs ${run.conclusion} (${run.html_url}) and no artifact: ${(err as Error).message}`,
      { cause: err },
    );
  }
  for (const f of readdirSync(out)) {
    const lines = readFileSync(join(out, f), 'utf8').trimEnd().split('\n');
    log(
      `\n== ${f} (${lines.filter(Boolean).length} lines) — last 40 ==\n${lines.slice(-40).join('\n')}`,
    );
  }
  if (run.conclusion !== 'success') log(`\nfetch-dev-logs ${run.conclusion}: ${run.html_url}`);
  log(`\nfull logs: ${out}`);
  return out;
}
