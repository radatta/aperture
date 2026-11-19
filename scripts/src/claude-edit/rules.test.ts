import { describe, expect, it } from 'vitest';
import {
  approvedRows,
  caseTwins,
  changedSpans,
  charProblems,
  decodeStrict,
  extractDiff,
  fence,
  flagsFor,
  goNames,
  hiddenIn,
  judgeEntries,
  messageProblem,
  renderFile,
  renderHeader,
  parseLedger,
  parseRaw,
  pathAllowed,
  pathProblem,
  safePath,
  showingNumber,
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
    '.claude/settings.local.json',
    '.claude/worktreesx',
    '.claude/hooks/README.md',
    '.claude/skills/s/SKILL.md',
    '.claude/skills/s/A_B-2.md',
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
    'claude.md',
    'claude.MD',
    '.CLAUDE/x',
    '.Claude/hooks/x.sh',
    '.claude/worktreesX',
  ])('refuses %s', (p) => expect(pathAllowed(p)).toBe(false));
  // One case rule under .claude/: the mount folds case, so each of these lands on a real file or directory.
  it.each([
    ['.claude/Agents/x.md', /directory/],
    ['.claude/Hooks/g.sh', /directory/],
    ['.claude/skills/S/SKILL.md', /directory/],
    ['.claude/Settings.local.json', /file name/],
    ['.claude/hooks/Readme.md', /file name/],
    ['.claude/hooks/README.MD', /file name/],
    ['.claude/hooks/README.sh', /file name/],
    ['.claude/.gitattributes', /gitattributes/],
    ['.claude/hooks/.GitAttributes', /file name/],
    ['.claude/hooks/.gitattributes', /gitattributes/],
    ['.claude/WORKTREES/x', /worktree/],
    ['docs/x.md', /outside/],
    ['.claude/a b.md', /unsafe/],
  ])('names why %s is refused', (p, why) => expect(pathProblem(p)).toMatch(why));
  it('names case twins: one file on a case-folding checkout', () => {
    expect(caseTwins(['CLAUDE.md', '.claude/a.md', '.claude/A.md'])).toEqual([
      '.claude/a.md and .claude/A.md differ only in case',
    ]);
    expect(caseTwins(['CLAUDE.md', '.claude/a.md'])).toEqual([]);
  });
  it('a safe path has the safe charset and no empty, . or .. segment', () => {
    expect(safePath('.claude/x-1_@+.md')).toBe(true);
    expect(safePath('.claude/x\n```diff')).toBe(false);
    expect(safePath('.claude/../x')).toBe(false);
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
  it('names settings, guards, agents, skills and executables in words', () => {
    const f = flagsFor([
      e('M', '.claude/settings.json'),
      e('A', '.claude/hooks/x.sh', '000000', '100755'),
      e('D', '.claude/hooks/y.sh', '100755', '000000'),
      e('M', '.claude/agents/a.md'),
      e('M', '.claude/rules/r.md'),
      e('A', '.claude/skills/s/run.sh', '000000', '100755'),
      e('M', '.claude/commands/c.md'),
      e('A', '.claude/tools/t.sh', '000000', '100755'),
    ]);
    expect(f).toEqual([
      'permissions or hook registration changed: .claude/settings.json',
      'guard new (executable): .claude/hooks/x.sh',
      'guard deleted: .claude/hooks/y.sh',
      'agent changed: .claude/agents/a.md',
      'skill or command new (executable): .claude/skills/s/run.sh',
      'skill or command changed: .claude/commands/c.md',
      'executable new: .claude/tools/t.sh',
    ]);
  });
  it('classifies on the lowercased path, as the checkout reads it', () =>
    expect(
      flagsFor([
        e('M', '.claude/Agents/x.md'),
        e('M', '.claude/Settings.local.json'),
        e('M', '.claude/skills/s/SKILL.md'),
        e('M', '.claude/HOOKS/g.sh'),
      ]),
    ).toEqual([
      'agent changed: .claude/Agents/x.md',
      'permissions or hook registration changed: .claude/Settings.local.json',
      'skill or command changed: .claude/skills/s/SKILL.md',
      'guard changed: .claude/HOOKS/g.sh',
    ]));
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
    ['variation selector 16', '+a\ufe0f\n'],
    ['variation selector 17', '+a\u{e0100}\n'],
    ['combining grapheme joiner', '+a\u034f\n'],
    ['Hangul filler', '+\u3164\n'],
    ['halfwidth Hangul filler', '+\uffa0\n'],
    ['Hangul choseong filler', '+\u115f\n'],
    ['braille blank', '+\u2800\n'],
    ['no-break space', '+a\u00a0b\n'],
    ['combining acute', '+e\u0301\n'],
    ['Arabic number sign (Cf, not default-ignorable)', '+\u0600\n'],
    ['combining enclosing circle (Me)', '+a\u20dd\n'],
  ])('refuses %s', (_, t) => expect(charProblems(t)).not.toEqual([]));
  it('splits hidden characters: on added lines, and on lines already in B', () =>
    expect(hiddenIn('@@ -1,3 +1,3 @@\n a\u00a0b\n-c\u200bd\n+e\u2028f\n++g\u00a0\n')).toEqual({
      added: ['line 4: U+2028', 'line 5: U+00A0'],
      other: ['line 2: U+00A0', 'line 3: U+200B'],
    }));
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
    trees: showing,
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
  it('adds the changed part of a long line under the diff, outside its fence', () => {
    const head = 'x'.repeat(250);
    const text = `diff --git a/CLAUDE.md b/CLAUDE.md\n--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1 +1 @@\n-${head} old words tail\n+${head} new words tail\n`;
    const md = renderFile(show(text));
    expect(extractDiff(md)).toBe(text);
    expect(changedSpans(text)).toEqual([
      'CLAUDE.md',
      `was: …${'x'.repeat(29)} ⟦old⟧ words tail`,
      `now: …${'x'.repeat(29)} ⟦new⟧ words tail`,
      '',
    ]);
    expect(md).toContain('⟦new⟧');
    expect(changedSpans('@@ -1 +1 @@\n-short\n+SHORT\n')).toEqual([]);
  });
  it('puts the branch, paths, flags and untracked names in code spans, so `_` is never italics', () => {
    const md = renderFile({
      ...show('+a\n'),
      branch: 'lane_x',
      files: ['A .claude/rules/a_b_c.md (+1 -0)'],
      flags: ['guard new: .claude/hooks/a_b.sh'],
      untracked: ['.claude/x_y.md', '.claude/z.md'],
    });
    expect(md).toContain('# claude-edit — `lane_x` claude-edit-1');
    expect(md).toContain('- files: `A .claude/rules/a_b_c.md (+1 -0)`');
    expect(md).toContain('- flags: `guard new: .claude/hooks/a_b.sh`');
    expect(md).toContain('- untracked under .claude/: `.claude/x_y.md`, `.claude/z.md`');
    expect(renderFile(show('+a\n'))).toContain('- flags: none');
  });
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
  it('names the branch or T8 while one tree is shown on the branch, only T8 once there are two', () => {
    expect(goNames(T, 1)).toBe('the branch or `aaaaaaaa`');
    expect(goNames(T, 2)).toBe('`aaaaaaaa`');
  });
  it.each([
    ['fixed cache policy ttl', null],
    ['added claude-edit CLI for hub', null],
    ['too short', /words/],
    ['one two three four five six seven', /words/],
    ['Fixed cache policy ttl', /lowercase/],
    ['fixed it; rm -f x', /only/],
    ['fixed `x` quoted it', /only/],
    ['fixed  double space here', /single/],
  ])('commit message %j', (m, want) =>
    want ? expect(messageProblem(m)).toMatch(want) : expect(messageProblem(m)).toBeNull(),
  );
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
    },
    {
      t: '',
      kind: 'applied',
      branch: 'other',
      n: 1,
      base: 'B',
      tree: 'T9',
      commit: 'd',
    },
  ];
  it('numbers showings by distinct tree and counts the trees', () => {
    expect(showingNumber(rows, 'b', 'T1')).toEqual({ showing: 1, trees: 2 });
    expect(showingNumber(rows, 'b', 'T2')).toEqual({ showing: 2, trees: 2 });
    expect(showingNumber(rows, 'b', 'T3')).toEqual({ showing: 3, trees: 3 });
    expect(showingNumber(rows, 'new', 'T1')).toEqual({ showing: 1, trees: 1 });
  });
  it('takes the applied rows of this branch, well-formed, shown, one per commit', () => {
    const [B, T1, T2, C, D] = ['1', '2', '3', '4', '5'].map((c) => c.repeat(40));
    const shown = (branch: string, tree: string): Row => ({
      t: '',
      kind: 'shown',
      branch,
      n: 1,
      base: B!,
      tree,
    });
    const applied = (branch: string, tree: string, commit: string): Row => ({
      ...shown(branch, tree),
      kind: 'applied',
      commit,
    });
    const ok = applied('b', T1!, C!);
    const ledger = [
      shown('b', T1!),
      ok,
      applied('b', T1!, C!), // the same commit again
      applied('b', T2!, D!), // T2 never shown on b
      applied('other', T1!, D!), // another branch
      applied('b', T1!, 'short'), // not a sha
    ];
    expect(approvedRows(ledger, 'b')).toEqual([ok]);
  });
  it('skips torn and foreign ledger lines', () => {
    const text = `${JSON.stringify(rows[0])}\n{"kind":"shown"\nnot json\n{"kind":"other","branch":"b","base":"B","tree":"T"}\n`;
    expect(parseLedger(text)).toEqual([rows[0]]);
  });
});
