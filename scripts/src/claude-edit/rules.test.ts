import { describe, expect, it } from 'vitest';
import {
  charProblems,
  decodeStrict,
  extractDiff,
  fence,
  flagsFor,
  goNames,
  judgeEntries,
  renderFile,
  renderHeader,
  parseLedger,
  parseRaw,
  pathAllowed,
  showingNumber,
  unapproved,
} from './rules.ts';
import type { Entry, Row } from './rules.ts';

const e = (status: string, path: string, srcMode = '100644', dstMode = '100644'): Entry => ({
  status,
  path,
  srcMode,
  dstMode,
});
const T = 'a'.repeat(40);

describe('pathAllowed', () => {
  it.each([
    'CLAUDE.md',
    '.claude/rules/x.md',
    '.claude/hooks/g.sh',
    '.claude/settings.json',
    '.claude/worktreesX',
  ])('allows %s', (p) => expect(pathAllowed(p)).toBe(true));
  it.each([
    'docs/x.md',
    'app/CLAUDE.md',
    '.claude/worktrees',
    '.claude/worktrees/a/CLAUDE.md',
    '.claude/WORKTREES/x',
    '.Claude/../docs/x',
    '.claude/a b.md',
    '.claude//x',
    '.claude/./x',
    '',
  ])('refuses %s', (p) => expect(pathAllowed(p)).toBe(false));
  it('compares case-insensitively, as the checkout does', () => {
    expect(pathAllowed('claude.MD')).toBe(true);
    expect(pathAllowed('.CLAUDE/x')).toBe(true);
  });
});

describe('judgeEntries', () => {
  it('allows M with its mode, A at 100644, D, and A at 100755 when named', () => {
    const entries = [
      e('M', 'CLAUDE.md'),
      e('M', '.claude/hooks/g.sh', '100755', '100755'),
      e('A', '.claude/rules/new.md', '000000'),
      e('D', '.claude/rules/old.md', '100644', '000000'),
      e('A', '.claude/hooks/new.sh', '000000', '100755'),
    ];
    expect(judgeEntries(entries, [], ['.claude/hooks/new.sh'])).toEqual([]);
  });
  it.each([
    ['an exec bit dropped', e('M', '.claude/hooks/g.sh', '100755', '100644')],
    ['an exec bit added', e('M', '.claude/hooks/g.sh', '100644', '100755')],
    ['a symlink', e('A', '.claude/link', '000000', '120000')],
    ['a submodule', e('A', '.claude/sub', '000000', '160000')],
    ['an unnamed executable', e('A', '.claude/hooks/x.sh', '000000', '100755')],
    ['a type change', e('T', '.claude/x', '100644', '120000')],
    ['a path outside', e('M', 'docs/x.md')],
    ['a worktree path', e('A', '.claude/worktrees/l/CLAUDE.md', '000000')],
    ['a symlink deleted', e('D', '.claude/link', '120000', '000000')],
  ])('refuses %s', (_, entry) => expect(judgeEntries([entry], [], [])).not.toEqual([]));
  it('refuses a binary file and an --exec path the patch does not add', () => {
    expect(judgeEntries([e('M', 'CLAUDE.md')], [{ added: '-', path: 'CLAUDE.md' }], [])).toEqual([
      'CLAUDE.md: binary',
    ]);
    expect(judgeEntries([e('M', 'CLAUDE.md')], [], ['CLAUDE.md'])[0]).toMatch(
      /not a file this patch adds/,
    );
  });
});

describe('parseRaw', () => {
  it('reads -z raw output', () => {
    const z = `:100644 100755 ${'1'.repeat(40)} ${'2'.repeat(40)} M\0.claude/g.sh\0:000000 100644 ${'0'.repeat(40)} ${'3'.repeat(40)} A\0CLAUDE.md\0`;
    expect(parseRaw(z)).toEqual([
      e('M', '.claude/g.sh', '100644', '100755'),
      e('A', 'CLAUDE.md', '000000'),
    ]);
  });
});

describe('flagsFor', () => {
  it('names settings, guards, agents and attributes in words', () => {
    const f = flagsFor([
      e('M', '.claude/settings.json'),
      e('A', '.claude/hooks/x.sh', '000000', '100755'),
      e('D', '.claude/hooks/y.sh', '100755', '000000'),
      e('M', '.claude/agents/a.md'),
      e('A', '.claude/.gitattributes', '000000'),
      e('M', '.claude/rules/r.md'),
    ]);
    expect(f).toEqual([
      'permissions or hook registration changed: .claude/settings.json',
      'guard new (executable): .claude/hooks/x.sh',
      'guard deleted: .claude/hooks/y.sh',
      'agent changed: .claude/agents/a.md',
      'checkout attributes new: .claude/.gitattributes',
    ]);
  });
});

