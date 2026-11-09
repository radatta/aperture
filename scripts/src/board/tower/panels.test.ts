process.env.TZ = 'America/Los_Angeles'; // the frames read local time, like board.sh
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { strip, width } from './ansi.ts';
import { build, parseArgs } from './main.ts';
import type { TowerState } from './model.ts';
import { HISTORY_H, layout } from './layout.ts';
import { compose, feedItems, since, waveItems, wants, type Ui } from './panels.ts';

const NOW = '2026-11-08T06:10:00Z';
// glyphs width() would mis-measure: controls, CJK, emoji (the fixtures carry all three)
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\u{1f000}-\u{1faff}]/u;
const mismeasured = (row: string) =>
  WIDE.test(row) ||
  [...row].some(
    (ch) => ch.charCodeAt(0) < 0x20 || (ch.charCodeAt(0) >= 0x7f && ch.charCodeAt(0) <= 0x9f),
  );
let state: TowerState;
const live: Ui = { range: '1h', cursor: 0 };
const text = (lines: string[]) => lines.map(strip).join('\n');

beforeAll(async () => {
  const { prs, source, clock } = build(
    parseArgs(['--fixtures', join(import.meta.dirname, 'fixtures'), '--now', NOW]),
  );
  await prs!.poll(clock());
  state = source.refresh(clock());
});

describe('frame', () => {
  it.each([
    [210, 55],
    [160, 40],
    [100, 50],
    [95, 30],
    [80, 24],
  ])('%ix%i: exactly rows lines of exactly cols columns', (cols, rows) => {
    for (const ui of [live, { range: '6h', cursor: 0 }, { range: '24h', cursor: 40 }] as Ui[]) {
      const f = compose(state, ui, cols, rows);
      expect(f).toHaveLength(rows);
      for (const l of f) expect(width(l)).toBe(cols);
      expect(f.join('')).not.toContain('\x1b[0m'); // a full reset would drop the Nord background
      for (const l of f) expect(mismeasured(strip(l))).toBe(false);
    }
  });

  it('external text arrives one column per glyph', () => {
    const f = text(compose(state, live, 210, 55));
    expect(f).toContain('Charlie: the open change ? ??');
    expect(f).toContain('echo  review round 2 now[2J'); // newline dropped, tab a space, ESC gone
  });

  it('wide: lock, gauges, queue, wave, sessions and history from the fixtures', () => {
    const f = text(compose(state, live, 210, 55));
    expect(f).toContain('dev lock bravo-branch (bravo) until 22:37 27m left');
    expect(f).toContain('next charlie-branch (charlie)');
    expect(f).toMatch(/mem ━+.*9\.0G\/18G/);
    expect(f).toContain('ON DEV bravo-branch bravo  27m');
    expect(f).toContain('WAIT   delta-branch delta  on Rahul: merge PR 41');
    expect(f).toContain('1. Merge PR 41 after its dev run');
    expect(f).toContain('1/5 merged');
    expect(f).toContain('open charlie-branch PR 41  Charlie: the open change');
    expect(f).not.toContain('done alpha-branch'); // merged items: counted, not listed
    expect(f).toContain('2 working · 5 idle');
    expect(f).toContain(
      'live 22:09 · cpu 6.7 · mem 9.0G · pids 737 · heavy 2 · working 2: alpha, bravo',
    );
    expect(f).toMatch(/╵21:10 +╵21:20/);
  });

  it('narrow keeps every panel', () => {
    const f = text(compose(state, live, 100, 50));
    for (const t of [
      'DEV QUEUE',
      'WAITING ON RAHUL',
      'WAVE 2',
      'PLAN',
      'MACHINE',
      'SESSIONS',
      'TEST FAILURES',
      'ACTIVITY',
      'STATUS',
    ])
      expect(f).toContain(t);
  });

  it('the readout moves back in time and says when', () => {
    const f = text(compose(state, { range: '6h', cursor: 30 }, 210, 55));
    expect(f).toMatch(/\d\d:\d\d–\d\d:\d\d · cpu/);
    expect(text(compose(state, { range: '6h', cursor: 0 }, 210, 55))).toContain('live 22:09');
  });

  it('marks the sampler gap and event ticks in 6 h', () => {
    const f = text(compose(state, { range: '6h', cursor: 0 }, 210, 55));
    const events = f.split('\n').find((l) => l.includes('events'))!;
    expect(events).toContain('✗'); // the failed suites
    expect(events).toContain('◆'); // devcheck runs
    expect(events).toContain('▲'); // the merge
  });

  it('a terminal under 95×24 gets a hint, not a crash', () => {
    expect(text(compose(state, live, 80, 24))).toContain(
      'the tower needs at least 95×24 (now 80×24)',
    );
  });
});

