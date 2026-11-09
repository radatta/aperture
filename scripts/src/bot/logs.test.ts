import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOG_GROUPS, parseLogsRequest } from './logs-spec.ts';
import { checkLoopGuard, parseSince } from './logs.ts';

const NOW = Date.parse('2026-10-13T20:00:00Z');
const req = (over: Partial<{ start: string; end: string; groups: string; key: string }> = {}) =>
  parseLogsRequest(
    {
      start: '2026-10-13T19:30:00Z',
      end: '2026-10-13T20:00:00Z',
      groups: 'bff,mcp',
      key: 'ci-bot-k',
      ...over,
    },
    NOW,
  );

describe('dev logs request', () => {
  it('maps the allowlist to -dev groups only', () => {
    expect(req({ groups: 'bff,mcp,finance-sync' }).groupNames).toEqual([
      '/aws/lambda/aperture-bff-dev',
      '/aws/lambda/aperture-mcp-dev',
      '/aws/lambda/aperture-finance-sync-dev',
    ]);
    for (const name of Object.values(LOG_GROUPS)) expect(name).toMatch(/-devb?$/);
  });

  it('covers four functions on each dev slot, slot B keyed with -devb', () => {
    const fns = ['bff', 'mcp', 'finance-sync', 'push-dispatch'];
    expect(Object.keys(LOG_GROUPS).sort()).toEqual([...fns, ...fns.map((f) => `${f}-devb`)].sort());
    expect(req({ groups: 'bff-devb,push-dispatch' }).groupNames).toEqual([
      '/aws/lambda/aperture-bff-devb',
      '/aws/lambda/aperture-push-dispatch-dev',
    ]);
  });

  it.each(['bff-prod', '/aws/lambda/aperture-bff-prod', 'aperture-bff-prod', '*', 'bff,prod'])(
    'rejects %s',
    (groups) => {
      expect(() => req({ groups })).toThrow(/unknown log group/);
    },
  );

  it('caps the window at 6 h', () => {
    expect(() => req({ start: '2026-10-13T13:59:59Z' })).toThrow(/longer than 6 h/);
    expect(req({ start: '2026-10-13T14:00:00Z' }).groups).toEqual(['bff', 'mcp']);
  });

  it('rejects inverted, future and malformed windows, and unsafe keys', () => {
    expect(() => req({ end: '2026-10-13T19:00:00Z' })).toThrow(/after start/);
    expect(() => req({ start: '2026-10-13T21:00:00Z', end: '2026-10-13T22:00:00Z' })).toThrow(
      /future/,
    );
    expect(() => req({ start: 'yesterday' })).toThrow(/ISO/);
    expect(() => req({ key: 'a b' })).toThrow(/key/);
  });

  it('dedupes groups', () => {
    expect(req({ groups: 'bff, bff ,mcp' }).groups).toEqual(['bff', 'mcp']);
  });

  it('parses --since', () => {
    expect(parseSince('30m')).toBe(30 * 60_000);
    expect(parseSince('2h')).toBe(2 * 60 * 60_000);
    expect(() => parseSince('30')).toThrow(/--since/);
  });
});

describe('logs loop guard', () => {
  const ledger = (ats: number[]) => {
    const f = join(mkdtempSync(join(tmpdir(), 'devlogs-')), 'fetches.jsonl');
    writeFileSync(f, ats.map((at) => JSON.stringify({ at })).join('\n'));
    return f;
  };

  it('allows the 10th fetch in an hour and refuses the 11th', () => {
    const nine = Array.from({ length: 9 }, (_, i) => NOW - i * 60_000);
    expect(() => checkLoopGuard(ledger(nine), NOW)).not.toThrow();
    expect(() => checkLoopGuard(ledger([...nine, NOW - 30 * 60_000]), NOW)).toThrow(
      /10 dev-log fetches in the last hour/,
    );
  });

  it('forgets fetches older than an hour', () => {
    const old = Array.from({ length: 20 }, () => NOW - 61 * 60_000);
    expect(() => checkLoopGuard(ledger(old), NOW)).not.toThrow();
  });

  it('starts empty without a ledger', () => {
    expect(() => checkLoopGuard(join(tmpdir(), 'no-ledger-here.jsonl'), NOW)).not.toThrow();
  });
});
