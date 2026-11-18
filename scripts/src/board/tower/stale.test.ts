import { describe, expect, it } from 'vitest';
import type { LaneFile } from './lanes.ts';
import type { PlanRow } from './plan.ts';
import type { Pr } from './prs.ts';
import type { Lane, QueueData } from './queue.ts';
import {
  boardLine,
  boardTone,
  formatStale,
  staleFile,
  staleItems,
  type Board,
  type StaleInputs,
  type StaleItem,
} from './stale.ts';

const NOW = Date.parse('2026-11-17T20:00:00Z');
const MIN = 60000;

const lane = (over: Partial<Lane> = {}): Lane => ({
  branch: 'echo',
  session: null,
  state: 'waiting',
  slot: 'dev',
  pr: null,
  eta: null,
  waitingOn: null,
  note: null,
  hold: null,
  ...over,
});
const pr = (over: Partial<Pr> = {}): Pr => ({
  number: 50,
  title: 'A change',
  branch: 'echo',
  state: 'OPEN',
  mergedAt: null,
  createdAt: NOW - 60 * MIN,
  sha: null,
  mergeSha: null,
  url: null,
  draft: false,
  ...over,
});
const merged = (n: number, branch: string, at = NOW - 10 * MIN) =>
  pr({ number: n, branch, state: 'MERGED', mergedAt: at });
const laneFile = (over: Partial<LaneFile> = {}): LaneFile => ({
  branch: 'echo',
  session: null,
  phase: 'build',
  step: null,
  phaseSince: NOW - 3 * 86400e3,
  sha: null,
  pr: null,
  slot: null,
  needs: null,
  updatedAt: NOW - 3 * 86400e3,
  files: null,
  plan: null,
  eta: null,
  ...over,
});
const queue = (over: Partial<QueueData> = {}): QueueData => ({
  updatedAt: NOW - 5 * MIN,
  devQueue: [],
  maintainer: [],
  wave: null,
  deadRows: null,
  plan: [],
  planNotes: [],
  planAt: NOW - 3600e3,
  followups: [],
  mergeOrder: [],
  ...over,
});

function run(over: Partial<StaleInputs> = {}): StaleItem[] {
  const prs = over.prs ?? [];
  return staleItems({
    now: NOW,
    queue: queue(),
    problems: [],
    rows: new Map(),
    prs,
    mergedAt: (n) => prs.find((p) => p.number === n && p.state === 'MERGED')?.mergedAt ?? null,
    lanes: [],
    liveHolder: () => null,
    ghOk: true,
    locksOk: true,
    table: [],
    staleFollowups: [],
    ...over,
  });
}
const kinds = (xs: StaleItem[]) => xs.map((x) => x.kind);

