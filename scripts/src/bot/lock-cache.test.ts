import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { holderSession, writeLockCache } from './lock-cache.ts';

const NOW = Date.parse('2026-10-13T20:00:00Z');
const held = { branch: 'flux', sha: 'a'.repeat(40), expiresAt: '2026-10-13T20:45:00.000Z' };

describe('lock cache', () => {
  it("writes the board's devlock.json for a held and a free lock", () => {
    const dir = mkdtempSync(join(tmpdir(), 'lock-cache-'));
    writeLockCache(dir, held, NOW);
    expect(JSON.parse(readFileSync(join(dir, 'devlock.json'), 'utf8'))).toEqual({
      v: 1,
      t: '2026-10-13T20:00:00.000Z',
      source: 'bot',
      holder: held,
    });
    writeLockCache(dir, null, NOW + 1000);
    expect(JSON.parse(readFileSync(join(dir, 'devlock.json'), 'utf8')).holder).toBeNull();
  });

  it('never throws or creates a board where there is none', () => {
    const gone = join(tmpdir(), `no-board-${process.pid}`);
    expect(() => writeLockCache(null, held, NOW)).not.toThrow();
    expect(() => writeLockCache(gone, held, NOW)).not.toThrow();
    expect(existsSync(gone)).toBe(false);
  });

  it('maps the holder branch to its live session, skipping gone ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lock-cache-'));
    mkdirSync(join(dir, 'sessions'));
    const reg = (pid: number, s: object) =>
      writeFileSync(join(dir, 'sessions', `${pid}.json`), JSON.stringify(s));
    reg(1, { branch: 'flux', name: 'flux-session', state: 'working' });
    reg(2, { branch: 'old', name: 'old-session', state: 'gone' });
    writeFileSync(join(dir, 'sessions', '3.json'), '{"branch":'); // half-written
    expect(holderSession(dir, 'flux')).toBe('flux-session');
    expect(holderSession(dir, 'old')).toBeUndefined();
    expect(holderSession(null, 'flux')).toBeUndefined();
  });
});
