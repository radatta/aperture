import { describe, expect, it } from 'vitest';
import { cells, lint, pathClaims, searches, searchProblem, unfence, type Tree } from './lint.ts';

// A synthetic repo: these files exist, with these line counts.
const FILES: Record<string, number> = {
  'packages/x/src/write.ts': 80,
  'packages/x/src/list.ts': 40,
  'packages/x/src/list.test.ts': 30,
  'docs/x.md': 50,
  'tools/y.sh': 10,
  'CLAUDE.md': 199,
};
const tree: Tree = {
  root: '/repo',
  topLevel: new Set(['packages', 'docs', 'scripts', 'tools', 'CLAUDE.md', 'localNotes']),
  exists: (p) =>
    p in FILES || Object.keys(FILES).some((f) => f.startsWith(p.replace(/\/$/, '') + '/')),
  lineCount: (p) => FILES[p],
};

const SECTIONS: Record<string, string> = {
  'Operator steps': 'none',
  Files: `| # | File | Via |
| --- | --- | --- |
| 1 | \`packages/x/src/write.ts\` | commit |
| 2 | \`packages/x/src/new.ts\` (new) | commit |`,
  'Change census': `| ID | State / contract | Writers | Readers | Searches → hits | Change |
| --- | --- | --- | --- | --- | --- |
| C1 | \`doneAt\` | \`packages/x/src/write.ts:40\` | \`packages/x/src/list.ts:12\` | \`git grep -n -e doneAt -- packages docs\` → 9; \`git grep -n -e "'doneAt'" -e done_at -- packages tools\` → 0 | optional |`,
  Unknowns: `| ID | Claim | Version | Evidence |
| --- | --- | --- | --- |
| U1 | a key over 1 KB is refused | tool 3.2 | searched: https://example.com/docs/limits |
| U2 | the flag exists | 3.2.1 | probed: \`tool --help\` → lists --dry-run |
| U3 | throttling | n/a | run-only: only the deployed stage throttles |`,
  Invariants: `| ID | Invariant | Failing test |
| --- | --- | --- |
| I1 | a done task is never open | T1 |
| I2 | doneAt survives a reload | T2 |
| I3 | the list stays sorted | \`packages/x/src/list.test.ts\` |`,
  'Ordering and races': `| ID | Path / hop | Risk | Rule |
| --- | --- | --- | --- |
| O1 | toggle then refetch | refetch lands first | the write's response wins |`,
  'Pre-mortem': `| ID | Class | Why it failed | Covered by |
| --- | --- | --- | --- |
| P1 | reader/writer | a missed reader | C1 |
| P2 | outside tool | a limit assumed | U1 |
| P3 | race | two writers | O1 |
| P4 | contract | a unit mismatch | C1 |
| P5 | test cannot fail | passes reverted | T1 |
| P6 | other | rollback | I1, I2 |`,
  'Test matrix': `| ID | Entry × case | Proof | Fails when |
| --- | --- | --- | --- |
| T1 | UI × toggle | dev | fails when: the toggle write is dropped |
| T2 | UI × reload | dev | fails when: doneAt is not persisted |`,
  'Step plan': `| # | Step | Phase key | Minutes | From |
| --- | --- | --- | --- | --- |
| 1 | build | build | 20–40 | f361 actuals |
| 2 | replay | local | 30–90? | no history |`,
  'Open questions': 'none',
};

function plan(mode = 'full', over: Record<string, string | null> = {}, head = ''): string {
  const out = [`# Plan: x`, ``, `Template: ${mode} — a synthetic example`, head];
  for (const [name, body] of Object.entries({ ...SECTIONS, ...over }))
    if (body !== null) out.push(``, `## ${name}`, ``, body);
  return out.join('\n') + '\n';
}
const run = (text: string) => lint(text, tree);
const checks = (text: string) => run(text).problems.map((p) => `${p.check}: ${p.message}`);

describe('a valid plan', () => {
  it('passes in full', () => {
    expect(run(plan())).toEqual({ mode: 'full', problems: [] });
  });

  it('passes in light without ordering and pre-mortem', () => {
    const r = run(plan('light', { 'Ordering and races': null, 'Pre-mortem': null }));
    expect(r).toEqual({ mode: 'light', problems: [] });
  });
});

