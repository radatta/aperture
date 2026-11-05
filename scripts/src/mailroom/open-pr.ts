// `pnpm mailroom open-pr` / `probe`: hand the Mac mailroom a job and report what it did. The PR is opened on the
// Mac with the user's PR-only token, so it is theirs; the bot never opens one (docs/ops/CI-BOT.md). Never silent:
// an unreachable Mac prints the hand-off command. docs/ops/MAILROOM.md.
import { join } from 'node:path';
import type { Clock } from '../bot/dispatch.ts';
import { featureBranch, requirePushed } from '../bot/git.ts';
import type { Run } from '../bot/sh.ts';
import { BRANCH_RE, REASON_HINT, makeOpenPrJob, validateJob } from './job.ts';
import type { Job } from './job.ts';
import { NotInstalled, lastSeen, submit, waitForResult, withdraw } from './submit.ts';
import type { Fs, Result } from './submit.ts';

export const MAC_ROOT = '/Users/rahuldatta/Coding/Personal/aperture';
export const macPath = (p: string) =>
  p === '/workspace' || p.startsWith('/workspace/') ? MAC_ROOT + p.slice('/workspace'.length) : p;
export const RENEW_LINE = `cd ${MAC_ROOT} && security add-generic-password -a "$USER" -s aperture-mailroom-gh -T /usr/bin/security -U -w`;
// The one install line (MAILROOM.md → Install): install.sh fetched from merged main, never the shared folder's copy.
export const INSTALL_LINE = `cd ${MAC_ROOT} && /bin/bash <(curl -sSf -H @<(printf 'Authorization: Bearer %s\\n' "$(security find-generic-password -s aperture-mailroom-gh -w)") -H 'Accept: application/vnd.github.raw+json' 'https://api.github.com/repos/radatta/aperture/contents/tools/mailroom/install.sh?ref=main')`;
const GRACE_MS = 30_000; // after a failed withdraw the Mac holds the job: give it this long to finish
// Wait + grace stays under the Bash tool's 120 s default timeout, so a caller is never killed before the withdraw.
export const WAIT_MS = 75_000;

// The branch is pushed (checked before submit), so a 404 on its ref means the token can't see it.
const HEAD_MISSING_HINT =
  'GitHub hid the pushed branch from the mailroom token — it lacks access to radatta/aperture or Contents: read (MAILROOM.md → The token)';

export const EXIT = { ok: 0, failed: 1, usage: 2, unreachable: 3 } as const;

export interface Deps {
  run: Run;
  fs: Fs;
  clock: Clock;
  dir: string; // .hostjobs
  root: string; // this worktree
  repoVersion: () => string;
  log: (s: string) => void;
}

const handOff = (d: Deps, branch: string, title: string) =>
  `cd ${macPath(d.root)} && gh pr create --title "${title}" --body-file localNotes/pr-${branch}.md`;

function unreachable(d: Deps, why: string, branch: string, title: string, late = false): number {
  if (late) {
    d.log(
      `MAC_UNREACHABLE: the Mac took the job but sent no result yet — it may still open the PR.`,
    );
    d.log(
      `Check before opening it by hand: gh pr list --head ${branch}; then, only if none:\n  ${handOff(d, branch, title)}`,
    );
    return EXIT.unreachable;
  }
  const seen = lastSeen(d.fs, d.dir);
  const age =
    seen.lastResultMs === null
      ? 'no result ever written'
      : `last result ${Math.round((d.clock.now() - seen.lastResultMs) / 60_000)} min ago`;
  d.log(
    `MAC_UNREACHABLE: ${why} (${seen.installedAt ? `installed ${seen.installedAt}` : 'never installed'}; ${age}).`,
  );
  d.log(`Open it by hand on the Mac:\n  ${handOff(d, branch, title)}`);
  return EXIT.unreachable;
}