describe('panels', () => {
  it('failures by concurrency, status tiles', () => {
    const f = text(compose(state, live, 210, 55));
    expect(f).toMatch(/alone +6 +1 +17%/);
    expect(f).toMatch(/1 other +2 +1 +50%/);
    expect(f).toMatch(/TTL proof +4\/12 full runs · 1 failed/);
    expect(f).toMatch(/bench +2 runs · 1 red · 22:05 waiting/);
    expect(f).toMatch(/suites 24h 10 · 3 failed/);
    expect(f).toMatch(/heavy now +test \(alpha\)/);
    expect(f).toMatch(/gh +0s ago · 1 open/);
  });

  it('the feed is newest first and keeps only what changed', () => {
    const items = feedItems(state);
    const texts = items.map((i) => i.text);
    expect(items.map((i) => i.t)).toEqual([...items.map((i) => i.t)].sort((a, b) => b - a));
    expect(new Set(items.map((i) => i.kind))).toEqual(
      new Set(['job', 'run', 'merge', 'pr', 'lease']),
    );
    // jobs: failures only (exit 1, 137), never a pass, a 143 (killed by us), lint/typecheck or the dev server
    const jobs = items.filter((i) => i.kind === 'job');
    expect(jobs.map((j) => j.text.match(/exit \d+/)![0]).sort()).toEqual([
      'exit 1',
      'exit 1',
      'exit 137',
    ]);
    expect(jobs.every((j) => j.tone === 'bad')).toBe(true);
    expect(texts.some((t) => /exit 0|exit 143|lint|typecheck|charlie {2}dev/.test(t))).toBe(false);
    expect(texts).toContain('merged PR 40  Alpha: an earlier change');
    expect(texts).toContain('PR 41 opened  Charlie: the open change ? ??');
    expect(texts.some((t) => t.startsWith('PR 40 opened'))).toBe(false); // opened over 24 h ago
    expect(texts).toContain('devcheck full PASS  10m00s');
    // a run's start shows only while it is still in flight
    expect(texts.filter((t) => t.endsWith('started'))).toEqual(['devcheck full started']);
    expect(items.find((i) => i.text.endsWith('started'))!.t).toBe(
      Date.parse('2026-11-08T06:02:00Z'),
    );
    // leases: gave up or denied only, not a wait
    expect(items.filter((i) => i.kind === 'lease').map((i) => i.text)).toEqual([
      'heavy gaveUp  foxtrot test',
    ]);
  });

  it('the feed keeps the dev lock taken (a deploy-dev) and drops it freed', () => {
    const t = Date.parse(NOW) - 60000;
    const items = feedItems({
      ...state,
      lockFeed: [
        { t, kind: 'lock', text: 'lock: x-branch (x) until 22:50', tone: 'warn' },
        { t: t + 1, kind: 'lock', text: 'lock: free (was w-branch)', tone: 'good' },
      ],
    });
    expect(items.filter((i) => i.kind === 'lock').map((i) => i.text)).toEqual([
      'lock: x-branch (x) until 22:50',
    ]);
  });

  it('gh upgrades a wave item to merged by its named PR only, and never downgrades', () => {
    const merged = {
      number: 50,
      title: 'x',
      branch: 'delta-branch',
      state: 'MERGED',
      mergedAt: 1,
      createdAt: null,
    };
    const reopened = {
      number: 51,
      title: 'reopened',
      branch: 'delta-branch',
      state: 'OPEN',
      mergedAt: null,
      createdAt: null,
    };
    const withPr = (pr: number | null): TowerState => ({
      ...state,
      queue: {
        ...state.queue,
        data: {
          ...state.queue.data!,
          wave: {
            name: 'W',
            items: [{ branch: 'delta-branch', state: 'in-flight', pr, session: null, title: null }],
          },
        },
      },
      prs: { ...state.prs, list: [merged, reopened] },
    });
    expect(waveItems(withPr(50))[0]).toMatchObject({ state: 'merged', gh: true, pr: 50 });
    // no PR named: an old merged PR on a reused branch name doesn't count; an open one lends number and title
    expect(waveItems(withPr(null))[0]).toMatchObject({
      state: 'in-flight',
      gh: false,
      pr: 51,
      title: 'reopened',
    });
    const open = {
      ...state,
      prs: {
        ...state.prs,
        list: [
          {
            number: 40,
            title: 'x',
            branch: 'alpha-branch',
            state: 'OPEN',
            mergedAt: null,
            createdAt: null,
          },
        ],
      },
    };
    expect(waveItems(open).find((i) => i.branch === 'alpha-branch')!.state).toBe('merged');
  });

  it('missing queue.json says how to seed it', () => {
    const f = text(
      compose({ ...state, queue: { status: 'missing', data: null, problems: [] } }, live, 210, 55),
    );
    expect(f).toContain('cp scripts/board/queue.example.json');
    expect(f).toMatch(/queue\.json +missing/);
  });

  it('a bad write keeps the last good queue and flags it', () => {
    const f = text(
      compose(
        {
          ...state,
          queue: { ...state.queue, status: 'bad', problems: ['devQueue[1]: state "x"'] },
        },
        live,
        210,
        55,
      ),
    );
    expect(f).toContain('devQueue[1]: state "x"');
    expect(f).toContain('bad write');
    expect(f).toContain('ON DEV bravo-branch');
  });

  it('a free lock, an expired one, and a stale cache', () => {
    const at = Date.parse(NOW);
    const head = (lock: TowerState['lock']) =>
      strip(compose({ ...state, lock }, live, 210, 55)[0]!);
    expect(
      head({ branch: null, session: null, expiresAt: null, asOf: at, failed: false }),
    ).toContain('dev lock free');
    expect(
      head({ branch: 'x', session: null, expiresAt: at - 1, asOf: at, failed: false }),
    ).toContain('EXPIRED');
    expect(
      head({ branch: 'x', session: null, expiresAt: at + 3e6, asOf: at - 6 * 60000, failed: true }),
    ).toContain('(as of 22:04, refresh failed)');
  });

  it('a stale sampler dims the gauges and says so', () => {
    const g = { ...state.gauges!, t: Date.parse(NOW) - 5 * 60000 };
    expect(strip(compose({ ...state, gauges: g }, live, 210, 55)[1]!)).toContain(
      'sampler stale 5m',
    );
  });

  it("a to-do's age", () => {
    const now = Date.parse(NOW); // 22:10 on 2026-11-07, local
    expect(
      ['2026-11-08', '2026-11-07', '2026-11-06', '2026-11-05', 'soon'].map((x) => since(x, now)),
    ).toEqual(['', '', '1d', '2d', 'soon']);
  });
});