describe('template', () => {
  it('needs the mode line', () => {
    expect(checks(plan().replace(/^Template:.*$/m, ''))).toContain(
      'template: no `Template: full|light — <why>` line under the title',
    );
    expect(checks(plan().replace('full — a synthetic example', 'medium — x'))[0]).toMatch(
      /^template:/,
    );
    expect(checks(plan().replace(' — a synthetic example', ''))[0]).toMatch(/^template:/);
  });

  it('light takes at most 5 files', () => {
    const rows = [1, 2, 3, 4, 5, 6].map((n) => `| ${n} | \`docs/x.md\` | commit |`).join('\n');
    const files = `| # | File | Via |\n| --- | --- | --- |\n${rows}`;
    const light = { 'Ordering and races': null, 'Pre-mortem': null };
    expect(checks(plan('light', { ...light, Files: files }))).toEqual([
      'template: light allows at most 5 files; this plan lists 6',
    ]);
    const five = files.split('\n').slice(0, -1).join('\n');
    expect(checks(plan('light', { ...light, Files: five }))).toEqual([]);
  });
});

describe('section', () => {
  it.each(Object.keys(SECTIONS))('flags a missing "%s" in full', (name) => {
    expect(checks(plan('full', { [name]: null }))).toContain(`section: missing "## ${name}"`);
  });

  it('light does not need ordering or pre-mortem, but needs the rest', () => {
    expect(
      checks(plan('light', { 'Ordering and races': null, 'Pre-mortem': null, Unknowns: null })),
    ).toEqual(['section: missing "## Unknowns"']);
  });

  it('flags a duplicate section and an empty one', () => {
    expect(checks(plan() + '\n## Files\n\nagain\n')).toContain('section: "Files" appears twice');
    expect(checks(plan('full', { Files: 'some prose' }))).toContain(
      'section: "Files" needs a table',
    );
    expect(checks(plan('full', { 'Test matrix': 'none' }))).toContain(
      'section: "Test matrix" needs a table',
    );
  });

  it('ignores headings inside a fence and extra sections', () => {
    const text =
      plan('full', { Files: null }) + '\n````\n## Files\n````\n\n## Appendix A\n\nfree text\n';
    expect(checks(text)).toContain('section: missing "## Files"');
  });
});

describe('census', () => {
  const row = (searches: string, writers = '`packages/x/src/write.ts:40`', readers = 'none') =>
    `| ID | State | Writers | Readers | Searches → hits | Change |\n| --- | --- | --- | --- | --- | --- |\n| C1 | x | ${writers} | ${readers} | ${searches} | y |`;
  const g1 = '`git grep -n -e doneAt -- packages`';
  const g2 = '`git grep -n -e done_at -- tools`';

  it('full needs two counted searches, light one', () => {
    expect(checks(plan('full', { 'Change census': row(`${g1} → 3`) }))).toEqual([
      'census: 2 searches with a hit count (`<command>` → <n>) needed, found 1',
    ]);
    const light = {
      'Ordering and races': null,
      'Pre-mortem': null,
      'Change census': row(`${g1} → 3`),
    };
    expect(checks(plan('light', light))).toEqual([]);
    expect(checks(plan('light', { ...light, 'Change census': row('none') }))[0]).toMatch(
      /needed, found 0/,
    );
  });

  it('accepts a 0 count and an ASCII arrow; rejects a missing count', () => {
    expect(checks(plan('full', { 'Change census': row(`${g1} → 0; ${g2} -> 12`) }))).toEqual([]);
    expect(checks(plan('full', { 'Change census': row(`${g1} → 3; ${g2}`) }))).toContain(
      'census: no hit count after "git grep -n -e done_at -- tools"',
    );
  });

  it('the census row reports what searchProblem finds', () => {
    expect(
      checks(plan('full', { 'Change census': row(`\`find packages -name x\` → 2; ${g2} → 1`) })),
    ).toEqual(['census: not a census search: "find packages -name x" (git grep)']);
  });
});

