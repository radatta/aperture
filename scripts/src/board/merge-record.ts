// The main sync's merge record (docs/ops/TOWER.md → Main sync): each round, after the fetch, every squash merge that
// reached origin/main since the last round is appended to history/events-<UTC day>.jsonl as a `merged` row, for
// merge-watch.sh to wake the hub on. The baseline is its own file (<board>/merge-seen), never the checkout's old HEAD:
// `pnpm lanes start` moves that too. A first run (no baseline) or one main no longer descends from (a rewrite) only
// sets the baseline: merges are never back-filled. Events are written before the baseline moves, so a crash between
// the two repeats a row (merge-watch dedupes by sha), never loses one.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type MergeRecord = { dir: string; now: () => Date };
export type MergedEvent = {
  v: 1;
  t: string;
  kind: 'merged';
  pr: number;
  sha: string;
  mergedAt: string;
  title: string;
};

export const SEEN_FILE = 'merge-seen';
export const TITLE_MAX = 120;

const SHA = /^[0-9a-f]{40}$/;
const LINE = /^([0-9a-f]{40})\t(\d+)\t(.*)\(#(\d+)\)$/;
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
// the point: a subject's control bytes never reach a terminal
const clean = (s: string) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, TITLE_MAX);

// `git log --first-parent --reverse --format=%H%x09%ct%x09%s` → merged rows, oldest first; a subject with no `(#N)`
// (a direct commit) is no PR merge and is skipped.
export function mergedRows(log: string, now: Date): MergedEvent[] {
  const out: MergedEvent[] = [];
  for (const l of log.split('\n')) {
    const m = LINE.exec(l.trimEnd());
    if (!m) continue;
    out.push({
      v: 1,
      t: iso(now),
      kind: 'merged',
      pr: +m[4]!,
      sha: m[1]!,
      mergedAt: iso(new Date(+m[2]! * 1000)),
      title: clean(m[3]!),
    });
  }
  return out;
}

const writeSeen = (dir: string, sha: string) => {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, SEEN_FILE);
  writeFileSync(`${f}.tmp.${process.pid}`, `${sha}\n`);
  renameSync(`${f}.tmp.${process.pid}`, f);
};

const hasCommit = (git: (args: string[]) => string, sha: string) => {
  try {
    git(['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

// One line for the sync's output, or null when nothing changed. `git` throws on a non-zero exit.
export function recordMerges(
  git: (args: string[]) => string,
  target: string,
  rec: MergeRecord,
): string | null {
  let seen = '';
  try {
    seen = readFileSync(join(rec.dir, SEEN_FILE), 'utf8').trim();
  } catch {
    // first run
  }
  if (seen === target) return null;
  if (!SHA.test(seen)) {
    writeSeen(rec.dir, target);
    return `merge log: baseline set at ${target.slice(0, 7)} (nothing back-filled)`;
  }
  try {
    git(['merge-base', '--is-ancestor', seen, target]);
  } catch (e) {
    // exit 1 is "not an ancestor" (a rewrite). Anything else keeps the baseline and fails the round, unless the
    // baseline commit is simply gone from the checkout (pruned): then no round could ever read it, so it is reset too.
    if ((e as { status?: unknown }).status !== 1 && hasCommit(git, seen)) throw e;
    writeSeen(rec.dir, target);
    return `merge log: ${seen.slice(0, 7)} is not under origin/main: baseline reset at ${target.slice(0, 7)} (nothing back-filled)`;
  }
  const now = rec.now();
  const rows = mergedRows(
    git(['log', '--first-parent', '--reverse', '--format=%H%x09%ct%x09%s', `${seen}..${target}`]),
    now,
  );
  if (rows.length) {
    const hist = join(rec.dir, 'history');
    mkdirSync(hist, { recursive: true });
    appendFileSync(
      join(hist, `events-${iso(now).slice(0, 10)}.jsonl`),
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
  }
  writeSeen(rec.dir, target);
  return rows.length
    ? `merged: ${rows.map((r) => `PR ${r.pr} (${r.sha.slice(0, 7)})`).join(', ')}`
    : null;
}
