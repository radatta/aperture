import { describe, expect, it } from 'vitest';
import type { PR } from './gh.ts';
import { agreement, clusters, phaseAt, timeline } from './phases.ts';
import { attribute, overhead, POST_MS, prTable, prType, type PRRow } from './prs.ts';
import { concurrency, reviewRounds, roundVerdicts } from './questions.ts';
import { parsePhaseLog } from './phaselog.ts';
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

  it('takes ready as local up to review, and skips it from dev on, as the CLI refuses it there', () => {
    const t = timeline([
      mk(1, 'lane-phase', { phase: 'review' }),
      mk(2, 'lane-phase', { phase: 'local', alias: true }),
      mk(3, 'lane-phase', { phase: 'pr' }),
      mk(4, 'lane-phase', { phase: 'local', alias: true }), // refused: the lane stayed at pr
      mk(5, 'lane-phase', { phase: 'local' }), // the real name still goes back
    ]);
    expect([2, 4, 5].map((n) => phaseAt(t, min(n) + 1))).toEqual(['local', 'pr', 'local']);
  });

  it('leaves calls before the first marker unattributed unless planning came first', () => {
    const t = timeline([mk(5, 'edit', { cls: 'src' })]);
    expect(phaseAt(t, min(1))).toBe('unattributed');
    expect(phaseAt(timeline([]), min(1))).toBe('unattributed');
  });

  it('keeps heuristics until the first explicit marker that names a phase', () => {
    const t = timeline([
      mk(1, 'lane-phase', { phase: 'parked' }),
      mk(2, 'plan'),
      mk(5, 'lane-phase', { phase: 'build' }),
    ]);
    expect(phaseAt(t, min(3))).toBe('plan');
    expect(phaseAt(t, min(6))).toBe('build');
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
    // a first marker that maps to no phase (parked) doesn't start the comparison
    const parked = [
      mk(1, 'lane-phase', { phase: 'parked' }),
      mk(10, 'lane-phase', { phase: 'plan' }),
      mk(11, 'plan'),
    ];
    expect(agreement(parked, calls)).toEqual({ agree: 1, total: 1 });
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
    // a lane whose PR merged only in the lookback (not in the table): merged up to its post window, after that a
    // reused name is new work. `win` stands in for another lane's PR that sets the overhead window.
    const win = [{ branch: 'lane-x', qu: 1, start: min(0), mergedAt: min(10_000) } as PRRow];
    const unmergedQU = (p: PR[]) =>
      overhead(a, win, p).unmerged.find((u) => u.lane === 'lane-a')?.qu ?? 0;
    expect(unmergedQU([prs[0]!])).toBeCloseTo(20); // only c4, past the post window
    const early = [{ ...prs[0]!, mergedAt: min(-POST_MS / 60_000 - 100) }];
    expect(unmergedQU(early)).toBeCloseTo(140); // all seven lane-a calls
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

describe('lens-regime PR rows', () => {
  const P = '-workspace--claude-worktrees-lane-b';
  const spawned = (n: number, agentType: string) => mk(n, 'spawn', { agentType });
  const sub = (id: string, agentType: string, model: string, n: number, o = 1_000_000): Shard => ({
    s: {
      rel: `${P}/${SID}/subagents/agent-${id}.jsonl`,
      project: P,
      sid: SID,
      kind: 'subagent',
      agentId: id,
      agentType,
    },
    calls: [call(`${id}-1`, n, o, { model })],
    markers: [],
  });
  const main: Shard = {
    s: {
      rel: `${P}/${SID}.jsonl`,
      project: P,
      sid: SID,
      kind: 'main',
      cwd: '/workspace/.claude/worktrees/lane-b',
    },
    calls: [call('m1', 1, 0, { cr: 100_000, cw5: 50_000 }), call('m2', 30, 0, { cr: 300_000 })],
    markers: [
      mk(0, 'plan'),
      spawned(20, 'code-reviewer'),
      mk(20, 'review'), // the old marker beside its spawn: one round
      spawned(22, 'review-correctness'),
      spawned(25, 'review-tests'),
      spawned(60, 'review-fixes'), // a recheck is a round of its own
      spawned(100, 'review-fixes'),
      spawned(105, 'general-purpose'), // not a review lens
    ],
  };
  const shards = [
    main,
    sub('c', 'review-correctness', 'claude-opus-5-5', 23),
    sub('t', 'review-tests', 'claude-sonnet-5-5', 26, 500_000),
    sub('f1', 'review-fixes', 'claude-opus-5-5', 61),
    sub('f2', 'review-fixes', 'claude-opus-5-5', 101),
  ];
  const pr: PR = {
    number: 11,
    title: 't',
    branch: 'lane-b',
    mergedAt: min(200),
    changedFiles: 2,
    additions: 30,
    deletions: 3,
    files: ['app/src/x.ts', 'docs/y.md'],
  };

  it('counts lens spawns and fix rechecks as rounds, and reads ui from the paths', () => {
    const [row] = prTable(attribute(loadShards(shards), 'hub'), [pr], min(-1000));
    expect(row).toMatchObject({ rounds: 3, rechecks: 2, ui: true, lensRegime: true, turns: 2 });
    expect(row!.roundStarts).toEqual([min(20), min(60), min(100)]);
    const [noUi] = prTable(
      attribute(loadShards(shards), 'hub'),
      [{ ...pr, files: ['scripts/a.ts'] }],
      min(-1000),
    );
    expect(noUi!.ui).toBe(false);
    const [ext] = prTable(
      attribute(loadShards(shards), 'hub'),
      [{ ...pr, changedFiles: 1, files: ['extension/Shared/a.js'] }],
      min(-1000),
    );
    expect(ext).toMatchObject({ ui: true, filesCut: false });
    const [cut] = prTable(
      attribute(loadShards(shards), 'hub'),
      [{ ...pr, changedFiles: 120, files: Array.from({ length: 100 }, (_, i) => `s/${i}.ts`) }],
      min(-1000),
    );
    expect(cut!.filesCut).toBe(true); // gh lists 100 at most
  });

  it('counts a recheck once when a fork copied its spawn, and a recheck-only lane is in the regime', () => {
    const copy = (n: number, id: string) =>
      mk(n, 'spawn', { agentType: 'review-fixes', toolUseId: id });
    const forked: Shard = {
      ...main,
      markers: [mk(0, 'plan'), copy(60, 'tu1'), copy(60, 'tu1'), copy(100, 'tu2')],
    };
    const only = [forked, sub('f1', 'review-fixes', 'claude-opus-5-5', 61)];
    const [row] = prTable(attribute(loadShards(only), 'hub'), [pr], min(-1000));
    expect(row).toMatchObject({ rechecks: 2, lensRegime: true });
  });

  it('lists each agent run with its type and model, and sums the main session apart', () => {
    const [row] = prTable(attribute(loadShards(shards), 'hub'), [pr], min(-1000));
    expect(row!.runs.map((r) => [r.agentType, r.model, Math.round(r.qu)]).sort()).toEqual([
      ['review-correctness', 'claude-opus-5-5', 20],
      ['review-fixes', 'claude-opus-5-5', 20],
      ['review-fixes', 'claude-opus-5-5', 20],
      ['review-tests', 'claude-sonnet-5-5', 5], // sonnet 5.5 output: $10 per MTok
    ]);
    // m1: 100k read at 0.2 + 50k written at 5 per MTok; m2: 300k read
    expect(row!.mainQU).toBeCloseTo(0.02 + 0.25 + 0.06);
    expect(row!.ctxSumM).toBeCloseTo(0.45);
    const [plain] = prTable(
      attribute(loadShards([main, sub('g', 'general-purpose', 'claude-opus-5-5', 23)]), 'hub'),
      [pr],
      min(-1000),
    );
    expect(plain!.lensRegime).toBe(false);
  });

  it("splits each call's QU into re-read, ingest and output, summing to its QU", () => {
    const a = attribute(loadShards(shards), 'hub');
    const m1 = a.calls.find((c) => c.ts === min(1))!;
    expect(m1.parts.reread).toBeCloseTo(0.02);
    expect(m1.parts.ingest).toBeCloseTo(0.25);
    expect(m1.parts.output).toBe(0);
    expect(m1.ctx).toBe(150_000);
    for (const c of a.calls)
      expect(c.parts.reread + c.parts.ingest + c.parts.output).toBeCloseTo(c.qu, 10);
  });
});

describe('the phase log', () => {
  const P = '-workspace--claude-worktrees-lane-c';
  const main = (markers: Marker[] = []): Shard => ({
    s: {
      rel: `${P}/${SID}.jsonl`,
      project: P,
      sid: SID,
      kind: 'main',
      cwd: '/workspace/.claude/worktrees/lane-c',
    },
    calls: [call('p1', 10, 1000), call('p2', 30, 1000), call('p3', 60, 1000), call('p4', 90, 1000)],
    markers,
  });
  const row = (lane: string, to: string | null, n: number, from: string | null = null) =>
    JSON.stringify({ v: 1, lane, from, to, ts: new Date(min(n)).toISOString(), pct: 12 });

  it('parses rows, dropping torn, foreign and repeated ones', () => {
    const text = [
      row('lane-c', 'build', 20),
      row('lane-c', 'build', 20), // the logger lost its state: said again
      '{"v":1,"lane":"lane-c","to":"bu',
      row('Lane_C', 'gate', 25),
      row('lane-c', 'shipping', 25),
      JSON.stringify({ v: 2, lane: 'lane-c', to: 'gate', ts: new Date(min(26)).toISOString() }),
      row('lane-c', 'gate', 30, 'shipping'), // a foreign from: the row stands, from null
      row('lane-c', null, 99, 'pr'),
      row('lane-c', null, 100, 'pr'), // the logger couldn't save its state: the removal repeats
      row('lane-c', 'plan', 120),
      row('lane-c', null, 130, 'plan'), // gone again after a sighting: a removal of its own
    ].join('\n');
    expect(parsePhaseLog(text)).toEqual([
      { lane: 'lane-c', from: null, to: 'build', ts: min(20), pct: 12 },
      { lane: 'lane-c', from: null, to: 'gate', ts: min(30), pct: 12 },
      { lane: 'lane-c', from: 'pr', to: null, ts: min(99), pct: 12 },
      { lane: 'lane-c', from: null, to: 'plan', ts: min(120), pct: 12 },
      { lane: 'lane-c', from: 'plan', to: null, ts: min(130), pct: 12 },
    ]);
  });

  it("opens a resumed session at the lane's last logged phase, not after a removal", () => {
    const second = (markers: Marker[] = []): Shard => {
      const m = main(markers);
      return {
        ...m,
        s: { ...m.s, sid: 'cafe0000-0000-4000-8000-000000000000', rel: `${P}/cafe.jsonl` },
        calls: m.calls.map((c) => ({ ...c, id: `${c.id}b`, ts: c.ts + min(300) - min(0) })),
      };
    };
    const log = parsePhaseLog(
      [
        row('lane-c', 'review', 50),
        row('lane-c', null, 200, 'review'),
        row('lane-c', 'dev', 280),
      ].join('\n'),
    );
    const a = attribute(loadShards([main(), second()]), 'hub', log);
    const at = (n: number) =>
      a.calls.filter((c) => c.ts === min(n)).map((c) => [c.phase, c.phaseSrc]);
    expect(at(60)).toEqual([['review', 'log']]);
    expect(at(310)).toEqual([['dev', 'log']]); // the second session, no row in its span: opens at dev
    // a removal before the span opens nothing
    const gone = parsePhaseLog(
      [row('lane-c', 'review', 50), row('lane-c', null, 200, 'review')].join('\n'),
    );
    expect(attribute(loadShards([second()]), 'hub', gone).calls[0]!.phaseSrc).toBe('none');
  });

  it('drives a track that has no transcript markers, inside its span only', () => {
    const log = parsePhaseLog(
      [
        row('lane-c', 'gate', 1), // before the span's first call less the slack: another session's
        row('lane-c', 'plan', 9), // inside the slack
        row('lane-c', 'review', 50),
        row('lane-c', 'gate', 200), // after the span
        row('lane-d', 'pr', 55), // another lane
      ].join('\n'),
    );
    const a = attribute(loadShards([main()]), 'hub', log);
    const ph = (n: number) => a.calls.find((c) => c.ts === min(n))!;
    expect([10, 30, 60, 90].map((n) => ph(n).phase)).toEqual(['plan', 'plan', 'review', 'review']);
    expect(ph(60).phaseSrc).toBe('log');
    // without the log the same track is unattributed
    expect(attribute(loadShards([main()]), 'hub').calls.map((c) => c.phaseSrc)).toEqual([
      'none',
      'none',
      'none',
      'none',
    ]);
  });

  it('counts as explicit: heuristics give way from the first logged phase on', () => {
    const shard = main([mk(5, 'plan'), mk(20, 'edit', { cls: 'src' }), mk(70, 'gate')]);
    const a = attribute(loadShards([shard]), 'hub', parsePhaseLog(row('lane-c', 'review', 50)));
    const ph = (n: number) => a.calls.find((c) => c.ts === min(n))!;
    expect([ph(10).phase, ph(10).phaseSrc]).toEqual(['plan', 'heuristic']);
    expect([ph(30).phase, ph(30).phaseSrc]).toEqual(['build', 'heuristic']);
    expect([ph(90).phase, ph(90).phaseSrc]).toEqual(['review', 'log']); // the gate marker after it is ignored
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
        // merged two days on, with no lane call that day: its merge still counts
        {
          number: 2,
          title: '',
          branch: 'l2',
          mergedAt: min(2 * 24 * 60),
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
      expect.objectContaining({
        day: '2026-01-07',
        meanLanes: 0,
        laneHours: 0,
        merged: 1,
        perLaneHour: NaN,
      }),
    ]);
    expect(c.slowdown).toEqual([{ cls: 'lint', n: 6, pctPerLane: expect.closeTo(10, 6) }]);
  });
});