// The allowlist: the plan reviewer re-runs these, so anything but one plain scoped search is refused.
describe('searchProblem', () => {
  const p = (cmd: string) => searchProblem(cmd, tree);

  it('passes the shapes real plans use', () => {
    for (const cmd of [
      'git grep -n -e doneAt -- packages docs',
      "git grep -n -i -e retry-after -e 'Retry After' -- packages tools CLAUDE.md",
      "git grep -n -e '--autocompact' -e '?.lanes' -- packages docs",
      'git grep -n doneAt -- docs packages',
      'git grep -nw -C 2 -e doneAt docs/x.md',
      'git grep -n --untracked -e doneAt -- packages/x/src/',
      'git grep -n "done at" ./docs',
      'git grep -nA3 doneAt docs',
      'git grep -n --max-count=2 -e doneAt docs',
    ])
      expect(p(cmd), cmd).toBeUndefined();
  });

  it('takes only git grep: grep -r and rg read ignored files', () => {
    expect(p('grep -rn doneAt docs')).toBe(
      'not a census search: "grep -rn doneAt docs" (git grep)',
    );
    // rg's -g glob, or an ignored path named outright, overrides .gitignore
    expect(p("rg -n -e key -g '*' docs")).toMatch(/^not a census search/);
    expect(p('rg -n x localNotes')).toMatch(/^not a census search/);
    expect(p('find packages -name x')).toMatch(/^not a census search/);
  });

  it('refuses shell syntax outside single quotes', () => {
    expect(p('git grep -n doneAt docs | wc -l')).toBe(
      'a pipe in a search hides its count: one command, one -e per form',
    );
    expect(p('git grep -n x docs|sh')).toMatch(/^a pipe/);
    for (const cmd of [
      'git grep -n x docs > localNotes/decisions.md',
      'git grep -n x docs ;sh',
      'git grep -n x docs&&sh',
      'git grep -n x docs &',
      'git grep -n -e x <(sh) docs',
      'git grep -n $(id) docs',
      'git grep -n `id` docs',
      'git grep -n x docs/*.md',
      'git grep -n x ~/docs',
    ])
      expect(p(cmd), cmd).toMatch(/^shell syntax outside quotes/);
    expect(p('git grep -n "$(id)" docs')).toMatch(/inside double quotes/);
    expect(p("git grep -n 'x docs")).toBe('an unclosed quote');
    // inside single quotes nothing is shell syntax
    expect(p("git grep -n -e 'a|b;$(c)' docs")).toBeUndefined();
  });

  it('refuses flags off the list, spelled any way', () => {
    for (const cmd of [
      'git grep -O -e x docs',
      'git grep -Ovim -e x docs',
      'git grep -nOsh -e x docs',
      'git grep --open-files-in-pager=vim -e x docs',
      'git grep --open -e x docs',
      'git grep --no-index -e x docs',
      'git grep --no-exclude-standard --untracked -e x docs',
      'git grep --recurse-submodules -e x docs',
      'git grep -f patterns docs',
      // not git grep options at all (git 2.55 exits 129), so a count beside them is invented
      'git grep --regexp=x docs',
      'git grep -x -e x docs',
      'git grep --line-regexp -e x docs',
    ])
      expect(p(cmd), cmd).toMatch(/is not on the census list/);
    expect(p('git grep -A x docs')).toBe('A takes a number');
    expect(p('git grep -n -e')).toBe('e needs a value');
  });

  it('the first operand is the pattern unless -e gave one', () => {
    // these search the whole root: `docs` is the pattern
    expect(p('git grep -n docs')).toBe('no repo path named in "git grep -n docs"');
    expect(p('git grep -n -e packages doneAt')).toBe('"doneAt" is not in the checkout');
    expect(p('git grep -n')).toBe('no pattern');
  });

  it('every path is a plain existing repo path', () => {
    expect(p('git grep -n x .')).toBe('a search of the whole root: name the directories');
    expect(p('git grep -n x ./')).toBe('a search of the whole root: name the directories');
    expect(p('git grep -n x docs/typodir')).toBe('"docs/typodir" is not in the checkout');
    expect(p('git grep -n x docs packages/nope')).toBe('"packages/nope" is not in the checkout');
    for (const op of ['docs/..', '/workspace', '/etc', 'docs/../..', ':/docs', 'cdk/.secrets'])
      expect(p(`git grep -n -e x -- ${op}`), op).toMatch(/is not a plain repo path/);
  });
});