describe('charProblems', () => {
  it.each([
    ['CR', '+a\r\n'],
    ['NUL', '+a\0b\n'],
    ['ESC', '+\x1b[2J\n'],
    ['zero-width space', '+a​b\n'],
    ['bidi override', '+‮\n'],
    ['line separator', '+a b\n'],
    ['paragraph separator', '+a b\n'],
    ['private use', '+\n'],
    ['tag character', '+\u{e0041}\n'],
    ['unassigned', '+\u{50000}\n'],
  ])('refuses %s', (_, t) => expect(charProblems(t)).not.toEqual([]));
  it('allows tab, LF, accents, arrows and CJK', () =>
    expect(charProblems('+\ta — → é 漢字\n-x\n')).toEqual([]));
  it('reports the line, counting LF only', () =>
    expect(charProblems('a b\nc​\n')).toEqual(['line 1: U+2028', 'line 2: U+200B']));
  it('refuses invalid UTF-8', () =>
    expect(() => decodeStrict(Uint8Array.from([0x61, 0xff]))).toThrow(/UTF-8/));
});

describe('the showing file and header', () => {
  const show = (text: string, showing = 1) => ({
    branch: 'lane-x',
    n: 1,
    showing,
    base: 'b'.repeat(40),
    tree: T,
    files: ['M CLAUDE.md (+1 -1)'],
    flags: [],
    untracked: [],
    text,
  });
  it.each([
    ['a plain diff', 'diff --git a/x b/x\n-a\n+b\n'],
    ['a 5,156-char line', `+${'x'.repeat(5156)}\n`],
    ['backtick runs', '+a ``` b\n+````\n'],
    ['a fence-looking line', '+```diff\n+```\n'],
    ['no newline at end', '-a\n+b\n\\ No newline at end of file\n'],
  ])('takes back %s byte for byte', (_, text) =>
    expect(extractDiff(renderFile(show(text)))).toBe(text),
  );
  it('fences past the longest backtick run', () => {
    expect(fence('a')).toBe('```');
    expect(fence('a ```` b')).toBe('`````');
  });
  it('refuses a file with no fence or no closing fence', () => {
    expect(() => extractDiff('# x\n')).toThrow(/no diff fence/);
    expect(() => extractDiff('```diff\n+a\n')).toThrow(/no closing fence/);
  });
  it('heads with B, T, the go, files, flags, untracked and the file', () => {
    const h = renderHeader(
      show('+a\n', 2),
      '<mac-repo>/localNotes/claude-edits/lane-x-aaaaaaaa.md',
    );
    expect(h.split('\n')).toEqual([
      'claude-edit check — lane-x claude-edit-1, showing 2 on this branch',
      `B ${'b'.repeat(40)}`,
      `T ${T}   go names: \`aaaaaaaa\``,
      'files: M CLAUDE.md (+1 -1)',
      'flags: none',
      'untracked under .claude/: none',
      'diff: 1 lines, longest 2 chars',
      'file: <mac-repo>/localNotes/claude-edits/lane-x-aaaaaaaa.md',
    ]);
    expect(renderHeader(show('+a\n'), null)).toMatch(/^PRE-CHECK/);
  });
});

describe('the go and the ledger', () => {
  it('names the branch or T8 first, only T8 from the second showing', () => {
    expect(goNames(T, 1)).toBe('the branch or `aaaaaaaa`');
    expect(goNames(T, 2)).toBe('`aaaaaaaa`');
  });
  const rows: Row[] = [
    { t: '', kind: 'shown', branch: 'b', n: 1, base: 'B', tree: 'T1' },
    { t: '', kind: 'shown', branch: 'b', n: 2, base: 'B', tree: 'T2' },
    {
      t: '',
      kind: 'applied',
      branch: 'b',
      n: 2,
      base: 'B',
      tree: 'T2',
      commit: 'c',
      patchId: 'p2',
    },
    {
      t: '',
      kind: 'applied',
      branch: 'other',
      n: 1,
      base: 'B',
      tree: 'T9',
      commit: 'd',
      patchId: 'p9',
    },
  ];
  it('numbers showings by distinct tree', () => {
    expect(showingNumber(rows, 'b', 'T1')).toBe(1);
    expect(showingNumber(rows, 'b', 'T2')).toBe(2);
    expect(showingNumber(rows, 'b', 'T3')).toBe(3);
    expect(showingNumber(rows, 'new', 'T1')).toBe(1);
  });
  it('approves a patch-id only for its own branch', () => {
    const commits = [
      { sha: 'c', patchId: 'p2' },
      { sha: 'x', patchId: 'p9' },
      { sha: 'y', patchId: 'nope' },
    ];
    expect(unapproved(commits, rows, 'b')).toEqual(['x', 'y']);
  });
  it('skips torn and foreign ledger lines', () => {
    const text = `${JSON.stringify(rows[0])}\n{"kind":"shown"\nnot json\n{"kind":"other","branch":"b","base":"B","tree":"T"}\n`;
    expect(parseLedger(text)).toEqual([rows[0]]);
  });
});