describe('tower v2', () => {
  const row = (f: string, re: RegExp) => f.split('\n').find((l) => re.test(l)) ?? '';

  it('lane badges for ready and needs-you', () => {
    const f = text(compose(state, live, 210, 55));
    expect(f).toContain('READY  hotel-branch PR 42 hotel');
    expect(f).toContain('RAHUL  india-branch india  on Rahul: admit to dev');
  });

  it("Rahul's to-dos show an age only past a day", () => {
    const f = text(compose(state, live, 210, 55));
    expect(f).not.toContain('today');
    expect(row(f, /1\. Merge PR 41/)).toMatch(/1\. Merge PR 41 after its dev run +││/);
    expect(row(f, /2\. Open the dev freeze/)).toMatch(/delta-branch +1d ││/);
  });

  it('SESSIONS lists the working and the branched, then one idle line', () => {
    const f = text(compose(state, live, 210, 55));
    expect(f).toContain('idle: echo, foxtrot, golf');
    expect(f).toMatch(/│ charlie +idle +charlie-branch/);
    expect(f).not.toMatch(/│ echo +idle/);
    expect(wants(state).sessions).toBe(4 + 2);
  });

  it("the middle band is MACHINE's full height, every series drawn", () => {
    expect(layout(210, 55, wants(state)).rects.history!.h).toBe(HISTORY_H);
    const f = text(compose(state, live, 210, 55));
    for (const lab of ['cpu ', 'mem ', 'pids ', 'heavy ', 'working ', 'events', 'live 22:09'])
      expect(f).toContain(lab);
    expect(f).not.toMatch(/\+\d+ more/);
  });

  it('PLAN: by time, the past due dimmed with ?, the unscheduled last, next merge in the title', () => {
    const f = text(compose(state, live, 210, 55));
    const r = layout(210, 55, wants(state)).rects.plan!;
    const lines = f
      .split('\n')
      .slice(r.y + 1, r.y + r.h - 1)
      .map((l) => [...l].slice(r.x, r.x + r.w).join(''))
      .filter((l) => !/^│ +│$/.test(l));
    expect(lines.map((l) => l.slice(0, 22))).toEqual([
      '│ 21:30     ? dev   br',
      '│ 22:25   15m rahul Op',
      '│ 22:40   30m merge me',
      '│ --:--       ci    PR',
    ]);
    expect(f).toMatch(/PLAN ─+ next merge ~22:40 ╮/);
    expect(f).not.toContain('a stale golf run'); // over 2 h past due
  });

  it('PLAN without a plan, and without a merge', () => {
    const withPlan = (plan: NonNullable<TowerState['queue']['data']>['plan']): string =>
      text(
        compose(
          { ...state, queue: { ...state.queue, data: { ...state.queue.data!, plan } } },
          live,
          210,
          55,
        ),
      );
    expect(withPlan([])).toContain('no plan in queue.json (dispatch writes it)');
    const at = Date.parse(NOW);
    const f = withPlan([
      { at: at + 600000, what: 'a dev run', kind: 'dev', who: null },
      { at: null, what: 'a check', kind: 'ci', who: null },
    ]);
    expect(f).toMatch(/PLAN ─+ 2 planned ╮/);
    // a merge already past due keeps the title, marked ?
    expect(withPlan([{ at: at - 60000, what: 'm', kind: 'merge', who: null }])).toMatch(
      /next merge \?22:09/,
    );
  });
});
