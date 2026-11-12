import { describe, expect, it } from 'vitest';
import { compareJob, formatCalibration, newestGreen, type SimResultFile } from './calibrate';
import type { JobResult } from './check';

const f = (x: number, y: number, w = 40, h = 30) => ({ x, y, w, h });
const job = (found: JobResult['found']): JobResult => ({
  scenario: 'ios-standalone',
  name: 'capture',
  ops: [],
  ok: true,
  found,
});

describe('newestGreen', () => {
  const results: Record<string, SimResultFile> = {
    '20261112T180905Z-ios-ios-standalone-capture-be55': {
      status: 'pass',
      reads: { bar: { role: 'AXTextArea', frame: f(1, 1) } },
    },
    '20261112T190000Z-ios-ios-standalone-capture-aa11': {
      status: 'fail',
      reads: { bar: { role: 'AXTextArea', frame: f(1, 1) } },
    },
    '20261112T191000Z-ios-ios-standalone-capture-long-bb22': {
      status: 'pass',
      reads: { x: { role: 'AXButton', frame: f(1, 1) } },
    },
    '20261112T170000Z-ios-ios-standalone-capture-cc33': { status: 'pass', reads: {} },
  };
  const read = (id: string) => results[id] ?? null;
  it("takes the newest passing run of that job with reads, never a longer job's name", () => {
    expect(newestGreen(Object.keys(results), 'ios-standalone', 'capture', read)).toBe(
      '20261112T180905Z-ios-ios-standalone-capture-be55',
    );
    expect(newestGreen(Object.keys(results), 'ios-standalone', 'relaunch', read)).toBeNull();
  });
});

describe('compareJob and formatCalibration', () => {
  const sim: SimResultFile = {
    status: 'pass',
    reads: {
      bar: { role: 'AXTextArea', frame: f(25, 489, 346, 36) },
      send: { role: 'AXButton', frame: f(379, 487, 36, 36) },
      typed: { role: 'AXStaticText', frame: f(33, 496, 33, 22) },
      search: { role: 'AXTextField', frame: f(20, 263, 400, 42) },
      gone: { role: 'AXButton', frame: f(0, 0) },
    },
  };
  const rows = compareJob(
    job({
      bar: { role: 'AXTextArea', frame: f(25, 489, 346, 36), modelled: true },
      send: { role: 'AXButton', frame: f(379, 495, 36, 36), modelled: true },
      typed: { role: 'AXTextArea', frame: f(25, 489, 346, 36), modelled: true },
      search: { role: 'AXTextField', frame: f(20, 308, 400, 42), modelled: false },
    }),
    sim,
  );

  it('rates each frame: within 7 pt ok, 8+ off, another role or a page keyboard not compared', () => {
    expect(rows.map((r) => [r.as, r.verdict])).toEqual([
      ['bar', 'ok'],
      ['send', 'off'],
      ['typed', 'role'],
      ['search', 'unmodelled'],
    ]);
    expect(rows[1]!.delta).toEqual({ x: 0, y: 8, w: 0, h: 0 });
  });

  it('is OFF when any frame is off, and names what to re-measure', () => {
    const out = formatCalibration(rows, ['be55']);
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(
      /^iOS probe calibration: OFF — 1 frames within 7 pt, 1 off \(against be55\)/,
    );
    expect(out.text).toContain('re-measure: KEYBOARD_VIEWPORT_H and SAFE');
    expect(
      formatCalibration(
        rows.filter((r) => r.as !== 'send'),
        ['be55'],
      ).ok,
    ).toBe(true);
  });

  it('is never OK with nothing compared', () => {
    expect(formatCalibration([], []).ok).toBe(false);
  });
});
