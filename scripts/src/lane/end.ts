// `pnpm lanes end <branch>`: once the PR is merged and main's deploy for it is green (or `--force-abandon "<reason>"`),
// archive the worktree's localNotes and check the copy, remove the worktree, clear the board lane, print the
// maintainer's Mac line, close the lane's window by id only, and sync main (board sync-main). A rerun resumes (docs/ops/LANES.md → End).
import { deployFor } from '../board/tower/derive.ts';
import { parseRuns } from '../board/tower/gh.ts';
import { verdict } from '../bot/prune.ts';
import type { GhRun } from '../board/tower/gh.ts';
import { macLine, parseAdmission } from './mac-line.ts';
import {
  EXIT,
  archivePath,
  hubName,
  lifecyclePath,
  lifecycleText,
  nameProblem,
  readLifecycle,
  syncMainSoft,
  tryRun,
  windowCheck,
  worktreePath,
} from './state.ts';
import type { Deps, Lifecycle } from './state.ts';

export const SELF_CLOSE_SEC = 90;
const NOTHING =
  'no dev admission to remove, and the branch is pruned at the end of the wave or already gone';
// Written into the archive by this command, so a rerun's compare leaves them out.
export const OWN_FILES = ['mac-cleanup.txt', 'lane-end.txt'];

export type EndArgs = { branch: string | undefined; abandon: string | null };

type Pr = {
  number: number;
  state: string;
  mergeCommit: { oid: string } | null;
  mergedAt: string | null;
  headRefOid: string;
  url: string;
};
// A merge this recent with no deploy run yet is "wait", not "refused": GitHub queues the run within seconds.
export const RUN_GRACE_MS = 10 * 60_000;

const refuse = (d: Deps, msg: string, code: number = EXIT.refused) => {
  d.log(`lane: ${msg}`);
  return code;
};
const short = (s: string) => s.slice(0, 7);

// A refusal (no PR: exit 3) or a failed read (exit 1: retry) as { msg, code }.
function readPr(d: Deps, b: string): Pr | { msg: string; code: number } {
  let text: string;
  try {
    text = d.run(
      'gh',
      ['pr', 'view', b, '--json', 'number,state,mergeCommit,mergedAt,headRefOid,url'],
      {
        cwd: d.env.mainRoot,
      },
    );
  } catch (err) {
    const m = (err as Error).message;
    return /no pull requests found/i.test(m)
      ? { msg: `no PR for ${b} (or --force-abandon "<reason>")`, code: EXIT.refused }
      : { msg: `gh pr view failed: ${m.split('\n')[0]}`, code: EXIT.failed };
  }
  try {
    return JSON.parse(text) as Pr;
  } catch {
    return { msg: 'gh pr view printed no JSON', code: EXIT.failed };
  }
}

function mainRuns(d: Deps, query: string): GhRun[] {
  return parseRuns(d.run('gh', ['api', `repos/${d.env.slug}/actions/runs?${query}`]));
}

// The deploy gate: green → null; else the refusal and its exit code. Main's latest page first; an older merge by its
// sha, and when its own run was cancelled, the push runs created since (deployFor follows a superseded run).
function deployGate(
  d: Deps,
  sha: string,
  mergedAt: number | null,
): { msg: string; code: number } | null {
  let hit;
  try {
    hit = deployFor(sha, mainRuns(d, 'branch=main&event=push&per_page=100'));
    if (!hit) {
      const own = mainRuns(d, `head_sha=${sha}&event=push&per_page=100`);
      hit = deployFor(sha, own);
      if (hit && hit.via === null && hit.run.conclusion === 'cancelled' && hit.run.createdAt) {
        // GitHub's documented date form has no fractional seconds
        const at = new Date(hit.run.createdAt).toISOString().replace(/\.\d{3}Z$/, 'Z');
        const since = encodeURIComponent(`>=${at}`);
        const later = mainRuns(d, `branch=main&event=push&per_page=100&created=${since}`);
        hit = deployFor(sha, [...own, ...later.filter((r) => r.sha !== sha)]) ?? hit;
      }
    }
  } catch (err) {
    return {
      msg: `could not read main's deploy runs: ${(err as Error).message.split('\n')[0]}`,
      code: EXIT.failed,
    };
  }
  if (!hit) {
    const fresh = mergedAt !== null && d.clock.now() - mergedAt < RUN_GRACE_MS;
    return {
      msg: `main's deploy for ${short(sha)} not found${fresh ? ' yet (merged minutes ago)' : ''}`,
      code: fresh ? EXIT.later : EXIT.refused,
    };
  }
  const r = hit.run;
  const via = hit.via ? ` (its own run ${hit.via.id} was superseded)` : '';
  if (r.status !== 'completed')
    return {
      msg: `main's deploy ${r.id} for ${short(sha)} is still running${via}`,
      code: EXIT.later,
    };
  if (r.conclusion !== 'success')
    return {
      msg: `main's deploy ${r.id} for ${short(sha)} ended ${r.conclusion}${via}: ${r.url ?? ''}`,
      code: EXIT.refused,
    };
  return null;
}

