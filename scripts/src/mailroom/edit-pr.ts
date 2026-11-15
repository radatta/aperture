// `pnpm mailroom edit-pr [--title T]`: after a push to an open PR, the Mac replaces its body (and title) with
// localNotes/pr-<branch>.md, as the user, through the same PR-only token as open-pr. The Mac finds the PR from the branch
// and refuses unless it's the one open PR, the user's, onto main, at this push. Never silent: an unreachable Mac prints
// the user's `gh pr edit` line. docs/ops/MAILROOM.md → The edit-pr job.
import { featureBranch, requirePushed } from '../bot/git.ts';
import { makeEditPrJob, sha256, validateJob } from './job.ts';
import {
  EXIT,
  MAC_NOTE,
  WAIT_MS,
  budget,
  deliver,
  failed,
  macPath,
  prBody,
  refuse,
  warnings,
} from './open-pr.ts';
import type { Deps, Fallback } from './open-pr.ts';

const HINTS: Record<string, string> = {
  NO_PR: 'no open PR from this branch — open one first: pnpm mailroom open-pr --title "<title>"',
  MANY_PRS:
    'more than one open PR from this branch — close the extra one on github.com, then retry',
  WRONG_BASE: 'the open PR targets another base than main — fix it on github.com, then retry',
  UNKNOWN_JOB:
    'the installed runner predates edit-pr — reinstall from main (MAILROOM.md → Install), or run the gh pr edit line by hand',
};

const editFallback = (d: Deps, branch: string, title?: string): Fallback => ({
  line: `cd ${macPath(d.root)} && gh pr edit ${branch} --body-file localNotes/pr-${branch}.md${title ? ` --title "${title}"` : ''}${MAC_NOTE}`,
  late: `it may still edit the PR. Check its body on github.com before running:`,
});

// The PR as GitHub now holds it, through the container's read-only gh. Null when gh can't reach GitHub from here.
function readBack(d: Deps, n: number): { body: string; title: string } | null {
  try {
    return JSON.parse(d.run('gh', ['pr', 'view', String(n), '--json', 'body,title'])) as {
      body: string;
      title: string;
    };
  } catch {
    return null;
  }
}

export async function editPr(d: Deps, title?: string, waitMs = WAIT_MS): Promise<number> {
  const start = d.clock.now();
  const branch = featureBranch(d.run);
  const sha = requirePushed(d.run, branch);
  const body = prBody(d, branch, sha, title ?? '');
  if (body === null) return EXIT.failed;
  const job = makeEditPrJob(
    title ? { branch, sha, title, body } : { branch, sha, body },
    d.clock.now(),
  );
  const bad = validateJob(job, job.id, d.clock.now());
  if (bad) return refuse(d, job, bad);

  const r = await deliver(d, job, budget(d, start, waitMs), editFallback(d, branch, title));
  if (typeof r === 'number') return r;
  warnings(d, r);
  if (r.status !== 'edited' || !r.pr) {
    const code = failed(d, r);
    const hint = r.reason ? HINTS[r.reason] : undefined;
    if (hint) d.log(hint);
    return code;
  }
  if (r.pr.headSha !== sha) {
    d.log(
      `edited ${r.pr.url}, but it is on ${r.pr.headSha.slice(0, 7)}, not ${sha.slice(0, 7)} — check it`,
    );
    return EXIT.failed;
  }
  if (r.bodySha256 !== job.params.bodySha256) {
    d.log(`edited ${r.pr.url}, but GitHub holds a different body (sha ${r.bodySha256}) — check it`);
    return EXIT.failed;
  }
  const now = readBack(d, r.pr.number);
  if (!now) {
    d.log(
      `edited ${r.pr.url} (author ${r.pr.author}); couldn't re-read it from here, the Mac's hash matched`,
    );
    return EXIT.ok;
  }
  if (sha256(now.body) !== job.params.bodySha256 || (title !== undefined && now.title !== title)) {
    d.log(`edited ${r.pr.url}, but it reads back different from what was sent — check it`);
    return EXIT.failed;
  }
  d.log(`edited ${r.pr.url} (author ${r.pr.author})`);
  return EXIT.ok;
}
