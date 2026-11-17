import { describe, expect, it } from 'vitest';
import type { PR } from './gh.ts';
import { agreement, clusters, phaseAt, timeline } from './phases.ts';
import { attribute, overhead, POST_MS, prTable, prType } from './prs.ts';
import { concurrency, reviewRounds, roundVerdicts } from './questions.ts';
import { loadShards, type Shard } from './store.ts';
import type { Call, Marker } from './transcript.ts';
import { SID, SID2 } from './fixtures.ts';

const T0 = Date.parse('2026-01-05T10:00:00Z');
const min = (n: number) => T0 + n * 60_000;
const mk = (n: number, kind: Marker['kind'], extra: Partial<Marker> = {}): Marker => ({
  ts: min(n),
  kind,
  ...extra,
});
const call = (id: string, n: number, o = 1_000_000, extra: Partial<Call> = {}): Call => ({
  id,
  ts: min(n),
  model: 'claude-opus-5-5',
  i: 0,
  cw5: 0,
  cw1: 0,
  cr: 0,
  o, // Opus 5.5 output: $20 per MTok, so 1e6 → 20 QU
  fast: false,
  unsplit: false,
  ...extra,
});

describe('phase timeline', () => {
  it('moves forward on heuristics: plan → build on a src edit → gate → review → dev → pr', () => {
    const t = timeline([
      mk(1, 'plan'),
      mk(5, 'edit', { cls: 'src' }),
      mk(10, 'gate'),
      mk(12, 'edit', { cls: 'src' }), // red gate fix: back to build
      mk(15, 'gate'),
      mk(20, 'review'),
      mk(25, 'edit', { cls: 'src' }), // a review fix stays review
      mk(26, 'gate'),
      mk(30, 'devcheck'),
      mk(40, 'pr'),
    ]);
    expect(t.map((s) => s.phase)).toEqual([
      'plan',
      'build',
      'gate',
      'build',
      'gate',
      'review',
      'dev',
      'pr',
    ]);
    expect(phaseAt(t, min(0))).toBe('plan'); // before the first marker, planning came first
    expect(phaseAt(t, min(27))).toBe('review');
  });

  it('lets explicit `pnpm board lane` markers win from the first one on', () => {
    const t = timeline([
      mk(1, 'plan'),
      mk(2, 'lane-phase', { phase: 'build' }),
      mk(3, 'review'), // ignored: after an explicit marker
      mk(4, 'lane-phase', { phase: 'parked' }), // keeps build
      mk(5, 'lane-phase', { phase: 'merged' }),
    ]);
    expect(t.map((s) => s.phase)).toEqual(['plan', 'build', 'post']);
    expect(phaseAt(t, min(4.5))).toBe('build');
  });

  it('leaves calls before the first marker unattributed unless planning came first', () => {
    const t = timeline([mk(5, 'edit', { cls: 'src' })]);
    expect(phaseAt(t, min(1))).toBe('unattributed');
    expect(phaseAt(timeline([]), min(1))).toBe('unattributed');
  });

  it('starts a new cycle when a Plan runs after the PR step', () => {
    const t = timeline([mk(1, 'plan'), mk(2, 'pr'), mk(3, 'plan'), mk(4, 'edit', { cls: 'src' })]);
    expect(phaseAt(t, min(4))).toBe('build');
  });

  it('clusters review markers into rounds by gaps from the previous marker', () => {
    const ms = [
      mk(0, 'review'),
      mk(8, 'review'),
      mk(16, 'review'),
      mk(40, 'review'),
      mk(41, 'gate'),
    ];
    expect(clusters(ms, ['review'], 10)).toEqual([min(0), min(40)]);
  });

  it('scores heuristic vs explicit agreement only from the first explicit marker on', () => {
    const ms = [
      mk(0, 'plan'),
      mk(10, 'lane-phase', { phase: 'build' }),
      mk(11, 'edit', { cls: 'src' }),
    ];
    expect(
      agreement(ms, [
        { ts: min(5), qu: 9 },
        { ts: min(12), qu: 1 },
      ]),
    ).toEqual({ agree: 1, total: 1 });
    expect(agreement([mk(0, 'plan')], [])).toBeNull();
    // a lane that writes `plan` first: its timeline starts at -Infinity, the comparison still at the marker
    const lead = [mk(10, 'lane-phase', { phase: 'plan' }), mk(11, 'plan')];
    const calls = [
      { ts: min(5), qu: 9 },
      { ts: min(12), qu: 1 },
    ];
    expect(agreement(lead, calls)).toEqual({ agree: 1, total: 1 });
  });
});

