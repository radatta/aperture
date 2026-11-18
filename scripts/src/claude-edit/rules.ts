// Pure rules for `pnpm claude-edit` (docs/ops/HUB.md → Agent-rule edits): what a lane's agent-rule patch may change,
// what the showing looks like, and how the ledger ties commits to approved patches. No git, no files.

export const EXIT = { ok: 0, refused: 1, usage: 2, stuck: 3 } as const;

// A check that changed nothing (exit 1) vs a state that needs a person (exit 3).
export class Refusal extends Error {}
export class Stuck extends Error {}

export interface Entry {
  srcMode: string;
  dstMode: string;
  status: string;
  path: string;
}

// `git diff-tree -r --raw -z --no-renames`: ":<src> <dst> <srcsha> <dstsha> <status>\0<path>\0" per entry.
export function parseRaw(z: string): Entry[] {
  const parts = z.split('\0');
  const out: Entry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const head = parts[i] ?? '';
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(head);
    if (!m) throw new Refusal(`unreadable diff-tree entry "${head}"`);
    out.push({ srcMode: m[1]!, dstMode: m[2]!, status: m[3]!, path: parts[i + 1] ?? '' });
  }
  return out;
}

// `git diff-tree -r --numstat -z --no-renames`: "<added>\t<deleted>\t<path>\0"; a binary file reads "-\t-".
export function parseNumstat(z: string): { added: string; deleted: string; path: string }[] {
  return z
    .split('\0')
    .filter(Boolean)
    .map((l) => {
      const [added = '', deleted = '', ...rest] = l.split('\t');
      return { added, deleted, path: rest.join('\t') };
    });
}

const SAFE = /^[A-Za-z0-9._/@+-]+$/;

// A path name a showing can print as is: the safe charset, no empty, `.` or `..` segment.
export const safePath = (p: string) =>
  SAFE.test(p) && !p.split('/').some((s) => s === '' || s === '.' || s === '..');

// Exactly CLAUDE.md or .claude/**, never .claude/worktrees. Case-exact: the checkout folds case (core.ignorecase,
// a case-insensitive mount), so `claude.md` or `.Claude/x` would land beside the real file or under another name.
export function pathAllowed(p: string): boolean {
  if (!safePath(p)) return false;
  if (p === 'CLAUDE.md') return true;
  if (!p.startsWith('.claude/')) return false;
  const l = p.toLowerCase(); // .claude/WORKTREES is the worktrees directory on this checkout
  return l !== '.claude/worktrees' && !l.startsWith('.claude/worktrees/');
}

// Paths in a tree that differ only in case: on this checkout they are one file.
export function caseTwins(paths: string[]): string[] {
  const seen = new Map<string, string>();
  const out: string[] = [];
  for (const p of paths) {
    const l = p.toLowerCase();
    const o = seen.get(l);
    if (o !== undefined && o !== p) out.push(`${o} and ${p} differ only in case`);
    else seen.set(l, p);
  }
  return out;
}

// Each entry: M with its mode unchanged, A at 100644 (100755 only when named with --exec), D of a regular file;
// nothing binary. Returns one problem per bad entry, empty when the patch may be shown.
export function judgeEntries(
  entries: Entry[],
  numstat: { added: string; path: string }[],
  exec: string[],
): string[] {
  const problems: string[] = [];
  const regular = (m: string) => m === '100644' || m === '100755';
  for (const e of entries) {
    const at = `${e.status} ${e.path}`;
    if (!pathAllowed(e.path))
      problems.push(`${at}: outside CLAUDE.md and .claude/ (or a worktree)`);
    if (e.status === 'M') {
      if (e.srcMode !== e.dstMode) problems.push(`${at}: mode ${e.srcMode} → ${e.dstMode}`);
      else if (!regular(e.dstMode)) problems.push(`${at}: not a regular file (${e.dstMode})`);
    } else if (e.status === 'A') {
      const want = exec.includes(e.path) ? '100755' : '100644';
      if (e.dstMode !== want) problems.push(`${at}: new mode ${e.dstMode}, expected ${want}`);
    } else if (e.status === 'D') {
      if (!regular(e.srcMode)) problems.push(`${at}: deletes a non-regular file (${e.srcMode})`);
    } else problems.push(`${at}: status ${e.status} is not M, A or D`);
  }
  for (const n of numstat) if (n.added === '-') problems.push(`${n.path}: binary`);
  for (const x of exec)
    if (!entries.some((e) => e.status === 'A' && e.path === x))
      problems.push(`--exec ${x}: not a file this patch adds`);
  return problems;
}

