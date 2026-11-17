import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOG_GROUPS, parseLogsRequest } from './logs-spec.ts';
import { identifierRules, type Identifiers } from '../identifiers.ts';
import type { Api } from './api.ts';
import { checkLoopGuard, defaultGroups, fetchLogs, parseSince, refuseIdentifiers } from './logs.ts';
import type { Run as Sh } from './sh.ts';

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

describe('default groups (no --groups)', () => {
  const run = async (branch: string | null, held: () => Promise<'dev' | 'devb' | null>) => {
    const lines: string[] = [];
    const groups = await defaultGroups(branch, held, (l) => lines.push(l));
    return { groups, lines };
  };
  it("reads the held slot's groups: devb's with -devb, and says so", async () => {
    expect(await run('b', async () => 'devb')).toEqual({
      groups: 'bff-devb,mcp-devb',
      lines: ["b holds the devb lock — reading devb's groups (--groups to choose)"],
    });
    expect(await run('a', async () => 'dev')).toEqual({ groups: 'bff,mcp', lines: [] });
    expect(await run('n', async () => null)).toEqual({ groups: 'bff,mcp', lines: [] });
  });
  it('a failed lock read says so, then reads slot A', async () => {
    const r = await run('b', () => Promise.reject(new Error('HTTP 502')));
    expect(r.groups).toBe('bff,mcp');
    expect(r.lines).toEqual([
      "couldn't read the dev locks (HTTP 502) — reading slot A's groups; --groups to choose",
    ]);
  });
  it('a detached checkout reads no lock', async () => {
    let asked = false;
    expect(await run(null, async () => ((asked = true), 'devb'))).toEqual({
      groups: 'bff,mcp',
      lines: [],
    });
    expect(asked).toBe(false);
  });
});

describe('identifier guard (the dispatch inputs are public)', () => {
  // Made up: no real identifier is in this file (tracked-identifiers.test.ts scans it).
  const fake: Identifiers = {
    maintainer: { name: 'Quillon Varnaby', github: 'qv-example' },
    repo: 'example/aperture',
    email: { contact: 'a@example.com', alerts: 'b@example.com', devTestUser: 'c@example.com' },
    domains: {
      apex: 'example.com',
      prod: 'a.example.com',
      dev: 'd.example.com',
      devb: 'e.example.com',
    },
    aws: { devAccountId: '123456789012', region: 'us-west-2', prodAccountSha256: 'a'.repeat(64) },
    bundlePrefix: 'com.example',
  };
  const rules = identifierRules(fake, null);
  const home = ['', 'Users', 'someone', 'logs'].join('/');

  it('refuses a name in --filter, naming the flag and kind but never the value', () => {
    let msg = '';
    try {
      refuseIdentifiers({ filter: '"quillon"' }, rules);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/^PERSONAL_IDENTIFIER — --filter names a personal identifier \(name\)/);
    expect(msg).toMatch(/nothing was dispatched/);
    expect(msg.toLowerCase()).not.toContain('quillon');
  });
  it('refuses an account id in --query (dashed too) and a home path in --groups', () => {
    expect(() =>
      refuseIdentifiers({ query: 'filter @message like /1234-5678-9012/' }, rules),
    ).toThrow(/--query .*\(account-id\)/);
    expect(() => refuseIdentifiers({ groups: `bff,${home}` }, rules)).toThrow(
      /--groups .*\(home-path\)/,
    );
  });
  it('lets ordinary values through', () => {
    expect(() =>
      refuseIdentifiers(
        { filter: 'ERROR', query: 'fields @timestamp, @message', groups: 'bff,mcp' },
        rules,
      ),
    ).not.toThrow();
    expect(() => refuseIdentifiers({}, rules)).not.toThrow();
  });
  it('refuses before anything is spent: no API call, no git, no ledger line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devlogs-guard-'));
    const api = (() => {
      throw new Error('api called');
    }) as unknown as Api;
    const sh = (() => {
      throw new Error('sh called');
    }) as unknown as Sh;
    const clock = { now: () => NOW, sleep: async () => {} };
    await expect(
      fetchLogs(sh, api, 'token', clock, { filter: 'Varnaby' }, root, () => {}, rules),
    ).rejects.toThrow(/PERSONAL_IDENTIFIER/);
    expect(existsSync(join(root, 'localNotes', 'devlogs', 'fetches.jsonl'))).toBe(false);
  });
  it('refuses a branch name (the run key, public in the run name) the same way', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devlogs-guard-'));
    const sh = ((cmd: string) => (cmd === 'git' ? 'varnaby-fix' : '')) as unknown as Sh;
    const api = (() => {
      throw new Error('api called');
    }) as unknown as Api;
    const clock = { now: () => NOW, sleep: async () => {} };
    await expect(
      fetchLogs(sh, api, 'token', clock, { groups: 'bff' }, root, () => {}, rules),
    ).rejects.toThrow(/PERSONAL_IDENTIFIER — the run key \(branch name\) .*\(name\)/);
    expect(existsSync(join(root, 'localNotes', 'devlogs', 'fetches.jsonl'))).toBe(false);
  });
  it('dispatches --start/--end normalised to ISO, so words around a date never reach the inputs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devlogs-guard-'));
    const sh = ((cmd: string) => (cmd === 'git' ? 'some-branch' : '')) as unknown as Sh;
    let sent: Record<string, string> | null = null;
    const api = (async (_m: string, _p: string, body?: { inputs: Record<string, string> }) => {
      sent = body!.inputs;
      throw new Error('stop here');
    }) as unknown as Api;
    const clock = { now: () => NOW, sleep: async () => {} };
    const args = {
      start: 'note Oct 13 2026 19:30 UTC',
      end: 'Oct 13 2026 19:45 UTC (note)',
      groups: 'bff',
    };
    await expect(fetchLogs(sh, api, 'token', clock, args, root, () => {}, rules)).rejects.toThrow(
      /stop here/,
    );
    expect(sent).toMatchObject({
      start: '2026-10-13T19:30:00.000Z',
      end: '2026-10-13T19:45:00.000Z',
    });
  });
});