// The local branch holds nothing the PR lacks: its head is the PR's, or an ancestor of it (the PR's head moved on
// GitHub, e.g. "Update branch"). The PR head is fetched into FETCH_HEAD only.
function headCovered(d: Deps, head: string, pr: Pr): boolean | 'fetch-failed' {
  if (head === pr.headRefOid) return true;
  const at = d.env.mainRoot;
  if (tryRun(d, 'git', ['fetch', 'origin', `pull/${pr.number}/head`], at) === null)
    return 'fetch-failed';
  return tryRun(d, 'git', ['merge-base', '--is-ancestor', head, pr.headRefOid], at) !== null;
}

function pruneVerdict(d: Deps, b: string, head: string): { deleted: boolean; why: string } | null {
  const text = tryRun(
    d,
    'gh',
    [
      'pr',
      'list',
      '--head',
      b,
      '--state',
      'all',
      '--json',
      'number,state,headRefName,headRefOid,isCrossRepository',
    ],
    d.env.mainRoot,
  );
  try {
    return text === null ? null : verdict(b, head, JSON.parse(text), false);
  } catch {
    return null;
  }
}

function heldLock(d: Deps, b: string): string | null {
  for (const [slot, f] of [
    ['dev', 'devlock.json'],
    ['devb', 'devlock.devb.json'],
  ] as const) {
    try {
      const h = JSON.parse(d.fs.read(`${d.env.boardDir}/${f}`) ?? 'null')?.holder;
      if (h?.branch === b && Date.parse(h.expiresAt) > d.clock.now())
        return `${slot} until ${h.expiresAt}`;
    } catch {
      // unreadable: the bot's own check decides
    }
  }
  return null;
}