describe('secrets and ports', () => {
  const secret = ['cdk', '.secrets', 'stage.json'].join('/');

  it('a path claim through a secrets dir is refused before anything reads it', () => {
    const read: string[] = [];
    const spy: Tree = {
      ...tree,
      topLevel: new Set([...tree.topLevel, 'cdk']),
      exists: () => true,
      lineCount: (q) => (read.push(q), 10),
    };
    const problems = lint(plan('full', {}, `See \`${secret}:1\`.`), spy).problems.map(
      (x) => x.message,
    );
    expect(problems).toContain(`\`${secret}:1\`: not a plain repo path (no .. or .secrets)`);
    expect(read).not.toContain(secret);
  });

  it('a searched: URL with an explicit port is refused', () => {
    const port = SECTIONS.Unknowns!.replace(
      'https://example.com/docs/limits',
      'https://example.com:9000/a',
    );
    expect(checks(plan('full', { Unknowns: port }))).toEqual([
      'unknown: searched: a URL with an explicit port (8080 pauses the container): link the public page',
    ]);
  });
});

describe('census writers and readers', () => {
  const row = (searches: string, writers = '`packages/x/src/write.ts:40`', readers = 'none') =>
    `| ID | State | Writers | Readers | Searches → hits | Change |\n| --- | --- | --- | --- | --- | --- |\n| C1 | x | ${writers} | ${readers} | ${searches} | y |`;
  const g1 = '`git grep -n -e doneAt -- packages`';
  const g2 = '`git grep -n -e done_at -- tools`';

  it('needs path:line or none for writers and readers', () => {
    expect(
      checks(plan('full', { 'Change census': row(`${g1} → 1; ${g2} → 1`, 'the Agent tool') })),
    ).toEqual(['census: Writers: a `path:line` or `none`']);
    expect(
      checks(
        plan('full', { 'Change census': row(`${g1} → 1; ${g2} → 1`, 'none (runtime)', 'n/a') }),
      ),
    ).toEqual([]);
  });
});

describe('unknowns', () => {
  const u = (evidence: string, version = '1.0') =>
    plan('full', {
      Unknowns: `| ID | Claim | Version | Evidence |\n| --- | --- | --- | --- |\n| U1 | a claim | ${version} | ${evidence} |`,
    });

  it.each([
    ['from memory: it works', '"from memory" is not evidence: search or probe it'],
    ['open: does it?', 'open: settle it (search or probe) before [kickoff]'],
    ['searched: the docs', 'searched: needs the URL it came from'],
    ['probed: ran it', 'probed: needs `<command>` → <output>'],
    ['probed: `tool -v`', 'probed: needs `<command>` → <output>'],
    ['run-only: dev', 'run-only: needs the reason no search or probe can settle it'],
    ['I checked', 'evidence must start with searched:, probed:, run-only:'],
  ])('rejects %j', (evidence, message) => {
    expect(checks(u(evidence))).toContain(`unknown: ${message}`);
  });

  it('accepts the three kinds, and none as the whole section', () => {
    expect(checks(u('searched: https://example.com/a'))).toEqual([]);
    expect(checks(u('probed: `tool -v` → 3.2.1'))).toEqual([]);
    expect(checks(u('run-only: only the deployed stage throttles'))).toEqual([]);
    expect(checks(u('searched: https://example.com/a', ''))).toEqual([
      'unknown: Version is empty (write the version, or n/a)',
    ]);
  });
});

