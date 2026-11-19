// The merge line (`pnpm board merge-line`, the hub's /ml): one `cd <mac-repo> && …` zsh line that merges every MERGE ME
// PR in dispatch's landing order (queue.json mergeOrder, then PR number), each pinned to the head the tower saw. The
// tower writes it to merge-line.txt every 30 s; the CLI adds a fresh ran marker. It only prints: the maintainer runs
// it, and nothing here ever merges (CLAUDE.md → Hard-blocked). The line carries numbers and hex shas only — never a
// branch or a title — so nothing from GitHub reaches the Mac's shell. Pure.
import type { LaneRow, SourceRow } from './tower/derive.ts';
import type { Pr } from './tower/prs.ts';

export const MERGE_LINE_FILE = 'merge-line.txt';
const SHA = /^[0-9a-f]{40}$/;

export type MergeLine = {
  head: string; // `MERGE 2 · landing order: …`, `MERGE none`, `MERGE unknown (…)`
  line: string | null; // the command, no marker (the page's copy button copies this)
  notes: string[]; // what was left out, and why
};

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f-\u009f]/g; // a control byte becomes a space: board text never moves a cursor
// shell syntax: the head and notes are free text (a hold reason, gh's error) printed beside the line a user pastes
// into zsh, so none of it can chain or substitute a command (fileShapeOk refuses a file that has any)
const SHELL = /[;&|$`<>\\]/g;
const one = (s: string, max = 60) => {
  const t = s.replace(CTRL, ' ').replace(SHELL, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// `merge`: NEXT's MERGE ME and HOLD rows; `order`: mergeOrder's branches, file order; `prs`: the tower's PR list (for
// the head sha); `gh`: the gh PRs source, so a stale list never prints a confident line.
export function mergeLine(
  merge: LaneRow[],
  order: string[],
  prs: Pr[],
  root: string,
  gh: SourceRow | undefined,
): MergeLine {
  if (gh && gh.state !== 'ok')
    return {
      head: `MERGE unknown (gh PRs ${gh.state}${gh.detail ? `: ${one(gh.detail, 40)}` : ''})`,
      line: null,
      notes: [],
    };
  const rank = (b: string) => {
    const i = order.indexOf(b);
    return i < 0 ? Infinity : i;
  };
  const me = merge
    .filter((r) => r.state === 'MERGE ME' && r.pr)
    .sort((a, b) => rank(a.branch) - rank(b.branch) || a.pr!.number - b.pr!.number || 0);
  const notes: string[] = [];
  const go: { n: number; branch: string; sha: string }[] = [];
  for (const r of me) {
    const sha = prs.find((p) => p.number === r.pr!.number)?.sha ?? null;
    if (sha && SHA.test(sha)) go.push({ n: r.pr!.number, branch: r.branch, sha });
    else notes.push(`left out, head unknown: PR ${r.pr!.number} ${one(r.branch, 40)}`);
  }
  for (const r of merge.filter((r) => r.state === 'HOLD' && r.pr))
    notes.push(
      `left out, on hold: PR ${r.pr!.number} ${one(r.branch, 40)}${r.hold ? ` (${one(r.hold)})` : ''}`,
    );
  if (!go.length) return { head: 'MERGE none', line: null, notes };
  const cmd = (p: (typeof go)[number]) =>
    `GH_PAGER=cat gh pr merge ${p.n} --squash --admin --body "" --match-head-commit ${p.sha}`;
  return {
    head: `MERGE ${go.length} · landing order: ${go.map((p) => `PR ${p.n} ${one(p.branch, 40)}`).join(', ')}`,
    line: `cd ${root} && ${go.map(cmd).join(' && ')}`,
    notes,
  };
}

// merge-line.txt: the head, the line (when there is one), the notes.
export const mergeLineText = (m: MergeLine) =>
  [m.head, ...(m.line ? [m.line] : []), ...m.notes].join('\n') + '\n';

// The one shape a merge line may have, checked again where it is printed: merge-line.txt sits in the shared board dir,
// so the CLI never trusts what it reads there — `cd <root>`, then only pinned squash merges of PR numbers.
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MERGE_CMD =
  'GH_PAGER=cat gh pr merge [1-9]\\d{0,6} --squash --admin --body "" --match-head-commit [0-9a-f]{40}';
export const lineShapeOk = (line: string, root: string) =>
  new RegExp(`^cd ${esc(root)} && ${MERGE_CMD}( && ${MERGE_CMD})*$`).test(line);

// The whole file, as the tower writes it: a `MERGE …` head, at most one command line (lineShapeOk), then `left out, …`
// notes — none of them carrying shell syntax. Anything else (a disguised command line, an extra line) is refused:
// null when it is fine, else what is wrong. `text` has had its control bytes turned to spaces.
export function fileShapeOk(text: string, root: string): string | null {
  const lines = text.replace(/\n$/, '').split('\n');
  const [head, ...rest] = lines;
  if (!head || !/^MERGE (none|unknown \(|\d+ · landing order: )/.test(head))
    return 'its first line is no MERGE head';
  let cds = 0;
  for (const l of rest) {
    if (l.startsWith('cd ')) {
      cds++;
      if (cds > 1 || !lineShapeOk(l, root))
        return `its line is not the pinned shape for cd ${root}`;
    } else if (!l.startsWith('left out, '))
      return `a line is neither the command nor a note: ${JSON.stringify(l.slice(0, 40))}`;
  }
  for (const l of lines)
    if (!l.startsWith('cd ') && new RegExp(SHELL.source).test(l))
      return `a note or the head carries shell syntax: ${JSON.stringify(l.slice(0, 40))}`;
  return null;
}

// What the CLI prints: the file with the marker suffix on its command line (the one starting `cd `).
export const withSuffix = (text: string, suffix: string) =>
  text
    .replace(/\n$/, '')
    .split('\n')
    .map((l) => (l.startsWith('cd ') ? `${l}${suffix}` : l))
    .join('\n');