describe('staleItems', () => {
  it('nothing contradicted: no items', () => {
    expect(run({ queue: queue({ devQueue: [lane()] }) })).toEqual([]);
  });

  it('a queue lane whose derived row has merged: one item, nothing else about it', () => {
    const items = run({
      queue: queue({ devQueue: [lane({ state: 'on-dev' })] }),
      rows: new Map([['echo', { state: 'DONE', pr: { number: 60 } }]]),
      prs: [merged(60, 'echo')],
    });
    expect(items).toEqual([
      expect.objectContaining({ kind: 'queue-merged', branch: 'echo', since: NOW - 10 * MIN }),
    ]);
  });

  it('lock facts count only from a fresh lock read', () => {
    const q = queue({ devQueue: [lane({ state: 'on-dev' }), lane({ branch: 'fox' })] });
    const holder = (b: string) => (b === 'fox' ? ('devb' as const) : null);
    expect(kinds(run({ queue: q, liveHolder: holder }))).toEqual(['queue-state', 'queue-state']);
    expect(run({ queue: q, liveHolder: holder, locksOk: false })).toEqual([]);
  });

  it('PR facts count only from a fresh PR list', () => {
    const q = queue({
      devQueue: [
        lane({ state: 'building', pr: 49 }),
        lane({ branch: 'fox', state: 'ready' }),
        lane({ branch: 'golf', state: 'next' }),
      ],
    });
    const prs = [pr(), pr({ number: 51, branch: 'golf', draft: true })];
    const items = run({ queue: q, prs });
    expect(items.map((x) => [x.kind, x.branch])).toEqual([
      ['queue-state', 'echo'], // building with PR 50 open
      ['queue-pr', 'echo'], // names 49, its open PR is 50
      ['queue-state', 'fox'], // ready with no open PR
    ]); // golf's PR is a draft: still building
    expect(run({ queue: q, prs, ghOk: false })).toEqual([]);
  });

  it('a waitingOn that names a merge which has happened; a date never', () => {
    const q = queue({
      devQueue: [
        lane({ waitingOn: 'hotel merges (server card removal)' }),
        lane({ branch: 'fox', waitingOn: 'PR 70' }),
        lane({ branch: 'golf', waitingOn: '2026-11-17 morning' }),
        lane({ branch: 'india', waitingOn: 'BEHIND lc-coach; mode?' }),
      ],
    });
    const items = run({ queue: q, prs: [merged(61, 'hotel', NOW - 50 * MIN)] });
    expect(items.map((x) => [x.kind, x.branch, x.since])).toEqual([
      ['waiting-on', 'echo', NOW - 50 * MIN],
    ]);
    expect(kinds(run({ queue: q, prs: [merged(70, 'x')] }))).toEqual(['waiting-on']);
  });

  it("a plan row the tower struck that dispatch hasn't; an old or missing planAt", () => {
    const hand = { at: NOW - 60 * MIN, what: 'Merge PR 9', kind: 'merge' as const, who: null };
    const p = { you: null, eta: null, lane: null, done: false, doneAt: null, ...hand };
    const row = { ...p, done: true, doneAt: NOW - 40 * MIN } as PlanRow;
    expect(run({ queue: queue({ plan: [p] }), table: [row] })).toEqual([
      expect.objectContaining({ kind: 'plan-done', since: NOW - 40 * MIN }),
    ]);
    // dispatch already marked it: nothing
    expect(run({ queue: queue({ plan: [{ ...p, done: true }] }), table: [row] })).toEqual([]);
    expect(kinds(run({ queue: queue({ plan: [p], planAt: NOW - 7 * 3600e3 }) }))).toEqual([
      'plan-age',
    ]);
    expect(kinds(run({ queue: queue({ plan: [p], planAt: null }) }))).toEqual(['plan-age']);
    // every row done: an old plan is fine
    expect(run({ queue: queue({ plan: [{ ...p, done: true }], planAt: null }) })).toEqual([]);
  });

  it('a landed mergeOrder entry; a wave item whose PR merged', () => {
    const q = queue({
      mergeOrder: [
        { branch: 'echo', pr: null, note: null },
        { branch: 'fox', pr: 80, note: null },
      ],
      wave: {
        name: 'W',
        items: [
          { branch: 'golf', state: 'open', pr: 80, session: null, title: null },
          { branch: 'hotel', state: 'merged', pr: 80, session: null, title: null },
        ],
      },
    });
    const items = run({ queue: q, prs: [merged(60, 'echo'), merged(80, 'fox')] });
    expect(items.map((x) => [x.kind, x.branch])).toEqual([
      ['merge-order', 'echo'],
      ['merge-order', 'fox'],
      ['wave', 'golf'],
    ]);
  });
  it('a reused branch name: an old merge on it is a namesake, not this lane (no PR number, no lane file)', () => {
    const old = merged(201, 'echo', NOW - 3 * 86400e3);
    const q = queue({
      devQueue: [lane({ waitingOn: 'echo merges' })],
      mergeOrder: [{ branch: 'echo', pr: null, note: null }],
    });
    expect(run({ queue: q, prs: [old] })).toEqual([]);
    // a merge under a day old on the name still counts
    expect(kinds(run({ queue: q, prs: [merged(201, 'echo', NOW - 2 * 3600e3)] }))).toEqual([
      'waiting-on',
      'merge-order',
    ]);
    // "+ 1 day" after a recent merge fires once its day is up
    const later = queue({ devQueue: [lane({ waitingOn: 'echo merges + 1 day' })] });
    expect(kinds(run({ queue: later, prs: [merged(201, 'echo', NOW - 25 * 3600e3)] }))).toEqual([
      'waiting-on',
    ]);
    // a derived row (its lane file dates the lane) decides: its open PR is no landing
    const rows = new Map([['echo', { state: 'PR', pr: { number: 230 } }]]);
    const open = pr({ number: 230 });
    expect(run({ queue: queue({ mergeOrder: q.mergeOrder }), rows, prs: [old, open] })).toEqual([]);
    // the orphan-lane rule still looks past a day: that is its point
    expect(kinds(run({ lanes: [laneFile({ phase: 'merged' })], prs: [old] }))).toEqual([
      'orphan-lane',
    ]);
  });

  it('an autoStart lane that has started (a lane file, or an open PR while gh is fresh)', () => {
    const q = queue({ autoStart: ['echo', 'fox', 'golf'] });
    const items = run({
      queue: q,
      lanes: [laneFile()],
      prs: [pr({ branch: 'fox' })],
    });
    expect(items.map((x) => x.branch)).toEqual(['echo', 'fox']);
    expect(
      run({ queue: q, lanes: [laneFile()], prs: [pr({ branch: 'fox' })], ghOk: false }).map(
        (x) => x.branch,
      ),
    ).toEqual(['echo']);
  });

  it('a lane file over a day past its merge, never ended', () => {
    const old = merged(60, 'echo', NOW - 2 * 86400e3);
    expect(run({ lanes: [laneFile()], prs: [old] })).toEqual([
      expect.objectContaining({ kind: 'orphan-lane', fix: 'pnpm lanes end echo' }),
    ]);
    // under a day: not yet
    expect(run({ lanes: [laneFile()], prs: [merged(60, 'echo', NOW - 3600e3)] })).toEqual([]);
    // a new lane on the reused name, begun after the merge
    expect(run({ lanes: [laneFile({ phaseSince: NOW - 3600e3 })], prs: [old] })).toEqual([]);
  });

  it('stale follow-ups and a bad queue write are items too', () => {
    const items = run({
      staleFollowups: [{ id: 'F1', what: 'thing', since: NOW - 2 * 86400e3 }],
      problems: ['plan[3]: no what', 'x'],
    });
    expect(items.map((x) => [x.kind, x.what])).toEqual([
      ['followup', 'F1: thing'],
      ['queue-bad', 'queue.json: plan[3]: no what (+1 more)'],
    ]);
  });
});

