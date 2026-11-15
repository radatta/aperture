// `pnpm lane end <branch>`: once the PR is merged and main's deploy for it is green (or `--force-abandon "<reason>"`),
// archive the worktree's localNotes and check the copy, remove the worktree, clear the board lane, print the
// maintainer's Mac line and close the lane's window, last and by id only. A rerun resumes (docs/ops/LANES.md → End).
import { deployFor } from '../board/tower/derive.ts';
import { parseRuns } from '../board/tower/gh.ts';
import type { GhRun } from '../board/tower/gh.ts';
import { macLine, parseAdmission } from './mac-line.ts';
import {
  EXIT,
  archivePath,
  hubName,
  lifecyclePath,
  nameProblem,
  readLifecycle,
  tryRun,
  windowCheck,
  worktreePath,
} from './state.ts';
import type { Deps } from './state.ts';

export const SELF_CLOSE_SEC = 90;
// Written into the archive by this command, so a rerun's compare leaves them out.
export const OWN_FILES = ['mac-cleanup.txt', 'lane-end.txt'];

export type EndArgs = { branch: string | undefined; abandon: string | null };

type Pr = {
  number: number;
  state: string;
  mergeCommit: { oid: string } | null;
  headRefOid: string;
  url: string;
};

const refuse = (d: Deps, msg: string, code: number = EXIT.refused) => {
  d.log(`lane: ${msg}`);
  return code;
};
const short = (s: string) => s.slice(0, 7);

function readPr(d: Deps, b: string): Pr | string {
  let text: string;
  try {
    text = d.run('gh', ['pr', 'view', b, '--json', 'number,state,mergeCommit,headRefOid,url'], {
      cwd: d.env.mainRoot,
    });
  } catch (err) {
    const m = (err as Error).message;
    return /no pull requests found/i.test(m)
      ? `no PR for ${b}`
      : `gh pr view failed: ${m.split('\n')[0]}`;
  }
  try {
    return JSON.parse(text) as Pr;
  } catch {
    return `gh pr view printed no JSON`;
  }
}

function mainRuns(d: Deps, query: string): GhRun[] {
  return parseRuns(d.run('gh', ['api', `repos/${d.env.slug}/actions/runs?${query}`]));
}

// The deploy gate: green → null; else the refusal and its exit code.
function deployGate(d: Deps, sha: string): { msg: string; code: number } | null {
  let hit;
  try {
    hit =
      deployFor(sha, mainRuns(d, 'branch=main&event=push&per_page=100')) ??
      deployFor(sha, mainRuns(d, `head_sha=${sha}&event=push&per_page=100`));
  } catch (err) {
    return {
      msg: `could not read main's deploy runs: ${(err as Error).message.split('\n')[0]}`,
      code: EXIT.failed,
    };
  }
  if (!hit) return { msg: `main's deploy for ${short(sha)} not found`, code: EXIT.refused };
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
  let why: string;
  if (a.abandon === null) {
    const pr = readPr(d, b);
    if (typeof pr === 'string') return refuse(d, `${pr} (or --force-abandon "<reason>")`);
    if (pr.state !== 'MERGED')
      return refuse(
        d,
        `PR ${pr.number} is ${pr.state === 'CLOSED' ? 'closed unmerged' : pr.state} (or --force-abandon "<reason>")`,
      );
    const head = hasTree ? tryRun(d, 'git', ['rev-parse', `refs/heads/${b}`], e.mainRoot) : null;
    if (head && head !== pr.headRefOid)
      return refuse(
        d,
        `local ${b} (${short(head)}) is not PR ${pr.number}'s merged head (${short(pr.headRefOid)}): those commits would go with the branch`,
      );
    const sha = pr.mergeCommit?.oid;
    if (!sha) return refuse(d, `PR ${pr.number} has no merge commit`);
    const gate = deployGate(d, sha);
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
    tryRun(d, 'gh', ['api', `repos/${e.slug}/environments/dev/deployment-branch-policies`]),
    b,
  );
  const rec = readLifecycle(d, b);
  const win = windowCheck(d, rec);

  // 1. Archive (skipped on a rerun whose worktree is already gone).
  let dest = archivePath(e, b);
  if (hasTree) {
    const src = `${wt}/localNotes`;
    const has = d.fs.exists(src);
    if (d.fs.exists(dest) && !(has && d.fs.sameTree(src, dest, OWN_FILES))) {
      let n = 1;
      while (d.fs.exists(`${dest}.${n}`)) n++;
      dest = `${dest}.${n}`;
    }
    try {
      if (!d.fs.exists(dest)) {
        if (has) d.log(`archived ${d.fs.archive(src, dest)} file(s) to ${dest}`);
        else d.fs.mkdirp(dest);
      } else d.log(`archive ${dest} already matches`);
    } catch (err) {
      return refuse(d, `archive failed, nothing removed: ${(err as Error).message}`, EXIT.failed);
    }
  } else if (!d.fs.exists(dest)) d.fs.mkdirp(dest);

  // 2. The record and the Mac line, in the archive.
  const line = macLine(e.macRoot, b, adm, e.slug);
  d.fs.write(`${dest}/mac-cleanup.txt`, `${line}\n`);
  d.fs.write(
    `${dest}/lane-end.txt`,
    `${b}: ${why}\nended ${new Date(d.clock.now()).toISOString()}\n`,
  );

  // 3. The worktree (no force: a refusal stops here; a rerun resumes).
  if (hasTree) {
    try {
      d.run('git', ['worktree', 'remove', `.claude/worktrees/${b}`], { cwd: e.mainRoot });
    } catch (err) {
      return refuse(
        d,
        `git worktree remove failed (archive is safe in ${dest}): ${(err as Error).message}`,
        EXIT.failed,
      );
    }
  }

  // 4. Board lane and the lifecycle record.
  try {
    d.lanes.clear(b);
  } catch (err) {
    d.log(`warning: board lane not cleared: ${(err as Error).message}`);
  }
  d.fs.rm(lifecyclePath(e, b));

  // 5. The maintainer's line: printed, never run. Relay it by SendMessage or point at mac-cleanup.txt.
  d.log(`lane ${b}: ended (${why})`);
  d.log(
    `the maintainer's Mac line (printed, not run; also in ${dest}/mac-cleanup.txt):\n  ${line}${e.macNote ? `\n  ${e.macNote}` : ''}`,
  );
  if (adm.kind === 'unknown')
    d.log('  (dev admission unknown: the line removes it by name if there is one)');

  // 6. The window, last, by its recorded id only.
  if ('why' in win) {
    d.log(`window not closed (${win.why}): close it yourself`);
    return EXIT.ok;
  }
  const self = e.tmuxPane
    ? tryRun(d, 'tmux', ['display', '-p', '-t', e.tmuxPane, '#{window_id}'])
    : null;
  if (self === win.id) {
    d.run('tmux', [
      'run-shell',
      '-b',
      '-d',
      String(SELF_CLOSE_SEC),
      '-C',
      `kill-window -t ${win.id}`,
    ]);
    d.log(
      `this is the lane's own window: it closes in ${SELF_CLOSE_SEC} s; send [merged] to the hub now`,
    );
  } else {
    d.run('tmux', ['kill-window', '-t', win.id]);
    d.log(`closed window ${win.id}`);
  }
  return EXIT.ok;
}