describe('invariants, ordering, pre-mortem, matrix, steps', () => {
  const inv = (n: number) =>
    `| ID | Invariant | Failing test |\n| --- | --- | --- |\n` +
    Array.from({ length: n }, (_, i) => `| I${i + 1} | holds | T1 |`).join('\n');

  it('full takes 3–7 invariants', () => {
    // P6 points at I2: keep at least 2 rows for its pointer, and count only the bound problem
    const bound = (n: number) =>
      checks(plan('full', { Invariants: inv(n) })).filter((c) => c.startsWith('invariant'));
    expect(bound(2)).toEqual(['invariant: full takes 3–7 invariants, found 2']);
    expect(bound(3)).toEqual([]);
    expect(bound(7)).toEqual([]);
    expect(bound(8)).toEqual(['invariant: full takes 3–7 invariants, found 8']);
  });

  it('light takes 1–3', () => {
    const light = { 'Ordering and races': null, 'Pre-mortem': null };
    expect(checks(plan('light', { ...light, Invariants: inv(1) }))).toEqual([]);
    expect(checks(plan('light', { ...light, Invariants: inv(4) }))).toEqual([
      'invariant: light takes 1–3 invariants, found 4',
    ]);
  });

  it('an invariant points at a real test row', () => {
    const bad = SECTIONS.Invariants!.replace('| T1 |', '| T9 |');
    expect(checks(plan('full', { Invariants: bad }))).toEqual([
      'ref: T9 is not a row in this plan',
    ]);
    const none = SECTIONS.Invariants!.replace('| T1 |', '| the toggle test |');
    expect(checks(plan('full', { Invariants: none }))).toEqual([
      'invariant: Failing test: no row id (T1)',
    ]);
  });

  it('an invariant points at a test, not at itself or another kind of row', () => {
    for (const id of ['I1', 'C1', 'U1'])
      expect(
        checks(plan('full', { Invariants: SECTIONS.Invariants!.replace('| T1 |', `| ${id} |`) })),
        id,
      ).toEqual([`invariant: Failing test: ${id} is not a T row`]);
    // a test file only counts backticked, as a real path
    const later = SECTIONS.Invariants!.replace('| T1 |', '| none yet, foo.test.ts later |');
    expect(checks(plan('full', { Invariants: later }))).toEqual([
      'invariant: Failing test: no row id (T1)',
    ]);
  });

  it('a pre-mortem row never points at a pre-mortem row', () => {
    expect(
      checks(
        plan('full', {
          'Pre-mortem': SECTIONS['Pre-mortem']!.replace('rollback | I1, I2', 'rollback | P6'),
        }),
      ),
    ).toEqual(['premortem: Covered by: P6 is not a C/U/I/O/T row']);
  });

  it('columns are read by header, not position', () => {
    const extra = SECTIONS.Invariants!.replace('| Failing test |', '| Failing test | Notes |')
      .replace('| --- | --- | --- |', '| --- | --- | --- | --- |')
      .replace('| T1 |', '| the toggle | T1 |');
    expect(checks(plan('full', { Invariants: extra }))).toContain(
      'invariant: Failing test: no row id (T1)',
    );
  });

  it('fails when: needs a real mutation; minutes run low to high', () => {
    expect(
      checks(
        plan('full', {
          'Test matrix': SECTIONS['Test matrix']!.replace(
            'fails when: the toggle write is dropped',
            'fails when: never',
          ),
        }),
      ),
    ).toEqual(['matrix: no `fails when: <mutation>`']);
    expect(
      checks(plan('full', { 'Step plan': SECTIONS['Step plan']!.replace('20–40', '90–5') })),
    ).toEqual(['steps: 90–5: low before high']);
  });

  it('ordering: bare N/A fails, N/A with a reason passes', () => {
    expect(
      checks(plan('full', { 'Ordering and races': 'N/A' })).filter((c) => c.startsWith('order')),
    ).toEqual(['order: N/A needs a reason: `N/A — <why no write path or async hop>`']);
    // P3 points at O1, so drop that pointer for this case
    const pm = SECTIONS['Pre-mortem']!.replace('two writers | O1', 'two writers | C1');
    expect(
      checks(
        plan('full', {
          'Ordering and races': 'N/A — a docs-only change, nothing writes',
          'Pre-mortem': pm,
        }),
      ),
    ).toEqual([]);
  });

  it('pre-mortem: count, every class, pointers', () => {
    const rows = SECTIONS['Pre-mortem']!.split('\n');
    expect(checks(plan('full', { 'Pre-mortem': rows.slice(0, -1).join('\n') }))).toEqual([
      'premortem: at least 6 reasons, found 5',
      'premortem: no "other" row',
    ]);
    const twice = SECTIONS['Pre-mortem']!.replace('| race |', '| contract |');
    expect(checks(plan('full', { 'Pre-mortem': twice }))).toEqual(['premortem: no "race" row']);
    const dangling = SECTIONS['Pre-mortem']!.replace('rollback | I1, I2', 'rollback | I8');
    expect(checks(plan('full', { 'Pre-mortem': dangling }))).toEqual([
      'ref: I8 is not a row in this plan',
    ]);
  });

  it('every matrix row needs fails when:, not only the header', () => {
    const m = SECTIONS['Test matrix']!.replace(
      'fails when: doneAt is not persisted',
      'it persists',
    );
    expect(checks(plan('full', { 'Test matrix': m }))).toEqual([
      'matrix: no `fails when: <mutation>`',
    ]);
    const empty = SECTIONS['Test matrix']!.replace(
      'fails when: doneAt is not persisted',
      'fails when:',
    );
    expect(checks(plan('full', { 'Test matrix': empty }))).toEqual([
      'matrix: no `fails when: <mutation>`',
    ]);
  });

  it('steps need a range and a source', () => {
    const s = SECTIONS['Step plan']!.replace('20–40', 'about 30').replace('no history |', ' |');
    expect(checks(plan('full', { 'Step plan': s }))).toEqual([
      'steps: no `<lo>–<hi>` minutes',
      'steps: From is empty (the record it came from, or `no history`)',
    ]);
  });

  it('an id range defines every id in it', () => {
    const u = SECTIONS.Unknowns!.replace('| U1 |', '| U1–U2 |').replace(/\n\| U2 .*$/m, '');
    expect(checks(plan('full', { Unknowns: u }))).toEqual([]);
  });
});

