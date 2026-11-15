// `pnpm lane start <branch>`: the worktree off origin/main, its install, a tmux window running Claude named after the
// branch with the kickoff as its first message, and the board lane. Refuses before changing anything; a failure
// midway rolls back what it made (docs/ops/LANES.md → Start).
import {
  EXIT,
  activeLanes,
  describeActive,
  expectedGitdir,
  hubName,
  laneCap,
  lifecyclePath,
  lifecycleText,
  nameProblem,
  parseWorktrees,
  tryRun,
  worktreePath,
} from './state.ts';
import type { Deps, Lifecycle } from './state.ts';

export const KICKOFF_MAX = 256 * 1024;
export const CONFIRM_MS = 20_000;
// The only prompt text that reaches an argv: COI reads every argv, and a kickoff quoting the safety rules would kill
// the container. Claude reads the kickoff itself.
export const KICKOFF_PROMPT =
  'Read localNotes/kickoff.md and follow it. It is the kickoff for this lane, written by the hub.';

export type StartArgs = {
  branch: string | undefined;
  kickoff: string | null;
  skipPermissions: boolean;
  overCap: string | null;
};

const refuse = (d: Deps, msg: string, code: number = EXIT.refused) => {
  d.log(`lane: ${msg}`);
  return code;
};

// The shell line typed into the new window: only the validated branch varies.
export const claudeLine = (b: string, kickoff: boolean, skip: boolean) =>
  ['claude', '-n', b, ...(skip ? ['--dangerously-skip-permissions'] : [])].join(' ') +
  (kickoff ? ` '${KICKOFF_PROMPT}'` : '');

