import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deps, pace, world } from './fakes.ts';
import {
  PACE_DEFAULTS,
  WAIT_DEFAULT_MIN,
  lastStartText,
  paceLimits,
  paceReasons,
  parseWait,
} from './pace.ts';

const NOW = Date.parse('2026-11-17T18:00:00Z');
const keys = (
  p: string | null,
  last: string | null = null,
  now = NOW,
  control: string | null = null,
) => paceReasons(p, control, last, now, PACE_DEFAULTS, '/board').map((r) => r.key);
const avg = (o: object) => ({ avg: { anonMiB: 8000, cores: 4, psiCpu: 10, ...o } });

describe('paceReasons', () => {
  it('a calm fresh file is clear', () => {
    expect(keys(pace(NOW))).toEqual([]);
  });

  it('thresholds are strict: just under passes, at the limit refuses', () => {
    expect(keys(pace(NOW, avg({ cores: 7.49, psiCpu: 39.99, anonMiB: 8999.9 })))).toEqual([]);
    expect(keys(pace(NOW, avg({ cores: 7.5 })))).toEqual(['cores']);
    expect(keys(pace(NOW, avg({ psiCpu: 40 })))).toEqual(['psiCpu']);
    expect(keys(pace(NOW, avg({ anonMiB: 9000 })))).toEqual(['anon']);
  });

  it('names every busy signal at once', () => {
    expect(
      keys(pace(NOW, { state: 'hot', ...avg({ cores: 9, psiCpu: 70, anonMiB: 11000 }) })),
    ).toEqual(['state', 'cores', 'psiCpu', 'anon']);
  });

  it('only state "calm" passes', () => {
    expect(keys(pace(NOW, { state: 'warm' }))).toEqual(['state']);
  });

  it('load5 and samples are not judged', () => {
    expect(keys(pace(NOW, { load5: 30, samples: 1 }))).toEqual([]);
  });

  it('stale only past staleSec', () => {
    expect(keys(pace(NOW - 180_000))).toEqual([]);
    expect(keys(pace(NOW - 181_000))).toEqual(['stale']);
  });

  it.each([
    ['empty', ''],
    ['junk', '{not json'],
    ['an array', '[]'],
    ['null', 'null'],
    ['no heartbeat', pace(NOW, { heartbeat: undefined })],
    ['a string heartbeat', pace(NOW, { heartbeat: '1794965129' })],
    ['no state', pace(NOW, { state: 42 })],
    ['no avg', pace(NOW, { avg: undefined })],
    ['a non-numeric avg field', pace(NOW, avg({ cores: 'n/a' }))],
    ['a heartbeat 61 s ahead', pace(NOW + 61_000)],
  ])('%s fails closed as unreadable', (_, text) => {
    expect(keys(text)).toEqual(['unreadable']);
  });

  it('a heartbeat up to 60 s ahead counts as fresh', () => {
    expect(keys(pace(NOW + 60_000))).toEqual([]);
  });

  it('missing fails closed, naming the watcher', () => {
    expect(paceReasons(null, null, null, NOW, PACE_DEFAULTS, '/b')).toEqual([
      {
        key: 'missing',
        text: 'no pace.json in /b: the watcher is not running, restart /b/pace-watch.sh',
      },
    ]);
  });

  it("the hub's pace-control state refuses when not calm, even while pace.json still says calm", () => {
    expect(keys(pace(NOW), null, NOW, '{"state":"hot","since":1,"held":[]}')).toEqual(['control']);
    expect(keys(pace(NOW), null, NOW, '{"state":"calm","since":0}')).toEqual([]);
    for (const junk of ['', '{', 'null', '{"since":1}', '{"state":3}'])
      expect(keys(pace(NOW), null, NOW, junk), junk).toEqual([]);
  });

  it('spacing: inside spacingSec refuses, at it passes', () => {
    expect(keys(pace(NOW), lastStartText('x', NOW - 119_000))).toEqual(['spacing']);
    expect(keys(pace(NOW), lastStartText('x', NOW - 120_000))).toEqual([]);
  });

  it.each([
    ['junk', '{'],
    ['no at', '{"v":1,"branch":"x"}'],
    ['a string at', '{"v":1,"at":"1","branch":"x"}'],
    ['a future at', lastStartText('x', NOW + 5_000)],
  ])('a broken last-start never blocks: %s', (_, last) => {
    expect(keys(pace(NOW), last)).toEqual([]);
  });
});

describe('paceLimits', () => {
  it('defaults with no pace block, and per field over a broken one', () => {
    const w = world();
    const t = deps(w, []);
    expect(paceLimits(t.d)).toEqual(PACE_DEFAULTS);
    writeFileSync(
      join(w.main, 'scripts/board/limits.json'),
      JSON.stringify({
        pace: { coresBelow: 6, psiCpuBelow: -1, anonMiBBelow: 'x', staleSec: 300 },
      }),
    );
    expect(paceLimits(t.d)).toEqual({ ...PACE_DEFAULTS, coresBelow: 6, staleSec: 300 });
    writeFileSync(join(w.main, 'scripts/board/limits.json'), '{oops');
    expect(paceLimits(t.d)).toEqual(PACE_DEFAULTS);
  });

  it('the tracked limits.json pace block is the defaults', async () => {
    const { readFileSync } = await import('node:fs');
    const l = JSON.parse(readFileSync(new URL('../../board/limits.json', import.meta.url), 'utf8'));
    expect(l.pace).toEqual(PACE_DEFAULTS);
  });
});

describe('parseWait', () => {
  it.each([
    [null, null],
    ['true', WAIT_DEFAULT_MIN],
    ['1', 1],
    ['30', 30],
    ['0', 'bad'],
    ['31', 'bad'],
    ['1.5', 'bad'],
    ['new-lane', 'bad'],
    ['', 'bad'],
  ])('%j → %j', (raw, want) => {
    expect(parseWait(raw)).toBe(want);
  });
});
