// `pnpm lanes <command>`: one lane = one branch = one worktree = one Claude session named after the branch, born at
// kickoff and gone at cleanup. Plain node, builtins only. docs/ops/LANES.md.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../bot/cli.ts';
import { cliGuard, emit } from '../bot/help.ts';
import type { Spec } from '../bot/help.ts';
import { boardDir } from '../bot/lock-cache.ts';
import { run } from '../bot/sh.ts';
import { withMainLock } from '../board/main-lock.ts';
import { macLine } from '../board/machine.ts';
import { execRun, syncMain } from '../board/sync-main.ts';
import { readLanes, writeLane } from '../board/tower/lanes.ts';
import { REPO_SLUG } from '../identifiers.ts';
import { MAC_PLACEHOLDER, MAC_ROOT_NOTE, macRoot } from '../mac-root.ts';
import { realFs } from './archive.ts';
import { end } from './end.ts';
import { WAIT_MAX_MIN, parseWait } from './pace.ts';
import { start } from './start.ts';
import {
  EXIT,
  activeLanes,
  describeActive,
  macRead,
  laneCap,
  parseWorktrees,
  readLifecycle,
} from './state.ts';
import type { Deps, Lanes } from './state.ts';

export const USAGE = `pnpm lanes <command>   (run from the main checkout; docs/ops/LANES.md)
  start <branch> [--kickoff <file>] [--over-cap "<reason>"] [--wait[=<min>] | --over-pace "<reason>"]
        worktree off origin/main + install + a tmux window running Claude named <branch> (the kickoff its first
        message) + the board lane. Give it a 600 s timeout: the install is in it (with --wait, run it in the background).
        Refuses (75) while the pace gate is busy: --wait polls up to <min> (default 5, max 30) first.
  end <branch> [--force-abandon "<reason>"]
        merged PR + green main deploy (or the reason) → archive localNotes, remove the worktree, clear the lane,
        print the maintainer's Mac line, close the lane's window by id
  status                               active lanes against the cap`;

const NO_PLAN = { plan: null, files: null, etaNext: null, etaPr: null }; // the step plan stays the lane's own

const flag = (f: Record<string, string>, k: string) => (k in f ? f[k]! : null);

export function lanesAt(dir: string): Lanes {
  return {
    read: () => readLanes(dir).lanes,
    write: (branch, phase, step, session, sha) =>
      void writeLane(
        dir,
        { clear: false, phase, step, pr: null, slot: null, session, needs: null, ...NO_PLAN },
        { branch, sha, session, now: new Date() },
      ),
    clear: (branch) =>
      void writeLane(
        dir,
        {
          clear: true,
          phase: null,
          step: null,
          pr: null,
          slot: null,
          session: null,
          needs: null,
          ...NO_PLAN,
        },
        { branch, sha: null, session: null, now: new Date() },
      ),
  };
}

function realDeps(): Deps {
  const here = process.env.INIT_CWD ?? process.cwd(); // pnpm runs scripts from the root; INIT_CWD is where it was typed
  const at = (args: string[]) => run('git', args, { cwd: here });
  const mainRoot = dirname(at(['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const board = boardDir((c, a) => run(c, a, { cwd: here }));
  if (!board) throw new Error('no board dir (set APERTURE_BOARD_DIR)');
  const root = macRoot();
  return {
    run,
    fs: realFs,
    lanes: lanesAt(board),
    clock: { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    log: (s) => console.log(s),
    env: {
      mainRoot,
      cwdTop: at(['rev-parse', '--show-toplevel']),
      invokedIn: here,
      boardDir: board,
      home: homedir(),
      tmuxPane: process.env.TMUX_PANE || null,
      macRoot: root,
      macNote: root === MAC_PLACEHOLDER ? MAC_ROOT_NOTE : '',
      slug: REPO_SLUG,
      procDir: '/proc',
    },
    syncMain: () => syncMain(execRun, mainRoot, withMainLock),
    lock: withMainLock,
  };
}

export function status(d: Deps): number {
  const trees = parseWorktrees(
    d.run('git', ['worktree', 'list', '--porcelain'], { cwd: d.env.mainRoot }),
  );
  const active = activeLanes(d, trees);
  d.log(
    `${active.length} of ${laneCap(d)} lanes active${active.length ? `: ${describeActive(active)}` : ''}`,
  );
  d.log(macLine(macRead(d))); // battery / Low Power Mode / thermal, with the ≤ 3 lanes advice (docs/ops/HUB.md)
  for (const a of active) {
    const r = readLifecycle(d, a.branch);
    d.log(
      `  ${a.branch}: ${a.why}${r?.windowId ? `, window ${r.windowId}` : ''}${r?.overCap ? `, over cap: ${r.overCap}` : ''}${r?.overPace ? `, over pace: ${r.overPace}` : ''}`,
    );
  }
  return EXIT.ok;
}

// Each command's flags (bot/help.ts cliGuard): help or a stray argument runs nothing.
export const FLAGS: Record<string, Spec> = {
  start: { flags: ['kickoff', 'over-cap', 'over-pace'], optional: ['wait'], args: 1 },
  end: { flags: ['force-abandon'], args: 1 },
  status: { args: 0 },
};

export async function main(argv: string[], deps: () => Deps = realDeps): Promise<number> {
  const guard = cliGuard(argv, USAGE, FLAGS, parseArgs);
  if (guard) return emit(guard);
  const [cmd, ...rest] = argv;
  if (!cmd || !(cmd in FLAGS)) {
    console.error(cmd ? `unknown command "${cmd}"\n${USAGE}` : USAGE);
    return EXIT.usage;
  }
  const { positional, flags } = parseArgs(rest);
  const wait = parseWait(flag(flags, 'wait')); // before deps: `--wait <branch>` swallows the branch
  if (wait === 'bad') {
    console.error(`--wait takes whole minutes, 1 to ${WAIT_MAX_MIN}: --wait=10\n${USAGE}`);
    return EXIT.usage;
  }
  const d = deps();
  if (cmd === 'status') return status(d);
  if (cmd === 'end')
    return end(d, { branch: positional[0], abandon: flag(flags, 'force-abandon') });
  const kickoff = flag(flags, 'kickoff');
  return start(d, {
    branch: positional[0],
    kickoff: kickoff === null ? null : resolve(d.env.invokedIn, kickoff),
    overCap: flag(flags, 'over-cap'),
    overPace: flag(flags, 'over-pace'),
    waitMin: wait,
  });
}

// Run only as the entry point (tests import main).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`lane: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(EXIT.failed);
    },
  );
}
