process.env.TZ = 'America/Los_Angeles'; // the frames read local time, like board.sh
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { strip, width } from './ansi.ts';
import { build, parseArgs } from './main.ts';
import type { TowerState } from './model.ts';
import { compose, feedItems, since, waveItems, type Ui } from './panels.ts';

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
    expect(f).toContain('done alpha-branch');
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

  it('the feed is newest first and mixes jobs, runs, merges and leases', () => {
    const items = feedItems(state);
    expect(items.map((i) => i.t)).toEqual([...items.map((i) => i.t)].sort((a, b) => b - a));
    expect(new Set(items.map((i) => i.kind))).toEqual(new Set(['job', 'run', 'merge', 'lease']));
    expect(items.find((i) => i.kind === 'job' && i.text.includes('exit 137'))!.tone).toBe('bad');
    expect(items.find((i) => i.kind === 'job' && i.text.includes('exit 143'))!.tone).toBe('normal');
  });

  it('gh upgrades a wave item to merged by its named PR only, and never downgrades', () => {
    const merged = { number: 50, title: 'x', branch: 'delta-branch', state: 'MERGED', mergedAt: 1 };
    const reopened = {
      number: 51,
      title: 'reopened',
      branch: 'delta-branch',
      state: 'OPEN',
      mergedAt: null,
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
        list: [{ number: 40, title: 'x', branch: 'alpha-branch', state: 'OPEN', mergedAt: null }],
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
    expect([since('2026-11-07', now), since('2026-11-05', now), since('soon', now)]).toEqual([
      'today',
      '2d',
      'soon',
    ]);
  });
});
