import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LANE_USAGE,
  laneEta,
  parseLane,
  parseLaneArgs,
  readLanes,
  writeLane,
  type LaneArgs,
} from './lanes.ts';

const T0 = new Date('2026-11-13T20:00:00Z');
const T1 = new Date('2026-11-13T20:30:00Z');
const env = (now = T0) => ({ branch: 'tower-web', sha: 'a'.repeat(40), session: 'auto-6', now });
const dir = () => mkdtempSync(join(tmpdir(), 'lanes-'));
const read = (d: string) => JSON.parse(readFileSync(join(d, 'lanes/tower-web.json'), 'utf8'));

describe('parseLaneArgs', () => {
  it('reads a phase with its flags', () => {
    expect(
      parseLaneArgs(['review', '--step', 'round 1 of 3', '--pr', '161', '--slot', 'devb']),
    ).toMatchObject({
      phase: 'review',
      step: 'round 1 of 3',
      pr: 161,
      slot: 'devb',
      needs: null,
    });
  });
  it('a needs item wants exactly one of an https link or a one-line command', () => {
    expect(
      parseLaneArgs(['dev', '--needs', 'Safari pass', '--cmd', 'open x', '--unblocks', 'the PR'])
        .needs,
    ).toEqual({
      what: 'Safari pass',
      link: null,
      cmd: 'open x',
      unblocks: 'the PR',
    });
    expect(() => parseLaneArgs(['dev', '--needs', 'x'])).toThrow(/exactly one/);
    expect(() =>
      parseLaneArgs(['dev', '--needs', 'x', '--link', 'https://a', '--cmd', 'b']),
    ).toThrow(/exactly one/);
    expect(() => parseLaneArgs(['dev', '--needs', 'x', '--link', 'http://a'])).toThrow(/https/);
    expect(() => parseLaneArgs(['dev', '--needs', 'x', '--cmd', 'a\nb'])).toThrow(/one line/);
    expect(() => parseLaneArgs(['dev', '--link', 'https://a'])).toThrow(/go with --needs/);
  });
  it('refuses unknown phases, flags and missing values', () => {
    expect(() => parseLaneArgs(['shipping'])).toThrow(/unknown phase/);
    expect(() => parseLaneArgs(['build', '--force'])).toThrow(/unknown flag/);
    expect(() => parseLaneArgs(['build', '--step'])).toThrow(/wants a value/);
    expect(() => parseLaneArgs(['build', '--pr', 'x'])).toThrow(/number/);
    expect(() => parseLaneArgs(['--step', 'x'])).toThrow(/phase is required/);
    expect(() => parseLaneArgs(['build', '--clear'])).toThrow(/--clear takes nothing/);
    expect(parseLaneArgs(['--clear']).clear).toBe(true);
  });
});

