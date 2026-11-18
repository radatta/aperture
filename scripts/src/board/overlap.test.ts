import { describe, it, expect } from 'vitest';
import { branchFiles, overlaps } from './overlap.ts';

describe('overlaps', () => {
  const trees = [
    {
      branch: 'task-parts',
      files: [
        'app/src/data/seed.ts',
        'app/src/data/stubClient.ts',
        'CLAUDE.md',
        'lambdas/src/x.ts',
      ],
    },
    {
      branch: 'flux',
      files: [
        'app/src/data/seed.ts',
        'app/src/data/stubClient.ts',
        'CLAUDE.md',
        'app/src/Flux.tsx',
      ],
    },
    { branch: 'session-board', files: ['scripts/board/board.sh', 'CLAUDE.md', 'docs/index.md'] },
  ];

  it('finds real overlaps per pair and keeps always-collides apart', () => {
    const o = overlaps(trees);
    expect(o.pairs).toEqual([
      { a: 'flux', b: 'task-parts', files: ['app/src/data/seed.ts', 'app/src/data/stubClient.ts'] },
    ]);
    expect(o.always).toEqual([
      { a: 'flux', b: 'session-board', files: ['CLAUDE.md'] },
      { a: 'flux', b: 'task-parts', files: ['CLAUDE.md'] },
      { a: 'session-board', b: 'task-parts', files: ['CLAUDE.md'] },
    ]);
  });

  it('writes a message for each side, naming the session to message when one is registered', () => {
    const o = overlaps(trees, { flux: 'flux', 'task-parts': 'task-parts' });
    expect(o.messages['task-parts']).toContain(
      'flux also touches 2 of your files: app/src/data/seed.ts, app/src/data/stubClient.ts — SendMessage session `flux`; expect a rebase conflict whichever merges second.',
    );
    expect(o.messages['flux']?.[0]).toMatch(/^task-parts also touches 2 of your files/);
    expect(o.messages['session-board']).toEqual([
      'flux also edits CLAUDE.md — small appends, expect a trivial rebase.',
      'task-parts also edits CLAUDE.md — small appends, expect a trivial rebase.',
    ]);
    expect(overlaps(trees).messages['flux']?.[0]).toMatch(/read its plan;/);
  });

  it('shortens long lists', () => {
    const files = Array.from({ length: 8 }, (_, i) => `app/f${i}.ts`);
    const o = overlaps([
      { branch: 'a', files },
      { branch: 'b', files },
    ]);
    expect(o.messages['a']?.[0]).toMatch(/8 of your files: app\/f0.ts, .*app\/f4.ts, \+3 more/);
  });

  it('says nothing when nothing is shared', () => {
    expect(
      overlaps([
        { branch: 'a', files: ['x'] },
        { branch: 'b', files: ['y'] },
      ]),
    ).toEqual({
      pairs: [],
      always: [],
      messages: {},
    });
  });
});

