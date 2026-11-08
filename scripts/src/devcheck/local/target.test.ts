import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { assertMcpTestUser } from '../mcp-login';
import {
  assertTestUser,
  cognitoAuthority,
  decodeJwtPayload,
  sessionFromStorage,
  userStoreKey,
} from '../token';
import { renderReport, type RowResult, type RunResult } from '../report';
import { LOCAL_NOT_PASTE, toLocalReport } from './run-local';
import {
  LOCAL_APP_CLIENT,
  LOCAL_CLAUDE_CLIENT,
  LOCAL_POOL_ID,
  LOCAL_SUB,
  localMcpSession,
  makeLocalAuth,
  seededState,
} from './target';

describe('useLocalOrigin — the one way off dev, and only to loopback', () => {
  it('accepts only http://127.0.0.1:<port>, then targets it and nothing else', async () => {
    vi.resetModules();
    const c = await import('../config');
    for (const bad of [
      'https://dev.aperture.rahuldatta.dev',
      'https://aperture.rahuldatta.dev',
      'http://localhost:4000',
      'http://0.0.0.0:4000',
      'https://127.0.0.1:4000',
      'http://127.0.0.1',
      'http://127.0.0.1:4000/x',
    ])
      expect(() => c.useLocalOrigin(bad), bad).toThrow(/refusing/);
    expect(c.targetOrigin()).toBe(c.DEV_ORIGIN);
    c.useLocalOrigin('http://127.0.0.1:4000');
    expect(c.targetOrigin()).toBe('http://127.0.0.1:4000');
    expect(() => c.assertDevOrigin('http://127.0.0.1:4000/api/x')).not.toThrow();
    expect(() => c.assertDevOrigin(`${c.DEV_ORIGIN}/api/x`)).toThrow(/refusing/);
    vi.resetModules();
  });
});

describe('makeLocalAuth', () => {
  const auth = makeLocalAuth(() => 1_800_000_000_000);
  const key = createPublicKey({ key: auth.jwks.keys[0] as never, format: 'jwk' });
  const verifies = (jwt: string) => {
    const [h, p, s] = jwt.split('.');
    return verify('sha256', Buffer.from(`${h}.${p}`), key, Buffer.from(s!, 'base64url'));
  };

  it('signs access tokens the JWKS verifies, as the pool’s issuer, for the asked client', () => {
    const { token, expiresAt } = auth.mint(LOCAL_CLAUDE_CLIENT);
    expect(verifies(token)).toBe(true);
    expect(decodeJwtPayload(token)).toMatchObject({
      iss: cognitoAuthority(LOCAL_POOL_ID),
      token_use: 'access',
      client_id: LOCAL_CLAUDE_CLIENT,
      sub: LOCAL_SUB,
      exp: expiresAt,
    });
    expect(expiresAt - 1_800_000_000).toBe(12 * 3600);
  });
  it('a new run is a new key: another run’s token does not verify', () => {
    expect(verifies(makeLocalAuth().mint(LOCAL_APP_CLIENT).token)).toBe(false);
  });
  it('the JWKS carries the public half only', () => {
    expect(Object.keys(auth.jwks.keys[0]!).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
  });
  it('a fresh origin secret per run', () => {
    expect(auth.originSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(makeLocalAuth().originSecret).not.toBe(auth.originSecret);
  });
});

describe('seededState and localMcpSession — through the dev check’s own identity guards', () => {
  const auth = makeLocalAuth();
  it('seeds the app’s oidc store for the run’s origin, as the test user', () => {
    const state = seededState(auth, 'http://127.0.0.1:4000') as {
      origins: { origin: string; localStorage: { name: string; value: string }[] }[];
    };
    expect(state.origins.map((o) => o.origin)).toEqual(['http://127.0.0.1:4000']);
    const storage = Object.fromEntries(
      state.origins[0]!.localStorage.map((x) => [x.name, x.value]),
    );
    const session = sessionFromStorage(
      storage,
      userStoreKey(cognitoAuthority(LOCAL_POOL_ID), LOCAL_APP_CLIENT),
    );
    expect(session).not.toBeNull();
    expect(() => assertTestUser(session!, auth.env.DEVCHECK_SUB)).not.toThrow();
    expect(decodeJwtPayload(session!.accessToken).client_id).toBe(LOCAL_APP_CLIENT);
  });
  it('the MCP session is the claude client’s access token', () => {
    expect(() => assertMcpTestUser(localMcpSession(auth), auth.env)).not.toThrow();
  });
});

describe('toLocalReport', () => {
  it('retitles the report and never says "on dev" for a local proof', () => {
    const md = [
      '# Dev check — PASS',
      'Proven on dev **3** · off dev **1**',
      '### Not proven on dev',
      '| a | proven on dev |',
      '### Deferred (slow tier)',
    ].join('\n');
    expect(toLocalReport(md)).toBe(
      [
        '# Local check — PASS (pre-flight; dev remains the proof)',
        'Proven locally **3** · off dev **1**',
        '### Not proven locally',
        '| a | proven locally |',
        '### Deferred (slow tier, or runs on dev)',
      ].join('\n'),
    );
  });
});

describe('toLocalReport over a real render', () => {
  const row = (scenario: string, status: RowResult['status'], note?: string): RowResult => ({
    scenario,
    row: `${scenario}-r`,
    entry: 'ui',
    kind: 'nominal',
    what: `${scenario} row`,
    status,
    provenBy: 'steps a (ui)',
    ...(note ? { note } : {}),
  });
  const result: RunResult = {
    runId: 'r1',
    tier: 'full',
    feature: ['feat'],
    expectedSha: 'a'.repeat(40),
    status: 'PASS',
    codes: [],
    failures: [],
    coverage: [
      row('feat', 'pass'),
      row('feat', 'needs-you', 'a phone'),
      row('other', 'pass'),
      row('fin', 'deferred', 'local: the Plaid Sandbox fixture bank is dev’s — runs on dev'),
    ],
    steps: [],
    created: [],
    swept: [],
    unrecorded: [],
    orphanIntents: [],
    blockedDeletes: [],
    failedDeletes: [],
    consoleErrors: [],
    throttled: [],
    failedLoads: [],
    injected: [],
    shots: [],
    durationMs: 1000,
  };
  const md = toLocalReport(renderReport(result));
  it('never carries a paste list or an "on dev" proof', () => {
    expect(md).not.toMatch(/^#+ You don't need to test$/m);
    expect(md).not.toMatch(/^#+ Needs you$/m);
    expect(md).not.toMatch(/[Pp]roven on dev/);
    expect(md).toContain(LOCAL_NOT_PASTE);
    expect(md.split('\n')[0]).toBe('# Local check — PASS (pre-flight; dev remains the proof)');
  });
  it('a local deferral says why, and never that --tier all runs it', () => {
    expect(md).toContain(
      'fin: fin row — local: the Plaid Sandbox fixture bank is dev’s — runs on dev',
    );
    expect(md).not.toContain('`--tier all` runs them._');
  });
});