describe('parseLaneArgs: the step plan and ETAs', () => {
  it('reads --plan, --files and the ETA flags; a trailing ? is a guess', () => {
    const a = parseLaneArgs([
      'build',
      '--plan',
      'build=60-90,gate=5-10,review=40-70,pr=10-20?',
      '--files',
      '37',
      '--eta-next',
      '20-35',
      '--eta-pr',
      '120-200?',
    ]);
    expect(a.plan).toEqual([
      { phase: 'build', lo: 60, hi: 90, guess: false },
      { phase: 'gate', lo: 5, hi: 10, guess: false },
      { phase: 'review', lo: 40, hi: 70, guess: false },
      { phase: 'pr', lo: 10, hi: 20, guess: true },
    ]);
    expect(a).toMatchObject({
      files: 37,
      etaNext: { lo: 20, hi: 35, guess: false },
      etaPr: { lo: 120, hi: 200, guess: true },
    });
  });
  it('refuses a bad plan: unknown or repeated step, lo over hi, not minutes', () => {
    expect(() => parseLaneArgs(['build', '--plan', 'ship=1-2'])).toThrow(/not a step/);
    expect(() => parseLaneArgs(['build', '--plan', 'merged=1-2'])).toThrow(/not a step/);
    expect(() => parseLaneArgs(['build', '--plan', 'gate=1-2,gate=3-4'])).toThrow(/twice/);
    expect(() => parseLaneArgs(['build', '--plan', 'gate=9-2'])).toThrow(/lo ≤ hi/);
    expect(() => parseLaneArgs(['build', '--plan', 'gate=1.5-2'])).toThrow(/lo ≤ hi/);
    expect(() => parseLaneArgs(['build', '--plan', 'gate'])).toThrow(/lo ≤ hi/);
    expect(() => parseLaneArgs(['build', '--eta-pr', '30'])).toThrow(/--eta-pr wants/);
    expect(() => parseLaneArgs(['build', '--files', 'many'])).toThrow(/number/);
    expect(() => parseLaneArgs(['--clear', '--files', '3'])).toThrow(/--clear takes nothing/);
  });
  it('every flag the usage names parses', () => {
    const flags = [...new Set(LANE_USAGE.match(/--[a-z-]+/g))];
    const sample: Record<string, string[]> = {
      '--step': ['x'],
      '--pr': ['1'],
      '--slot': ['dev'],
      '--session': ['s'],
      '--needs': ['x', '--cmd', 'y'],
      '--link': ['https://a', '--needs', 'x'],
      '--cmd': ['y', '--needs', 'x'],
      '--unblocks': ['u', '--needs', 'x', '--cmd', 'y'],
      '--plan': ['gate=1-2'],
      '--files': ['3'],
      '--eta-next': ['1-2'],
      '--eta-pr': ['1-2'],
    };
    for (const f of flags) {
      if (f === '--clear') continue;
      expect(sample[f], f).toBeDefined();
      expect(() => parseLaneArgs(['build', f, ...sample[f]!]), f).not.toThrow();
    }
  });
});

describe('laneEta', () => {
  const now = Date.parse('2026-11-16T20:00:00Z');
  const M = 60e3;
  const plan = [
    { phase: 'build' as const, lo: 60, hi: 90, source: 'measured' as const, spentMs: 0 },
    { phase: 'review' as const, lo: 20, hi: 40, source: 'measured' as const, spentMs: 0 },
    { phase: 'pr' as const, lo: 10, hi: 20, source: 'guess' as const, spentMs: 0 },
  ];
  const none = { etaNext: null, etaPr: null };
  it('next is the current step less its time spent; the PR adds every later step', () => {
    expect(laneEta(plan, none, 'build', 30 * M, now)).toEqual({
      next: { lo: now + 30 * M, hi: now + 60 * M },
      pr: { lo: now + 60 * M, hi: now + 120 * M },
      source: 'guess', // the pr step is a guess
    });
  });
  it('a step past its estimate is due now, never in the past', () => {
    expect(laneEta(plan, none, 'build', 120 * M, now)!.next).toEqual({ lo: now, hi: now });
  });
  it('flags win over the plan, each its own; no plan and no flags is none', () => {
    const e = laneEta(
      plan,
      { etaNext: null, etaPr: { lo: 5, hi: 10, guess: false } },
      'pr',
      0,
      now,
    );
    expect(e).toEqual({
      next: { lo: now + 10 * M, hi: now + 20 * M },
      pr: { lo: now + 5 * M, hi: now + 10 * M },
      source: 'guess',
    });
    expect(laneEta(null, none, 'build', 0, now)).toBeNull();
    expect(
      laneEta(null, { etaNext: { lo: 1, hi: 2, guess: false }, etaPr: null }, 'build', 0, now),
    ).toEqual({
      next: { lo: now + M, hi: now + 2 * M },
      pr: null,
      source: 'measured',
    });
  });
  it('past the PR (merged), parked or blocked: nothing from the plan', () => {
    expect(laneEta(plan, none, 'merged', 0, now)).toBeNull();
    expect(laneEta(plan, none, 'blocked', 0, now)).toBeNull();
  });
  it('a phase the plan skips is done now; the later steps still count', () => {
    expect(laneEta(plan, none, 'gate', 0, now)).toMatchObject({
      next: { lo: now, hi: now },
      pr: { lo: now + 30 * M, hi: now + 60 * M },
    });
  });
});