describe('overlaps with a merge-tree check', () => {
  const none = { conflicts: [], clean: [], landed: [], stale: [], pending: 0 };
  const trees = [
    { branch: 'a', files: ['x.ts', 'y.ts', 'CLAUDE.md'] },
    { branch: 'b', files: ['x.ts', 'CLAUDE.md'] },
    { branch: 'c', files: ['y.ts'], uncommitted: ['y.ts'] },
    { branch: 'gone', files: ['x.ts'] },
    { branch: 'old', files: ['x.ts'] },
  ];

  it('puts conflicts first, keeps landed and stale lanes out, and marks each pair with what git said', () => {
    const o = overlaps(
      trees,
      { b: 'bee' },
      {
        ...none,
        conflicts: [
          { a: 'a', b: 'main', files: ['z.ts'] },
          { a: 'a', b: 'b', files: ['x.ts'] },
        ],
        clean: [['a', 'c']],
        landed: ['gone'],
        stale: ['old'],
      },
    );
    expect(o.pairs).toEqual([
      { a: 'a', b: 'b', files: ['x.ts'], git: 'conflict' },
      { a: 'a', b: 'c', files: ['y.ts'], git: 'unchecked' }, // clean at the heads, but y.ts is uncommitted in c
    ]);
    expect(o.messages['a']).toEqual([
      'merge conflict with main on 1 file: z.ts (git merge-tree) — rebase onto origin/main now.',
      'b will conflict with you on 1 file: x.ts (git merge-tree) — SendMessage session `bee`; whichever merges second rebases.',
      'c also touches 1 of your files: y.ts (uncommitted: git can’t check it yet) — read its plan; expect a rebase conflict whichever merges second.',
    ]); // no "small appends" line for b: the conflict line says it
    expect(o.messages['gone']).toBeUndefined();
    expect(o.messages['old']).toBeUndefined();
    expect(o).toMatchObject({
      landed: ['gone'],
      stale: ['old'],
      uncommitted: [{ branch: 'c', files: ['y.ts'] }],
    });
    expect(o.conflicts).toEqual([
      { a: 'a', b: 'main', files: ['z.ts'] },
      { a: 'a', b: 'b', files: ['x.ts'] },
    ]);
  });

  it('a landed or stale lane picked up again keeps its new, uncommitted edits in the overlap — only those', () => {
    const o = overlaps(
      [
        { branch: 'a', files: ['x.ts', 'y.ts'] },
        { branch: 'gone', files: ['x.ts', 'y.ts'], uncommitted: ['y.ts'] },
        { branch: 'old', files: ['x.ts'], uncommitted: ['x.ts'] },
      ],
      {},
      { ...none, landed: ['gone'], stale: ['old'] },
    );
    expect(o.pairs).toEqual([
      { a: 'a', b: 'gone', files: ['y.ts'], git: 'unchecked' }, // x.ts is gone's landed commit: not news
      { a: 'a', b: 'old', files: ['x.ts'], git: 'unchecked' },
    ]);
    expect(o.messages['gone']).toEqual([
      'a also touches 1 of your files: y.ts (uncommitted: git can’t check it yet) — read its plan; expect a rebase conflict whichever merges second.',
    ]);
  });

  it('says an overlap git merges cleanly is harmless, after the unchecked ones', () => {
    const o = overlaps(
      [
        { branch: 'a', files: ['x.ts', 'y.ts'] },
        { branch: 'b', files: ['x.ts'] },
        { branch: 'c', files: ['y.ts'] },
      ],
      {},
      { ...none, clean: [['a', 'b']], pending: 1 },
    );
    expect(o.pairs.map((p) => p.git)).toEqual(['clean', 'unchecked']); // a ↔ c still pending
    expect(o.messages['a']).toEqual([
      'c also touches 1 of your files: y.ts — read its plan; expect a rebase conflict whichever merges second.',
      'b also touches 1 file: x.ts — git merges both heads cleanly today; recheck after either commits.',
    ]);
    expect(o.pending).toBe(1);
  });

  it('a conflict on files that never overlapped by name still reaches both lanes', () => {
    const o = overlaps(
      [
        { branch: 'a', files: ['old.ts'] },
        { branch: 'b', files: ['new.ts'] },
      ],
      {},
      { ...none, conflicts: [{ a: 'a', b: 'b', files: ['new.ts'] }] },
    );
    expect(o.messages['a']?.[0]).toMatch(/^b will conflict with you on 1 file: new.ts/);
    expect(o.messages['b']?.[0]).toMatch(/^a will conflict with you on 1 file: new.ts/);
  });
});

describe('branchFiles', () => {
  it('unions committed, uncommitted and untracked, minus localNotes/', () => {
    expect(branchFiles('a.ts\nb.ts\n', 'b.ts\nc.ts\n', 'localNotes/plan.md\nd.ts\n\n')).toEqual([
      'a.ts',
      'b.ts',
      'c.ts',
      'd.ts',
    ]);
  });
});
