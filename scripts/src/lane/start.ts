// `pnpm lanes start <branch>`: the worktree off origin/main, its install, a tmux window running Claude named after the
// branch with the kickoff as its first message, the board lane, then sync-main. Refuses before changing anything; a failure
// midway rolls back what it made (docs/ops/LANES.md → Start).
import {
  EXIT,
  activeLanes,
  compactWindow,
  describeActive,
  macRead,
  expectedGitdir,
  hubName,
  laneCap,
  lifecyclePath,
  lifecycleText,
  nameProblem,
  parseWorktrees,
  syncMainSoft,
  tryRun,
  worktreePath,
  LS_REMOTE_TIMEOUT_MS,
} from './state.ts';
import type { Deps, Lifecycle } from './state.ts';
import { MainBusy } from '../board/main-lock.ts';
import { LANES_THROTTLED, powerSummary } from '../board/tower/health.ts';
import { FETCH_TIMEOUT_MS } from '../board/sync-main.ts';
import { lastStartFile, lastStartText, paceBlock, waitForPace } from './pace.ts';

export const KICKOFF_MAX = 256 * 1024;
export const CONFIRM_MS = 20_000;
// The only prompt text that reaches an argv: COI reads every argv, and a kickoff quoting the safety rules would kill
// the container. Claude reads the kickoff itself.
export const KICKOFF_PROMPT =
  'Read docs/ops/FEATURE-WORKFLOW.md first, then localNotes/kickoff.md, and follow both. The kickoff is for this lane, written by the hub.';

export type StartArgs = {
  branch: string | undefined;
  kickoff: string | null;
  overCap: string | null;
  overPace: string | null;
  waitMin: number | null; // --wait: minutes to wait for the pace gate (cli.ts parseWait)
};

const refuse = (d: Deps, msg: string, code: number = EXIT.refused) => {
  d.log(`lane: ${msg}`);
  return code;
};