describe('round-1 review cases', () => {
  const pm = (from: string, to: string) => SECTIONS['Pre-mortem']!.replace(from, to);

  it('Unknowns may be none as the whole section', () => {
    // P2 points at U1, so repoint it when the section goes
    const r = checks(
      plan('full', { Unknowns: 'none', 'Pre-mortem': pm('assumed | U1', 'assumed | C1') }),
    );
    expect(r).toEqual([]);
  });

  it('an empty ordering section fails in full', () => {
    expect(
      checks(
        plan('full', {
          'Ordering and races': '',
          'Pre-mortem': pm('two writers | O1', 'two writers | C1'),
        }),
      ),
    ).toContain('section: "Ordering and races" needs a table');
  });

  it('a pre-mortem row with no pointer fails', () => {
    expect(
      checks(plan('full', { 'Pre-mortem': pm('rollback | I1, I2', 'rollback | the docs') })),
    ).toContain('premortem: Covered by: no row id (C1, U1, I1, O1 or T1)');
  });

  it('a reversed range and line 0 are not ranges', () => {
    expect(checks(plan('full', {}, 'See `docs/x.md:40-30`.'))).toEqual([
      'path: `docs/x.md:40-30`: not a line range (lines start at 1, low to high)',
    ]);
    expect(checks(plan('full', {}, 'See `docs/x.md:0`.'))).toEqual([
      'path: `docs/x.md:0`: not a line range (lines start at 1, low to high)',
    ]);
  });
});

describe('round-1 correctness cases', () => {
  it('a ./ path and an en-dash range are checked, not skipped', () => {
    expect(checks(plan('full', {}, 'See `./docs/nope.md`.'))).toEqual([
      'path: `./docs/nope.md` does not exist (a file the change adds: `path` (new))',
    ]);
    expect(checks(plan('full', {}, 'See `docs/x.md:10–20000`.'))).toEqual([
      'path: `docs/x.md:10–20000`: docs/x.md has 50 lines',
    ]);
  });

  it('(new) on a file that exists is flagged', () => {
    expect(checks(plan('full', {}, 'Adds `docs/x.md` (new).'))).toEqual([
      'path: `docs/x.md` (new) already exists: the plan misread the repo, or drop (new)',
    ]);
  });

  it('writers and readers need a backticked path:line', () => {
    const c = (w: string) =>
      checks(
        plan('full', {
          'Change census': SECTIONS['Change census']!.replace('`packages/x/src/write.ts:40`', w),
        }),
      );
    expect(c('see notes:1')).toEqual(['census: Writers: a `path:line` or `none`']);
    expect(c('`none` (runtime)')).toEqual([]);
  });

  it('a backticked none counts as none', () => {
    expect(checks(plan('full', { 'Open questions': '`none`' }))).toEqual([]);
  });

  it('placeholders: capital markers only, quoted text is a mention', () => {
    expect(checks(plan('full', {}, 'A list for todo apps.'))).toEqual([]);
    expect(checks(plan('full', {}, 'The ledger marks TODO(scale) items.'))).toEqual([]);
    expect(checks(plan('full', {}, 'The doc says "to be decided" there.'))).toEqual([]);
    expect(checks(plan('full', {}, 'TODO: write this.'))).toEqual(['placeholder: "TODO" left in']);
  });

  it('a table ends at a blank line; any GFM separator is skipped', () => {
    const files = '| # | File | Via |\n|--|--|--|\n| 1 | `docs/x.md` | commit |\n\n| a | b | c |';
    expect(
      checks(plan('light', { 'Ordering and races': null, 'Pre-mortem': null, Files: files })),
    ).toEqual([]);
  });
});

