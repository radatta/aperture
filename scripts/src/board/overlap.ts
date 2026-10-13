// File-overlap warning (docs/ops/SESSION-BOARD.md → Overlaps): which worktree branches touch the same files,
// so the session that merges second hears about the rebase conflict before it happens. Pure; cli.ts gathers
// each worktree's files from git.

export type Tree = { branch: string; files: string[] };

// Files nearly every branch edits — reported apart so real overlaps stand out.
export const ALWAYS_COLLIDE = new Set([
  'pnpm-lock.yaml',
  'package.json',
  'CLAUDE.md',
  'docs/index.md',
  '.claude/settings.json',
  '.claude/hooks/README.md',
  '.claude/hooks/testdata/run-fixtures.py',
]);

export type Pair = { a: string; b: string; files: string[] };

export type Overlap = {
  pairs: Pair[]; // real overlaps
  always: Pair[]; // always-collides only
  messages: Record<string, string[]>; // per branch, ready to inject at SessionStart
};

const SHOWN = 5;

// `names` maps a branch to the session working on it (the SendMessage address), when one is registered.
export function overlaps(trees: Tree[], names: Record<string, string> = {}): Overlap {
  const pairs: Pair[] = [];
  const always: Pair[] = [];
  const messages: Record<string, string[]> = {};
  const sorted = [...trees].sort((x, y) => x.branch.localeCompare(y.branch));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      const bFiles = new Set(b.files);
      const shared = [...new Set(a.files)].filter((f) => bFiles.has(f)).sort();
      const real = shared.filter((f) => !ALWAYS_COLLIDE.has(f));
      const common = shared.filter((f) => ALWAYS_COLLIDE.has(f));
      if (real.length) pairs.push({ a: a.branch, b: b.branch, files: real });
      if (common.length) always.push({ a: a.branch, b: b.branch, files: common });
      for (const [me, other] of [
        [a.branch, b.branch],
        [b.branch, a.branch],
      ] as const) {
        if (real.length) (messages[me] ??= []).push(message(other, real, names[other]));
        if (common.length)
          (messages[me] ??= []).push(
            `${other} also edits ${common.join(', ')} — small appends, expect a trivial rebase.`,
          );
      }
    }
  }
  // Real overlaps first: they're the ones worth acting on.
  const real = (s: string) => (s.includes(' also touches ') ? 0 : 1);
  for (const lines of Object.values(messages)) lines.sort((x, y) => real(x) - real(y));
  return { pairs, always, messages };
}

function message(other: string, files: string[], session?: string): string {
  const list =
    files.slice(0, SHOWN).join(', ') +
    (files.length > SHOWN ? `, +${files.length - SHOWN} more` : '');
  const who = session ? `SendMessage session \`${session}\`` : `read its plan`;
  return (
    `${other} also touches ${files.length} of your file${files.length === 1 ? '' : 's'}: ${list} — ` +
    `${who}; expect a rebase conflict whichever merges second.`
  );
}

// `git diff --name-only` ∪ uncommitted ∪ untracked, minus gitignored scratch.
export function branchFiles(committed: string, uncommitted: string, untracked: string): string[] {
  const all = [committed, uncommitted, untracked].flatMap((s) =>
    s.split('\n').map((l) => l.trim()),
  );
  return [...new Set(all.filter((f) => f && !f.startsWith('localNotes/')))].sort();
}