// Submit, wait, and withdraw on timeout: the Mac's result, or the exit code for an unreachable Mac. `waitMs` is
// what is left of the budget, so wait + grace never outlasts the caller's timeout.
async function deliver(d: Deps, job: Job, waitMs: number, title: string): Promise<Result | number> {
  const branch = job.params.branch;
  // Too little left to wait for an answer: don't queue a job the caller's timeout would orphan.
  if (waitMs < MIN_WAIT_MS)
    return unreachable(
      d,
      'the pre-submit checks used up the wait budget; nothing was queued',
      branch,
      title,
    );
  try {
    submit(d.fs, d.dir, job);
  } catch (err) {
    if (err instanceof NotInstalled) return unreachable(d, err.message, branch, title);
    throw err;
  }
  d.log(`submitted ${job.id}; waiting up to ${Math.round(waitMs / 1000)} s for the Mac`);
  const r = await waitForResult(d.fs, d.clock, d.dir, job.id, waitMs);
  if (r) return r;
  if (withdraw(d.fs, d.dir, job.id))
    return unreachable(d, `no result in ${Math.round(waitMs / 1000)} s`, branch, title);
  d.log('the Mac picked the job up late; waiting for it to finish');
  return (
    (await waitForResult(d.fs, d.clock, d.dir, job.id, GRACE_MS)) ??
    unreachable(d, '', branch, title, true)
  );
}

const MIN_WAIT_MS = 10_000;

// The PR's first line when the head commit's newest devcheck ran without the iPhone checks (Mac asleep, Device Hub
// down, …): never a quiet "needs you". Plain ⚠ — the emoji form carries U+FE0F, which BAD_TEXT refuses.
const IOS_BANNER_MARK = 'iPhone checks did not run';
export function iosBanner(fs: Fs, root: string, sha: string): string | null {
  const dir = join(root, 'localNotes', 'devcheck');
  for (const run of fs.list(dir).sort().reverse()) {
    let r: {
      expectedSha?: string;
      ios?: { unavailable?: { reason: string; rows: number } | null };
    };
    try {
      r = JSON.parse(fs.read(join(dir, run, 'report.json')) ?? '') as typeof r;
    } catch {
      continue;
    }
    const at = r.expectedSha ?? '';
    if (at.length < 7 || !(sha.startsWith(at) || at.startsWith(sha))) continue;
    const u = r.ios?.unavailable;
    if (!u) return null;
    const reason = /^[A-Z_/()0-9.]{1,40}$/.test(u.reason) ? u.reason : 'SIM_UNAVAILABLE';
    return `> ⚠ **${IOS_BANNER_MARK}** (${reason}, Mac asleep?): ${u.rows} iOS row${u.rows === 1 ? '' : 's'} untested. Rerun the devcheck with the Mac awake before merging a UI change.`;
  }
  return null;
}
const budget = (d: Deps, startMs: number, waitMs: number) => waitMs - (d.clock.now() - startMs);

// Warnings every result can carry: an expiring token, an installed runner older than the repo's.
function warnings(d: Deps, r: Result): void {
  if (r.tokenWarning)
    d.log(
      `TOKEN_EXPIRING: the mailroom token expires ${r.tokenExpiresAt} — regenerate it in GitHub, then:\n  ${RENEW_LINE}`,
    );
  const want = d.repoVersion();
  if (r.runnerVersion !== want)
    d.log(
      `the Mac runs runner ${r.runnerVersion.slice(0, 12)}, the repo has ${want.slice(0, 12)} — reinstall on the Mac (from merged main):\n  ${INSTALL_LINE}`,
    );
}

function refuse(d: Deps, job: Job, reason: keyof typeof REASON_HINT): number {
  d.log(`refused before submit: ${reason} — ${REASON_HINT[reason]}`);
  if (reason === 'BAD_PARAM' && !BRANCH_RE.test(job.params.branch))
    d.log(`branch \`${job.params.branch}\` is not mailroom-safe`);
  return EXIT.failed;
}

