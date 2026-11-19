import { describe, expect, it } from 'vitest';
import {
  awayStamp,
  backDigest,
  readStamp,
  STOP_LEAD_SEC,
  stopAt,
  stopLine,
  stopFile,
  usageRow,
} from './away.ts';
import type { LaneFile } from './tower/lanes.ts';
import type { Ask } from './tower/queue.ts';

const f = (t: number) => new Date(t).toISOString().slice(11, 16); // UTC, so the test is TZ-free
const T = Date.parse('2026-11-18T18:05:00Z');

describe('the away stamp', () => {
  it('round-trips, and a bad file reads as none', () => {
    const s = awayStamp(T, true, '41% · 8.2%/h (18:04)');
    expect(readStamp(JSON.stringify(s))).toEqual(s);
    for (const bad of [null, '', 'nope', '{}', '{"at":"soon"}']) expect(readStamp(bad)).toBeNull();
    expect(readStamp('{"at":"2026-11-18T18:05:00Z","ping":"yes"}')).toMatchObject({
      ping: false,
      usage: null,
    });
  });
  it("reads board.line's usage row", () => {
    const line = `1795045649 1795045550 4 warn\nusage ${T / 1000} usage 68% · 2.8%/h · ~11.4 h to 100%\nctx 3 0 -\n`;
    expect(usageRow(line, f)).toBe('68% · 2.8%/h · ~11.4 h to 100% (18:05)');
    expect(usageRow('ctx 3 0 -\n', f)).toBeNull();
    expect(usageRow(null, f)).toBeNull();
  });
});

describe('backDigest', () => {
  const lane = (branch: string, phase: string, at: number | null) =>
    ({ branch, phase, phaseSince: at }) as unknown as LaneFile;
  const ask = (id: string, asked: number) => ({ id, asked }) as unknown as Ask;
  it('what moved since the stamp: merges (deduped, in order), starts, phase changes, asks, usage', () => {
    const out = backDigest(
      {
        stamp: awayStamp(T, false, '41% (18:04)'),
        now: T + 97 * 60e3,
        merged: [
          {
            pr: 233,
            sha: 'b'.repeat(40),
            mergedAt: '2026-11-18T19:02:00Z',
            title: 'Recurring tasks',
          },
          {
            pr: 231,
            sha: 'a'.repeat(40),
            mergedAt: '2026-11-18T18:20:00Z',
            title: 'Gate\u001b[2J trims',
          },
          { pr: 231, sha: 'a'.repeat(40), mergedAt: '2026-11-18T18:20:00Z', title: 'Gate trims' }, // a repeated row
          {
            pr: 229,
            sha: 'c'.repeat(40),
            mergedAt: '2026-11-18T17:00:00Z',
            title: 'before the stamp',
          },
        ],
        started: [
          { branch: 'gate-trims', startedAt: '2026-11-18T18:31:00Z' },
          { branch: 'old', startedAt: '2026-11-18T10:00:00Z' },
        ],
        lanes: [
          lane('warm-caches', 'review', T + 35 * 60e3),
          lane('idle', 'build', T - 1),
          lane('none', 'plan', null),
        ],
        asks: [ask('d3', T - 60e3), ask('d4', T + 60e3)],
        usageNow: '53% (19:40)',
      },
      f,
    );
    expect(out.split('\n')).toEqual([
      'BACK 19:42 · away since 18:05 (1h37m)',
      'MERGED 2 · PR 231 "Gate [2J trims" 18:20 · PR 233 "Recurring tasks" 19:02',
      'STARTED 1 · gate-trims 18:31',
      'MOVED 1 · warm-caches → review 18:40',
      'ASKS 2 open (1 new)',
      'USAGE then 41% (18:04) · now 53% (19:40)',
      "deploys: not recorded on the board (the brief's LANES, the tower's DONE TODAY)",
    ]);
  });
  it('says none under every heading when nothing moved', () => {
    const out = backDigest(
      {
        stamp: awayStamp(T, false, null),
        now: T + 5 * 60e3,
        merged: [],
        started: [],
        lanes: [],
        asks: [],
        usageNow: null,
      },
      f,
    );
    expect(out.split('\n').slice(1, 6)).toEqual([
      'MERGED none',
      'STARTED none',
      'MOVED none',
      'ASKS none open',
      'USAGE then unknown · now unknown',
    ]);
  });
});

describe('the hard stop', () => {
  it('HH:MM → the next such local time, today or tomorrow', () => {
    const now = new Date(2026, 10, 18, 20, 0, 30).getTime();
    expect(stopAt('22:30', now)).toBe(new Date(2026, 10, 18, 22, 30).getTime() / 1000);
    expect(stopAt('7:05', now)).toBe(new Date(2026, 10, 19, 7, 5).getTime() / 1000); // passed: tomorrow
    expect(stopAt('20:00', now)).toBe(new Date(2026, 10, 19, 20, 0).getTime() / 1000); // this minute is past
    for (const bad of ['24:00', '22:60', '2230', 'soon', '22:3'])
      expect(() => stopAt(bad, now)).toThrow(/want HH:MM/);
  });
  it('the line says the stop, the exit-12 time and when lanes stop', () => {
    const at = T / 1000 + 3 * 3600;
    expect(stopLine(at, T, f)).toBe(
      `STOP 21:05 hard · in 3h00m · pace-watch exits 12 at ${f((at - STOP_LEAD_SEC) * 1000)}: lanes work until 21:04, then stop clean`,
    );
  });
  it('under STOP_LEAD away, the line says exit 12 comes on the next tick, not at a time already past', () => {
    expect(stopLine(T / 1000 + 300, T, f)).toBe(
      'STOP 18:10 hard · in 5m · pace-watch exits 12 on its next tick (under 10 min away): lanes work until 18:09, then stop clean',
    );
  });
  it("stop.json, the stop's own file: the time or null for off, and when it was set", () => {
    expect(JSON.parse(stopFile(99, T))).toEqual({
      v: 1,
      stopAt: 99,
      setAt: new Date(T).toISOString(),
    });
    expect(JSON.parse(stopFile(null, T)).stopAt).toBeNull();
  });
});