export function end(d: Deps, a: EndArgs): number {
  const e = d.env;
  const bad = nameProblem(a.branch, hubName(d));
  if (bad) return refuse(d, bad, EXIT.usage);
  const b = a.branch!;
  if (a.abandon === 'true' || (a.abandon !== null && !a.abandon.trim()))
    return refuse(d, '--force-abandon wants a reason', EXIT.usage);
  if (a.abandon !== null && /[\n\r]/.test(a.abandon))
    return refuse(d, '--force-abandon: one line', EXIT.usage);
  if (e.cwdTop !== e.mainRoot)
    return refuse(d, `run it from ${e.mainRoot}: the lifecycle always runs main's code`);

  const wt = worktreePath(e, b);
  const hasTree = d.fs.exists(wt);
  // Checked with or without the worktree: end must never drop a worktree whose branch holds work the PR lacks.
  const head = tryRun(
    d,
    'git',
    ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`],
    e.mainRoot,
  );
  let why: string;
  if (a.abandon === null) {
    const pr = readPr(d, b);
    if ('msg' in pr) return refuse(d, pr.msg, pr.code);
    if (pr.state !== 'MERGED')
      return refuse(
        d,
        `PR ${pr.number} is ${pr.state === 'CLOSED' ? 'closed unmerged' : pr.state} (or --force-abandon "<reason>")`,
      );
    const covered = head ? headCovered(d, head, pr) : true;
    if (covered === 'fetch-failed')
      return refuse(d, `could not fetch PR ${pr.number}'s head to compare`, EXIT.failed);
    if (head && !covered)
      return refuse(
        d,
        `local ${b} (${short(head)}) has commits PR ${pr.number}'s merged head (${short(pr.headRefOid)}) lacks: they would go with the branch`,
      );
    const sha = pr.mergeCommit?.oid;
    if (!sha) return refuse(d, `PR ${pr.number} has no merge commit`);
    const merged = pr.mergedAt ? Date.parse(pr.mergedAt) : NaN;
    const gate = deployGate(d, sha, Number.isNaN(merged) ? null : merged);
    if (gate) return refuse(d, gate.msg, gate.code);
    why = `PR ${pr.number} merged as ${sha}; main's deploy green (${pr.url})`;
  } else why = `abandoned: ${a.abandon}`;

  if (hasTree) {
    const dirty = d.run('git', ['status', '--porcelain'], { cwd: wt }).split('\n').filter(Boolean);
    if (dirty.length)
      return refuse(d, `the worktree has uncommitted files:\n  ${dirty.slice(0, 10).join('\n  ')}`);
  }
  const lock = heldLock(d, b);
  if (lock)
    return refuse(d, `${b} holds the ${lock} lock: pnpm bot lock release from the worktree first`);

  const adm = parseAdmission(
    tryRun(d, 'gh', [
      'api',
      `repos/${e.slug}/environments/dev/deployment-branch-policies?per_page=100`,
    ]),
    b,
  );
  const lc = lifecyclePath(e, b);
  const rec = readLifecycle(d, b);
  const win = windowCheck(d, rec);
  // Whether the wave-end `pnpm bot prune-branches` will take this branch, by prune's own rule (bot/prune.ts verdict),
  // so the two can't drift: a merged PR at exactly this tip. Anything prune keeps (abandoned, a tip behind the PR head,
  // a name reused across PRs, or an unreadable PR list) gets its delete in the maintainer's line.
  const prune = head === null ? null : pruneVerdict(d, b, head);
  const line = macLine(e.macRoot, b, head !== null && !prune?.deleted, adm, e.slug);

  // 1. Archive. The destination is kept in the lifecycle record, so a rerun writes to this lane's own archive and
  // never to an older same-name lane's. An existing archive is reused only when it is this lane's (recorded) or a
  // plain copy no end has claimed (no lane-end.txt) that matches.
  let dest = rec?.archive && d.fs.exists(rec.archive) ? rec.archive : null;
  if (hasTree) {
    const src = `${wt}/localNotes`;
    const has = d.fs.exists(src);
    const own = OWN_FILES.filter((f) => d.fs.exists(`${src}/${f}`));
    if (own.length)
      return refuse(d, `localNotes/${own[0]} would be overwritten in the archive: rename it first`);
    const base = archivePath(e, b);
    // An archive fits when it holds this localNotes; with no localNotes, when it holds only this command's files.
    const fits = (p: string) =>
      d.fs.exists(p) &&
      (has ? d.fs.sameTree(src, p, OWN_FILES) : d.fs.list(p).every((f) => OWN_FILES.includes(f)));
    if (dest && has && !fits(dest)) dest = null; // localNotes changed since: a fresh copy
    if (!dest && d.fs.exists(base) && !d.fs.exists(`${base}/lane-end.txt`) && fits(base))
      dest = base;
    try {
      if (dest) d.log(`archive ${dest} already matches`);
      else {
        dest = base;
        for (let n = 1; d.fs.exists(dest); n++) dest = `${base}.${n}`;
        if (has) d.log(`archived ${d.fs.archive(src, dest)} file(s) to ${dest}`);
        else d.fs.mkdirp(dest);
      }
      d.fs.write(lc, lifecycleText({ ...(rec ?? bareRecord(b, wt, d)), archive: dest }));
      // 2. The record and the Mac line, in the archive.
      d.fs.write(`${dest}/mac-cleanup.txt`, `${line || `# nothing for the Mac: ${NOTHING}`}\n`);
      d.fs.write(
        `${dest}/lane-end.txt`,
        `${b}: ${why}\nended ${new Date(d.clock.now()).toISOString()}\n`,
      );
    } catch (err) {
      return refuse(d, `archive failed, nothing removed: ${(err as Error).message}`, EXIT.failed);
    }

    // 3. The worktree (no force: a refusal stops here; a rerun resumes).
    try {
      d.run('git', ['worktree', 'remove', `.claude/worktrees/${b}`], { cwd: e.mainRoot });
    } catch (err) {
      return refuse(
        d,
        `git worktree remove failed (archive is safe in ${dest}): ${(err as Error).message}`,
        EXIT.failed,
      );
    }
  } else if (!dest) d.log('no worktree and no archive recorded for this lane: nothing archived');

  // 4. The window, by its recorded id only, before the record that names it goes.
  let closed: string;
  if ('why' in win) closed = `window not closed (${win.why}): close it yourself`;
  else {
    // At once only when this provably runs in another window; in its own, or when that can't be told, delayed, so
    // a kill can't cut this run off before the record goes and the line is printed.
    const self = e.tmuxPane
      ? tryRun(d, 'tmux', ['display', '-p', '-t', e.tmuxPane, '#{window_id}'])
      : null;
    try {
      if (self === null || self === win.id) {
        d.run('tmux', [
          'run-shell',
          '-b',
          '-d',
          String(SELF_CLOSE_SEC),
          '-C',
          `kill-window -t ${win.id}`,
        ]);
        closed =
          self === null
            ? `window ${win.id} closes in ${SELF_CLOSE_SEC} s (this may be it: send [merged] to the hub now)`
            : `this is the lane's own window: it closes in ${SELF_CLOSE_SEC} s; send [merged] to the hub now`;
      } else {
        d.run('tmux', ['kill-window', '-t', win.id]);
        closed = `closed window ${win.id}`;
      }
    } catch (err) {
      closed = `window not closed (${(err as Error).message.split('\n')[0]}): close it yourself`;
    }
  }

  // 5. Board lane and the lifecycle record.
  try {
    d.lanes.clear(b);
  } catch (err) {
    d.log(`warning: board lane not cleared: ${(err as Error).message}`);
  }
  d.fs.rm(lc);

  // 6. The maintainer's line: printed, never run. Relay it by SendMessage or point at mac-cleanup.txt.
  d.log(`lane ${b}: ended (${why})`);
  if (!line) d.log(`nothing for the Mac: ${NOTHING}`);
  else
    d.log(
      `the maintainer's Mac line (printed, not run${dest ? `; also in ${dest}/mac-cleanup.txt` : ''}):\n  ${line}${e.macNote ? `\n  ${e.macNote}` : ''}`,
    );
  if (head === null) d.log('  (the local branch is already gone: no delete in the line)');
  else if (prune?.deleted)
    d.log('  (the local branch goes at the end of the wave: the hub runs pnpm bot prune-branches)');
  else
    d.log(
      `  (pnpm bot prune-branches would keep it: ${prune?.why ?? 'its PRs could not be read'})`,
    );
  if (adm.kind === 'unknown')
    d.log('  (dev admission unknown: the line removes it by name if there is one)');
  d.log(closed);
  // 7. Main to origin/main (the merge just landed) and the tower restarted if stale. Last: in the lane's own window
  // the delayed kill can only cut this off, never the record removal or the line.
  syncMainSoft(d);
  return EXIT.ok;
}

// A record for a lane started before `pnpm lanes start` (no window known), so its archive can be recorded.
const bareRecord = (b: string, wt: string, d: Deps): Lifecycle => ({
  v: 1,
  branch: b,
  worktree: wt,
  windowId: null,
  paneId: null,
  tmuxServerPid: null,
  tmuxServerStart: null,
  tmuxSession: null,
  baseSha: null,
  kickoff: null,
  overCap: null,
  archive: null,
  startedAt: new Date(d.clock.now()).toISOString(),
});