export async function start(d: Deps, a: StartArgs): Promise<number> {
  const e = d.env;
  const bad = nameProblem(a.branch, hubName(d));
  if (bad) return refuse(d, bad, EXIT.usage);
  const b = a.branch!;
  let kickoff: string | null = null;
  if (a.kickoff !== null) {
    kickoff = d.fs.read(a.kickoff);
    if (!kickoff || !kickoff.trim() || kickoff.length > KICKOFF_MAX)
      return refuse(d, `--kickoff ${a.kickoff}: missing, empty or over 256 KiB`, EXIT.usage);
  }
  if (a.overCap === 'true' || a.overCap === '')
    return refuse(d, '--over-cap wants a reason', EXIT.usage);
  if (e.cwdTop !== e.mainRoot)
    return refuse(d, `run it from ${e.mainRoot}: the lifecycle always runs main's code`);

  const here = e.tmuxPane
    ? tryRun(d, 'tmux', ['display', '-p', '-t', e.tmuxPane, '#{session_id} #{pid} #{start_time}'])
    : null;
  const sessions = here
    ? [here]
    : (tryRun(d, 'tmux', ['list-sessions', '-F', '#{session_id} #{pid} #{start_time}']) ?? '')
        .split('\n')
        .filter(Boolean);
  if (sessions.length !== 1)
    return refuse(
      d,
      sessions.length
        ? 'several tmux sessions and this is in none: run it from a tmux pane'
        : 'no tmux session to open the window in',
    );
  const [tmuxSession, serverPid, serverStart] = sessions[0]!.split(' ');

  const status = d.run('git', ['status', '--porcelain'], { cwd: e.mainRoot });
  const tracked = status.split('\n').filter((l) => l && !l.startsWith('??'));
  if (tracked.length)
    return refuse(
      d,
      `the main checkout has tracked changes:\n  ${tracked.slice(0, 10).join('\n  ')}`,
    );
  if (tryRun(d, 'git', ['symbolic-ref', '-q', 'HEAD'], e.mainRoot) !== null)
    return refuse(d, `the main checkout is on a branch; it stays detached at origin/main`);
  const untracked = status.split('\n').filter((l) => l.startsWith('??'));
  if (untracked.length)
    d.log(`note: untracked in the main checkout (left alone): ${untracked.length} path(s)`);

  try {
    d.run('git', ['fetch', 'origin'], { cwd: e.mainRoot });
  } catch (err) {
    return refuse(d, `git fetch failed: ${(err as Error).message}`, EXIT.failed);
  }
  if (tryRun(d, 'git', ['show-ref', '--verify', '--quiet', `refs/heads/${b}`], e.mainRoot) !== null)
    return refuse(d, `branch ${b} already exists (local)`);
  if (d.run('git', ['ls-remote', '--heads', 'origin', b], { cwd: e.mainRoot }).trim())
    return refuse(d, `branch ${b} already exists (on origin)`);
  const wt = worktreePath(e, b);
  const trees = parseWorktrees(
    d.run('git', ['worktree', 'list', '--porcelain'], { cwd: e.mainRoot }),
  );
  if (d.fs.exists(wt) || trees.some((t) => t.path === wt))
    return refuse(d, `.claude/worktrees/${b} already exists`);
  if (d.fs.exists(lifecyclePath(e, b)))
    return refuse(d, `a lifecycle record for ${b} exists: pnpm lane end ${b} first`);
  const windows = d.run('tmux', ['list-windows', '-a', '-F', '#{window_id} #{window_name}']);
  const same = windows.split('\n').find((l) => l.split(' ')[1] === b);
  if (same)
    return refuse(d, `a window named ${b} exists (${same.split(' ')[0]}): names are addresses`);
  const active = activeLanes(d, trees);
  const cap = laneCap(d);
  if (active.length >= cap && a.overCap === null)
    return refuse(
      d,
      `${active.length} of ${cap} lanes active: ${describeActive(active)}. End one (pnpm lane end), park one ` +
        `(pnpm board lane parked), or pass --over-cap "<reason>".`,
      EXIT.later,
    );
  if (active.length >= cap) d.log(`over the cap (${active.length} of ${cap}): ${a.overCap}`);

  // From here every step registers its undo; a failure runs them in reverse.
  const undo: { what: string; fn: () => void }[] = [];
  const rollback = (why: string) => {
    d.log(`lane: ${why}; rolling back`);
    const left: string[] = [];
    for (const u of undo.reverse()) {
      try {
        u.fn();
      } catch (err) {
        left.push(`${u.what} (${(err as Error).message.split('\n')[0]})`);
      }
    }
    d.log(left.length ? `left behind: ${left.join('; ')}` : 'rolled back: nothing left behind');
    return EXIT.failed;
  };

  const rec: Lifecycle = {
    v: 1,
    branch: b,
    worktree: wt,
    windowId: null,
    paneId: null,
    tmuxServerPid: serverPid ?? null,
    tmuxServerStart: serverStart ?? null,
    tmuxSession: tmuxSession ?? null,
    baseSha: null,
    kickoff: a.kickoff,
    overCap: a.overCap,
    startedAt: new Date(d.clock.now()).toISOString(),
  };
  const lc = lifecyclePath(e, b);
  if (!d.fs.writeNew(lc, lifecycleText(rec)))
    return refuse(d, `a lifecycle record for ${b} appeared meanwhile: another start?`);
  undo.push({ what: `lifecycle record ${lc}`, fn: () => d.fs.rm(lc) });

  try {
    const base = d.run('git', ['rev-parse', 'origin/main'], { cwd: e.mainRoot });
    rec.baseSha = base;
    if (d.run('git', ['rev-parse', 'HEAD'], { cwd: e.mainRoot }) !== base)
      d.run('git', ['switch', '--detach', 'origin/main'], { cwd: e.mainRoot });
    d.run(
      'git',
      ['worktree', 'add', '--no-track', '-b', b, `.claude/worktrees/${b}`, 'origin/main'],
      { cwd: e.mainRoot },
    );
  } catch (err) {
    return rollback(`worktree add failed: ${(err as Error).message}`);
  }
  // The safe delete: the branch sits at origin/main, so -d never refuses (and never loses work).
  undo.push({
    what: `branch ${b}`,
    fn: () => d.run('git', ['branch', '-d', b], { cwd: e.mainRoot }),
  });
  undo.push({
    what: `worktree ${wt}`,
    fn: () => d.run('git', ['worktree', 'remove', `.claude/worktrees/${b}`], { cwd: e.mainRoot }),
  });

  const gitdir = (d.fs.read(`${wt}/.git`) ?? '').trim();
  if (gitdir !== expectedGitdir(b))
    return rollback(
      `the worktree's .git reads "${gitdir}", not "${expectedGitdir(b)}" (git < 2.48? CLAUDE.md → relative paths)`,
    );

  d.log(`installing in .claude/worktrees/${b} …`);
  try {
    d.run('pnpm', ['install'], { cwd: wt, env: { ...process.env, CI: 'true' } });
  } catch (err) {
    const tail = (err as Error).message.split('\n').slice(-15).join('\n');
    return rollback(`pnpm install failed:\n${tail}`);
  }
  if (kickoff !== null) d.fs.write(`${wt}/localNotes/kickoff.md`, kickoff);

  let ids: string[];
  try {
    ids = d
      .run('tmux', [
        'new-window',
        '-d',
        '-P',
        '-F',
        '#{window_id} #{pane_id}',
        '-t',
        `${tmuxSession}:`,
        '-n',
        b,
        '-c',
        wt,
      ])
      .split(' ');
  } catch (err) {
    return rollback(`tmux new-window failed: ${(err as Error).message}`);
  }
  const [windowId, paneId] = ids;
  if (!windowId?.startsWith('@') || !paneId?.startsWith('%'))
    return rollback(`tmux new-window printed "${ids.join(' ')}", not a window and pane id`);
  undo.push({
    what: `window ${windowId}`,
    fn: () => d.run('tmux', ['kill-window', '-t', windowId]),
  });
  rec.windowId = windowId;
  rec.paneId = paneId;
  d.fs.write(lc, lifecycleText(rec));

  try {
    d.run('tmux', [
      'send-keys',
      '-t',
      paneId,
      '-l',
      '--',
      claudeLine(b, kickoff !== null, a.skipPermissions),
    ]);
    d.run('tmux', ['send-keys', '-t', paneId, 'Enter']);
  } catch (err) {
    return rollback(`tmux send-keys failed: ${(err as Error).message}`);
  }

  // A live session now: nothing below rolls back.
  try {
    d.lanes.clear(b); // a lingering file of a past same-name lane would hand its PR number on (writeLane keeps pr)
    d.lanes.write(b, 'plan', kickoff !== null ? 'kickoff sent' : 'started', b, rec.baseSha);
  } catch (err) {
    d.log(`warning: board lane not written: ${(err as Error).message}`);
  }
  const confirmed = await confirmSession(d, b, wt);
  d.log(
    `lane ${b}: started in window ${windowId} (.claude/worktrees/${b})` +
      (confirmed
        ? `, session ${b} confirmed`
        : `; session name not confirmed: look at window ${windowId}`),
  );
  return EXIT.ok;
}

// Claude's own registry (~/.claude/sessions/<pid>.json; the .key files beside them are never read): a session in the
// worktree named after the branch.
async function confirmSession(d: Deps, b: string, wt: string): Promise<boolean> {
  const dir = `${d.env.home}/.claude/sessions`;
  const until = d.clock.now() + CONFIRM_MS;
  for (;;) {
    for (const f of d.fs.list(dir).filter((x) => x.endsWith('.json'))) {
      try {
        const s = JSON.parse(d.fs.read(`${dir}/${f}`) ?? 'null');
        if (s?.cwd === wt && s.name === b) return true;
      } catch {
        // mid-write
      }
    }
    if (d.clock.now() >= until) return false;
    await d.clock.sleep(1000);
  }
}
