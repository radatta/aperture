// File-overlap warning (docs/ops/SESSION-BOARD.md → Overlaps): which worktree branches touch the same files,
// so the session that merges second hears about the rebase conflict before it happens — and, with a conflicts.ts
// check, which of those git really can't merge. Pure; cli.ts gathers each worktree's files and the check from git.
import { MAIN, type Check, type Conflict } from './conflicts.ts';

export type Tree = { branch: string; files: string[]; uncommitted?: string[] }; // uncommitted ∪ untracked: merge-tree can't see them

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

// git: what merge-tree said of the two heads — absent when no check ran; 'unchecked' when a shared file is
// uncommitted or the merge is still pending.
export type Pair = {
  a: string;
  b: string;
  files: string[];
  git?: 'conflict' | 'clean' | 'unchecked';
};

export type Overlap = {
  pairs: Pair[]; // real overlaps
  always: Pair[]; // always-collides only
  messages: Record<string, string[]>; // per branch, ready to inject at SessionStart
  // from the merge-tree check, when one ran:
  conflicts?: Conflict[]; // git can't merge these (b 'main': against origin/main)
  clean?: [string, string][]; // overlapping or not, git merges these two cleanly at both heads
  landed?: string[]; // squash-merged, worktree not cleaned up: out of every list above
  stale?: string[]; // no commit in STALE_DAYS: out of every list above
  uncommitted?: { branch: string; files: string[] }[];
  pending?: number; // merges left for the next run
};

const SHOWN = 5;

// `names` maps a branch to the session working on it (the SendMessage address), when one is registered.
export function overlaps(
  trees: Tree[],
  names: Record<string, string> = {},
  check?: Omit<Check, 'cache'>,
): Overlap {
  const gone = new Set([...(check?.landed ?? []), ...(check?.stale ?? [])]);
  const pairs: Pair[] = [];
  const always: Pair[] = [];
  const messages: Record<string, string[]> = {};
  const say = (me: string, line: string, rank: number) =>
    (messages[me] ??= []).push(`${rank}${line}`);
  const pairKey = (x: string, y: string) => [x, y].sort().join(' ');
  const clean = new Set((check?.clean ?? []).map(([x, y]) => pairKey(x, y)));
  const conflict = new Map(
    (check?.conflicts ?? []).filter((c) => c.b !== MAIN).map((c) => [pairKey(c.a, c.b), c.files]),
  );
  for (const c of check?.conflicts ?? [])
    if (c.b === MAIN && !gone.has(c.a))
      say(
        c.a,
        `merge conflict with main on ${list(c.files)} (git merge-tree) — rebase onto origin/main now.`,
        0,
      );

  const sorted = trees
    .filter((t) => !gone.has(t.branch))
    .sort((x, y) => x.branch.localeCompare(y.branch));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      const bFiles = new Set(b.files);
      const shared = [...new Set(a.files)].filter((f) => bFiles.has(f)).sort();
      const real = shared.filter((f) => !ALWAYS_COLLIDE.has(f));
      const common = shared.filter((f) => ALWAYS_COLLIDE.has(f));
      const k = pairKey(a.branch, b.branch);
      const hard = conflict.get(k);
      // an uncommitted shared file is outside what git checked: the file overlap is all there is to say
      const dirty = shared.some((f) => a.uncommitted?.includes(f) || b.uncommitted?.includes(f));
      const git = !check
        ? {}
        : ({ git: hard ? 'conflict' : clean.has(k) && !dirty ? 'clean' : 'unchecked' } as const);
      if (real.length) pairs.push({ a: a.branch, b: b.branch, files: real, ...git });
      if (common.length) always.push({ a: a.branch, b: b.branch, files: common });
      for (const [me, other] of [
        [a.branch, b.branch],
        [b.branch, a.branch],
      ] as const) {
        if (hard) say(me, conflictLine(other, hard, names[other]), 0);
        else if (real.length && clean.has(k) && !dirty)
          say(
            me,
            `${other} also touches ${list(real)} — git merges both heads cleanly today; recheck after either commits.`,
            2,
          );
        else if (real.length) say(me, message(other, real, names[other]), 1);
        if (common.length && !hard)
          say(
            me,
            `${other} also edits ${common.join(', ')} — small appends, expect a trivial rebase.`,
            3,
          );
      }
    }
  }
  // Conflicts first, then unchecked overlaps, then the ones git merges cleanly.
  for (const [me, lines] of Object.entries(messages))
    messages[me] = lines.sort((x, y) => Number(x[0]) - Number(y[0])).map((l) => l.slice(1));
  if (!check) return { pairs, always, messages };
  return {
    pairs,
    always,
    messages,
    conflicts: check.conflicts.filter((c) => !gone.has(c.a) && !gone.has(c.b)),
    clean: check.clean,
    landed: check.landed,
    stale: check.stale,
    uncommitted: sorted
      .filter((t) => t.uncommitted?.length)
      .map((t) => ({ branch: t.branch, files: t.uncommitted! })),
    pending: check.pending,
  };
}

const list = (files: string[]) =>
  `${files.length} file${files.length === 1 ? '' : 's'}: ` +
  files.slice(0, SHOWN).join(', ') +
  (files.length > SHOWN ? `, +${files.length - SHOWN} more` : '');

function conflictLine(other: string, files: string[], session?: string): string {
  const who = session ? `SendMessage session \`${session}\`` : `read its plan`;
  return `${other} will conflict with you on ${list(files)} (git merge-tree) — ${who}; whichever merges second rebases.`;
}

function message(other: string, files: string[], session?: string): string {
  const list =
    files.slice(0, SHOWN).join(', ') +
    (files.length > SHOWN ? `, +${files.length - SHOWN} more` : '');
  const who = session ? `SendMessage session \`${session}\`` : `read its plan`;
  return (
    `${other} also touches ${files.length === 1 ? '1 of your files' : `${files.length} of your files`}: ${list} — ` +
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
