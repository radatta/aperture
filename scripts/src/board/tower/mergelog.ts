// Main's own merge record: squash subjects end `(#N)`, so `git log origin/main --first-parent` says which PRs
// merged, when and as which sha — offline, past `gh pr list`'s newest 40, and while gh fails (TOWER.md → Board
// freshness). Pure parse; web/main.ts reads the log at most once a minute.
import type { Pr } from './prs.ts';

export type MainMerge = { number: number; sha: string; mergedAt: number };

// A branch name is reused (a new lane under an old name). With nothing naming a PR number and no lane file to date
// the lane, a merge on that name counts as this lane's only while it is under a day old: the queue never keeps a
// merged lane a day (plan-age flags a stale plan sooner), and an older one is a new lane's namesake.
export const REUSE_MS = 24 * 3600e3;

export const MAINLOG_ARGS = [
  'log',
  'origin/main',
  '--first-parent',
  '-n',
  '400',
  '--format=%H%x09%ct%x09%s',
];

const LINE = /^([0-9a-f]{40})\t(\d+)\t.*\(#(\d+)\)$/;

export function parseMainLog(text: string): MainMerge[] {
  const out: MainMerge[] = [];
  for (const l of text.split('\n')) {
    const m = LINE.exec(l.trimEnd());
    if (m) out.push({ number: +m[3]!, sha: m[1]!, mergedAt: +m[2]! * 1000 });
  }
  return out;
}

// A PR some board record names (queue, lane file, landing order) that main's log shows merged but gh's list
// doesn't hold: a MERGED Pr standing in for it, on the branch that named it.
export function mergedFromLog(
  named: { branch: string; pr: number | null }[],
  prs: Pr[],
  log: MainMerge[],
): Pr[] {
  const out: Pr[] = [];
  for (const n of named) {
    if (n.pr === null || prs.some((p) => p.number === n.pr) || out.some((p) => p.number === n.pr))
      continue;
    const m = log.find((x) => x.number === n.pr);
    if (!m) continue;
    out.push({
      number: m.number,
      title: `PR ${m.number}`,
      branch: n.branch,
      state: 'MERGED',
      mergedAt: m.mergedAt,
      createdAt: null,
      sha: null,
      mergeSha: m.sha,
      url: null,
      draft: false,
    });
  }
  return out;
}

// Every PR number main shows merged, with when: gh's merged list over the log (gh's time is the merge's own).
export function mergedNumbers(prs: Pr[], log: MainMerge[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const x of log) m.set(x.number, x.mergedAt);
  for (const p of prs) if (p.state === 'MERGED' && p.mergedAt !== null) m.set(p.number, p.mergedAt);
  return m;
}