describe('PR typing', () => {
  const pr = (files: string[], changedFiles = files.length) => ({ files, changedFiles });
  it('takes the first matching rule', () => {
    expect(prType(pr(['docs/a.md', 'README.md']))).toBe('research');
    expect(prType(pr(['app/x.ts']), 0.6)).toBe('research');
    expect(prType(pr(['scripts/a.ts', 'cdk/b.ts', 'app/c.ts']))).toBe('infra-ci');
    expect(prType(pr(['scripts/a.ts', 'app/c.ts']))).toBe('small-fix'); // exactly half is not over half
    expect(prType(pr(Array.from({ length: 7 }, (_, i) => `app/${i}.ts`)))).toBe('small-fix');
    expect(prType(pr(Array.from({ length: 8 }, (_, i) => `app/${i}.ts`)))).toBe('feature');
  });
});

describe('attribution and the PR table', () => {
  const P = '-workspace--claude-worktrees-lane-a';
  const shard = (
    rel: string,
    s: Partial<Shard['s']>,
    calls: Call[],
    markers: Marker[] = [],
  ): Shard => ({
    s: { rel, project: P, sid: SID, kind: 'main', ...s },
    calls,
    markers,
  });
  const main = shard(
    `${P}/${SID}.jsonl`,
    { cwd: '/workspace/.claude/worktrees/lane-a', name: 'lane-a' },
    [call('c1', 1), call('c2', 30), call('c3', 200), call('c4', 200 + POST_MS / 60_000 + 10)],
    [mk(0, 'plan'), mk(20, 'review'), mk(25, 'local'), mk(26, 'devcheck'), mk(100, 'pr')],
  );
  const sub = shard(
    `${P}/${SID}/subagents/agent-r1.jsonl`,
    { kind: 'subagent', agentId: 'r1', agentType: 'code-reviewer' },
    [call('s1', 21), call('s2', 22)],
  );
  const hub = shard(
    `-workspace/${SID2}.jsonl`,
    { project: '-workspace', sid: SID2, name: 'hub', cwd: '/workspace' },
    [
      call('h1', 50, 500_000, { lane: 'lane-a' }), // the hub cd'ing into a worktree stays the hub
    ],
  );
  const adhoc = shard(
    `-workspace/00000000-0000-4000-8000-000000000003.jsonl`,
    { project: '-workspace', sid: '00000000-0000-4000-8000-000000000003', cwd: '/workspace' },
    [call('a1', 60, 1_000_000, { lane: 'lane-a' }), call('a2', 61)], // an older lane run from the main checkout
  );
  const other = shard(
    `-home-x-other/${SID2}.jsonl`,
    { project: '-home-x-other', sid: SID2, cwd: '/home/x/other' },
    [call('o1', 70, 1_000_000, { lane: 'lane-a' })], // another repo on a branch of the same name
  );
  const a = attribute(loadShards([main, sub, hub, adhoc, other]), 'hub');
  const prs: PR[] = [
    {
      number: 7,
      title: 't',
      branch: 'lane-a',
      mergedAt: min(200),
      changedFiles: 9,
      additions: 10,
      deletions: 5,
      files: [],
    },
    {
      number: 6,
      title: 'old',
      branch: 'lane-z',
      mergedAt: min(-10_000),
      changedFiles: 1,
      additions: 1,
      deletions: 1,
      files: [],
    },
  ];

  it('charges subagents to the parent phase at their first call, and keeps the hub the hub', () => {
    const byId = (n: number) => a.calls.find((c) => c.ts === min(n))!;
    expect(byId(21)).toMatchObject({
      lane: 'lane-a',
      role: 'lane',
      phase: 'review',
      kind: 'subagent',
    });
    expect(byId(22).phase).toBe('review');
    expect(byId(50)).toMatchObject({ role: 'hub', lane: null });
    expect(byId(60)).toMatchObject({ role: 'lane', lane: 'lane-a' });
    expect(byId(61)).toMatchObject({ role: 'adhoc' });
    expect(byId(70)).toMatchObject({ role: 'other', lane: null });
  });

  it('rolls calls into the PR, post-merge up to POST_MS, with phases summing to the total', () => {
    const [row] = prTable(a, prs, min(-1000));
    expect(row).toMatchObject({
      number: 7,
      type: 'feature',
      turns: 4,
      subagents: 1,
      rounds: 1,
      localRuns: 1,
      devRuns: 1,
    });
    // c1 c2 c3 s1 s2 a1 = 6 × 20 QU; c4 is past the post window
    expect(row!.qu).toBeCloseTo(120);
    const phases = Object.values(row!.byPhase).reduce((x, y) => x + y, 0);
    expect(phases).toBeCloseTo(row!.qu);
    expect(row!.byPhase.post).toBeUndefined(); // c3 sits exactly at the merge
  });

  it('spreads the hub over merged PRs and lists ad hoc work apart', () => {
    const rows = prTable(a, prs, min(-1000));
    const o = overhead(a, rows);
    expect(o.hubQU).toBeCloseTo(10);
    expect(o.perPR).toBeCloseTo(10);
    expect(o.adhocQU).toBeCloseTo(20);
    expect(o.otherQU).toBeCloseTo(20);
  });

  it('gives a branch with two PRs each its own window', () => {
    const two: PR[] = [
      { ...prs[0]!, number: 8, mergedAt: min(25) },
      { ...prs[0]!, number: 9, mergedAt: min(200) },
    ];
    const rows = prTable(a, two, min(-1000));
    expect(rows.map((r) => [r.number, Math.round(r.qu)])).toEqual([
      [8, 60], // c1 s1 s2
      [9, 60], // c2 a1 c3
    ]);
  });
});

