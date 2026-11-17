import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from './cli.ts';
import { macLine } from './machine.ts';
import type { MacRead } from './tower/health.ts';

const T = Date.now();
const stats = (power?: object, t = T) => ({
  v: 1,
  t: new Date(t).toISOString(),
  host: 'mac',
  memTotalMiB: 36864,
  mem: {
    freeMiB: 1,
    activeMiB: 1,
    inactiveMiB: 1,
    wiredMiB: 1,
    compressedMiB: 1,
    usedMiB: 1,
    pressure: 'normal',
  },
  ...(power && { power }),
});
const calm = {
  source: 'battery',
  batteryPct: 18,
  state: 'discharging',
  remainingMin: 75,
  lowPowerMode: false,
  thermal: {
    warningLevel: null,
    performanceWarningLevel: null,
    cpuSpeedLimit: null,
    cpuSchedulerLimit: null,
    cpuAvailableCpus: null,
  },
};

function board(mac: object | null, jobs: object[]) {
  const dir = mkdtempSync(join(tmpdir(), 'machine-'));
  mkdirSync(join(dir, 'history'));
  if (mac) writeFileSync(join(dir, 'mac-stats.json'), JSON.stringify(mac));
  writeFileSync(
    join(dir, 'history', 'events-2026-11-17.jsonl'),
    jobs.map((j) => JSON.stringify(j)).join('\n') + '\n{"torn',
  );
  return dir;
}
const job = (cls: string, agoMin: number, wallSec: number) => ({
  v: 1,
  kind: 'job',
  t: new Date(T - agoMin * 60_000).toISOString(),
  class: cls,
  wallSec,
  exit: 0,
});

describe('cli.ts machine', () => {
  it('prints the mac line and the slowdown line', () => {
    const jobs = [
      ...[60, 120, 180, 240, 300].map((m) => job('lint', m, 4)),
      job('lint', 3, 8),
      job('lint', 4, 8),
    ];
    expect(main(['machine', board(stats(calm), jobs)], () => '').split('\n')).toEqual([
      'mac: battery 18% discharging (1:15 left) · no thermal limit — RED: battery 18% — suggest ≤ 3 lanes (on battery under 30% or Low Power Mode)',
      'slowdown (30 min vs 24 h): typecheck – (0 recent) · lint ×2.0 (2/5) · test – (0 recent) · ui – (0 recent)',
    ]);
  });

  it('--json carries the power summary and the ratios; a missing mac-stats.json and an empty history say so', () => {
    const j = JSON.parse(main(['machine', board(null, []), '--json'], () => ''));
    expect(j.mac).toEqual({
      state: 'missing',
      power: { known: false, line: '', alerts: [], advice: null },
    });
    expect(j.slowdown.worst).toBeNull();
    expect(j.lines[0]).toBe('mac: no stats (agent not installed: tower NEEDS YOU)');
  });

  it('wants its board dir', () => {
    expect(() => main(['machine'], () => '')).toThrow();
  });
});

describe('macLine', () => {
  const read = (state: MacRead['state'], s: object | null, error: string | null = null): MacRead =>
    ({ state, at: T - 400_000, error, stats: s }) as MacRead;
  it('says why there is no power line', () => {
    expect(macLine(read('silent', null))).toMatch(/^mac: stats silent since \d\d:\d\d/);
    expect(macLine(read('bad', null, 'v is 2, want 1'))).toBe(
      'mac: stats unreadable (v is 2, want 1)',
    );
    expect(macLine(read('ok', {}))).toMatch(/^mac: power unknown \(an agent older than F120/);
  });
});
