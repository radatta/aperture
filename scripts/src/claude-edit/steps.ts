// `pnpm claude-edit` steps (docs/ops/HUB.md → Agent-rule edits). The hub runs them from /workspace, main's code: a
// lane's patch becomes tree T on base commit B in a scratch index, the hub shows the diff git derives from those two
// objects, and only an index that is exactly T is committed.
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Git } from './git.ts';
import { DIFF_FLAGS } from './git.ts';
import {
  BRANCH,
  Refusal,
  SHA,
  Stuck,
  charProblems,
  decodeStrict,
  flagsFor,
  judgeEntries,
  parseLedger,
  parseNumstat,
  parseRaw,
  extractDiff,
  renderFile,
  renderHeader,
  showingFile,
  showingNumber,
  unapproved,
  wasShown,
} from './rules.ts';
import type { Row } from './rules.ts';

export interface Deps {
  git: Git;
  main: string; // the main checkout (/workspace): worktrees, the ledger
  fromMain: boolean; // the CLI runs from the main checkout's own code
  macRoot: string; // the main checkout's path on the Mac, where the user reads the showing file
  now: () => Date;
  log: (s: string) => void;
}

const PATHS = [':(icase)CLAUDE.md', ':(icase).claude'];
const MAX_PATCH = 1 << 20;
export const ledgerPath = (d: Deps) => join(d.main, 'localNotes', 'claude-edits.jsonl');
const SHOWINGS = ['localNotes', 'claude-edits'];
export const showingPath = (d: Deps, branch: string, tree: string) =>
  join(d.main, ...SHOWINGS, showingFile(branch, tree));

function readRows(d: Deps): Row[] {
  try {
    return parseLedger(readFileSync(ledgerPath(d), 'utf8'));
  } catch {
    return [];
  }
}
const addRow = (d: Deps, r: Omit<Row, 't'>) =>
  appendFileSync(ledgerPath(d), JSON.stringify({ t: d.now().toISOString(), ...r }) + '\n');

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

function mainOnly(d: Deps, cmd: string) {
  if (!d.fromMain)
    throw new Refusal(
      `${cmd} runs only from the main checkout's code (/workspace), never a lane's copy`,
    );
}

// The lane's worktree: <main>/.claude/worktrees/<branch>, its own toplevel, on <branch>.
function worktree(d: Deps, branch: string): string {
  if (!BRANCH.test(branch)) throw new Refusal(`bad branch name "${branch}"`);
  const w = join(d.main, '.claude', 'worktrees', branch);
  if (!real(w)) throw new Refusal(`${w} is not a worktree of its own`);
  const top = d.git.exec(['rev-parse', '--show-toplevel'], { cwd: w });
  if (top.status !== 0 || real(top.stdout.toString().trim()) !== real(w))
    throw new Refusal(`${w} is not a worktree of its own`);
  const head = d.git.exec(['symbolic-ref', '--short', 'HEAD'], { cwd: w });
  if (head.status !== 0 || head.stdout.toString().trim() !== branch)
    throw new Refusal(`${w} is not on ${branch}`);
  // info/attributes (the worktree's and the common one) outranks --attr-source: it must be missing or empty.
  const abs = (...a: string[]) =>
    d.git.out(['rev-parse', '--path-format=absolute', ...a], { cwd: w });
  for (const at of [
    abs('--git-path', 'info/attributes'),
    join(abs('--git-common-dir'), 'info', 'attributes'),
  ]) {
    let body = '';
    try {
      body = readFileSync(at, 'utf8');
    } catch {
      // missing is fine
    }
    if (body.trim()) throw new Refusal(`${at} is not empty`);
  }
  return w;
}

