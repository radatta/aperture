import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSlot, tellingWhoToTell } from './cli.ts';
import { LockHeld } from './lock.ts';

const NOW = Date.parse('2026-10-13T20:00:00Z');
const holder = { branch: 'flux', sha: 'a'.repeat(40), expiresAt: '2026-10-13T20:30:00.000Z' };

function ctx(branch: () => string = () => 'ci-bot') {
  const dir = mkdtempSync(join(tmpdir(), 'bot-cli-'));
  const lines: string[] = [];
  return {
    dir,
    lines,
    c: {
      dir,
      branch,
      hub: () => 'dispatch',
      log: (s: string) => void lines.push(s),
      now: () => NOW,
    },
  };
}

describe('the refused acquire', () => {
  it('prints whom to tell, caches the holder, and rethrows the same error', async () => {
    const { dir, lines, c } = ctx();
    mkdirSync(join(dir, 'sessions'));
    writeFileSync(
      join(dir, 'sessions', '1.json'),
      JSON.stringify({ branch: 'flux', name: 'flux-session', state: 'working' }),
    );
    const refused = new LockHeld(holder);
    const err = await tellingWhoToTell(c, () => Promise.reject(refused)).catch((e: unknown) => e);
    expect(err).toBe(refused);
    expect(lines[0]).toMatch(/^dev is locked — send these now, once each/);
    expect(lines[1]).toMatch(
      /^ {2}SendMessage dispatch: "\[lock\] ci-bot — queued behind flux \(flux-session\)/,
    );
    expect(lines[2]).toMatch(/^ {2}SendMessage flux-session: "Queued behind you/);
    expect(JSON.parse(readFileSync(join(dir, 'devlock.json'), 'utf8')).holder).toEqual(holder);
  });

  it('passes other errors and successes through untouched', async () => {
    const { lines, c } = ctx();
    const other = new Error('HEAD is behind origin/main');
    await expect(tellingWhoToTell(c, () => Promise.reject(other))).rejects.toBe(other);
    expect(await tellingWhoToTell(c, () => Promise.resolve(7))).toBe(7);
    expect(lines).toEqual([]);
  });

  it('still rethrows the refusal when the branch lookup fails', async () => {
    const { lines, c } = ctx(() => {
      throw new Error('detached HEAD');
    });
    const refused = new LockHeld(holder);
    await expect(tellingWhoToTell(c, () => Promise.reject(refused))).rejects.toBe(refused);
    expect(lines[1]).toMatch(/\[lock\] <your branch> — queued behind flux;/);
  });

  it('names both holders and caches each slot when both refused', async () => {
    const { dir, lines, c } = ctx();
    const lc = { branch: 'lc', sha: 'b'.repeat(40), expiresAt: '2026-10-13T20:20:00.000Z' };
    const refused = new LockHeld(holder, 'dev', [{ slot: 'devb', holder: lc }]);
    await expect(tellingWhoToTell(c, () => Promise.reject(refused))).rejects.toBe(refused);
    expect(lines[0]).toMatch(/^both dev slots are locked — .*`pnpm bot lock wait --any`/);
    expect(lines[1]).toMatch(/queued behind flux on dev and lc on devb; lock wait --any next/);
    expect(JSON.parse(readFileSync(join(dir, 'devlock.json'), 'utf8')).holder).toEqual(holder);
    expect(JSON.parse(readFileSync(join(dir, 'devlock.devb.json'), 'utf8')).holder).toEqual(lc);
  });
});

describe('--slot', () => {
  it('names a slot, or is misuse', () => {
    expect(parseSlot(undefined)).toBeUndefined();
    expect(parseSlot('dev')).toBe('dev');
    expect(parseSlot('devb')).toBe('devb');
    for (const bad of ['true', 'prod', 'devc', ''])
      expect(() => parseSlot(bad)).toThrow(/--slot must be/);
  });
});
