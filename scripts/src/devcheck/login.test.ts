import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEV_ORIGIN, TEST_USER_EMAIL, TEST_USERS, type DevcheckEnv } from './config';
import type { FetchLike } from './api';
import {
  cachedState,
  launchCached,
  LAUNCH_RENEW_TIMEOUT_MS,
  readCheckedSession,
  refreshSession,
} from './login';
import type { PwModule, PwPage } from './pw-types';
import { cognitoAuthority, userStoreKey } from './token';

const env = {
  DEVCHECK_POOL_ID: 'us-west-1_ABC',
  DEVCHECK_CLIENT_ID: 'c1',
  DEVCHECK_SUB: 's1',
} as DevcheckEnv;
const jwt = (sub: string) => `h.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.sig`;
const state = (sub: string, email: string) =>
  JSON.stringify({
    cookies: [],
    origins: [
      {
        origin: DEV_ORIGIN,
        localStorage: [
          {
            name: userStoreKey(cognitoAuthority(env.DEVCHECK_POOL_ID), env.DEVCHECK_CLIENT_ID),
            value: JSON.stringify({ access_token: jwt(sub), profile: { sub, email } }),
          },
        ],
      },
    ],
  });

describe('cachedState: the identity check before any page loads', () => {
  const file = (text: string) => {
    const path = join(mkdtempSync(join(tmpdir(), 'state-')), 'state.json');
    writeFileSync(path, text);
    return path;
  };
  // No refresh token in these fixtures, so no grant: only the check runs.
  const check = (path: string, log = vi.fn()) =>
    cachedState(path, env, { fetch: vi.fn<FetchLike>(), now: () => 0, log });
  it("keeps the test user's cached session", async () => {
    const path = file(state('s1', TEST_USER_EMAIL));
    expect(await check(path)).toEqual(JSON.parse(state('s1', TEST_USER_EMAIL)));
    expect(existsSync(path)).toBe(true);
  });
  it('discards a cached session for anyone else, before any page loads', async () => {
    const path = file(state('s9', 'someone@example.com'));
    const log = vi.fn();
    expect(await check(path, log)).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/WRONG_USER/));
  });
  it('checks every oidc user entry, not only the env client id', async () => {
    const other = JSON.parse(state('s1', TEST_USER_EMAIL));
    other.origins[0].localStorage.push({
      name: 'oidc.user:https://elsewhere:old-client',
      value: JSON.stringify({
        access_token: jwt('s9'),
        profile: { sub: 's9', email: 'x@example.com' },
      }),
    });
    const path = file(JSON.stringify(other));
    await check(path);
    expect(existsSync(path)).toBe(false);
  });
  it('discards an unreadable cache without quoting it, and ignores a missing one', async () => {
    const path = file('{"refresh_token":"RT-SECRET" not json');
    const log = vi.fn();
    expect(await check(path, log)).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(log).toHaveBeenCalledWith('discarding the cached session (unreadable)');
    expect(await check(path)).toBeUndefined();
  });
});

describe('readCheckedSession', () => {
  const page = (sub: string, email: string) =>
    ({
      evaluate: async () =>
        Object.fromEntries(
          JSON.parse(state(sub, email)).origins[0].localStorage.map(
            (x: { name: string; value: string }) => [x.name, x.value],
          ),
        ),
    }) as unknown as PwPage;
  it("returns the test user's session", async () => {
    expect((await readCheckedSession(page('s1', TEST_USER_EMAIL), env))?.sub).toBe('s1');
  });
  it('throws WRONG_USER for anyone else', async () => {
    await expect(readCheckedSession(page('s9', 'x@example.com'), env)).rejects.toThrow(
      /WRONG_USER/,
    );
  });
});

