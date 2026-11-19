// The hardened git runner for `pnpm claude-edit`: no global, system or user-level config or attributes, no hooks,
// no external diff or textconv, a fixed diff shape. What the user is shown must be what git commits, whatever a
// session wrote into ~/.gitconfig, ~/.config/git or the repo's own config (docs/ops/HUB.md → Agent-rule edits).
import { spawnSync } from 'node:child_process';
import { Refusal } from './rules.ts';

// git's empty tree (sha1): an attribute source with no .gitattributes in it.
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// The env is an allowlist: every inherited GIT_*, HOME and XDG_* is dropped (GIT_CONFIG_COUNT, GIT_EXTERNAL_DIFF,
// GIT_INDEX_FILE …). GIT_CONFIG_GLOBAL covers ~/.gitconfig and the XDG file; the attributes file is a -c below.
export function hardenedEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {
    PATH: base.PATH ?? '/usr/bin:/bin',
    LC_ALL: 'C',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1', // a refs/replace/<sha> could hide a branch's commits from rev-list
  };
  if (base.TMPDIR) env.TMPDIR = base.TMPDIR;
  return { ...env, ...extra };
}

// Before every subcommand. The repo's own config can't be switched off by env, so each key a session could plant
// there that changes a diff, an apply, a merge or a commit is pinned here; the round trip in `check` catches the rest.
export const GIT_PRE = [
  `--attr-source=${EMPTY_TREE}`,
  ...[
    'core.attributesFile=/dev/null',
    'core.hooksPath=/dev/null',
    'core.fsmonitor=false',
    'core.autocrlf=false',
    'core.safecrlf=false',
    'core.eol=lf',
    'core.quotePath=false',
    'core.whitespace=',
    'apply.whitespace=nowarn',
    'apply.ignoreWhitespace=no',
    'diff.noprefix=false',
    'diff.mnemonicPrefix=false',
    'diff.relative=false',
    'diff.suppressBlankEmpty=false',
    'diff.external=',
    'merge.default=text', // needs no attribute: `union` would turn a conflict into a clean replay
  ].flatMap((kv) => ['-c', kv]),
];

// Every diff the showing, the apply and the back-out read.
export const DIFF_FLAGS = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-renames',
  '--no-color',
  '--full-index',
  '--binary',
  '--inter-hunk-context=0',
  '--diff-algorithm=myers',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '-O/dev/null',
];

// verify's replay of an approved commit: renames off (a rename could carry an edit to another path; with none,
// directory renames have nothing to act on), the algorithm fixed so diff.algorithm can't steer the result.
export const MERGE_FLAGS = [
  '--write-tree',
  '--no-messages',
  '-X',
  'no-renames',
  '-X',
  'diff-algorithm=histogram',
];

export interface GitResult {
  status: number;
  stdout: Buffer;
  stderr: string;
}
export interface GitOpts {
  cwd: string;
  input?: Buffer | string;
  index?: string; // a scratch GIT_INDEX_FILE
}
export type GitExec = (args: string[], opts: GitOpts) => GitResult;

// `pre` is a test seam: a test drops one pin to show it matters.
export function makeExec(base: NodeJS.ProcessEnv = process.env, pre: string[] = GIT_PRE): GitExec {
  return (args, opts) => {
    const r = spawnSync('git', [...pre, ...args], {
      cwd: opts.cwd,
      input: opts.input,
      env: hardenedEnv(base, opts.index ? { GIT_INDEX_FILE: opts.index } : {}),
      maxBuffer: 64 << 20,
      timeout: 60_000,
    });
    if (r.error) throw r.error;
    return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr.toString('utf8').trim() };
  };
}

export interface Git {
  exec: GitExec;
  out: (args: string[], opts: GitOpts) => string; // trimmed stdout; a non-zero exit is a Refusal
  raw: (args: string[], opts: GitOpts) => Buffer;
  ok: (args: string[], opts: GitOpts) => boolean; // exit 0, for --quiet checks
}

export function makeGit(exec: GitExec = makeExec()): Git {
  const raw = (args: string[], opts: GitOpts) => {
    const r = exec(args, opts);
    if (r.status !== 0)
      throw new Refusal(`git ${args[0]} failed: ${r.stderr || `exit ${r.status}`}`);
    return r.stdout;
  };
  return {
    exec,
    raw,
    out: (args, opts) => raw(args, opts).toString('utf8').trim(),
    ok: (args, opts) => exec(args, opts).status === 0,
  };
}