function clean(d: Deps, w: string) {
  d.git.exec(['update-index', '-q', '--refresh'], { cwd: w });
  if (!d.git.ok(['diff-index', '--cached', '--quiet', 'HEAD', '--'], { cwd: w }))
    throw new Refusal('the worktree has staged changes');
  if (!d.git.ok(['diff-files', '--quiet', '--', ...PATHS], { cwd: w }))
    throw new Refusal('the worktree has unstaged changes under CLAUDE.md or .claude/');
}

function withScratch<T>(fn: (index: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'claude-edit-'));
  try {
    return fn(join(dir, 'index'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// T: base B with the patch applied, in a scratch index (the worktree's own index is never touched).
function buildTree(d: Deps, w: string, base: string, patch: Buffer, exec: string[]): string {
  return withScratch((index) => {
    const o = { cwd: w, index };
    d.git.out(['read-tree', base], o);
    d.git.out(['apply', '--cached', '-'], { ...o, input: patch });
    for (const p of exec) {
      const blob = d.git.out(['rev-parse', `:${p}`], o);
      d.git.out(['update-index', '--cacheinfo', `100755,${blob},${p}`], o);
    }
    return d.git.out(['write-tree'], o);
  });
}

// The tree a diff text gives on B, in a scratch index; null when it doesn't apply.
function treeFromText(d: Deps, w: string, base: string, text: string): string | null {
  return withScratch((index) => {
    d.git.out(['read-tree', base], { cwd: w, index });
    const r = d.git.exec(['apply', '--cached', '-'], { cwd: w, index, input: text });
    return r.status === 0 ? d.git.out(['write-tree'], { cwd: w, index }) : null;
  });
}

// The diff git derives from the two objects: what is shown, staged, backed out and patch-id'd.
const objectDiff = (d: Deps, w: string, from: string, to: string, context = 3) =>
  d.git.raw(['diff-tree', '-p', '-r', ...DIFF_FLAGS, `-U${context}`, from, to, '--'], { cwd: w });

export function patchId(d: Deps, cwd: string, from: string, to: string): string {
  const diff = objectDiff(d, cwd, from, to, 0);
  const id = d.git.out(['patch-id', '--verbatim'], { cwd, input: diff }).split(' ')[0] ?? '';
  if (!SHA.test(id)) throw new Refusal(`no patch-id for ${from}..${to}`);
  return id;
}

export function check(d: Deps, a: { branch: string; n: number; exec: string[] }): number {
  const w = worktree(d, a.branch);
  clean(d, w);
  const file = join(w, 'localNotes', `claude-edit-${a.n}.patch`);
  const st = (() => {
    try {
      return lstatSync(file);
    } catch {
      return null;
    }
  })();
  if (!st?.isFile()) throw new Refusal(`${file} is not a regular file`);
  if (st.size > MAX_PATCH) throw new Refusal(`${file} is over 1 MiB`);
  const patch = readFileSync(file); // read once; nothing re-reads the lane's file
  const base = d.git.out(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: w });
  const tree = buildTree(d, w, base, patch, a.exec);
  const o = { cwd: w };
  const z = (args: string[]) =>
    d.git.raw(['diff-tree', '-r', '-z', '--no-renames', ...args, base, tree], o).toString('utf8');
  const entries = parseRaw(z(['--raw']));
  if (!entries.length) throw new Refusal('the patch changes nothing');
  const numstat = parseNumstat(z(['--numstat']));
  const problems = judgeEntries(entries, numstat, a.exec);
  const claudeMd = entries.find((e) => e.path === 'CLAUDE.md' && e.status !== 'D');
  if (claudeMd) {
    const lines =
      d.git
        .raw(['cat-file', 'blob', `${tree}:CLAUDE.md`], o)
        .toString('utf8')
        .split('\n').length - 1;
    if (lines >= 200) problems.push(`CLAUDE.md: ${lines} lines (must stay under 200)`);
  }
  if (problems.length) throw new Refusal(problems.join('\n'));
  const text = decodeStrict(objectDiff(d, w, base, tree));
  const hidden = charProblems(text);
  if (hidden.length) throw new Refusal(`hidden characters: ${hidden.slice(0, 10).join(', ')}`);
  // The round trip: the shown text applied to B must give T, or some config shaped the text.
  const back = treeFromText(d, w, base, text);
  if (back !== tree)
    throw new Refusal(`round trip gave ${back}, not ${tree}: the showing would not be T`);
  const untracked = d.git
    .out(['ls-files', '--others', '--exclude-standard', '-z', '--', ':(icase).claude'], o)
    .split('\0')
    .filter(Boolean);
  const rows = readRows(d);
  const files = numstat.map((n) => {
    const e = entries.find((x) => x.path === n.path);
    return `${e?.status ?? '?'} ${n.path} (+${n.added} -${n.deleted})`;
  });
  const s = {
    branch: a.branch,
    n: a.n,
    showing: showingNumber(rows, a.branch, tree),
    base,
    tree,
    files,
    flags: flagsFor(entries),
    untracked,
    text,
  };
  if (!d.fromMain) {
    d.log(renderHeader(s, null));
    return 0;
  }
  mkdirSync(join(d.main, ...SHOWINGS), { recursive: true });
  writeFileSync(showingPath(d, a.branch, tree), renderFile(s));
  if (!wasShown(rows, a.branch, base, tree))
    addRow(d, { kind: 'shown', branch: a.branch, n: a.n, base, tree });
  d.log(renderHeader(s, [d.macRoot, ...SHOWINGS, showingFile(a.branch, tree)].join('/')));
  return 0;
}

function shas(base: string, tree: string) {
  if (!SHA.test(base) || !SHA.test(tree)) throw new Refusal('--base and --tree take full shas');
}

export function stage(d: Deps, a: { branch: string; base: string; tree: string }): number {
  mainOnly(d, 'stage');
  shas(a.base, a.tree);
  const w = worktree(d, a.branch);
  if (!wasShown(readRows(d), a.branch, a.base, a.tree))
    throw new Refusal(`${a.branch} was never shown B ${a.base} T ${a.tree}: run check and show it`);
  const o = { cwd: w };
  if (d.git.out(['rev-parse', 'HEAD'], o) !== a.base)
    throw new Refusal(`${a.branch} HEAD is not B: it moved`);
  clean(d, w);
  // The file the user read must still give T; else it changed after the showing.
  const shown = (() => {
    try {
      return readFileSync(showingPath(d, a.branch, a.tree), 'utf8');
    } catch {
      throw new Refusal(`no showing file for T ${a.tree}: run check and show it again`);
    }
  })();
  const read = treeFromText(d, w, a.base, extractDiff(shown));
  if (read !== a.tree)
    throw new Refusal(
      `the showing file gives ${read ?? 'nothing'}, not T: run check and show it again`,
    );
  const text = objectDiff(d, w, a.base, a.tree);
  d.git.out(['apply', '--index', '-'], { ...o, input: text });
  const got = d.git.out(['write-tree'], o);
  if (got !== a.tree) {
    const r = d.git.exec(['apply', '--index', '-R', '-'], { ...o, input: text });
    const baseTree = d.git.out(['rev-parse', `${a.base}^{tree}`], o);
    if (r.status !== 0 || d.git.out(['write-tree'], o) !== baseTree)
      throw new Stuck(`staged ${got}, not T, and the back-out failed: ${w} needs a person`);
    throw new Refusal(`staged ${got}, not T: backed out, nothing changed`);
  }
  d.log(
    [
      `staged T ${a.tree} in ${w}. Run these three lines, each as its own Bash call:`,
      `cd ${w}`,
      `[ "$(git rev-parse --show-toplevel)" = ${w} ] && [ "$(git write-tree)" = ${a.tree} ] && git -c core.hooksPath=/dev/null commit -m "<4-5 words, CLAUDE.md's commit rule>"`,
      `cd ${d.main}`,
      `then: pnpm claude-edit record ${a.branch} --base ${a.base} --tree ${a.tree}`,
    ].join('\n'),
  );
  return 0;
}

export function record(d: Deps, a: { branch: string; base: string; tree: string }): number {
  mainOnly(d, 'record');
  shas(a.base, a.tree);
  const w = worktree(d, a.branch);
  const rows = readRows(d);
  if (!wasShown(rows, a.branch, a.base, a.tree))
    throw new Refusal(`${a.branch} was never shown this B and T`);
  const o = { cwd: w };
  const head = d.git.out(['rev-parse', 'HEAD'], o);
  const tree = d.git.out(['rev-parse', 'HEAD^{tree}'], o);
  const parents = d.git.out(['rev-list', '--parents', '-n', '1', 'HEAD'], o).split(' ').slice(1);
  if (tree !== a.tree || parents.length !== 1 || parents[0] !== a.base)
    throw new Stuck(
      `HEAD ${head} is not one commit of T ${a.tree} on B ${a.base} (tree ${tree}, parents ${parents.join(' ')}): stop and report, no reset`,
    );
  const id = patchId(d, w, a.base, head);
  const n =
    [...rows]
      .reverse()
      .find((r) => r.kind === 'shown' && r.branch === a.branch && r.tree === a.tree)?.n ?? 0;
  if (!rows.some((r) => r.kind === 'applied' && r.branch === a.branch && r.commit === head))
    addRow(d, {
      kind: 'applied',
      branch: a.branch,
      n,
      base: a.base,
      tree: a.tree,
      commit: head,
      patchId: id,
    });
  d.log(
    `recorded ${a.branch} claude-edit-${n}: B ${a.base} T ${a.tree} commit ${head} patch-id ${id}`,
  );
  return 0;
}

// Every commit on origin/<branch> past origin/main that touches CLAUDE.md or .claude/ must carry an applied
// patch-id for that branch. No branch: every origin branch ahead of main. Run after `git fetch origin`.
export function verify(d: Deps, a: { branch: string | null }): number {
  mainOnly(d, 'verify');
  const o = { cwd: d.main };
  const mainSha = d.git.out(['rev-parse', '--verify', 'refs/remotes/origin/main'], o);
  const branches = a.branch
    ? [a.branch]
    : d.git
        .out(['for-each-ref', '--format=%(refname:strip=3)', 'refs/remotes/origin'], o)
        .split('\n')
        .filter((b) => b && b !== 'HEAD' && b !== 'main');
  const rows = readRows(d);
  const bad: string[] = [];
  for (const b of branches) {
    if (!BRANCH.test(b)) continue;
    const ref = `refs/remotes/origin/${b}`;
    const head = d.git.exec(['rev-parse', '--verify', ref], o);
    if (head.status !== 0) {
      if (a.branch) throw new Refusal(`no ${ref}: fetch first`);
      continue;
    }
    const range = `${mainSha}..${head.stdout.toString().trim()}`;
    const merges = d.git.out(['rev-list', '--merges', range], o);
    if (merges) bad.push(`${b}: merge commits ${merges.split('\n').join(' ')}`);
    const touched = d.git
      .out(['rev-list', range, '--', ...PATHS], o)
      .split('\n')
      .filter(Boolean);
    const commits = touched.map((sha) => ({ sha, patchId: patchId(d, d.main, `${sha}^`, sha) }));
    for (const sha of unapproved(commits, rows, b)) bad.push(`${b}: ${sha} has no approved patch`);
    d.log(
      `${b}: origin/main ${mainSha.slice(0, 8)}, head ${head.stdout.toString().trim().slice(0, 8)}, ${touched.length} agent-rule commit(s)`,
    );
  }
  if (bad.length) throw new Refusal(bad.join('\n'));
  d.log('verify: every agent-rule commit has an approved patch');
  return 0;
}
