// Merged PRs for the PR table, through the container's read-only `gh`, cached for an hour in <cache>/prs.json.
// A refetch asks only for PRs merged since the cache's newest (a merged PR's files and counts don't change), so the
// query stays one small page however many PRs merge. A failed read falls back to the cache and returns `stale`,
// which every caller prints as a header; with no cache it fails loud.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_SLUG } from '../identifiers.ts';
import { writeAtomic } from './store.ts';

export interface PR {
  number: number;
  title: string;
  branch: string;
  mergedAt: number; // epoch ms
  changedFiles: number;
  additions: number;
  deletions: number;
  files: string[];
}

export type GhText = (args: string[]) => Promise<string>;
export const ghText: GhText = (args) =>
  new Promise((resolve, reject) =>
    execFile('gh', args, { timeout: 90_000, maxBuffer: 64 << 20 }, (err, out, errOut) =>
      err
        ? reject(new Error(String(errOut).trim().split('\n')[0] || err.message.split('\n')[0]))
        : resolve(out),
    ),
  );

export const PR_LIMIT = 1000;
// The search starts LOOKBACK_DAYS before `since`: a PR merged just before it on the same branch name still bounds the
// next PR's window (prs.ts drops it from the table). The date bound makes the limit a ceiling the report warns about.
export const LOOKBACK_DAYS = 60;
export const searchFrom = (since: string) =>
  new Date(Date.parse(`${since}T00:00:00Z`) - LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
export const prArgs = (since: string, from = searchFrom(since)) => [
  'pr',
  'list',
  '--repo',
  REPO_SLUG,
  '--state',
  'merged',
  '--search',
  `merged:>=${from}`,
  '--limit',
  String(PR_LIMIT),
  '--json',
  'number,title,headRefName,mergedAt,changedFiles,additions,deletions,files',
];

export function parsePRs(text: string): PR[] {
  const raw = JSON.parse(text);
  if (!Array.isArray(raw)) throw new Error('gh pr list: not an array');
  return raw.flatMap((r: Record<string, unknown>) => {
    const mergedAt = Date.parse(String(r.mergedAt));
    if (
      !Number.isInteger(r.number) ||
      !Number.isFinite(mergedAt) ||
      typeof r.headRefName !== 'string'
    )
      return [];
    const n = (x: unknown) => (typeof x === 'number' ? x : 0);
    return [
      {
        number: r.number as number,
        title: typeof r.title === 'string' ? r.title : '',
        branch: r.headRefName,
        mergedAt,
        changedFiles: n(r.changedFiles),
        additions: n(r.additions),
        deletions: n(r.deletions),
        files: Array.isArray(r.files)
          ? r.files.flatMap((f: { path?: unknown }) =>
              typeof f?.path === 'string' ? [f.path] : [],
            )
          : [],
      },
    ];
  });
}

export const newestPR = (prs: PR[]) =>
  prs.reduce<PR | null>((a, p) => (!a || p.mergedAt > a.mergedAt ? p : a), null);

// A fetch that failed, so the cache stands in: its newest PR and when it was fetched, and gh's first error line.
export interface Stale {
  newest: number | null;
  fetchedAt: number;
  why: string;
}

const DAY_MS = 86_400_000;

export async function mergedPRs(
  cache: string,
  o: { since: string; refresh?: boolean; now: number; gh?: GhText },
): Promise<{ prs: PR[]; note: string | null; stale: Stale | null; fetchedAt: number }> {
  const path = join(cache, 'prs.json');
  // an unreadable file is no cache: the full fetch below rewrites it
  const cached = cachedPRs(cache);
  const full = (got: PR[], from: string) =>
    got.length >= PR_LIMIT
      ? `${PR_LIMIT} merged PRs since ${from}, the gh limit: older ones may be missing`
      : null;
  // a cache for an earlier --since holds every PR this one asks for: reuse it and keep its since, so a report and
  // score never refetch in turn (the cache's since only moves earlier)
  const covers = !!cached?.since && cached.since <= o.since;
  const keep = covers ? cached!.since! : o.since;
  if (cached && covers && o.now - cached.fetchedAt < 3_600_000 && !o.refresh)
    return { prs: cached.prs, note: null, stale: null, fetchedAt: cached.fetchedAt };
  const gh = o.gh ?? ghText;
  // the cache's newest merge less a day (the search reads a bare date in its own zone), else the whole lookback
  const base = cached && covers && cached.prs.length ? cached.prs : null;
  const newest = base && newestPR(base);
  const from = newest
    ? new Date(newest.mergedAt - DAY_MS).toISOString().slice(0, 10)
    : searchFrom(keep);
  const args = prArgs(keep, from);
  try {
    // one retry: a big query with files now and then fails upstream and works the second time
    const got = parsePRs(await gh(args).catch(() => gh(args)));
    const byNumber = new Map((base ?? []).map((p) => [p.number, p]));
    for (const p of got) byNumber.set(p.number, p);
    const prs = [...byNumber.values()].sort((a, b) => a.mergedAt - b.mergedAt);
    writeAtomic(path, JSON.stringify({ fetchedAt: o.now, since: keep, prs }));
    return { prs, note: full(got, from), stale: null, fetchedAt: o.now };
  } catch (e) {
    if (!cached)
      throw new Error(
        `gh failed (${(e as Error).message.split('\n')[0]}) and ${existsSync(path) ? 'cache/prs.json is unreadable' : 'there is no cache/prs.json'}`,
        { cause: e },
      );
    const why = (e as Error).message.split('\n')[0]!;
    return {
      prs: cached.prs,
      note: null,
      fetchedAt: cached.fetchedAt,
      stale: {
        newest: newestPR(cached.prs)?.number ?? null,
        fetchedAt: cached.fetchedAt,
        why: covers ? why : `${why}; the cache is for --since ${cached.since ?? '?'}`,
      },
    };
  }
}

// The cached PR list as it is, never refetched (`pnpm usage estimate` stays offline); null with no cache or an
// unreadable one.
export function cachedPRs(
  cache: string,
): { prs: PR[]; fetchedAt: number; since: string | null } | null {
  try {
    const c = JSON.parse(readFileSync(join(cache, 'prs.json'), 'utf8'));
    return Array.isArray(c?.prs) && Number.isFinite(c.fetchedAt)
      ? {
          prs: c.prs as PR[],
          fetchedAt: Number(c.fetchedAt),
          // a since that isn't a real day reads as none (it seeds the search's lookback)
          since:
            typeof c.since === 'string' &&
            /^\d{4}-\d{2}-\d{2}$/.test(c.since) &&
            Number.isFinite(Date.parse(`${c.since}T00:00:00Z`))
              ? c.since
              : null,
        }
      : null;
  } catch {
    return null;
  }
}
