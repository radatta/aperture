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