describe('the browser lane’s user: every caller checks against its env’s user, not the Simulator’s', () => {
  const wenv = { ...env, DEVCHECK_EMAIL: TEST_USERS.web, DEVCHECK_SUB: 'sw' } as DevcheckEnv;
  const file = (text: string) => {
    const path = join(mkdtempSync(join(tmpdir(), 'state-')), 'state.json');
    writeFileSync(path, text);
    return path;
  };
  const page = (sub: string, email: string) =>
    ({
      evaluate: async () =>
        Object.fromEntries(
          JSON.parse(state(sub, email)).origins[0].localStorage.map(
            (x: { name: string; value: string }) => [x.name, x.value],
          ),
        ),
    }) as unknown as PwPage;
  const check = (path: string, log = vi.fn()) =>
    cachedState(path, wenv, { fetch: vi.fn<FetchLike>(), now: () => 0, log });

  it('cachedState keeps the browser user’s cache and discards the Simulator user’s, before any page loads', async () => {
    const mine = file(state('sw', TEST_USERS.web));
    expect(await check(mine)).toEqual(JSON.parse(state('sw', TEST_USERS.web)));
    const theirs = file(state('s1', TEST_USER_EMAIL)); // a main-user state file in the web user's slot
    const log = vi.fn();
    expect(await check(theirs, log)).toBeUndefined();
    expect(existsSync(theirs)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/WRONG_USER/));
  });

  it('readCheckedSession: the browser user’s session reads; the Simulator user’s is WRONG_USER', async () => {
    expect((await readCheckedSession(page('sw', TEST_USERS.web), wenv))?.email).toBe(
      TEST_USERS.web,
    );
    await expect(readCheckedSession(page('s1', TEST_USER_EMAIL), wenv)).rejects.toThrow(
      /WRONG_USER/,
    );
    await expect(readCheckedSession(page('sw', TEST_USER_EMAIL), wenv)).rejects.toThrow(
      /WRONG_USER/,
    );
  });

  it('refreshSession: a renewal that comes back as the Simulator’s user is WRONG_USER', async () => {
    const HOST = 'aperture-dev-123456789012.auth.us-west-1.amazoncognito.com';
    const renv = { ...wenv, DEVCHECK_COGNITO_HOST: HOST } as DevcheckEnv;
    const key = userStoreKey(cognitoAuthority(renv.DEVCHECK_POOL_ID), renv.DEVCHECK_CLIENT_ID);
    const claims = (p: Record<string, unknown>) =>
      `h.${Buffer.from(JSON.stringify(p)).toString('base64url')}.sig`;
    const pg = {
      evaluate: async () => ({
        [key]: JSON.stringify({
          access_token: jwt('sw'),
          refresh_token: 'RT-W',
          profile: { sub: 'sw' },
        }),
      }),
    } as unknown as PwPage;
    const as = (email: string) =>
      vi.fn<FetchLike>(async () => ({
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: claims({ sub: 'sw', exp: 5000 }),
            id_token: claims({ sub: 'sw', email }),
            expires_in: 3600,
          }),
      }));
    expect(await refreshSession(pg, renv, as(TEST_USERS.web), () => 0)).toMatchObject({
      email: TEST_USERS.web,
    });
    await expect(refreshSession(pg, renv, as(TEST_USER_EMAIL), () => 0)).rejects.toThrow(
      /WRONG_USER/,
    );
  });
});