describe('boardTone', () => {
  const it1 = (since: number | null): StaleItem => ({
    kind: 'plan-done',
    what: 'x',
    fix: 'y',
    branch: null,
    since,
  });
  it('dim with none, amber with some or unsure, red at 5, one over 30 min, or a failed sync', () => {
    expect(boardTone([], null, NOW).tone).toBe('dim');
    expect(boardTone([], 'gh PRs stale', NOW).tone).toBe('warn');
    expect(boardTone([it1(NOW - 10 * MIN)], null, NOW).tone).toBe('warn');
    expect(boardTone([it1(null)], null, NOW).tone).toBe('warn');
    expect(boardTone([it1(NOW - 31 * MIN)], null, NOW)).toMatchObject({ tone: 'bad' });
    expect(boardTone(Array(5).fill(it1(null)), null, NOW)).toMatchObject({
      tone: 'bad',
      why: '5 stale items',
    });
    const fu = { ...it1(NOW - 3 * 86400e3), kind: 'followup' as const };
    expect(boardTone(Array(6).fill(fu), null, NOW).tone).toBe('warn');
    expect(boardTone([], null, NOW, 'main sync failed')).toEqual({
      tone: 'bad',
      why: 'main sync failed',
    });
  });
});

describe('the derived files', () => {
  const board = (over: Partial<Board> = {}): Board => ({
    updatedAt: NOW - 12 * MIN,
    items: [],
    unsure: null,
    tone: 'dim',
    why: null,
    ...over,
  });
  const row = (over: Partial<PlanRow>) =>
    ({ what: 'Merge x', kind: 'merge', at: NOW, done: false, ...over }) as PlanRow;
  const hm = (t: number) => new Date(t).toISOString().slice(11, 16);
  it('board.line: the head, then the next merge row not done, due within the last 2 h', () => {
    const s = (t: number) => Math.floor(t / 1000);
    expect(boardLine(board(), [], NOW, hm)).toBe(`${s(NOW)} ${s(NOW - 12 * MIN)} 0 dim\n`);
    const it = { kind: 'plan-done' as const, what: 'w', fix: 'f', branch: null, since: null };
    const rows = [
      row({ at: NOW - 3 * 3600e3, what: 'too old' }),
      row({ at: NOW + 3600e3, what: 'later' }),
      row({ at: NOW - 30 * MIN, what: 'Merge  G2\tnow', done: false }),
      row({ at: NOW - 40 * MIN, what: 'done one', done: true }),
      row({ at: NOW - 50 * MIN, what: 'a maintainer row', kind: 'maintainer' }),
    ];
    expect(
      boardLine(
        board({ items: [it], unsure: 'gh stale', tone: 'warn', updatedAt: null }),
        rows,
        NOW,
        hm,
      ),
    ).toBe(`${s(NOW)} - 1? warn\nmerge ${s(NOW - 30 * MIN)} 19:30 Merge G2 now\n`);
    // context: the count over 40, over 50, and the names at 50
    const cx = {
      at: NOW,
      stale: false,
      warn: [{ name: 'a', pct: 41 }],
      bad: [
        { name: 'b', pct: 77 },
        { name: 'c', pct: 51 },
      ],
    };
    expect(boardLine(board(), [], NOW, hm, null, cx).split('\n')[1]).toBe('ctx 3 2 b,c');
    // a name or text carrying control bytes, spaces or commas can't split a field or reach the terminal
    const odd = { at: NOW, stale: false, warn: [], bad: [{ name: 'a b,c\u001b[2J', pct: 60 }] };
    expect(boardLine(board(), [], NOW, hm, null, odd).split('\n')[1]).toBe('ctx 1 1 a_b_c_[2J');
    expect(boardLine(board(), [], NOW, hm, { at: NOW, text: 'wk 40%\u001b]0;x\u0007' })).toMatch(
      /\nusage \d+ wk 40% \]0;x\n$/,
    );
    expect(boardLine(board(), [], NOW, hm, null, { ...cx, warn: [], bad: [] }).split('\n')[1]).toBe(
      '',
    );
    // the usage line rides last, one line whatever it was given
    expect(boardLine(board(), [], NOW, hm, { at: NOW - MIN, text: 'usage 41% ·\n0.8%/h' })).toBe(
      `${s(NOW)} ${s(NOW - 12 * MIN)} 0 dim\nusage ${s(NOW - MIN)} usage 41% · 0.8%/h\n`,
    );
  });
  it('board.line: the slow, mac and vm rows ride after ctx, each absent without its fact', () => {
    const head = `${Math.floor(NOW / 1000)} ${Math.floor((NOW - 12 * MIN) / 1000)} 0 dim`;
    const cx = { at: NOW, stale: false, warn: [{ name: 'a', pct: 41 }], bad: [] };
    const load = {
      slow: { tone: 'warn' as const, short: 'slow 30m tc×1.6 gw×1.1' },
      mac: { load: [6.31, 7.86, 12.5], cpus: 12 },
      cores: 9,
    };
    expect(boardLine(board(), [], NOW, hm, null, cx, load)).toBe(
      `${head}\nctx 1 0 -\nslow warn slow 30m tc×1.6 gw×1.1\nmac 6 8 13 12\nvm 9\n`,
    );
    expect(boardLine(board(), [], NOW, hm, null, null, null)).toBe(`${head}\n`);
    expect(
      boardLine(board(), [], NOW, hm, null, null, { slow: null, mac: null, cores: null }),
    ).toBe(`${head}\n`);
    // control bytes can't split the row or reach the terminal; nothing left is no row
    const odd = (short: string) =>
      boardLine(board(), [], NOW, hm, null, null, { ...load, slow: { tone: 'bad', short } });
    expect(odd('slow 30m tc×1.2\u001b[2J\nx')).toContain('\nslow bad slow 30m tc×1.2 [2J x\nmac ');
    expect(odd('\u001b\n\t')).not.toContain('slow');
    // a Mac read short of three averages, or with a bad number, is no row; so is a zero core count
    const mac = (m: { load: number[]; cpus: number }) =>
      boardLine(board(), [], NOW, hm, null, null, { slow: null, mac: m, cores: 0 });
    expect(mac({ load: [1, 2], cpus: 12 })).toBe(`${head}\n`);
    expect(mac({ load: [1, NaN, 3], cpus: 12 })).toBe(`${head}\n`);
    expect(mac({ load: [1, 2, 3], cpus: NaN })).toBe(`${head}\n`);
    expect(mac({ load: [1, 2, 3], cpus: 0 })).toBe(`${head}\n`);
    expect(mac({ load: [-1, 2, 3], cpus: 12 })).toBe(`${head}\n`);
  });
  it('pnpm board stale: age, count, tone and each item with its fix; missing and unreadable say so', () => {
    const it = {
      kind: 'merge-order' as const,
      what: 'x landed',
      fix: 'drop x',
      branch: 'x',
      since: null,
    };
    const f = staleFile(
      board({ items: [it], tone: 'warn', unsure: 'gh PRs stale' }),
      NOW - 2 * MIN,
    );
    expect(formatStale(JSON.stringify(f), NOW)).toBe(
      [
        'board updated 12 min ago · 1? stale · warn · read 2 min ago',
        "  can't tell all: gh PRs stale",
        '  merge-order: x landed → drop x',
      ].join('\n'),
    );
    expect(formatStale(null, NOW)).toMatch(/^no stale.json/);
    expect(formatStale('{', NOW)).toBe('stale.json unreadable');
  });
});