describe('writeLane', () => {
  const args = (a: string[]): LaneArgs => parseLaneArgs(a);
  it('writes tmp + rename, keeps phaseSince while the phase is unchanged and resets it on a change', () => {
    const d = dir();
    expect(writeLane(d, args(['review', '--step', 'round 1 of 3']), env())).toBe(
      'lane tower-web: review · round 1 of 3',
    );
    expect(read(d)).toMatchObject({
      v: 1,
      branch: 'tower-web',
      session: 'auto-6',
      phase: 'review',
      phaseSince: T0.toISOString(),
      sha: 'a'.repeat(40),
    });
    writeLane(d, args(['review', '--step', 'round 2 of 3']), env(T1));
    expect(read(d)).toMatchObject({
      step: 'round 2 of 3',
      phaseSince: T0.toISOString(),
      updatedAt: T1.toISOString(),
    });
    writeLane(d, args(['dev']), env(T1));
    expect(read(d)).toMatchObject({ phase: 'dev', step: null, phaseSince: T1.toISOString() });
    expect(existsSync(join(d, `lanes/tower-web.json.tmp.${process.pid}`))).toBe(false);
  });
  it('clears needs on any write without --needs; keeps the PR number', () => {
    const d = dir();
    writeLane(d, args(['dev', '--needs', 'Safari pass', '--cmd', 'open x', '--pr', '7']), env());
    expect(read(d).needs).toMatchObject({ what: 'Safari pass' });
    writeLane(d, args(['dev', '--step', 'devcheck']), env(T1));
    expect(read(d)).toMatchObject({ needs: null, pr: 7 });
  });
  it('keeps the plan across writes and accrues the time per phase on a change; parked time counts to no step', () => {
    const d = dir();
    const at = (min: number) => new Date(T0.getTime() + min * 60e3);
    writeLane(
      d,
      args(['build', '--plan', 'build=60-90,review=20-40,pr=10-20', '--files', '12']),
      env(at(0)),
    );
    expect(read(d)).toMatchObject({
      files: 12,
      plan: [
        { phase: 'build', lo: 60, hi: 90, source: 'measured', spentMs: 0 },
        { phase: 'review', spentMs: 0 },
        { phase: 'pr', spentMs: 0 },
      ],
      eta: {
        next: { lo: at(60).toISOString(), hi: at(90).toISOString() },
        pr: { lo: at(90).toISOString(), hi: at(150).toISOString() },
        source: 'measured',
      },
    });
    // same phase: nothing accrues, the ETA counts the time already in it
    writeLane(d, args(['build', '--step', 'half way']), env(at(30)));
    expect(read(d).plan[0].spentMs).toBe(0);
    expect(read(d).eta.next).toEqual({ lo: at(60).toISOString(), hi: at(90).toISOString() });
    expect(read(d).files).toBe(12);
    // a change: build took 70 min
    expect(writeLane(d, args(['review']), env(at(70)))).toMatch(/· PR ~\d\d:\d\d–\d\d:\d\d$/);
    expect(read(d).plan[0].spentMs).toBe(70 * 60e3);
    expect(read(d).eta.pr).toEqual({ lo: at(100).toISOString(), hi: at(130).toISOString() });
    writeLane(d, args(['parked']), env(at(80)));
    expect(read(d).plan[1].spentMs).toBe(10 * 60e3);
    expect(read(d).eta).toBeNull();
    writeLane(d, args(['review']), env(at(200))); // 120 min parked: no step
    expect(read(d).plan.map((s: { spentMs: number }) => s.spentMs)).toEqual([
      70 * 60e3,
      10 * 60e3,
      0,
    ]);
    // a new plan keeps what each step has taken
    writeLane(d, args(['review', '--plan', 'review=30-50,pr=10-20?']), env(at(200)));
    expect(read(d).plan).toEqual([
      { phase: 'review', lo: 30, hi: 50, source: 'measured', spentMs: 10 * 60e3 },
      { phase: 'pr', lo: 10, hi: 20, source: 'guess', spentMs: 0 },
    ]);
    expect(read(d).eta.source).toBe('guess');
  });
  it('no plan and no flags writes no ETA', () => {
    const d = dir();
    expect(writeLane(d, args(['build']), env())).toBe('lane tower-web: build');
    expect(read(d)).toMatchObject({ plan: null, eta: null, files: null });
  });
  it('--clear removes the file; a bad branch name is refused', () => {
    const d = dir();
    writeLane(d, args(['build']), env());
    expect(writeLane(d, args(['--clear']), env())).toBe('lane tower-web: cleared');
    expect(existsSync(join(d, 'lanes/tower-web.json'))).toBe(false);
    expect(() => writeLane(d, args(['build']), { ...env(), branch: '../evil' })).toThrow(
      /not a lane name/,
    );
    expect(() => writeLane(d, args(['build']), { ...env(), branch: 'Feature/X' })).toThrow(
      /not a lane name/,
    );
  });
});