describe('refreshSession', () => {
  const HOST = 'aperture-dev-123456789012.auth.us-west-1.amazoncognito.com';
  const renv = {
    ...env,
    DEVCHECK_COGNITO_HOST: HOST,
    DEVCHECK_CLIENT_ID: 'app-client',
  } as DevcheckEnv;
  const key = userStoreKey(cognitoAuthority(renv.DEVCHECK_POOL_ID), renv.DEVCHECK_CLIENT_ID);
  const claims = (p: Record<string, unknown>) =>
    `h.${Buffer.from(JSON.stringify(p)).toString('base64url')}.sig`;
  const page = (user: Record<string, unknown>) =>
    ({ evaluate: async () => ({ [key]: JSON.stringify(user) }) }) as unknown as PwPage;
  const stored = { access_token: jwt('s1'), refresh_token: 'RT-1', profile: { sub: 's1' } };
  const grant = (status: number, sub = 's1', email = TEST_USER_EMAIL, extra = {}) =>
    vi.fn<FetchLike>(async () => ({
      status,
      text: async () =>
        JSON.stringify(
          status === 200
            ? {
                access_token: claims({ sub, exp: 5000 }),
                id_token: claims({ sub, email }),
                expires_in: 3600,
              }
            : { error: 'invalid_grant', ...extra },
        ),
    }));

  it("renews with the page's refresh token at the dev pool's token endpoint", async () => {
    const fetch = grant(200);
    const s = await refreshSession(page(stored), renv, fetch, () => 0);
    expect(s).toMatchObject({ sub: 's1', email: TEST_USER_EMAIL, expiresAt: 5000 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://${HOST}/oauth2/token`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      grant_type: 'refresh_token',
      client_id: 'app-client',
      refresh_token: 'RT-1',
    });
  });
  it('is null, with no request, when the page keeps no refresh token', async () => {
    const fetch = grant(200);
    expect(
      await refreshSession(page({ access_token: jwt('s1') }), renv, fetch, () => 0),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('throws WRONG_USER when the renewed identity is not the test user', async () => {
    await expect(
      refreshSession(page(stored), renv, grant(200, 's9', 'x@example.com'), () => 0),
    ).rejects.toThrow(/WRONG_USER/);
  });
  it('an unreadable stored session is AUTH_REJECTED, never quoting the record', async () => {
    const torn = {
      evaluate: async () => ({ [key]: '{"refresh_token":"RT-SECRET"' }),
    } as unknown as PwPage;
    const fetch = grant(200);
    const err = await refreshSession(torn, renv, fetch, () => 0).catch((e: unknown) => e as Error);
    expect(String(err)).toMatch(/AUTH_REJECTED.*unreadable/);
    expect(String(err)).not.toMatch(/RT-SECRET/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("throws AUTH_REJECTED naming Cognito's error, never the body or the token", async () => {
    const err = await refreshSession(
      page(stored),
      renv,
      grant(400, 's1', TEST_USER_EMAIL, { detail: 'SECRETBODY' }),
      () => 0,
    ).catch((e: unknown) => e as Error);
    expect(String(err)).toMatch(/AUTH_REJECTED.*session refresh.*HTTP 400 invalid_grant/);
    expect(String(err)).not.toMatch(/SECRETBODY|RT-1/);
  });
});

describe('cachedState', () => {
  const HOST = 'aperture-dev-123456789012.auth.us-west-1.amazoncognito.com';
  const cenv = { ...env, DEVCHECK_COGNITO_HOST: HOST } as DevcheckEnv;
  const key = userStoreKey(cognitoAuthority(cenv.DEVCHECK_POOL_ID), cenv.DEVCHECK_CLIENT_ID);
  const claims = (p: Record<string, unknown>) =>
    `h.${Buffer.from(JSON.stringify(p)).toString('base64url')}.sig`;
  const NOW = 1_800_000_000_000; // ms
  const NEW_EXP = NOW / 1000 + 3540; // the access token's own exp — not NOW + expires_in
  const OLD_AT = claims({ sub: 's1', exp: 1 });
  const NEW_AT = claims({ sub: 's1', exp: NEW_EXP, n: 'new' });
  const NEW_ID = claims({ sub: 's1', email: TEST_USER_EMAIL, n: 'new' });
  // A cached file as the harness saves it: the app's record, another key and the Hosted UI cookie; expiresIn is
  // seconds from NOW (negative: expired).
  const cache = (
    expiresIn: number | undefined,
    extra: Record<string, unknown> = {},
    name = key,
  ) => {
    const path = join(mkdtempSync(join(tmpdir(), 'state-')), 'state.json');
    writeFileSync(
      path,
      JSON.stringify({
        cookies: [{ name: 'cognito', value: 'COOKIE-1' }],
        origins: [
          {
            origin: DEV_ORIGIN,
            localStorage: [
              { name: 'theme', value: 'dark' },
              {
                name,
                value: JSON.stringify({
                  access_token: OLD_AT,
                  id_token: 'OLD-ID',
                  refresh_token: 'RT-1',
                  token_type: 'Bearer',
                  ...(expiresIn === undefined ? {} : { expires_at: NOW / 1000 + expiresIn }),
                  profile: { sub: 's1', email: TEST_USER_EMAIL },
                  ...extra,
                }),
              },
            ],
          },
        ],
      }),
    );
    return path;
  };
  const grant = (status: number, body: Record<string, unknown> = {}) =>
    vi.fn<FetchLike>(async () => ({
      status,
      text: async () =>
        JSON.stringify(
          status === 200
            ? { access_token: NEW_AT, id_token: NEW_ID, expires_in: 3600, ...body }
            : body,
        ),
    }));
  const record = (state: unknown) => {
    const s = state as { origins: { localStorage: { name: string; value: string }[] }[] };
    return JSON.parse(s.origins[0]!.localStorage.find((x) => x.name === key)!.value) as Record<
      string,
      unknown
    >;
  };
  const fakePw = () => {
    const newContext = vi.fn(async () => ({}));
    const pw = {
      chromium: { launch: vi.fn(async () => ({ newContext })) },
    } as unknown as PwModule;
    return { pw, newContext };
  };
  const deps = (fetch: FetchLike, log: (msg: string) => void = vi.fn()) => ({
    fetch,
    now: () => NOW,
    log,
  });
  const run = (path: string, fetch: FetchLike, log?: (msg: string) => void) =>
    cachedState(path, cenv, deps(fetch, log));

  it("launchCached renews a cache older than the token's life before the browser loads it", async () => {
    const path = cache(-3 * 3600);
    const before = readFileSync(path, 'utf8');
    const fetch = grant(200);
    const log = vi.fn();
    const { pw, newContext } = fakePw();
    await launchCached(pw, path, cenv, deps(fetch, log));
    const opts = (newContext.mock.calls[0] as unknown[])[0] as { storageState: unknown };
    expect(record(opts.storageState)).toEqual({
      access_token: NEW_AT,
      id_token: NEW_ID,
      refresh_token: 'RT-1',
      token_type: 'Bearer',
      expires_at: NEW_EXP,
      profile: { sub: 's1', email: TEST_USER_EMAIL },
    });
    expect(JSON.stringify(opts)).not.toContain(OLD_AT);
    expect(JSON.stringify(opts)).toContain('"theme","value":"dark"'); // the page's other keys stay
    expect(JSON.stringify(opts)).toContain('COOKIE-1'); // and the Hosted UI cookie
    expect(fetch.mock.invocationCallOrder[0]).toBeLessThan(
      (pw.chromium.launch as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
    expect(readFileSync(path, 'utf8')).toBe(before); // memory only: the file is re-saved after sign-in
    expect(log).toHaveBeenCalledWith(
      'renewed the cached session before launch (it expired 180 min before)',
    );
  });
  it('renews a cache with time left too — whatever its age', async () => {
    for (const [left, said] of [
      [3500, 'had 58 min left'],
      [30, 'had 0 min left'],
      [-30, 'expired 0 min before'],
      [undefined, 'had no expiry'],
    ] as const) {
      const log = vi.fn();
      expect(record(await run(cache(left), grant(200), log)).access_token).toBe(NEW_AT);
      expect(log).toHaveBeenCalledWith(`renewed the cached session before launch (it ${said})`);
    }
  });
  it("posts the refresh grant to the dev pool's token endpoint, refusing a redirect", async () => {
    const fetch = grant(200);
    await run(cache(-60), fetch);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://${HOST}/oauth2/token`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      grant_type: 'refresh_token',
      client_id: 'c1',
      refresh_token: 'RT-1',
    });
  });
  it('keeps a rotated refresh token', async () => {
    const out = await run(cache(-60), grant(200, { refresh_token: 'RT-2' }));
    expect(record(out).refresh_token).toBe('RT-2');
  });
  it('a dead refresh token (invalid_grant) discards the cache, so the run signs in by the form', async () => {
    const path = cache(-60);
    const log = vi.fn();
    const { pw, newContext } = fakePw();
    await launchCached(pw, path, cenv, deps(grant(400, { error: 'invalid_grant' }), log));
    expect(existsSync(path)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/discarding.*invalid_grant/));
    expect((newContext.mock.calls[0] as unknown[])[0]).not.toHaveProperty('storageState');
  });
  it('any other failure loads the cache as it is, with one log line', async () => {
    const down = vi.fn<FetchLike>(async () => {
      throw new Error('ECONNRESET');
    });
    for (const fetch of [
      down,
      grant(503, { error: 'server_error' }),
      grant(200, { id_token: 7 }),
      grant(200, { id_token: 'h.not-json.sig' }),
    ]) {
      const path = cache(-60);
      const before = JSON.parse(readFileSync(path, 'utf8'));
      const log = vi.fn();
      expect(await run(path, fetch, log)).toEqual(before);
      expect(existsSync(path)).toBe(true);
      expect(log).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/not renewed.*loading it as cached/));
    }
  });
  it('a token endpoint that never answers is cancelled at the timeout and the cache loads as it is', async () => {
    vi.useFakeTimers();
    try {
      const path = cache(-60);
      const log = vi.fn();
      let signal: AbortSignal | undefined;
      const hung = vi.fn<FetchLike>((_, init) => {
        signal = init.signal;
        return new Promise(() => {});
      });
      const out = run(path, hung, log);
      await vi.advanceTimersByTimeAsync(LAUNCH_RENEW_TIMEOUT_MS);
      expect(record(await out).access_token).toBe(OLD_AT);
      expect(signal?.aborted).toBe(true);
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/took over 15 s.*loading it as cached/),
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it('a renew that answers leaves no timer behind', async () => {
    vi.useFakeTimers();
    try {
      await run(cache(-60), grant(200));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('renewed tokens for anyone else throw WRONG_USER before any browser, and the cache goes', async () => {
    const path = cache(-60);
    const other = grant(200, {
      access_token: claims({ sub: 's9', exp: NOW / 1000 + 3600 }),
      id_token: claims({ sub: 's9', email: 'x@example.com' }),
    });
    const { pw } = fakePw();
    await expect(launchCached(pw, path, cenv, deps(other))).rejects.toThrow(/WRONG_USER/);
    expect(pw.chromium.launch).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });
  it('a wrong cached identity is discarded first, with no request', async () => {
    const path = cache(-60, { profile: { sub: 's9', email: 'x@example.com' } });
    const fetch = grant(200);
    expect(await run(path, fetch)).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('no refresh token, or not a string: loads as cached, logged, with no request', async () => {
    for (const rt of [undefined, 42, '']) {
      const fetch = grant(200);
      const log = vi.fn();
      const out = await run(cache(-60, { refresh_token: rt }), fetch, log);
      expect(record(out).access_token).toBe(OLD_AT);
      expect(fetch).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/no refresh token/));
    }
  });
  it('no app session for the env key: loads as cached, logged, with no request', async () => {
    const fetch = grant(200);
    const log = vi.fn();
    const path = cache(-60, {}, 'theme-2');
    expect(await run(path, fetch, log)).toEqual(JSON.parse(readFileSync(path, 'utf8')));
    expect(fetch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/no app session/));
  });
  it('no token text reaches a log line or an error', async () => {
    const seen: string[] = [];
    const log = (m: string) => void seen.push(m);
    const leaky = vi.fn<FetchLike>(async () => {
      throw new Error('socket hang up sending refresh_token=RT-1');
    });
    await run(cache(-60), grant(200), log);
    await run(cache(-60), grant(400, { error: 'invalid_grant', detail: 'SECRETBODY' }), log);
    await run(cache(-60), grant(503, { detail: 'SECRETBODY' }), log);
    await run(cache(-60), leaky, log);
    await run(
      cache(-60),
      grant(200, {
        access_token: claims({ sub: 's9', exp: 9e9 }),
        id_token: claims({ sub: 's9' }),
      }),
      log,
    ).catch((e: unknown) => seen.push(String(e)));
    expect(seen).toHaveLength(5);
    for (const secret of [OLD_AT, NEW_AT, NEW_ID, 'OLD-ID', 'RT-1', 'SECRETBODY', 'COOKIE-1'])
      expect(seen.join('\n')).not.toContain(secret);
  });
});

describe('the callers open their browser through launchCached', () => {
  // Both entry points must renew before launch; a bare launch(pw, statePath) would load the cache unrenewed.
  it.each([
    // each lane's own user's state (lanes.ts): `state` is statePath(main, slot, o.user)
    [
      'devcheck/run.ts',
      /const state = statePath\(main, slot, o\.user\);[^]*launchCached\(\s*pw,\s*state,/,
    ],
    [
      'mailroom/sim-bench-seed.ts',
      /launchCached\(\s*loadPlaywright\(\),\s*statePath\(main, 'dev'\)/,
    ],
  ])('%s', (file, call) => {
    const src = readFileSync(join(import.meta.dirname, '..', file), 'utf8');
    expect(src).toMatch(call);
    expect(src).not.toMatch(/\blaunch\(/);
  });
});