describe('measure-first questions', () => {
  it('reads round verdicts from report prose', () => {
    const v = roundVerdicts(
      [
        '- **Round 1:** 0 bugs; 4 nits taken',
        '- **Round 2: 3 Sev 2.**',
        '- Round 3 was clean.',
        '- Round 4: reviewer found 2 bugs',
        '- Round 1 full pass: screenshots/round-1/',
      ].join('\n'),
    );
    expect([...v]).toEqual([
      [1, 'clean'],
      [2, 'real'],
      [3, 'clean'],
      [4, 'real'],
    ]);
  });

  it('measures each review round: QU, src fixes and report verdicts', () => {
    const P = '-workspace--claude-worktrees-lane-b';
    const sh: Shard = {
      s: {
        rel: `${P}/${SID}.jsonl`,
        project: P,
        sid: SID,
        kind: 'main',
        cwd: '/workspace/.claude/worktrees/lane-b',
      },
      calls: [call('r1', 1), call('r2', 31), call('r3', 32)],
      markers: [
        mk(0, 'review'),
        mk(2, 'edit', { cls: 'src' }),
        mk(30, 'review'),
        mk(40, 'devcheck'),
      ],
    };
    const a = attribute(loadShards([sh]), 'hub');
    const rows = prTable(
      a,
      [
        {
          number: 1,
          title: '',
          branch: 'lane-b',
          mergedAt: min(60),
          changedFiles: 2,
          additions: 1,
          deletions: 1,
          files: [],
        },
      ],
      0,
    );
    const r = reviewRounds(
      a,
      rows,
      new Map([['lane-b', 'Round 1: found 1 bug\nRound 2: no bugs']]),
    );
    expect(r.parsed).toBe(1);
    expect(
      r.rounds.map((x) => [
        x.round,
        x.lanes,
        Math.round(x.medianQU),
        x.srcShare,
        x.reportReal,
        x.reportClean,
      ]),
    ).toEqual([
      [1, 1, 20, 1, 1, 0],
      [2, 1, 40, 0, 0, 1],
    ]);
  });

  it('relates daily concurrency to merges, and heavy.sh wall time to load', () => {
    const P = (l: string) => `-workspace--claude-worktrees-${l}`;
    const shards: Shard[] = ['l1', 'l2'].map((l, i) => ({
      s: {
        rel: `${P(l)}/${SID}.jsonl`,
        project: P(l),
        sid: SID,
        kind: 'main',
        cwd: `/workspace/.claude/worktrees/${l}`,
      },
      calls: [call(`${l}-1`, i * 5)],
      markers: [],
    }));
    const a = attribute(loadShards(shards), 'hub');
    const rows = prTable(
      a,
      [
        {
          number: 1,
          title: '',
          branch: 'l1',
          mergedAt: min(30),
          changedFiles: 1,
          additions: 1,
          deletions: 1,
          files: [],
        },
      ],
      0,
    );
    const ev = Array.from({ length: 6 }, (_, i) => ({
      t: new Date(min(i)).toISOString(),
      kind: 'job',
      class: 'lint',
      exit: 0,
      wallSec: 10 * 1.1 ** i,
      mix: { working: i, heavy: 0 },
    }));
    const c = concurrency(a, rows, ev, 0);
    expect(c.days).toEqual([
      expect.objectContaining({
        day: '2026-01-05',
        meanLanes: 2,
        maxLanes: 2,
        laneHours: 2,
        merged: 1,
      }),
    ]);
    expect(c.slowdown).toEqual([{ cls: 'lint', n: 6, pctPerLane: expect.closeTo(10, 6) }]);
  });
});