// The shell line typed into the new window: only the validated branch and the integer window vary.
export const claudeLine = (b: string, kickoff: boolean, window: number | null = null) =>
  `claude -n ${b}` +
  // a flag, not the env var: the PreCompact hook's handoff fork would inherit an env var and compact itself
  (window === null ? '' : ` --autocompact ${window}`) +
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
  if (a.overCap !== null && (a.overCap === 'true' || !a.overCap.trim()))
    return refuse(d, '--over-cap wants a reason', EXIT.usage);
  if (a.overPace !== null && (a.overPace === 'true' || !a.overPace.trim()))
    return refuse(d, '--over-pace wants a reason', EXIT.usage);
  if (a.overPace !== null && a.waitMin !== null)
    return refuse(d, '--wait and --over-pace together: pick one', EXIT.usage);
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

  const wt = worktreePath(e, b);
  const lc = lifecyclePath(e, b);
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
    overPace: a.overPace,
    archive: null,
    startedAt: new Date(d.clock.now()).toISOString(),
  };
  // From here every step registers its undo; a failure runs them in reverse.
  const undo: { what: string; fn: () => void }[] = [];
  const rollback = (why: string) => {
    d.log(`lane: ${why}; rolling back`);
    const left: string[] = [];
    const steps = () => {
      for (const u of undo.reverse()) {
        try {
          u.fn();
        } catch (err) {
          left.push(`${u.what} (${(err as Error).message.split('\n')[0]})`);
        }
      }
    };
    try {
      d.lock(steps); // its git steps touch the main checkout's refs too; nested inside the locked span, free
    } catch (err) {
      if (!(err instanceof MainBusy)) throw err;
      steps(); // undoing beats leaving it half made
    }
    d.log(left.length ? `left behind: ${left.join('; ')}` : 'rolled back: nothing left behind');
    return EXIT.failed;
  };

  // The dirty check through worktree add run under the main-checkout lock (board/main-lock.ts, F155): sync-main (a
  // `lanes end` finishing) can't move HEAD or refs in between. Busy past its wait is a refusal: nothing changed.
  let base = '';
  let early: number | null;
  const RACED = -1; // lost the in-lock pace check with wait time left: wait again
  const until = a.waitMin === null ? null : d.clock.now() + a.waitMin * 60_000;
  const stillBusy = (why: string) =>
    refuse(d, `pace: still busy after ${a.waitMin} min: ${why}`, EXIT.later);
  for (;;) {
    // The pace gate (pace.ts), before the lock so a wait never holds it; checked again inside the lock.
    if (a.overPace === null) {
      const why = until === null ? paceBlock(d) : await waitForPace(d, until, a.waitMin!);
      if (why && until === null)
        return refuse(
          d,
          `pace: ${why}. Retry later, pass --wait, or --over-pace "<reason>".`,
          EXIT.later,
        );
      if (why) return stillBusy(why);
    }
    try {
      early = d.lock((): number | null => {
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
          d.run('git', ['fetch', 'origin'], { cwd: e.mainRoot, timeoutMs: FETCH_TIMEOUT_MS });
        } catch (err) {
          return refuse(
            d,
            `git fetch failed (nothing changed): ${(err as Error).message}`,
            EXIT.failed,
          );
        }
        if (
          tryRun(d, 'git', ['show-ref', '--verify', '--quiet', `refs/heads/${b}`], e.mainRoot) !==
          null
        )
          return refuse(d, `branch ${b} already exists (local)`);
        let remote: string;
        try {
          remote = d
            .run('git', ['ls-remote', '--heads', 'origin', `refs/heads/${b}`], {
              cwd: e.mainRoot,
              timeoutMs: LS_REMOTE_TIMEOUT_MS,
            })
            .trim();
        } catch (err) {
          return refuse(
            d,
            `git ls-remote failed (nothing changed): ${(err as Error).message}`,
            EXIT.failed,
          );
        }
        if (remote) return refuse(d, `branch ${b} already exists (on origin)`);
        const trees = parseWorktrees(
          d.run('git', ['worktree', 'list', '--porcelain'], { cwd: e.mainRoot }),
        );
        if (d.fs.exists(wt) || trees.some((t) => t.path === wt))
          return refuse(d, `.claude/worktrees/${b} already exists`);
        if (d.fs.exists(lifecyclePath(e, b)))
          return refuse(d, `a lifecycle record for ${b} exists: pnpm lanes end ${b} first`);
        // Tab-separated: a window name may hold spaces.
        const windows = d.run('tmux', ['list-windows', '-a', '-F', '#{window_id}\t#{window_name}']);
        const same = windows.split('\n').find((l) => l.slice(l.indexOf('\t') + 1) === b);
        if (same)
          return refuse(
            d,
            `a window named ${b} exists (${same.split('\t')[0]}): names are addresses`,
          );
        const active = activeLanes(d, trees);
        const cap = laneCap(d);
        if (active.length >= cap && a.overCap === null)
          return refuse(
            d,
            `${active.length} of ${cap} lanes active: ${describeActive(active)}. End one (pnpm lanes end), park one ` +
              `(pnpm board lane parked), or pass --over-cap "<reason>".`,
            EXIT.later,
          );
        if (active.length >= cap) d.log(`over the cap (${active.length} of ${cap}): ${a.overCap}`);
        // advice, never a refusal: the hub decides (docs/ops/HUB.md → lanes on battery)
        const advice = powerSummary(macRead(d)).advice;
        if (advice && active.length >= LANES_THROTTLED)
          d.log(
            `note: the Mac is on battery or Low Power Mode, ${active.length} lanes active already: suggest ${advice}`,
          );

        // The authoritative pace check: another start may have stamped, or the box turned hot, since the one above.
        const pace = paceBlock(d);
        if (pace && a.overPace === null) {
          if (until === null)
            return refuse(
              d,
              `pace: turned busy during the start (${pace}); nothing changed, rerun with --wait`,
              EXIT.later,
            );
          return d.clock.now() < until ? RACED : stillBusy(pace);
        }
        if (pace) d.log(`over the pace gate (${pace}): ${a.overPace}`);

        rec.startedAt = new Date(d.clock.now()).toISOString(); // after any wait: the claim is the start
        if (!d.fs.writeNew(lc, lifecycleText(rec)))
          return refuse(d, `a lifecycle record for ${b} appeared meanwhile: another start?`);
        undo.push({ what: `lifecycle record ${lc}`, fn: () => d.fs.rm(lc) });
        // Kept on a rollback: the spacing counts every start that got this far.
        try {
          d.fs.write(lastStartFile(e), lastStartText(b, d.clock.now()));
        } catch (err) {
          // spacing is advisory: an unwritable board dir must not block every start, --over-pace included
          d.log(
            `warning: start time not recorded (the spacing won't see this start): ${(err as Error).message}`,
          );
        }

        // One sha for every step: another session's fetch moving origin/main mid-start can't split the base.
        try {
          base = d.run('git', ['rev-parse', 'origin/main'], { cwd: e.mainRoot });
          rec.baseSha = base;
          if (d.run('git', ['rev-parse', 'HEAD'], { cwd: e.mainRoot }) !== base)
            d.run('git', ['switch', '--detach', base], { cwd: e.mainRoot });
        } catch (err) {
          return rollback(
            `could not detach the main checkout at origin/main: ${(err as Error).message}`,
          );
        }
        try {
          d.run('git', ['worktree', 'add', '--no-track', '-b', b, `.claude/worktrees/${b}`, base], {
            cwd: e.mainRoot,
          });
        } catch (err) {
          // git makes the -b branch before the checkout and keeps it when the checkout fails: take it back if it is ours.
          const made = tryRun(
            d,
            'git',
            ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`],
            e.mainRoot,
          );
          if (made === base)
            undo.push({
              what: `branch ${b}`,
              fn: () => {
                d.run('git', ['worktree', 'prune'], { cwd: e.mainRoot }); // repo-wide, but only drops dead admin dirs
                d.run('git', ['branch', '-d', b], { cwd: e.mainRoot });
              },
            });
          return rollback(`worktree add failed: ${(err as Error).message}`);
        }
        // The safe delete: the branch sits at the main checkout's HEAD, so -d never refuses (and never loses work).
        undo.push({
          what: `branch ${b}`,
          fn: () => d.run('git', ['branch', '-d', b], { cwd: e.mainRoot }),
        });
        undo.push({
          what: `worktree ${wt}`,
          fn: () =>
            d.run('git', ['worktree', 'remove', `.claude/worktrees/${b}`], { cwd: e.mainRoot }),
        });

        return null;
      });
    } catch (err) {
      if (err instanceof MainBusy)
        return refuse(d, `${err.message} (nothing changed; retry)`, EXIT.later);
      throw err;
    }
    if (early !== RACED) break;
    d.log('pace: another start got in first; waiting again');
  }
  if (early !== null) return early;

  const gitdir = (d.fs.read(`${wt}/.git`) ?? '').trim();
  if (gitdir !== expectedGitdir(b))
    return rollback(
      `the worktree's .git reads "${gitdir}", not "${expectedGitdir(b)}" (git < 2.48? docs/ops/LANES.md → Start)`,
    );

  d.log(`installing in .claude/worktrees/${b} …`);
  try {
    d.run('pnpm', ['install'], { cwd: wt, env: { ...process.env, CI: 'true' } });
  } catch (err) {
    const tail = (err as Error).message.split('\n').slice(-15).join('\n');
    return rollback(`pnpm install failed:\n${tail}`);
  }
  try {
    if (kickoff !== null) d.fs.write(`${wt}/localNotes/kickoff.md`, kickoff);
  } catch (err) {
    return rollback(`could not copy the kickoff: ${(err as Error).message}`);
  }

  let ids: string[];
  try {
    ids = d
      .run('tmux', [
        'new-window',
        '-d',
        '-P',
        '-F',
        '#{window_id}\t#{pane_id}',
        '-t',
        `${tmuxSession}:`,
        '-n',
        b,
        '-c',
        wt,
      ])
      .split('\t');
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
  try {
    d.fs.write(lc, lifecycleText(rec));
  } catch (err) {
    return rollback(`could not record the window: ${(err as Error).message}`);
  }

  try {
    const line = claudeLine(b, kickoff !== null, compactWindow(d));
    d.run('tmux', ['send-keys', '-t', paneId, '-l', '--', line]);
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
  syncMainSoft(d); // last: the main checkout moved above, and a slow fetch here can't hold back the line before
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
