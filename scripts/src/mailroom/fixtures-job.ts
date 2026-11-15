// `pnpm mailroom fixtures [--sha <sha>]`: the Mac runs a pushed commit's mailroom fixture suite under its own bash 3.2,
// sandboxed (jobs/fixtures.sh), in place of the user pasting the line before a tools/mailroom/ branch's trial. It runs
// in the slow lane, so it can queue behind a sim run; start it in the background. docs/ops/MAILROOM.md → The fixtures job.
import { join } from 'node:path';
import { featureBranch, requirePushed } from '../bot/git.ts';
import { makeFixturesJob, validateJob } from './job.ts';
import { EXIT, warnings } from './open-pr.ts';
import type { Deps } from './open-pr.ts';
import { NotInstalled, lastSeen, submit, waitForResult, withdraw } from './submit.ts';

export const PICKUP_MS = 15 * 60_000; // the slow lane may be in a sim run; the job expires at 20 min anyway
export const RUN_MS = (600 + 150 + 60) * 1000; // FX_TIMEOUT + the fetch + grace
const SHA_RE = /^[0-9a-f]{40}$/;
// The Mac refuses these (TOUCHES_INSTALL): an install change is proven by the user's trial install, never by a job.
const INSTALL_RE = /^tools\/mailroom\/(install\.sh|[^/]*\.plist\.tmpl)$/;

const HINTS: Record<string, string> = {
  TOUCHES_INSTALL:
    'the branch changes install.sh or the plist template — the user runs that branch’s fixtures by hand (MAILROOM.md → Trial)',
  DIFF_TOO_LARGE:
    'over 300 changed files: GitHub cuts the compare list there, so the install check can’t be made',
  SANDBOX_MISSING: 'sandbox-exec is missing on the Mac — the job never runs unsandboxed',
  HEAD_MISSING: 'GitHub has no such commit — `pnpm bot push` first',
  UNKNOWN_JOB:
    'the installed runner predates the fixtures job — reinstall from main, or run the suite by hand (MAILROOM.md → Trial step 2)',
};

export async function fixturesJob(d: Deps, shaFlag?: string): Promise<number> {
  const sha = shaFlag ?? requirePushed(d.run, featureBranch(d.run));
  if (!SHA_RE.test(sha)) {
    d.log(`--sha wants a full 40-hex commit, got ${sha}`);
    return EXIT.usage;
  }
  // The Mac checks GitHub's diff; this is the early, fixable copy.
  try {
    const touched = d
      .run('git', ['diff', '--name-only', '--no-renames', `origin/main...${sha}`])
      .split('\n')
      .filter((f) => INSTALL_RE.test(f));
    if (touched.length) {
      d.log(
        `refused before submit: TOUCHES_INSTALL (${touched.join(', ')}) — ${HINTS.TOUCHES_INSTALL}`,
      );
      return EXIT.failed;
    }
  } catch {
    // no local diff (an unfetched sha): the Mac decides
  }
  const job = makeFixturesJob(sha, d.clock.now());
  const bad = validateJob(job, job.id, d.clock.now());
  if (bad) {
    d.log(`refused before submit: ${bad}`);
    return EXIT.failed;
  }
  try {
    submit(d.fs, d.dir, job);
  } catch (err) {
    if (err instanceof NotInstalled) {
      d.log(`MAC_UNREACHABLE: ${err.message}`);
      return EXIT.unreachable;
    }
    throw err;
  }
  d.log(`submitted ${job.id}; waiting up to ${PICKUP_MS / 60_000} min for the Mac's slow lane`);
  const rdir = join(d.dir, 'results', job.id);
  const t0 = d.clock.now();
  while (!d.fs.isDir(rdir)) {
    if (d.clock.now() - t0 >= PICKUP_MS) {
      if (withdraw(d.fs, d.dir, job.id)) {
        const seen = lastSeen(d.fs, d.dir);
        d.log(
          `MAC_UNREACHABLE: no pickup in ${PICKUP_MS / 60_000} min — Mac asleep, mailroom not running, or a long sim run (${seen.installedAt ? `installed ${seen.installedAt}` : 'never installed'}); withdrawn`,
        );
        return EXIT.unreachable;
      }
      break; // taken just now
    }
    await d.clock.sleep(2000);
  }
  d.log('picked up; the suite takes a few minutes');
  const r = await waitForResult(d.fs, d.clock, d.dir, job.id, RUN_MS, 5000);
  if (!r) {
    d.log(`MAC_STALLED: no result in ${RUN_MS / 60_000} min after pickup — the Mac may have slept`);
    return EXIT.unreachable;
  }
  warnings(d, r);
  const fx = r.fixtures;
  const log = join(rdir, 'fixtures.log');
  if (r.status === 'pass' && fx) {
    d.log(`fixtures pass on the Mac: ${fx.passed}/${fx.cases} at ${sha.slice(0, 7)} (log: ${log})`);
    return EXIT.ok;
  }
  d.log(
    `fixtures ${r.status}: ${r.reason}${fx ? ` — ${fx.passed ?? '?'} passed, ${fx.failed ?? '?'} failed, of ${fx.cases ?? '?'}` : ''}`,
  );
  for (const f of fx?.failing ?? []) d.log(`  not ok - ${f}`);
  if (fx) d.log(`log tail: ${log}`);
  const hint = r.reason ? HINTS[r.reason] : undefined;
  if (hint) d.log(hint);
  return EXIT.failed;
}
