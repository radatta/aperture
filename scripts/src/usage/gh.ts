// Merged PRs for the PR table, through the container's read-only `gh`, cached for an hour in <cache>/prs.json.
// A failed read falls back to the cache and says so; with no cache it fails loud.
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

export const PR_ARGS = [
  'pr',
  'list',
  '--repo',
  REPO_SLUG,
  '--state',
  'merged',
  '--limit',
  '300',
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

export async function mergedPRs(
  cache: string,
  o: { refresh?: boolean; now: number; gh?: GhText },
): Promise<{ prs: PR[]; note: string | null }> {
  const path = join(cache, 'prs.json');
  const cached = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as { fetchedAt: number; prs: PR[] })
    : null;
  if (cached && !o.refresh && o.now - cached.fetchedAt < 3_600_000)
    return { prs: cached.prs, note: null };
  const gh = o.gh ?? ghText;
  try {
    // one retry: a 300-PR query with files now and then fails upstream and works the second time
    const prs = parsePRs(await gh(PR_ARGS).catch(() => gh(PR_ARGS)));
    writeAtomic(path, JSON.stringify({ fetchedAt: o.now, prs }));
    return { prs, note: null };
  } catch (e) {
    if (!cached)
      throw new Error(`gh pr list failed and no cached PRs: ${(e as Error).message}`, { cause: e });
    return {
      prs: cached.prs,
      note: `gh failed; PRs as cached ${new Date(cached.fetchedAt).toISOString()}`,
    };
  }
}
