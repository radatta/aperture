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

// CLAUDE.md or .claude/** — never .claude/worktrees — compared case-insensitively (the checkout has core.ignorecase).
export function pathAllowed(p: string): boolean {
  if (!SAFE.test(p) || p.split('/').some((s) => s === '' || s === '.' || s === '..')) return false;
  const l = p.toLowerCase();
  if (l === 'claude.md') return true;
  if (!l.startsWith('.claude/')) return false;
  return l !== '.claude/worktrees' && !l.startsWith('.claude/worktrees/');
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
    const l = e.path.toLowerCase();
    const how = e.status === 'A' ? 'new' : e.status === 'D' ? 'deleted' : 'changed';
    if (/^\.claude\/settings[^/]*\.json$/.test(l))
      out.push(`permissions or hook registration ${how}: ${e.path}`);
    else if (l.startsWith('.claude/hooks/'))
      out.push(
        `guard ${how}${e.dstMode === '100755' && e.status === 'A' ? ' (executable)' : ''}: ${e.path}`,
      );
    else if (l.startsWith('.claude/agents/')) out.push(`agent ${how}: ${e.path}`);
    if (l.endsWith('.gitattributes')) out.push(`checkout attributes ${how}: ${e.path}`);
  }
  return out;
}

// Characters a terminal may not draw: Cc but tab and LF, and Cf, Zl, Zp, Co, Cn. The text must be strict UTF-8.
const HIDDEN = /[^\P{Cc}\t\n]|[\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/gu;
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

// What the user's go must name: the branch or T's first 8, only the 8 from a branch's second showing on.
export const goNames = (tree: string, showing: number) =>
  showing >= 2 ? `\`${tree.slice(0, 8)}\`` : `the branch or \`${tree.slice(0, 8)}\``;

export interface Showing {
  branch: string;
  n: number;
  showing: number;
  base: string;
  tree: string;
  files: string[];
  flags: string[];
  untracked: string[];
  text: string;
}

const lineCount = (text: string) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

// The short header the hub pastes; `file` is where the user reads the diff (a Mac path), null for a PRE-CHECK.
export function renderHeader(s: Showing, file: string | null): string {
  const longest = Math.max(0, ...s.text.split('\n').map((l) => l.length));
  return [
    ...(file ? [] : ['PRE-CHECK (lane copy, not a showing: nothing written or recorded)']),
    `claude-edit check — ${s.branch} claude-edit-${s.n}, showing ${s.showing} on this branch`,
    `B ${s.base}`,
    `T ${s.tree}   go names: ${goNames(s.tree, s.showing)}`,
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
    `Showing ${s.showing} on this branch. Your go names ${goNames(s.tree, s.showing)}.`,
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
  ].join('\n');
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

// The showing number a new check of `tree` gets on `branch`: distinct trees shown there, this one counted.
export function showingNumber(rows: Row[], branch: string, tree: string): number {
  const trees = [
    ...new Set(rows.filter((r) => r.kind === 'shown' && r.branch === branch).map((r) => r.tree)),
  ];
  const i = trees.indexOf(tree);
  return i >= 0 ? i + 1 : trees.length + 1;
}

export const wasShown = (rows: Row[], branch: string, base: string, tree: string) =>
  rows.some((r) => r.kind === 'shown' && r.branch === branch && r.base === base && r.tree === tree);

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

export const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
