// The web tower's GitHub reads, all through the container's read-only `gh` (docs/ops/TOWER.md → Panels): Actions
// runs once a minute, each open PR's checks by head sha and a PR's files once per head sha. Every cache keeps its
// last good value, the time it got it and the last error: a failed read shows as failed, never empty.
import { execFile } from 'node:child_process';
import { clean, parseTime } from './fmt.ts';
import { REPO_SLUG } from '../../identifiers.ts';
export { REPO_SLUG };

export type GhRun = {
  id: number;
  name: string; // the workflow's name: `Deploy`, `PR`, `Deploy dev (dispatch)`
  title: string; // display_title, the run-name: `deploy-dev <sha> <key>` for a dev dispatch (bot/dispatch.ts)
  event: string;
  branch: string; // head_branch
  sha: string;
  status: string; // queued | in_progress | completed | …
  conclusion: string | null;
  startedAt: number | null;
  createdAt: number | null;
  url: string | null;
  number: number | null;
};

export type GhText = (args: string[]) => Promise<string>;
export const ghText: GhText = (args) =>
  new Promise((resolve, reject) =>
    execFile('gh', args, { timeout: 8000, maxBuffer: 8 << 20 }, (err, out) =>
      err ? reject(err) : resolve(out),
    ),
  );

const errText = (e: unknown) =>
  clean(((e as Error)?.message || 'failed').split('\n')[0]!).slice(0, 80);
const s = (x: unknown) => (typeof x === 'string' ? clean(x) : '');

export function parseRuns(text: string): GhRun[] {
  const raw = JSON.parse(text) as { workflow_runs?: unknown };
  if (!raw || !Array.isArray(raw.workflow_runs)) throw new Error('actions/runs: no workflow_runs');
  return (raw.workflow_runs as Record<string, unknown>[])
    .filter((r) => Number.isInteger(r?.id))
    .map((r) => ({
      id: r.id as number,
      name: s(r.name),
      title: s(r.display_title),
      event: s(r.event),
      branch: s(r.head_branch),
      sha: s(r.head_sha),
      status: s(r.status),
      conclusion: typeof r.conclusion === 'string' ? r.conclusion : null,
      startedAt: parseTime(r.run_started_at),
      createdAt: parseTime(r.created_at),
      url:
        typeof r.html_url === 'string' && r.html_url.startsWith('https://github.com/')
          ? s(r.html_url)
          : null,
      number: Number.isInteger(r.run_number) ? (r.run_number as number) : null,
    }));
}

export type Cached<T> = { value: T; at: number | null; error: string | null; tried: number | null };

// One fetch at a time, at most once per `everyMs`.
export class Poller<T> {
  state: Cached<T>;
  private busy = false;
  private load: () => Promise<T>;
  private everyMs: number;
  constructor(init: T, load: () => Promise<T>, everyMs: number) {
    this.state = { value: init, at: null, error: null, tried: null };
    this.load = load;
    this.everyMs = everyMs;
  }
  async poll(now: number): Promise<void> {
    if (this.busy || (this.state.tried !== null && now - this.state.tried < this.everyMs)) return;
    this.busy = true;
    this.state.tried = now;
    try {
      this.state.value = await this.load();
      this.state.at = now;
      this.state.error = null;
    } catch (e) {
      this.state.error = errText(e);
    } finally {
      this.busy = false;
    }
  }
}

// The newest 100 runs: main's Deploy runs (DONE TODAY, DEPLOYING, the HOLD) and dev dispatches (deploying).
export const runsPoller = (gh: GhText, everyMs = 60000) =>
  new Poller<GhRun[]>(
    [],
    async () => parseRuns(await gh(['api', `repos/${REPO_SLUG}/actions/runs?per_page=100`])),
    everyMs,
  );

// A PR's changed files, fetched once per head sha (the automatic HOLD's devb rule needs them). A failed read is
// retried after a minute, not every tick.
export class FilesCache {
  private map = new Map<string, { files: string[] | null; error: string | null; tried: number }>();
  private busy = new Set<string>();
  private gh: GhText;
  constructor(gh: GhText) {
    this.gh = gh;
  }
  get(sha: string): { files: string[] | null; error: string | null } | null {
    return this.map.get(sha) ?? null;
  }
  async want(pr: number, sha: string, now: number): Promise<void> {
    const c = this.map.get(sha);
    if (this.busy.has(sha) || c?.files || (c && now - c.tried < 60000)) return;
    this.busy.add(sha);
    try {
      const out = JSON.parse(
        await this.gh(['pr', 'view', String(pr), '--json', 'files,headRefOid']),
      ) as { files?: { path?: unknown }[]; headRefOid?: string };
      if (out.headRefOid !== sha) throw new Error('head moved'); // the next PR poll brings the new sha
      const files = (out.files ?? []).map((f) => s(f.path)).filter(Boolean);
      this.map.set(sha, { files, error: null, tried: now });
    } catch (e) {
      this.map.set(sha, { files: null, error: errText(e), tried: now });
    } finally {
      this.busy.delete(sha);
    }
    if (this.map.size > 50) this.map.delete(this.map.keys().next().value!);
  }
}

// An open PR's checks: the pull_request runs for its head sha (`gh pr` can't read check rollups with this token).
// Re-read every minute while any is unfinished or none is seen yet, every 2 min once all finished (a re-run shows
// within that).
export type Checks = { runs: GhRun[]; at: number | null; error: string | null };
export class ChecksCache {
  private map = new Map<string, Checks & { tried: number }>();
  private busy = new Set<string>();
  private gh: GhText;
  constructor(gh: GhText) {
    this.gh = gh;
  }
  get(sha: string): Checks | null {
    return this.map.get(sha) ?? null;
  }
  async want(sha: string, now: number): Promise<void> {
    const c = this.map.get(sha);
    const done = !!c?.at && c.runs.length > 0 && c.runs.every((r) => r.status === 'completed');
    if (this.busy.has(sha) || (c && now - c.tried < (done ? 120000 : 60000))) return;
    this.busy.add(sha);
    try {
      const runs = parseRuns(
        await this.gh([
          'api',
          `repos/${REPO_SLUG}/actions/runs?head_sha=${sha}&event=pull_request&per_page=30`,
        ]),
      );
      // a re-run replaces its workflow's earlier run: keep the newest per workflow name
      const newest = new Map<string, GhRun>();
      for (const r of runs) {
        const o = newest.get(r.name);
        if (!o || (r.createdAt ?? 0) > (o.createdAt ?? 0)) newest.set(r.name, r);
      }
      this.map.set(sha, { runs: [...newest.values()], at: now, error: null, tried: now });
    } catch (e) {
      // keeps the last runs for the record, but derive.ts never turns them green while `error` is set
      this.map.set(sha, { runs: c?.runs ?? [], at: c?.at ?? null, error: errText(e), tried: now });
    } finally {
      this.busy.delete(sha);
    }
    if (this.map.size > 50) this.map.delete(this.map.keys().next().value!);
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
// UTC month key, for the AWS costs read
export const monthKey = (now: number) => {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
};
