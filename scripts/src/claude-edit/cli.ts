// `pnpm claude-edit <command>`: the hub's checks for a lane's CLAUDE.md / .claude/ patch, run from /workspace (main's
// code). The flow, and what the user sees and types: docs/ops/HUB.md → Agent-rule edits. Plain node, builtins only.
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../bot/cli.ts';
import { cliGuard, emit } from '../bot/help.ts';
import type { Spec } from '../bot/help.ts';
import { MAC_PLACEHOLDER, MAC_ROOT_NOTE, readMacRoot } from '../mac-root.ts';
import { makeGit } from './git.ts';
import { EXIT, Refusal, Stuck } from './rules.ts';
import { check, close, record, stage, unstage, verify } from './steps.ts';
import type { Deps } from './steps.ts';

export const USAGE = `pnpm -C /workspace claude-edit <command>   (the hub, main's code; docs/ops/HUB.md → Agent-rule edits)
  check <branch> <n> [--exec <path>[,<path>]]
        build T from the lane's HEAD (B) and localNotes/claude-edit-<n>.patch, check it, write the showing file the
        user reads and print the header to paste. From a lane's own checkout: a PRE-CHECK, nothing written.
  stage <branch> --base <B> --tree <T> --message "<commit message>"
        the showing file is still the one check wrote; stage exactly T in the lane's worktree; prints the lines to run
  unstage <branch> --base <B> --tree <T>
        a staged T that was never committed (the commit denied, the go withdrawn): back to B
  record <branch> --base <B> --tree <T>
        after the commit: HEAD is one commit of T on B; writes the ledger row, pins the commit under refs/claude-edits/ and prints the record for the [relay]
  verify <branch>
        after git fetch origin: every commit on it touching CLAUDE.md, .claude/ or the root .gitattributes is an approved
        commit or a clean replay of one, and its newest approval is on it; prints the merge line's part
  close <branch>
        after its PR merges (or it is dropped): its approvals stop counting and its pins are deleted
exit: 0 ok · 1 refused (nothing changed; for record, fix the call and rerun) · 2 usage · 3 stuck, needs a person`;

export const FLAGS: Record<string, Spec> = {
  check: { flags: ['exec'], args: 2 },
  stage: { flags: ['base', 'tree', 'message'], args: 1 },
  unstage: { flags: ['base', 'tree'], args: 1 },
  record: { flags: ['base', 'tree'], args: 1 },
  verify: { args: 1 },
  close: { args: 1 },
};

// This file's own checkout, and the main checkout its git common dir names.
const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function realDeps(): Deps {
  const git = makeGit();
  const common = git.out(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: CLI_ROOT,
  });
  const main = dirname(common);
  return {
    git,
    main,
    fromMain: realpathSync(CLI_ROOT) === realpathSync(main),
    macRoot: readMacRoot(join(main, '.local', 'mac-root')) ?? `${MAC_PLACEHOLDER} ${MAC_ROOT_NOTE}`,
    now: () => new Date(),
    log: (s) => console.log(s),
  };
}

const usage = (why: string) => {
  console.error(`${why}\n${USAGE}`);
  return EXIT.usage;
};

export function main(argv: string[], deps: () => Deps = realDeps): number {
  const guard = cliGuard(argv, USAGE, FLAGS, parseArgs);
  if (guard) return emit(guard);
  const [cmd, ...rest] = argv;
  if (!cmd || !(cmd in FLAGS)) return usage(cmd ? `unknown command "${cmd}"` : 'no command');
  const { positional, flags } = parseArgs(rest);
  const branch = positional[0];
  if (!branch) return usage(`${cmd}: needs a branch`);
  try {
    if (cmd === 'check') {
      const n = Number(positional[1]);
      if (!Number.isInteger(n) || n < 1) return usage('check: <n> is a whole number from 1');
      const exec = flags.exec ? flags.exec.split(',').filter(Boolean) : [];
      return check(deps(), { branch, n, exec });
    }
    if (cmd === 'verify') return verify(deps(), { branch });
    if (cmd === 'close') return close(deps(), { branch });
    const base = flags.base ?? '';
    const tree = flags.tree ?? '';
    if (!base || !tree) return usage(`${cmd}: needs --base <B> and --tree <T>`);
    if (cmd === 'stage') {
      if (!flags.message) return usage('stage: needs --message "<commit message>"');
      return stage(deps(), { branch, base, tree, message: flags.message });
    }
    return (cmd === 'unstage' ? unstage : record)(deps(), { branch, base, tree });
  } catch (e) {
    if (e instanceof Stuck) {
      console.error(`claude-edit ${cmd}: STUCK — ${e.message}`);
      return EXIT.stuck;
    }
    if (e instanceof Refusal) {
      console.error(`claude-edit ${cmd}: refused — ${e.message}`);
      return EXIT.refused;
    }
    throw e;
  }
}

// Run only as the entry point (tests import main).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`claude-edit: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT.stuck);
  }
}