// What the user is told in words, beside the diff.
export function flagsFor(entries: Entry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const p = e.path;
    const how = e.status === 'A' ? 'new' : e.status === 'D' ? 'deleted' : 'changed';
    const x = e.status !== 'D' && e.dstMode === '100755' ? ' (executable)' : '';
    if (/^\.claude\/settings[^/]*\.json$/.test(p))
      out.push(`permissions or hook registration ${how}: ${p}`);
    else if (p.startsWith('.claude/hooks/')) out.push(`guard ${how}${x}: ${p}`);
    else if (p.startsWith('.claude/agents/')) out.push(`agent ${how}${x}: ${p}`);
    else if (p.startsWith('.claude/skills/') || p.startsWith('.claude/commands/'))
      out.push(`skill or command ${how}${x}: ${p}`);
    else if (x) out.push(`executable ${how}: ${p}`);
    if (p.endsWith('.gitattributes')) out.push(`checkout attributes ${how}: ${p}`);
  }
  return out;
}

// Characters a reader may not see: Cc but tab and LF; Cf, Zl, Zp, Co, Cn; every default-ignorable (variation
// selectors, Hangul fillers, CGJ); combining marks; any space but U+0020; the braille blank. Strict UTF-8 only.
const HIDDEN =
  /[^\P{Cc}\t\n]|[\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}\p{Mn}\p{Me}\u2800]|[^\P{Zs} ]/gu;
export function decodeStrict(buf: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new Refusal('the diff is not valid UTF-8');
  }
}
export function charProblems(text: string): string[] {
  const out: string[] = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(HIDDEN)) {
      const cp = m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
      out.push(`line ${i + 1}: U+${cp}`);
    }
  });
  return out;
}

export const longestBacktickRun = (text: string) =>
  Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
export const fence = (text: string) => '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));

// What the user's go must name: the branch or T's first 8 while this is the only tree shown on the branch, only the 8
// once a second tree has been shown there (a re-showing of the first one included).
export const goNames = (tree: string, trees: number) =>
  trees >= 2 ? `\`${tree.slice(0, 8)}\`` : `the branch or \`${tree.slice(0, 8)}\``;

export interface Showing {
  branch: string;
  n: number;
  showing: number;
  trees: number; // distinct trees shown on the branch, this one counted
  base: string;
  tree: string;
  files: string[];
  flags: string[];
  untracked: string[];
  text: string;
}

export const lineCount = (text: string) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

// The short header the hub pastes; `file` is where the user reads the diff (a Mac path), null for a PRE-CHECK.
export function renderHeader(s: Showing, file: string | null): string {
  const longest = Math.max(0, ...s.text.split('\n').map((l) => l.length));
  return [
    ...(file ? [] : ['PRE-CHECK (lane copy, not a showing: nothing written or recorded)']),
    `claude-edit check — ${s.branch} claude-edit-${s.n}, showing ${s.showing} on this branch`,
    `B ${s.base}`,
    `T ${s.tree}   go names: ${goNames(s.tree, s.trees)}`,
    `files: ${s.files.join('; ')}`,
    `flags: ${s.flags.length ? s.flags.join('; ') : 'none'}`,
    `untracked under .claude/: ${s.untracked.length ? s.untracked.join(', ') : 'none'}`,
    `diff: ${lineCount(s.text)} lines, longest ${longest} chars`,
    `file: ${file ?? 'none'}`,
  ].join('\n');
}

// The file the user reads in a Markdown viewer (proportional font: nothing relies on column alignment). The diff
// sits in one fence longer than any backtick run in it, so `extractDiff` takes it back byte for byte.
export function renderFile(s: Showing): string {
  const f = fence(s.text);
  return [
    `# claude-edit — ${s.branch} claude-edit-${s.n}`,
    '',
    `Showing ${s.showing} on this branch. Your go names ${goNames(s.tree, s.trees)}.`,
    '',
    `- B \`${s.base}\``,
    `- T \`${s.tree}\``,
    `- files: ${s.files.join('; ')}`,
    `- flags: ${s.flags.length ? s.flags.join('; ') : 'none'}`,
    `- untracked under .claude/: ${s.untracked.length ? s.untracked.join(', ') : 'none'}`,
    `- diff: ${lineCount(s.text)} lines`,
    '',
    `${f}diff`,
    s.text + f,
    '',
    ...spansBlock(s.text),
  ].join('\n');
}

function spansBlock(text: string): string[] {
  const spans = changedSpans(text);
  if (!spans.length) return [];
  const body = spans.join('\n');
  const f = fence(body);
  return [
    'Long lines changed in place: the changed part between ⟦ ⟧, 30 characters each side.',
    '',
    `${f}text`,
    body + f,
    '',
  ];
}

