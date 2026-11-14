import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLane, parseLaneArgs, readLanes, writeLane, type LaneArgs } from './lanes.ts';

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
});
