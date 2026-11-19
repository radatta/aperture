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
  lstatSync,
  openSync,
  readSync,
  renameSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Git } from './git.ts';
import { DIFF_FLAGS, EMPTY_TREE, MERGE_FLAGS } from './git.ts';
import {
  BRANCH,
  Refusal,
  approvedRows,
  liveRows,
  SHA,
  Stuck,
  caseTwins,
  charProblems,
  decodeStrict,
  extractDiff,
  flagsFor,
  hiddenIn,
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
const MAX_SHOWING = 16 << 20; // a 1 MiB patch's diff and its spans block
const MAX_LEDGER = 16 << 20;
const MAX_ATTRS = 64 << 10;
export const ledgerPath = (d: Deps) => join(d.main, 'localNotes', 'claude-edits.jsonl');
const SHOWINGS = ['localNotes', 'claude-edits'];
export const showingPath = (d: Deps, branch: string, tree: string) =>
  join(d.main, ...SHOWINGS, showingFile(branch, tree));
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

// A file read once through one descriptor: no symlink, no FIFO or device, at most `max` bytes. Null when missing.
export function readSmall(file: string, max: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Refusal(`${file} is not a regular file`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Refusal(`${file} is not a regular file`);
    const over = () => new Refusal(`${file} is over ${max} bytes`);
    if (st.size > max) throw over();
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (let r; n <= max && (r = readSync(fd, buf, n, max + 1 - n, null)) > 0;) n += r;
    if (n > max) throw over();
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

const readRows = (d: Deps): Row[] =>
  parseLedger(readSmall(ledgerPath(d), MAX_LEDGER)?.toString('utf8') ?? '');
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
  const notOwn = () => new Refusal(`${w} is not its own worktree`);
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
  try {
    repoPlain(d, w);
  } catch (e) {
    throw e instanceof Refusal ? new offBranch(e.message) : e;
  }
  return w;
}

// What no -c pin reaches: info/attributes (the worktree's and the common one) outranks --attr-source, info/grafts
// rewrites parents, a shallow clone hides them. Each must be missing or empty.
function repoPlain(d: Deps, cwd: string) {
  const abs = (...a: string[]) => d.git.out(['rev-parse', '--path-format=absolute', ...a], { cwd });
  const common = abs('--git-common-dir');
  const files = [
    abs('--git-path', 'info/attributes'),
    join(common, 'info', 'attributes'),
    join(common, 'info', 'grafts'),
  ];
  for (const f of files)
    if (readSmall(f, MAX_ATTRS)?.toString('utf8').trim()) throw new Refusal(`${f} is not empty`);
  if (d.git.out(['rev-parse', '--is-shallow-repository'], { cwd }) !== 'false')
    throw new Refusal(`${cwd} is a shallow clone`);
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
  const b = readSmall(file, MAX_PATCH);
  if (!b) throw new Refusal(`${file} is not a regular file`);
  return b;
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

// The diff git derives from the two objects: what is shown, staged and backed out.
const objectDiff = (d: Deps, w: string, from: string, to: string) =>
  d.git.raw(['diff-tree', '-p', '-r', ...DIFF_FLAGS, '-U3', from, to, '--'], { cwd: w });

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
  // Hidden characters the patch adds refuse; ones already in B (context, removed lines) are told.
  const hidden = hiddenIn(text);
  if (hidden.added.length)
    throw new Refusal(`hidden characters on added lines: ${hidden.added.slice(0, 10).join(', ')}`);
  // The round trip: the shown text applied to B must give T, or some config shaped the text.
  const back = treeFromText(d, w, base, text);
  if (back !== tree)
    throw new Refusal(`round trip gave ${back}, not ${tree}: the showing would not be T`);
  const files = numstat.map((n) => {
    const e = entries.find((x) => x.path === n.path);
    return `${e?.status ?? '?'} ${n.path} (+${n.added} -${n.deleted})`;
  });
  const flags = flagsFor(entries);
  if (hidden.other.length)
    flags.push(
      `hidden characters on lines this patch does not add: ${hidden.other.slice(0, 5).join(', ')}`,
    );
  // Never the opener itself in the flag: it would open a comment in the showing file.
  if (text.split('\n').some((l) => l.startsWith('+') && l.includes('<!--')))
    flags.push('an HTML comment opener on an added line');
  return { raw, text, files, flags };
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
  // Written beside its name and renamed over it, so a link planted at the name is replaced, never followed.
  const dir = join(d.main, ...SHOWINGS);
  mkdirSync(dir, { recursive: true });
  if (!lstatSync(dir).isDirectory()) throw new Refusal(`${dir} is not a directory`);
  const at = showingPath(d, a.branch, tree);
  const tmp = `${at}.${process.pid}.tmp`;
  writeFileSync(tmp, md, { flag: 'wx' });
  renameSync(tmp, at);
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
  const buf = readSmall(showingPath(d, branch, tree), MAX_SHOWING);
  if (!buf) throw new Refusal(`no showing file for T ${tree}: ${again}`);
  const md = buf.toString('utf8');
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
  const others = untrackedNames(d, w);
  // From here the lane's index and files may hold part of T: every failure backs out to `before`, or is Stuck.
  let got: string | null = null;
  let err: string;
  try {
    const r = d.git.exec(['apply', '--index', '-'], { ...o, input: raw });
    err = r.stderr;
    if (r.status === 0) got = d.git.out(['write-tree'], o);
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  if (got !== a.tree) {
    const why = err ? ` (${err})` : '';
    if (settled(d, w, before, others))
      throw new Refusal(`apply did not give T${why}: nothing changed`);
    const now = d.git.exec(['write-tree'], o);
    if (now.status === 0 && now.stdout.toString().trim() === before)
      throw new Stuck(
        `apply failed and left files changed in ${w}${why}: needs a person, no reset`,
      );
    backOut(d, w, raw, before, others);
    throw new Refusal(`staged ${got ?? 'nothing whole'}, not T${why}: backed out, nothing changed`);
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

// Every untracked or ignored name under the agent-rule paths.
const untrackedNames = (d: Deps, w: string) =>
  d.git.out(['ls-files', '--others', '-z', '--', ...PATHS], { cwd: w });

// The lane's worktree is back where it was: the index is `tree`, no file under the paths differs from it, and the
// untracked names are the same.
function settled(d: Deps, w: string, tree: string, others: string): boolean {
  const o = { cwd: w };
  try {
    const t = d.git.exec(['write-tree'], o);
    if (t.status !== 0 || t.stdout.toString().trim() !== tree) return false;
    if (!d.git.ok(['diff', '--quiet', '--no-ext-diff', '--no-textconv', '--', ...PATHS], o))
      return false;
    return untrackedNames(d, w) === others;
  } catch {
    return false;
  }
}

// The reverse apply of B..T, checked back to `to`; Stuck when it can't be.
function backOut(d: Deps, w: string, raw: Buffer, to: string, others: string) {
  const o = { cwd: w };
  const ok = (() => {
    try {
      const r = d.git.exec(['apply', '--index', '-R', '-'], { ...o, input: raw });
      return r.status === 0 && settled(d, w, to, others);
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
  backOut(d, w, raw, d.git.out(['rev-parse', `${a.base}^{tree}`], o), untrackedNames(d, w));
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
    // The approved commit pinned, so gc keeps it for verify's replay. Named by its sha: a rerun is a no-op and a
    // moved ref is put back.
    const pin = `refs/claude-edits/${a.branch}/${head}`;
    d.git.out(['update-ref', pin, head], { cwd: d.main });
    const at = d.git.exec(['rev-parse', '--verify', '--quiet', pin], { cwd: d.main });
    if (at.status !== 0 || at.stdout.toString().trim() !== head)
      throw new Error(`${pin} does not point at ${head}`);
    const live = liveRows(rows, a.branch);
    const n =
      live.findLast((r) => r.kind === 'shown' && r.branch === a.branch && r.tree === a.tree)?.n ??
      0;
    if (!live.some((r) => r.kind === 'applied' && r.branch === a.branch && r.commit === head))
      addRow(d, {
        kind: 'applied',
        branch: a.branch,
        n,
        base: a.base,
        tree: a.tree,
        commit: head,
      });
    d.log(
      `recorded ${a.branch} claude-edit-${n}: B ${a.base} T ${a.tree} commit ${head} pinned ${pin}`,
    );
  } catch (e) {
    throw new Stuck(
      `commit ${head} is T on B but not recorded: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return 0;
}

const parentsOf = (d: Deps, sha: string): string[] | null => {
  const r = d.git.exec(['rev-list', '--parents', '-n', '1', sha], { cwd: d.main });
  return r.status === 0 ? r.stdout.toString().trim().split(' ').slice(1) : null;
};

// git's replay of approved commit `a` onto `parent`, the way a rebase makes it: the tree, or null on a conflict.
// A non-match leaves unreachable loose objects in main's .git; gc prunes them.
function replay(d: Deps, a: Row, parent: string): string | null {
  const args = ['merge-tree', ...MERGE_FLAGS, `--merge-base=${a.base}`, parent, a.commit!];
  const r = d.git.exec(args, { cwd: d.main });
  if (r.status === 1) return null;
  if (r.status !== 0) throw new Refusal(`git merge-tree failed: ${r.stderr || `exit ${r.status}`}`);
  const t = r.stdout.toString('utf8').split('\n')[0] ?? '';
  return SHA.test(t) ? t : null;
}

// What a commit changes, as `M path` items, against its first parent (a root commit: the empty tree); a name the
// showing couldn't print is quoted.
function changed(d: Deps, c: string): { status: string; path: string }[] {
  const parent = parentsOf(d, c)?.[0] ?? EMPTY_TREE;
  const z = d.git
    .raw(['diff-tree', '-r', '-z', '--no-renames', '--name-status', parent, c, '--'], {
      cwd: d.main,
    })
    .toString('utf8')
    .split('\0');
  const out: { status: string; path: string }[] = [];
  for (let i = 0; i + 1 < z.length; i += 2) {
    const p = z[i + 1]!;
    out.push({ status: z[i]!, path: safePath(p) ? p : JSON.stringify(p) });
  }
  return out;
}

// The root .gitattributes sets how CLAUDE.md and .claude/ check out (eol, encoding, ident), and no approval can
// cover it: verify counts a commit that touches it as an agent-rule commit, always for a hand check.
const VERIFY_PATHS = [...PATHS, ':(icase).gitattributes'];
const day = (r: Row) => r.t.slice(0, 10) || 'undated';

// Every commit on origin/<branch> past origin/main that touches CLAUDE.md, .claude/ or the root .gitattributes must
// be an approved commit (one the hub recorded for this branch since it was last closed) or git's clean replay of one
// onto the commit's own parent, whole tree equal: a clean rebase passes, a moved, altered, hand-merged or mixed edit
// doesn't. One approval covers one commit, and an approval newer than every one on the branch must be on it.
// Run after `git fetch origin`.
export function verify(d: Deps, a: { branch: string }): number {
  mainOnly(d, 'verify');
  const b = a.branch;
  if (!BRANCH.test(b)) throw new Refusal(`bad branch name "${b}": claude-edit can't approve it`);
  const o = { cwd: d.main };
  repoPlain(d, d.main);
  // A config merge driver runs in place of the built-in one, even under merge.default=text.
  const drivers = d.git.exec(['config', '--get-regexp', '^merge\\..*\\.driver$'], o);
  if (drivers.status === 0)
    throw new Refusal(`a merge driver is configured: ${drivers.stdout.toString().trim()}`);
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
    .out(['rev-list', '--reverse', range, '--', ...VERIFY_PATHS], o)
    .split('\n')
    .filter(Boolean);
  d.log(
    `${b}: origin/main ${mainSha.slice(0, 8)}, head ${head}, ${touched.length} agent-rule commit(s)`,
  );
  // The ledger's approvals, each confirmed by git: the commit exists and is exactly T on B.
  const approved: Row[] = [];
  const named = (x: Row) =>
    `approved commit ${x.commit!.slice(0, 8)} (claude-edit-${x.n}, T ${x.tree.slice(0, 8)}, ${day(x)})`;
  for (const row of approvedRows(readRows(d), b)) {
    const ps = d.git.ok(['cat-file', '-e', `${row.commit}^{commit}`], o)
      ? parentsOf(d, row.commit!)
      : null;
    if (!ps) d.log(`  ${named(row)} is missing: its pin is gone`);
    else if (
      ps.length !== 1 ||
      ps[0] !== row.base ||
      d.git.out(['rev-parse', `${row.commit}^{tree}`], o) !== row.tree
    )
      d.log(`  ${named(row)} is not T on B: ignored`);
    else approved.push(row);
  }
  const used = new Set<Row>();
  const match = new Map<string, { row: Row; how: string }>();
  const take = (c: string, row: Row, how: string) => {
    used.add(row);
    match.set(c, { row, how });
  };
  for (const c of touched) {
    const row = approved.find((x) => !used.has(x) && x.commit === c);
    if (row) take(c, row, 'as committed');
  }
  for (const c of touched) {
    if (match.has(c)) continue;
    const ps = parentsOf(d, c);
    if (ps?.length !== 1) continue;
    const ct = d.git.out(['rev-parse', `${c}^{tree}`], o);
    const row = approved.find((x) => !used.has(x) && replay(d, x, ps[0]!) === ct);
    if (row) take(c, row, `replayed onto ${ps[0]!.slice(0, 8)}`);
  }
  const files = new Set<string>();
  const trees: string[] = [];
  for (const c of touched) {
    const ch = changed(d, c);
    const list = ch.map((x) => `${x.status} ${x.path}`).join('; ');
    const m = match.get(c);
    if (m) {
      ch.forEach((x) => files.add(x.path));
      trees.push(m.row.tree.slice(0, 8));
      d.log(
        `  ${c.slice(0, 8)} claude-edit-${m.row.n}, approved T ${m.row.tree.slice(0, 8)} (${day(m.row)}), ${m.how}: ${list}`,
      );
    } else if (ch.some((x) => x.path.toLowerCase() === '.gitattributes'))
      bad.push(
        `${b}: ${c} changes the root .gitattributes, which sets how the agent files check out (${list}): the hub checks it by hand`,
      );
    else
      bad.push(
        `${b}: ${c} is not an approved commit or a clean replay of one (${list}): send n+1, or check an old-rule commit by hand`,
      );
  }
  // An approval missing from the branch: told when a later one is on it, red when it is the newest.
  const last = approved.findLastIndex((x) => used.has(x));
  approved.forEach((x, i) => {
    if (used.has(x)) return;
    if (i < last) d.log(`  ${named(x)} is not on the branch: a later approval is`);
    else
      bad.push(
        `${b}: ${named(x)} is not on the branch, and no later approval is: check by hand, or close it with n+1`,
      );
  });
  if (bad.length) throw new Refusal(bad.join('\n'));
  d.log(
    `verify: every agent-rule commit on ${b} is an approved commit or a clean replay of one. Merge line: --match-head-commit ${head}` +
      (touched.length
        ? `; changes agent rules: ${[...files].join(', ')}, approved ${trees.join(', ')}`
        : ''),
  );
  return 0;
}

// After a branch's PR merges (or it is abandoned): its approvals stop counting and its pins go, so a branch name used
// again starts with none. Run from main; it only takes approvals away.
export function close(d: Deps, a: { branch: string }): number {
  mainOnly(d, 'close');
  const b = a.branch;
  if (!BRANCH.test(b)) throw new Refusal(`bad branch name "${b}"`);
  const o = { cwd: d.main };
  const refs = d.git
    .out(['for-each-ref', '--format=%(refname) %(objectname)', `refs/claude-edits/${b}/`], o)
    .split('\n')
    .filter(Boolean);
  addRow(d, { kind: 'closed', branch: b, n: 0, base: '', tree: '' });
  for (const line of refs) {
    const [name, sha] = line.split(' ');
    d.git.out(['update-ref', '-d', name!, sha!], o);
  }
  d.log(`closed ${b}: its approvals no longer count; ${refs.length} pin(s) deleted`);
  return 0;
}