// For each long line changed in place (a run of - lines then as many + lines, paired in order), the part that
// changed: the shared head and tail trimmed to `ctx` characters, the change between ⟦ ⟧. The eye can't find one
// phrase in two 600-character lines.
export function changedSpans(text: string, over = 200, ctx = 30): string[] {
  const out: string[] = [];
  const lines = text.split('\n');
  let file = '';
  let hunk = false;
  const cut = (l: string, p: number, s: number) =>
    `${p > ctx ? '…' : ''}${l.slice(Math.max(0, p - ctx), p)}⟦${l.slice(p, l.length - s)}⟧${l.slice(l.length - s, l.length - s + ctx)}${s > ctx ? '…' : ''}`;
  for (let i = 0; i < lines.length;) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) hunk = false;
    else if (!hunk && l.startsWith('+++ b/')) file = l.slice('+++ b/'.length);
    else if (l.startsWith('@@')) hunk = true;
    else if (hunk && l.startsWith('-')) {
      let j = i;
      while (j < lines.length && lines[j]!.startsWith('-')) j++;
      let k = j;
      while (k < lines.length && lines[k]!.startsWith('+')) k++;
      if (k - j === j - i)
        for (let x = 0; x < j - i; x++) {
          const was = lines[i + x]!.slice(1);
          const now = lines[j + x]!.slice(1);
          if (Math.max(was.length, now.length) <= over) continue;
          let p = 0;
          while (p < was.length && p < now.length && was[p] === now[p]) p++;
          let q = 0;
          while (q < was.length - p && q < now.length - p && was.at(-1 - q) === now.at(-1 - q)) q++;
          out.push(`${file}`, `was: ${cut(was, p, q)}`, `now: ${cut(now, p, q)}`, '');
        }
      i = k;
      continue;
    }
    i++;
  }
  return out;
}

export function extractDiff(md: string): string {
  const lines = md.split('\n');
  const open = lines.findIndex((l) => /^`{3,}diff$/.test(l));
  if (open < 0) throw new Refusal('the showing file has no diff fence');
  const f = lines[open]!.slice(0, -'diff'.length);
  const close = lines.findIndex((l, i) => i > open && l === f);
  if (close < 0) throw new Refusal('the showing file has no closing fence');
  return lines.slice(open + 1, close).join('\n') + '\n';
}

export const showingFile = (branch: string, tree: string) => `${branch}-${tree.slice(0, 8)}.md`;

// The hub's ledger, /workspace/localNotes/claude-edits.jsonl: one JSON row per showing and per applied commit.
export interface Row {
  t: string;
  kind: 'shown' | 'applied';
  branch: string;
  n: number;
  base: string;
  tree: string;
  commit?: string;
  patchId?: string;
  file?: string; // shown: sha256 of the showing file check wrote
}

export function parseLedger(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Partial<Row>;
      if ((r.kind === 'shown' || r.kind === 'applied') && r.branch && r.base && r.tree)
        rows.push(r as Row);
    } catch {
      // a torn or foreign line names nothing
    }
  }
  return rows;
}

// A check of `tree` on `branch`: its showing number (distinct trees shown there, in first-shown order, this one
// counted) and how many distinct trees that makes.
export function showingNumber(rows: Row[], branch: string, tree: string) {
  const trees = [
    ...new Set(rows.filter((r) => r.kind === 'shown' && r.branch === branch).map((r) => r.tree)),
  ];
  const i = trees.indexOf(tree);
  return i >= 0
    ? { showing: i + 1, trees: trees.length }
    : { showing: trees.length + 1, trees: trees.length + 1 };
}

const shownRows = (rows: Row[], branch: string, base: string, tree: string) =>
  rows.filter(
    (r) => r.kind === 'shown' && r.branch === branch && r.base === base && r.tree === tree,
  );
export const wasShown = (rows: Row[], branch: string, base: string, tree: string) =>
  shownRows(rows, branch, base, tree).length > 0;
// The showing file's hash on the last showing of this B and T: the file stage takes must still be that one.
export const lastShownFile = (rows: Row[], branch: string, base: string, tree: string) =>
  shownRows(rows, branch, base, tree).at(-1)?.file;

// Commits on a branch that touch CLAUDE.md or .claude/ with no applied row for that branch.
export function unapproved(
  commits: { sha: string; patchId: string }[],
  rows: Row[],
  branch: string,
): string[] {
  const ok = new Set(
    rows.filter((r) => r.kind === 'applied' && r.branch === branch).map((r) => r.patchId),
  );
  return commits.filter((c) => !ok.has(c.patchId)).map((c) => c.sha);
}

export const BRANCH = /^(?!(?:main|dev|master|HEAD)$)[A-Za-z0-9][A-Za-z0-9._-]*$/; // never a deploy branch
export const SHA = /^[0-9a-f]{40}$/; // sha1 repos only: EMPTY_TREE is sha1's

// The hub's commit message, checked before it is printed into a shell line: CLAUDE.md's rule (one lowercase line,
// 4–6 words) and nothing a shell or the guard would read differently.
export function messageProblem(m: string): string | null {
  if (!/^[A-Za-z0-9 .,:_/+-]+$/.test(m)) return 'letters, digits, spaces and .,:_/+- only';
  const words = m.trim().split(/\s+/).length;
  if (words < 4 || words > 6) return `${words} words: 4–6`;
  if (m !== m.trim() || /\s\s/.test(m)) return 'single spaces, no leading or trailing space';
  if (!/^[a-z]/.test(m)) return 'starts lowercase';
  return null;
}
