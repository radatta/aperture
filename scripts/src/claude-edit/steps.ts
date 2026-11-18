// `pnpm claude-edit` steps (docs/ops/HUB.md → Agent-rule edits). The hub runs them from /workspace, main's code: a
// lane's patch becomes tree T on base commit B in a scratch index, the hub shows the diff git derives from those two
// objects, and only an index that is exactly T is committed.
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
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
  caseTwins,
  charProblems,
  decodeStrict,
  extractDiff,
  flagsFor,
  judgeEntries,
  lastShownFile,
  lineCount,
  messageProblem,
  parseLedger,
  parseNumstat,
  parseRaw,
  renderFile,
  renderHeader,
  safePath,
  showingFile,
  showingNumber,
  unapproved,
  wasShown,
} from './rules.ts';
import type { Entry, Row } from './rules.ts';

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
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

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

// The lane's worktree: <main>/.claude/worktrees/<branch>, its own toplevel, a worktree of main's repo (sha1), on
// <branch>. `offBranch` is what a wrong branch is: a refusal before anything ran, Stuck once the hub has committed.
function worktree(d: Deps, branch: string, offBranch: typeof Refusal = Refusal): string {
  if (!BRANCH.test(branch)) throw new Refusal(`bad branch name "${branch}"`);
  const w = join(d.main, '.claude', 'worktrees', branch);
  const notOwn = () => new Refusal(`${w} is not a worktree of its own`);
  if (!real(w)) throw notOwn();
  const top = d.git.exec(['rev-parse', '--show-toplevel'], { cwd: w });
  if (top.status !== 0 || real(top.stdout.toString().trim()) !== real(w)) throw notOwn();
  const abs = (...a: string[]) =>
    d.git.out(['rev-parse', '--path-format=absolute', ...a], { cwd: w });
  const common = abs('--git-common-dir');
  if (real(common) !== real(join(d.main, '.git')))
    throw new Refusal(`${w} is not a worktree of ${d.main}`);
  if (d.git.out(['rev-parse', '--show-object-format'], { cwd: w }) !== 'sha1')
    throw new Refusal('only sha1 repos: the empty attribute tree is sha1');
  const head = d.git.exec(['symbolic-ref', '--short', 'HEAD'], { cwd: w });
  if (head.status !== 0 || head.stdout.toString().trim() !== branch)
    throw new offBranch(`${w} is not on ${branch}`);
  // info/attributes (the worktree's and the common one) outranks --attr-source: it must be missing or empty.
  for (const at of [abs('--git-path', 'info/attributes'), join(common, 'info', 'attributes')]) {
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

// No staged change anywhere, no unstaged one under the agent-rule paths. `diff` refreshes the stat cache in memory
// only, so the lane's index.lock is never taken.
function clean(d: Deps, w: string) {
  if (!d.git.ok(['diff-index', '--cached', '--quiet', 'HEAD', '--'], { cwd: w }))
    throw new Refusal('the worktree has staged changes');
  if (!d.git.ok(['diff', '--quiet', '--no-ext-diff', '--no-textconv', '--', ...PATHS], { cwd: w }))
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

// The lane's patch, read once through one descriptor: no symlink, no FIFO or device, at most 1 MiB.
function readPatch(file: string): Buffer {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new Refusal(`${file} is not a regular file`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Refusal(`${file} is not a regular file`);
    if (st.size > MAX_PATCH) throw new Refusal(`${file} is over 1 MiB`);
    const buf = Buffer.alloc(MAX_PATCH + 1);
    let n = 0;
    for (let r; n <= MAX_PATCH && (r = readSync(fd, buf, n, MAX_PATCH + 1 - n, null)) > 0;) n += r;
    if (n > MAX_PATCH) throw new Refusal(`${file} is over 1 MiB`);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
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
const objectDiff = (d: Deps, w: string, from: string, to: string) =>
  d.git.raw(['diff-tree', '-p', '-r', ...DIFF_FLAGS, '-U3', from, to, '--'], { cwd: w });

// At -U3: the context pins where a line sits, so the same line moved to another section is another patch. A clean
// rebase keeps it; one that changes a context line makes the lane send n+1.
export function patchId(d: Deps, cwd: string, from: string, to: string): string {
  const diff = objectDiff(d, cwd, from, to);
  const id = d.git.out(['patch-id', '--verbatim'], { cwd, input: diff }).split(' ')[0] ?? '';
  if (!SHA.test(id)) throw new Refusal(`no patch-id for ${from}..${to}`);
  return id;
}

// Every check on B..T that check and stage both run (stage never trusts the ledger for them). Returns what the
// showing prints; `exec` is the --exec list (check) or every new 100755 file (stage, which shows nothing new).
function judge(d: Deps, w: string, base: string, tree: string, exec: string[] | null) {
  const o = { cwd: w };
  const z = (args: string[]) =>
    d.git.raw(['diff-tree', '-r', '-z', '--no-renames', ...args, base, tree], o).toString('utf8');
  const entries: Entry[] = parseRaw(z(['--raw']));
  if (!entries.length) throw new Refusal('the patch changes nothing');
  const numstat = parseNumstat(z(['--numstat']));
  const execs =
    exec ?? entries.filter((e) => e.status === 'A' && e.dstMode === '100755').map((e) => e.path);
  const problems = judgeEntries(entries, numstat, execs);
  // ls-tree takes no :(icase) pathspec: filter the whole tree.
  const inT = d.git
    .out(['ls-tree', '-r', '-z', '--name-only', tree], o)
    .split('\0')
    .filter((p) => /^(claude\.md$|\.claude\/)/i.test(p));
  problems.push(...caseTwins(inT));
  if (entries.some((e) => e.path === 'CLAUDE.md' && e.status !== 'D')) {
    const lines = lineCount(
      d.git.raw(['cat-file', 'blob', `${tree}:CLAUDE.md`], o).toString('utf8'),
    );
    if (lines >= 200) problems.push(`CLAUDE.md: ${lines} lines (must stay under 200)`);
  }
  if (problems.length) throw new Refusal(problems.join('\n'));
  const raw = objectDiff(d, w, base, tree);
  const text = decodeStrict(raw);
  const hidden = charProblems(text);
  if (hidden.length) throw new Refusal(`hidden characters: ${hidden.slice(0, 10).join(', ')}`);
  // The round trip: the shown text applied to B must give T, or some config shaped the text.
  const back = treeFromText(d, w, base, text);
  if (back !== tree)
    throw new Refusal(`round trip gave ${back}, not ${tree}: the showing would not be T`);
  const files = numstat.map((n) => {
    const e = entries.find((x) => x.path === n.path);
    return `${e?.status ?? '?'} ${n.path} (+${n.added} -${n.deleted})`;
  });
  return { raw, text, files, flags: flagsFor(entries) };
}

export function check(d: Deps, a: { branch: string; n: number; exec: string[] }): number {
  const w = worktree(d, a.branch);
  clean(d, w);
  const patch = readPatch(join(w, 'localNotes', `claude-edit-${a.n}.patch`)); // read once
  const base = d.git.out(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: w });
  const tree = buildTree(d, w, base, patch, a.exec);
  const j = judge(d, w, base, tree, a.exec);
  // Untracked names are printed as they are, so each must be a safe path name.
  const untracked = d.git
    .out(['ls-files', '--others', '--exclude-standard', '-z', '--', ...PATHS], { cwd: w })
    .split('\0')
    .filter(Boolean);
  const unsafe = untracked.filter((u) => !safePath(u) || charProblems(u).length);
  if (unsafe.length)
    throw new Refusal(
      `untracked names the showing can't print: ${JSON.stringify(unsafe)}; remove them`,
    );
  const rows = readRows(d);
  const s = {
    branch: a.branch,
    n: a.n,
    ...showingNumber(rows, a.branch, tree),
    base,
    tree,
    files: j.files,
    flags: j.flags,
    untracked,
    text: j.text,
  };
  if (!d.fromMain) {
    d.log(renderHeader(s, null));
    return 0;
  }
  const md = renderFile(s);
  mkdirSync(join(d.main, ...SHOWINGS), { recursive: true });
  writeFileSync(showingPath(d, a.branch, tree), md);
  const file = sha256(md);
  if (lastShownFile(rows, a.branch, base, tree) !== file)
    addRow(d, { kind: 'shown', branch: a.branch, n: a.n, base, tree, file });
  d.log(renderHeader(s, [d.macRoot, ...SHOWINGS, showingFile(a.branch, tree)].join('/')));
  return 0;
}

function shas(base: string, tree: string) {
  if (!SHA.test(base) || !SHA.test(tree)) throw new Refusal('--base and --tree take full shas');
}

// The showing file the user read: byte for byte the one check last wrote for this B and T, its diff exactly B..T.
function showingHolds(d: Deps, branch: string, base: string, tree: string, raw: Buffer) {
  const again = `run check and show it again`;
  let md: string;
  try {
    md = readFileSync(showingPath(d, branch, tree), 'utf8');
  } catch {
    throw new Refusal(`no showing file for T ${tree}: ${again}`);
  }
  if (sha256(md) !== lastShownFile(readRows(d), branch, base, tree))
    throw new Refusal(`the showing file changed since check wrote it: ${again}`);
  if (extractDiff(md) !== raw.toString('utf8'))
    throw new Refusal(`the showing file's diff is not B..T: ${again}`);
}

export function stage(
  d: Deps,
  a: { branch: string; base: string; tree: string; message: string },
): number {
  mainOnly(d, 'stage');
  shas(a.base, a.tree);
  const bad = messageProblem(a.message);
  if (bad) throw new Refusal(`--message: ${bad}`);
  const w = worktree(d, a.branch);
  if (!wasShown(readRows(d), a.branch, a.base, a.tree))
    throw new Refusal(`${a.branch} was never shown B ${a.base} T ${a.tree}: run check and show it`);
  const o = { cwd: w };
  if (d.git.out(['rev-parse', 'HEAD'], o) !== a.base)
    throw new Refusal(`${a.branch} HEAD is not B: it moved`);
  clean(d, w);
  const { raw } = judge(d, w, a.base, a.tree, null);
  showingHolds(d, a.branch, a.base, a.tree, raw);
  const before = d.git.out(['write-tree'], o);
  // From here the lane's index may hold part of T: every failure backs out to `before`, or is Stuck.
  let got: string | null = null;
  try {
    const r = d.git.exec(['apply', '--index', '-'], { ...o, input: raw });
    if (r.status === 0) got = d.git.out(['write-tree'], o);
  } catch {
    got = null;
  }
  if (got !== a.tree) {
    const now = d.git.exec(['write-tree'], o);
    if (now.status === 0 && now.stdout.toString().trim() === before)
      throw new Refusal(`apply did not give T: nothing changed`);
    backOut(d, w, raw, before);
    throw new Refusal(`staged ${got ?? 'nothing whole'}, not T: backed out, nothing changed`);
  }
  const q = (s: string) => `'${s}'`;
  d.log(
    [
      `staged T ${a.tree} in ${w}. Run these three lines, each as its own Bash call:`,
      `cd ${q(w)}`,
      `[ "$(git rev-parse --show-toplevel)" = ${q(w)} ] && [ "$(git symbolic-ref --short HEAD)" = ${q(a.branch)} ] && [ "$(git rev-parse HEAD)" = ${a.base} ] && [ "$(git write-tree)" = ${a.tree} ] && git -c core.hooksPath=/dev/null commit -m ${q(a.message)}`,
      `cd ${q(d.main)}`,
      `Then (main's code, whatever the directory):`,
      `pnpm -C ${q(d.main)} claude-edit record ${a.branch} --base ${a.base} --tree ${a.tree}`,
      `If the commit is denied or the go withdrawn:`,
      `pnpm -C ${q(d.main)} claude-edit unstage ${a.branch} --base ${a.base} --tree ${a.tree}`,
    ].join('\n'),
  );
  return 0;
}

// The reverse apply of B..T, checked back to `to`; Stuck when it can't be.
function backOut(d: Deps, w: string, raw: Buffer, to: string) {
  const o = { cwd: w };
  const ok = (() => {
    try {
      const r = d.git.exec(['apply', '--index', '-R', '-'], { ...o, input: raw });
      const t = d.git.exec(['write-tree'], o);
      return r.status === 0 && t.status === 0 && t.stdout.toString().trim() === to;
    } catch {
      return false;
    }
  })();
  if (!ok) throw new Stuck(`the back-out to ${to} failed: ${w} needs a person, no reset`);
}

// After a stage whose commit never happened: the index is exactly T on B, so back it out to B.
export function unstage(d: Deps, a: { branch: string; base: string; tree: string }): number {
  mainOnly(d, 'unstage');
  shas(a.base, a.tree);
  const w = worktree(d, a.branch);
  const o = { cwd: w };
  if (d.git.out(['rev-parse', 'HEAD'], o) !== a.base)
    throw new Refusal(`${a.branch} HEAD is not B: committed or moved; record, or stop and report`);
  if (d.git.out(['write-tree'], o) !== a.tree)
    throw new Refusal(`the index is not T: nothing to unstage`);
  const raw = objectDiff(d, w, a.base, a.tree);
  backOut(d, w, raw, d.git.out(['rev-parse', `${a.base}^{tree}`], o));
  d.log(`unstaged T ${a.tree} in ${w}: the index is B again`);
  return 0;
}

export function record(d: Deps, a: { branch: string; base: string; tree: string }): number {
  mainOnly(d, 'record');
  shas(a.base, a.tree);
  const w = worktree(d, a.branch, Stuck);
  const rows = readRows(d);
  if (!wasShown(rows, a.branch, a.base, a.tree))
    throw new Refusal(`${a.branch} was never shown this B and T`);
  const o = { cwd: w };
  const head = d.git.out(['rev-parse', 'HEAD'], o);
  if (head === a.base) throw new Refusal(`${a.branch} HEAD is still B: no commit to record`);
  const tree = d.git.out(['rev-parse', 'HEAD^{tree}'], o);
  const parents = d.git.out(['rev-list', '--parents', '-n', '1', 'HEAD'], o).split(' ').slice(1);
  if (tree !== a.tree || parents.length !== 1 || parents[0] !== a.base)
    throw new Stuck(
      `HEAD ${head} is not one commit of T ${a.tree} on B ${a.base} (tree ${tree}, parents ${parents.join(' ')}): stop and report, no reset`,
    );
  // The commit is T on B: from here a failure leaves a commit with no row, which needs a person.
  try {
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
  } catch (e) {
    throw new Stuck(
      `commit ${head} is T on B but not recorded: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return 0;
}

// Every commit on origin/<branch> past origin/main that touches CLAUDE.md or .claude/ must carry an applied
// patch-id for that branch. Run after `git fetch origin`.
export function verify(d: Deps, a: { branch: string }): number {
  mainOnly(d, 'verify');
  const b = a.branch;
  if (!BRANCH.test(b)) throw new Refusal(`bad branch name "${b}": claude-edit can't approve it`);
  const o = { cwd: d.main };
  const mainSha = d.git.out(['rev-parse', '--verify', 'refs/remotes/origin/main'], o);
  const ref = `refs/remotes/origin/${b}`;
  const r = d.git.exec(['rev-parse', '--verify', ref], o);
  if (r.status !== 0) throw new Refusal(`no ${ref}: fetch first`);
  const head = r.stdout.toString().trim();
  const range = `${mainSha}..${head}`;
  const bad: string[] = [];
  const merges = d.git.out(['rev-list', '--merges', range], o);
  if (merges) bad.push(`${b}: merge commits ${merges.split('\n').join(' ')}`);
  const touched = d.git
    .out(['rev-list', range, '--', ...PATHS], o)
    .split('\n')
    .filter(Boolean);
  const commits = touched.map((sha) => ({ sha, patchId: patchId(d, d.main, `${sha}^`, sha) }));
  for (const sha of unapproved(commits, readRows(d), b))
    bad.push(`${b}: ${sha} has no approved patch`);
  d.log(
    `${b}: origin/main ${mainSha.slice(0, 8)}, head ${head.slice(0, 8)}, ${touched.length} agent-rule commit(s)`,
  );
  if (bad.length) throw new Refusal(bad.join('\n'));
  d.log(
    `verify: every agent-rule commit on ${b} has an approved patch. Merge line: --match-head-commit ${head}` +
      (touched.length ? `; it changes agent rules (${touched.length} commit(s))` : ''),
  );
  return 0;
}