export async function openPr(d: Deps, title: string, waitMs = WAIT_MS): Promise<number> {
  const start = d.clock.now();
  const branch = featureBranch(d.run);
  const sha = requirePushed(d.run, branch);
  const bodyPath = join(d.root, 'localNotes', `pr-${branch}.md`);
  const written = d.fs.read(bodyPath);
  if (written === null) throw new Error(`${bodyPath} is missing — write the PR body first`);
  const banner = written.includes(IOS_BANNER_MARK) ? null : iosBanner(d.fs, d.root, sha);
  if (banner) d.log(banner.slice(2));
  const body = banner ? `${banner}\n\n${written}` : written;
  const job = makeOpenPrJob({ branch, sha, title, body }, d.clock.now());
  const bad = validateJob(job, job.id, d.clock.now());
  if (bad) return refuse(d, job, bad);

  // Best-effort, with the container's read-only token: an open PR needs no job. Offline → the Mac checks anyway.
  try {
    const url = d.run('gh', [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'open',
      '--json',
      'url',
      '--jq',
      '.[0].url // ""',
    ]);
    if (url) {
      d.log(`exists ${url}`);
      return EXIT.ok;
    }
  } catch {
    // no GitHub from here right now
  }

  const r = await deliver(d, job, budget(d, start, waitMs), title);
  if (typeof r === 'number') return r;
  warnings(d, r);
  if ((r.status === 'opened' || r.status === 'exists') && r.pr) {
    if (r.status === 'opened' && r.pr.headSha !== sha) {
      d.log(
        `opened ${r.pr.url}, but on ${r.pr.headSha.slice(0, 7)}, not ${sha.slice(0, 7)} — a push landed mid-job; check it`,
      );
      return EXIT.failed;
    }
    if (r.status === 'opened' && r.bodySha256 !== job.params.bodySha256) {
      d.log(
        `opened ${r.pr.url}, but the Mac sent a different body (sha ${r.bodySha256}) — check it`,
      );
      return EXIT.failed;
    }
    d.log(`${r.status} ${r.pr.url} (author ${r.pr.author})`);
    return EXIT.ok;
  }
  d.log(`${r.status}: ${r.reason}`);
  if (r.reason?.startsWith('TOKEN_'))
    d.log(`the mailroom token needs attention (MAILROOM.md → Token). Renew:\n  ${RENEW_LINE}`);
  if (r.reason === 'HEAD_MISMATCH')
    d.log('origin moved since this job was built — `pnpm bot push`, then retry');
  if (r.reason === 'HEAD_MISSING') d.log(HEAD_MISSING_HINT);
  return EXIT.failed;
}

// The trial's probe: the whole path (inbox → launchd → Keychain → GitHub) with a zero sha, so it stops at
// HEAD_MISMATCH before any write.
export async function probe(d: Deps, waitMs = WAIT_MS): Promise<number> {
  const start = d.clock.now();
  const branch = featureBranch(d.run);
  requirePushed(d.run, branch); // so HEAD_MISSING can only mean the token can't see the repo
  const job = makeOpenPrJob(
    { branch, sha: '0'.repeat(40), title: 'Mailroom probe', body: 'probe' },
    d.clock.now(),
  );
  const bad = validateJob(job, job.id, d.clock.now());
  if (bad) return refuse(d, job, bad);
  const r = await deliver(d, job, budget(d, start, waitMs), 'Mailroom probe');
  if (typeof r === 'number') return r;
  warnings(d, r);
  const ok = r.status === 'rejected' && r.reason === 'HEAD_MISMATCH';
  d.log(
    ok
      ? `probe ok: the Mac answered in ${r.durationMs} ms (started ${r.startedAt}); token expires ${r.tokenExpiresAt ?? 'unknown'}`
      : `probe failed: ${r.status} ${r.reason}`,
  );
  if (r.reason === 'HEAD_MISSING') d.log(HEAD_MISSING_HINT);
  return ok ? EXIT.ok : EXIT.failed;
}