describe('placeholders', () => {
  it('flags them in prose and cells, not in code or fences', () => {
    expect(checks(plan('full', {}, 'Decide the TTL: TBD.'))).toEqual([
      'placeholder: "TBD" left in',
    ]);
    expect(checks(plan('full', {}, 'Which store? ???'))).toEqual(['placeholder: "???" left in']);
    expect(checks(plan('full', {}, 'The cap is to be decided.'))).toEqual([
      'placeholder: "to be decided" left in',
    ]);
    expect(checks(plan('full', {}, 'The lint flags `TODO` markers.'))).toEqual([]);
    expect(checks(plan('full', {}, '```\nTODO in a quoted example\n```'))).toEqual([]);
    const cell = SECTIONS.Files!.replace('| commit |', '| <via> |');
    expect(checks(plan('full', { Files: cell }))).toEqual([
      'placeholder: a cell that is only a `<…>` placeholder',
    ]);
  });
});

describe('paths', () => {
  it('flags a missing file and a line past its end', () => {
    expect(checks(plan('full', {}, 'See `docs/gone.md`.'))).toEqual([
      'path: `docs/gone.md` does not exist (a file the change adds: `path` (new))',
    ]);
    expect(checks(plan('full', {}, 'See `docs/x.md:51`.'))).toEqual([
      'path: `docs/x.md:51`: docs/x.md has 50 lines',
    ]);
    expect(checks(plan('full', {}, 'See `docs/x.md:40-60`.'))).toEqual([
      'path: `docs/x.md:40-60`: docs/x.md has 50 lines',
    ]);
    expect(checks(plan('full', {}, 'See `docs/x.md:50` and `docs/x.md:1-50`.'))).toEqual([]);
    expect(checks(plan('full', {}, 'See `docs:3`.'))).toEqual([
      'path: `docs:3`: not a readable file',
    ]);
  });

  it('a (new) mark anywhere exempts that path everywhere', () => {
    // SECTIONS.Files marks packages/x/src/new.ts (new)
    expect(checks(plan('full', {}, 'Then `packages/x/src/new.ts` exports it.'))).toEqual([]);
    const unmarked = SECTIONS.Files!.replace(' (new)', '');
    expect(checks(plan('full', { Files: unmarked }))[0]).toMatch(
      /^path: `packages\/x\/src\/new.ts` does not exist/,
    );
  });

  it('skips what is not a repo path', () => {
    const notPaths =
      '`origin/main` `https://example.com/x` `packages/*.ts` `localNotes/plan.md` `/etc/hosts` `$HOME/x` `pnpm plan-lint` `a/b`';
    expect(checks(plan('full', {}, notPaths))).toEqual([]);
  });

  it('checks an absolute path under the root relative to it', () => {
    expect(checks(plan('full', {}, '`/repo/docs/x.md` and `/repo/docs/gone.md`'))).toEqual([
      'path: `/repo/docs/gone.md` does not exist (a file the change adds: `path` (new))',
    ]);
  });
});

describe('helpers', () => {
  it('cells keep escaped pipes', () => {
    expect(cells('| a | b \\| c | `d` |')).toEqual(['a', 'b | c', '`d`']);
  });

  it('unfence blanks fenced lines, nested longer fences included', () => {
    expect(unfence(['a', '````', '```', 'b', '```', '````', 'c'])).toEqual([
      'a',
      '',
      '',
      '',
      '',
      '',
      'c',
    ]);
  });

  it('searches split on ; before a search only', () => {
    expect(searches('`grep -rn "a;b" docs` → 2; `rg x tools` → 1')).toEqual([
      { command: 'grep -rn "a;b" docs', hits: 2 },
      { command: 'rg x tools', hits: 1 },
    ]);
  });

  it('pathClaims strips anchors and trailing punctuation', () => {
    expect(pathClaims('`docs/x.md#top` `docs/x.md:3.`', tree).map((p) => [p.path, p.from])).toEqual(
      [
        ['docs/x.md', undefined],
        ['docs/x.md', 3],
      ],
    );
  });
});