describe('readLanes / parseLane', () => {
  it('a missing dir is no lanes; a bad file is a problem row, never dropped', () => {
    expect(readLanes(dir())).toEqual({ lanes: [], problems: [] });
    const d = dir();
    mkdirSync(join(d, 'lanes'));
    writeLane(d, parseLaneArgs(['gate']), env());
    writeFileSync(join(d, 'lanes/broken.json'), '{nope');
    writeFileSync(
      join(d, 'lanes/other.json'),
      JSON.stringify({ v: 1, branch: 'tower-web', phase: 'gate', updatedAt: T0.toISOString() }),
    );
    const r = readLanes(d);
    expect(r.lanes.map((l) => l.branch)).toEqual(['tower-web']);
    expect(r.problems.map((p) => [p.file, p.problem.split(':')[0]])).toEqual([
      ['broken.json', 'not JSON'],
      ['other.json', 'branch missing or not the file name'],
    ]);
  });
  it('drops a non-https link and an unknown slot; cleans text', () => {
    const l = parseLane(
      JSON.stringify({
        v: 1,
        branch: 'x',
        phase: 'dev',
        updatedAt: T0.toISOString(),
        slot: 'prod',
        step: 'a\u001b[2Jb',
        needs: { what: 'w', link: 'javascript:alert(1)' },
      }),
      'x.json',
    );
    expect(l).toMatchObject({ slot: null, step: 'a[2Jb', needs: { what: 'w', link: null } });
    expect(parseLane(JSON.stringify({ v: 2 }), 'x.json')).toMatchObject({
      problem: 'v is 2, want 1',
    });
    expect(
      parseLane(
        JSON.stringify({ v: 1, branch: 'x', phase: 'nope', updatedAt: T0.toISOString() }),
        'x.json',
      ),
    ).toMatchObject({ problem: 'phase "nope"' });
  });
  it('reads the plan and ETAs; a malformed one is absent, never a problem row', () => {
    const base = { v: 1, branch: 'x', phase: 'build', updatedAt: T0.toISOString() };
    const good = {
      ...base,
      files: 9,
      plan: [{ phase: 'build', lo: 10, hi: 20, source: 'guess', spentMs: 600000 }],
      eta: { next: { lo: T0.toISOString(), hi: T1.toISOString() }, pr: null, source: 'guess' },
    };
    expect(parseLane(JSON.stringify(good), 'x.json')).toMatchObject({
      files: 9,
      plan: [{ phase: 'build', lo: 10, hi: 20, source: 'guess', spentMs: 600000 }],
      eta: { next: { lo: T0.getTime(), hi: T1.getTime() }, pr: null, source: 'guess' },
    });
    for (const bad of [
      { plan: [{ phase: 'ship', lo: 1, hi: 2, source: 'guess' }] },
      { plan: [{ phase: 'build', lo: 3, hi: 2, source: 'guess' }] },
      { plan: [{ phase: 'build', lo: 1, hi: 2, source: 'hunch' }] },
      { plan: 'build=1-2' },
      { eta: { next: { lo: T1.toISOString(), hi: T0.toISOString() }, source: 'guess' } },
      { eta: { next: { lo: T0.toISOString(), hi: T1.toISOString() }, source: 'hunch' } },
      { files: -1 },
    ]) {
      const l = parseLane(JSON.stringify({ ...base, ...bad }), 'x.json');
      expect(l).toMatchObject({ phase: 'build' });
      expect(l).toMatchObject({
        ...('plan' in bad ? { plan: null } : {}),
        ...('eta' in bad ? { eta: null } : {}),
      });
      if ('files' in bad) expect(l).toMatchObject({ files: null });
    }
    // an old file without them reads as before
    expect(parseLane(JSON.stringify(base), 'x.json')).toMatchObject({
      files: null,
      plan: null,
      eta: null,
    });
  });
});
