// `pnpm lane <command>`: one lane = one branch = one worktree = one Claude session named after the branch, born at
// kickoff and gone at cleanup. Plain node, builtins only. docs/ops/LANES.md.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../bot/cli.ts';
import { boardDir } from '../bot/lock-cache.ts';
import { run } from '../bot/sh.ts';
import { readLanes, writeLane } from '../board/tower/lanes.ts';
import { REPO_SLUG } from '../identifiers.ts';
import { MAC_PLACEHOLDER, MAC_ROOT_NOTE, macRoot } from '../mac-root.ts';
import { realFs } from './archive.ts';
import { end } from './end.ts';
import { start } from './start.ts';
import {
  EXIT,
  activeLanes,
  describeActive,
  laneCap,
  parseWorktrees,
  readLifecycle,
} from './state.ts';
import type { Deps, Lanes } from './state.ts';

export const USAGE = `pnpm lane <command>   (run from the main checkout; docs/ops/LANES.md)
  start <branch> [--kickoff <file>] [--skip-permissions] [--over-cap "<reason>"]
        worktree off origin/main + install + a tmux window running Claude named <branch> (the kickoff its first
        message) + the board lane. Give it a 600 s timeout: the install is in it.
  end <branch> [--force-abandon "<reason>"]
        merged PR + green main deploy (or the reason) → archive localNotes, remove the worktree, clear the lane,
        print the maintainer's Mac line, close the lane's window by id
  status                               active lanes against the cap`;

const flag = (f: Record<string, string>, k: string) => (k in f ? f[k]! : null);

export function lanesAt(dir: string): Lanes {
  return {
    read: () => readLanes(dir).lanes,
    write: (branch, phase, step, session, sha) =>
      void writeLane(
        dir,
        { clear: false, phase, step, pr: null, slot: null, session, needs: null },
        { branch, sha, session, now: new Date() },
      ),
    clear: (branch) =>
      void writeLane(
        dir,
        { clear: true, phase: null, step: null, pr: null, slot: null, session: null, needs: null },
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
  for (const a of active) {
    const r = readLifecycle(d, a.branch);
    d.log(
      `  ${a.branch}: ${a.why}${r?.windowId ? `, window ${r.windowId}` : ''}${r?.overCap ? `, over cap: ${r.overCap}` : ''}`,
    );
  }
  return EXIT.ok;
}

export async function main(argv: string[], deps: () => Deps = realDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  const known: Record<string, string[]> = {
    start: ['kickoff', 'skip-permissions', 'over-cap'],
    end: ['force-abandon'],
    status: [],
  };
  if (cmd === '--help' || 'help' in flags) {
    console.log(USAGE);
    return EXIT.ok;
  }
  if (!cmd || !(cmd in known)) {
    console.error(cmd ? `unknown command "${cmd}"\n${USAGE}` : USAGE);
    return EXIT.usage;
  }
  const extra = Object.keys(flags).filter((k) => !known[cmd]!.includes(k));
  if (extra.length || positional.length > (cmd === 'status' ? 0 : 1)) {
    console.error(
      `lane: unexpected ${extra.length ? `--${extra[0]}` : `argument ${positional.at(-1)}`}\n${USAGE}`,
    );
    return EXIT.usage;
  }
  const d = deps();
  if (cmd === 'status') return status(d);
  if (cmd === 'end')
    return end(d, { branch: positional[0], abandon: flag(flags, 'force-abandon') });
  const kickoff = flag(flags, 'kickoff');
  if (kickoff === 'true') {
    console.error('lane: --kickoff wants a file');
    return EXIT.usage;
  }
  return start(d, {
    branch: positional[0],
    kickoff: kickoff === null ? null : resolve(d.env.invokedIn, kickoff),
    skipPermissions: flag(flags, 'skip-permissions') === 'true',
    overCap: flag(flags, 'over-cap'),
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
