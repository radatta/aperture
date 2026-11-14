// The web tower's GitHub reads, all through the container's read-only `gh` (docs/ops/TOWER.md → Sources): Actions
// runs once a minute, a PR's files once per head sha, and the month's Actions minutes as an hourly estimate. Every
// cache keeps its last good value, the time it got it and the last error: a failed read shows as failed, never empty.
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { clean, parseTime } from './fmt.ts';

export const REPO_SLUG = 'radatta/aperture';
export const ACTIONS_INCLUDED_MIN = 3000; // Rahul's plan (Student Pro): the page says "of 3,000 (plan)"

export type GhRun = {
  id: number;
  name: string; // the workflow's run name: `Deploy`, `PR`, or `deploy-dev <sha> <key>` for a dispatch
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

const errText = (e: unknown) => clean(((e as Error)?.message || 'failed').split('\n')[0]!).slice(0, 80);
const s = (x: unknown) => (typeof x === 'string' ? clean(x) : '');

export function parseRuns(text: string): GhRun[] {
  const raw = JSON.parse(text) as { workflow_runs?: unknown };
  if (!raw || !Array.isArray(raw.workflow_runs)) throw new Error('actions/runs: no workflow_runs');
  return (raw.workflow_runs as Record<string, unknown>[])
    .filter((r) => Number.isInteger(r?.id))
    .map((r) => ({
      id: r.id as number,
      name: s(r.name),
      event: s(r.event),
      branch: s(r.head_branch),
      sha: s(r.head_sha),
      status: s(r.status),
      conclusion: typeof r.conclusion === 'string' ? r.conclusion : null,
      startedAt: parseTime(r.run_started_at),
      createdAt: parseTime(r.created_at),
      url: typeof r.html_url === 'string' && r.html_url.startsWith('https://github.com/') ? s(r.html_url) : null,
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

// A PR's changed files, fetched once per head sha (the automatic HOLD's devb rule needs them).
export class FilesCache {
  private map = new Map<string, { files: string[] | null; error: string | null }>();
  private busy = new Set<string>();
  private gh: GhText;
  constructor(gh: GhText) {
    this.gh = gh;
  }
  get(sha: string) {
    return this.map.get(sha) ?? null;
  }
  async want(pr: number, sha: string): Promise<void> {
    if (this.busy.has(sha) || this.map.get(sha)?.files) return;
    this.busy.add(sha);
    try {
      const out = JSON.parse(await this.gh(['pr', 'view', String(pr), '--json', 'files,headRefOid'])) as {
        files?: { path?: unknown }[];
        headRefOid?: string;
      };
      if (out.headRefOid !== sha) throw new Error('head moved'); // the next poll asks for the new sha
      this.map.set(sha, { files: (out.files ?? []).map((f) => s(f.path)).filter(Boolean), error: null });
    } catch (e) {
      this.map.set(sha, { files: null, error: errText(e) });
    } finally {
      this.busy.delete(sha);
    }
    if (this.map.size > 50) this.map.delete(this.map.keys().next().value!);
  }
}

// Actions minutes this month, ESTIMATED: the container token can't read billing (403), so each run's jobs are
// summed, each job rounded up to a whole minute (GitHub's per-job rounding), cached per run on disk.
export type Minutes = { month: string; minutes: number; counted: number; total: number; capped: boolean };
type MinutesFile = { v: 1; month: string; runs: Record<string, number> };

export const monthKey = (now: number) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export function jobMinutes(text: string): number {
  const raw = JSON.parse(text) as { jobs?: { started_at?: unknown; completed_at?: unknown }[] };
  if (!raw || !Array.isArray(raw.jobs)) throw new Error('jobs: no jobs array');
  let m = 0;
  for (const j of raw.jobs) {
    const a = parseTime(j.started_at);
    const b = parseTime(j.completed_at);
    if (a !== null && b !== null && b > a) m += Math.ceil((b - a) / 60000);
  }
  return m;
}

export class MinutesCache {
  private file: string;
  private gh: GhText;
  private perCycle: number;
  private data: MinutesFile;
  constructor(file: string, gh: GhText, perCycle = 100) {
    this.file = file;
    this.gh = gh;
    this.perCycle = perCycle;
    this.data = { v: 1, month: '', runs: {} };
    try {
      const d = JSON.parse(readFileSync(file, 'utf8')) as MinutesFile;
      if (d?.v === 1 && d.runs && typeof d.runs === 'object') this.data = d;
    } catch {
      // first run
    }
  }

  // Lists this month's completed runs (paged), then fetches jobs for up to `perCycle` uncounted ones.
  async load(now: number): Promise<Minutes> {
    const month = monthKey(now);
    if (this.data.month !== month) this.data = { v: 1, month, runs: {} };
    const ids: number[] = [];
    for (let page = 1; page <= 20; page++) {
      const runs = parseRuns(
        await this.gh(['api', `repos/${REPO_SLUG}/actions/runs?created=>=${month}-01&status=completed&per_page=100&page=${page}`]),
      );
      ids.push(...runs.map((r) => r.id));
      if (runs.length < 100) break;
    }
    const todo = ids.filter((id) => !(String(id) in this.data.runs));
    for (const id of todo.slice(0, this.perCycle))
      this.data.runs[String(id)] = jobMinutes(await this.gh(['api', `repos/${REPO_SLUG}/actions/runs/${id}/jobs?per_page=100`]));
    this.save();
    const counted = ids.filter((id) => String(id) in this.data.runs);
    return {
      month,
      minutes: counted.reduce((n, id) => n + this.data.runs[String(id)]!, 0),
      counted: counted.length,
      total: ids.length,
      capped: ids.length >= 2000,
    };
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.data) + '\n');
    renameSync(tmp, this.file);
  }
}

export const minutesPoller = (cache: MinutesCache, clock: () => number, everyMs = 3600000) =>
  new Poller<Minutes | null>(null, () => cache.load(clock()), everyMs);

// An open PR's checks: the pull_request runs for its head sha (`gh pr` can't read check rollups with this
// token). Re-read every minute while any is unfinished or none is seen yet, every 10 min once all finished.
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
    if (this.busy.has(sha) || (c && now - c.tried < (done ? 600000 : 60000))) return;
    this.busy.add(sha);
    try {
      const runs = parseRuns(
        await this.gh(['api', `repos/${REPO_SLUG}/actions/runs?head_sha=${sha}&event=pull_request&per_page=30`]),
      );
      // a re-run replaces its workflow's earlier run: keep the newest per workflow name
      const newest = new Map<string, GhRun>();
      for (const r of runs) {
        const o = newest.get(r.name);
        if (!o || (r.createdAt ?? 0) > (o.createdAt ?? 0)) newest.set(r.name, r);
      }
      this.map.set(sha, { runs: [...newest.values()], at: now, error: null, tried: now });
    } catch (e) {
      this.map.set(sha, { runs: c?.runs ?? [], at: c?.at ?? null, error: errText(e), tried: now });
    } finally {
      this.busy.delete(sha);
    }
    if (this.map.size > 50) this.map.delete(this.map.keys().next().value!);
  }
}
