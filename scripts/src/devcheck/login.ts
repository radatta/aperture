// Signing the test user in through dev's classic Cognito Hosted UI, then caching the session (Playwright
// storageState) so later runs skip the form until the 30-day refresh token lapses. Selectors are exact, not
// guessed: if the Hosted UI changes, the run fails AUTH_PAGE_CHANGED with a screenshot rather than typing a
// password into whatever field looks close.
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { slotOrigin, type DevcheckEnv } from './config';
import { DevcheckError } from './errors';
import { launch } from './browser';
import type { PwBrowser, PwContext, PwModule, PwPage } from './pw-types';
import type { FetchLike } from './api';
import {
  assertTestUser,
  cognitoAuthority,
  grantTokens,
  sessionFromStorage,
  tokenGrant,
  userStoreKey,
  type Session,
} from './token';

export const SHELL = 'textarea[aria-label^="Capture "]';
const FORM = {
  username: 'input[name="username"]:visible',
  password: 'input[name="password"]:visible',
  submit: 'input[name="signInSubmitButton"]:visible',
};

// The page's session, which must still be the test user's (WRONG_USER otherwise) — cleanup re-reads it.
export async function readCheckedSession(page: PwPage, env: DevcheckEnv): Promise<Session | null> {
  const session = await readSession(page, env);
  if (session) assertTestUser(session, env.DEVCHECK_SUB);
  return session;
}

export async function readSession(page: PwPage, env: DevcheckEnv): Promise<Session | null> {
  const storage = await page.evaluate<Record<string, string>>(
    'Object.assign({}, window.localStorage)',
  );
  return sessionFromStorage(
    storage,
    userStoreKey(cognitoAuthority(env.DEVCHECK_POOL_ID), env.DEVCHECK_CLIENT_ID),
  );
}

// The page hasn't renewed its session (pipeline.ts `fresh`): renew from here with the refresh token it keeps,
// at the dev pool's token endpoint, and check the identity again. The page is left alone: its own renew runs
// on its timer, and Cognito's refresh token isn't rotated (if it ever is, write the new one back). Nothing is
// written to storage or logged. Null when the page keeps no refresh token.
export async function refreshSession(
  page: PwPage,
  env: DevcheckEnv,
  fetch: FetchLike,
  now: () => number,
): Promise<Session | null> {
  const storage = await page.evaluate<Record<string, string>>(
    'Object.assign({}, window.localStorage)',
  );
  const raw = storage[userStoreKey(cognitoAuthority(env.DEVCHECK_POOL_ID), env.DEVCHECK_CLIENT_ID)];
  let refresh: unknown;
  try {
    refresh = raw ? (JSON.parse(raw) as { refresh_token?: unknown }).refresh_token : undefined;
  } catch {
    // never the parser's message: it quotes the record, tokens and all
    throw new DevcheckError(
      'AUTH_REJECTED',
      'session refresh: the page’s stored session is unreadable',
    );
  }
  if (typeof refresh !== 'string' || !refresh) return null;
  const { accessToken, expiresAt, email, sub } = await tokenGrant(
    fetch,
    env.DEVCHECK_COGNITO_HOST,
    { grant_type: 'refresh_token', client_id: env.DEVCHECK_CLIENT_ID, refresh_token: refresh },
    now,
    (m) => new DevcheckError('AUTH_REJECTED', `session refresh: ${m}`),
  );
  const session = { accessToken, expiresAt, email, sub };
  assertTestUser(session, env.DEVCHECK_SUB);
  return session;
}

// Playwright's storageState, as `context.storageState()` writes it — what the cache file holds.
export interface StorageState {
  cookies: unknown[];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
}

// The cache, parsed once and checked: undefined when there is none or it was just discarded. The cached session
// must be the test user's BEFORE any page loads: loading the app already writes (getDay materialises recurring
// tasks), so a wrong cached identity would write to that account. A mismatch or an unreadable cache is deleted and
// the run signs in fresh.
function readCheckedState(
  path: string,
  env: DevcheckEnv,
  log: (msg: string) => void,
): StorageState | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const state = JSON.parse(readFileSync(path, 'utf8')) as StorageState;
    const ls = state.origins?.find((o) => o.origin === slotOrigin())?.localStorage ?? [];
    const storage = Object.fromEntries(ls.map((x) => [x.name, x.value]));
    // Every oidc user entry, not just the env's key: a drifted client id would leave another one unchecked,
    // and the app would load it.
    for (const key of Object.keys(storage).filter((k) => k.startsWith('oidc.user:'))) {
      const session = sessionFromStorage(storage, key);
      if (session) assertTestUser(session, env.DEVCHECK_SUB);
    }
    return state;
  } catch (err) {
    // A parser's message quotes the bytes around the fault — tokens, the cookie — so only our own errors are named.
    log(
      `discarding the cached session (${err instanceof DevcheckError ? err.message : 'unreadable'})`,
    );
    unlinkSync(path);
    return undefined;
  }
}

// How long the launch renew waits on the token endpoint before it cancels the request and loads the cache as is.
export const LAUNCH_RENEW_TIMEOUT_MS = 15_000;

// What the browser loads (F226): the checked cache, with the app's session renewed first — at every launch that
// has a refresh token, whatever its age — so the app never starts on a dead, boundary or server-refused token and
// never renews at launch. The renew uses the cache's refresh token at the dev pool's token endpoint and checks the
// new tokens are the test user's (WRONG_USER throws before any browser, and the cache, which holds that account's
// refresh token, goes). It patches that one record in memory; the file is re-saved after sign-in as before. A dead
// refresh token (invalid_grant) discards the cache, so the run signs in through the form; any other failure loads
// the cache as it is (the app renews it itself), logged. Nothing here logs a token.
export async function cachedState(
  path: string,
  env: DevcheckEnv,
  deps: { fetch: FetchLike; now: () => number; log: (msg: string) => void },
): Promise<StorageState | undefined> {
  const { fetch, now, log } = deps;
  const state = readCheckedState(path, env, log);
  if (!state) return undefined;
  const key = userStoreKey(cognitoAuthority(env.DEVCHECK_POOL_ID), env.DEVCHECK_CLIENT_ID);
  const origin = state.origins?.find((o) => o.origin === slotOrigin());
  const entry = origin?.localStorage?.find((x) => x.name === key);
  const session = entry ? sessionFromStorage({ [key]: entry.value }, key) : null;
  if (!entry || !session) {
    log('the cache holds no app session — loading it as cached');
    return state;
  }
  const user = JSON.parse(entry.value) as Record<string, unknown>; // parsed above: sessionFromStorage read it
  if (typeof user.refresh_token !== 'string' || !user.refresh_token) {
    log('the cached session holds no refresh token — loading it as cached');
    return state;
  }
  let dead = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  let granted: Awaited<ReturnType<typeof grantTokens>>;
  try {
    granted = await Promise.race([
      grantTokens(
        fetch,
        env.DEVCHECK_COGNITO_HOST,
        {
          grant_type: 'refresh_token',
          client_id: env.DEVCHECK_CLIENT_ID,
          refresh_token: user.refresh_token,
        },
        now,
        (m, error) => {
          dead = error === 'invalid_grant';
          return new DevcheckError('AUTH_REJECTED', `cached session renew: ${m}`);
        },
        abort.signal,
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort(); // frees the request; one Cognito already took can't be recalled (rotation is off)
          reject(new Error(`the token endpoint took over ${LAUNCH_RENEW_TIMEOUT_MS / 1000} s`));
        }, LAUNCH_RENEW_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    if (dead) {
      log('discarding the cached session (its refresh token is dead: invalid_grant)');
      unlinkSync(path);
      return undefined;
    }
    const why = err instanceof Error ? err.message : 'failed';
    log(`cached session not renewed (${why}) — loading it as cached`);
    return state;
  } finally {
    clearTimeout(timer);
  }
  try {
    assertTestUser(granted.session, env.DEVCHECK_SUB);
  } catch (err) {
    unlinkSync(path); // its refresh token signs in someone else: never renew from it again
    throw err;
  }
  const renewed = JSON.stringify({
    ...user,
    access_token: granted.session.accessToken,
    id_token: granted.idToken,
    expires_at: granted.session.expiresAt,
    ...(granted.refreshToken ? { refresh_token: granted.refreshToken } : {}),
  });
  log(`renewed the cached session before launch (it ${age(session.expiresAt * 1000 - now())})`);
  return {
    ...state,
    origins: state.origins.map((o) =>
      o !== origin
        ? o
        : {
            ...o,
            localStorage: o.localStorage.map((x) => (x === entry ? { ...x, value: renewed } : x)),
          },
    ),
  };
}

// The cached session's age, for the log: whole minutes, rounded toward "expired".
const age = (leftMs: number): string =>
  !Number.isFinite(leftMs) || leftMs < -1e12
    ? 'had no expiry'
    : leftMs <= 0
      ? `expired ${Math.floor(-leftMs / 60_000)} min before`
      : `had ${Math.floor(leftMs / 60_000)} min left`;

// The browser, launched on the cache cachedState renewed — the one way a run opens its signed-in browser.
export async function launchCached(
  pw: PwModule,
  path: string,
  env: DevcheckEnv,
  deps: { fetch: FetchLike; now: () => number; log: (msg: string) => void },
): Promise<{ browser: PwBrowser; context: PwContext }> {
  return launch(pw, await cachedState(path, env, deps));
}

// The browser's session file holds the refresh token and the Hosted UI cookie: mode 600 on create, and an
// existing file tightened first, since `mode` doesn't touch a file that already exists.
export async function saveState(context: PwContext, path: string): Promise<void> {
  const state = JSON.stringify(await context.storageState());
  if (existsSync(path)) chmodSync(path, 0o600);
  writeFileSync(path, state, { mode: 0o600 });
}

// The classic Hosted UI form, by exact selectors — shared by the app's sign-in and the MCP one (mcp-login.ts).
export async function submitHostedUiForm(
  page: PwPage,
  env: DevcheckEnv,
  shot: (name: string) => Promise<void>,
): Promise<void> {
  try {
    for (const sel of Object.values(FORM)) await page.locator(sel).waitFor({ timeout: 10_000 });
  } catch {
    await shot('auth-page-changed');
    throw new DevcheckError(
      'AUTH_PAGE_CHANGED',
      `the Hosted UI form at ${page.url()} isn't the classic one`,
    );
  }
  try {
    await page.locator(FORM.username).fill(env.DEVCHECK_EMAIL);
    await page.locator(FORM.password).fill(env.DEVCHECK_PASSWORD);
    await page.locator(FORM.submit).click();
  } catch {
    // Playwright's error text can echo the filled value — never let it reach a report.
    await shot('auth-page-changed');
    throw new DevcheckError(
      'AUTH_PAGE_CHANGED',
      `filling the Hosted UI form at ${page.url()} failed`,
    );
  }
}

export async function ensureSignedIn(
  page: PwPage,
  context: PwContext,
  env: DevcheckEnv,
  opts: { statePath: string; shot: (name: string) => Promise<void> },
): Promise<Session> {
  await page.goto(`${slotOrigin()}/tasks`, { waitUntil: 'domcontentloaded' });
  const signIn = page.getByRole('button', { name: 'Sign in' });
  await page.locator(`${SHELL}, button:has-text("Sign in")`).first().waitFor({ timeout: 30_000 });

  if (await signIn.isVisible()) {
    await signIn.click();
    try {
      await page.waitForURL((u) => u.host === env.DEVCHECK_COGNITO_HOST, { timeout: 20_000 });
    } catch {
      throw new DevcheckError(
        'AUTH_REDIRECT_UNEXPECTED',
        `Sign in went to ${page.url()}, not ${env.DEVCHECK_COGNITO_HOST}`,
      );
    }
    await submitHostedUiForm(page, env, opts.shot);
    try {
      await page.waitForURL((u) => u.origin === slotOrigin(), { timeout: 20_000 });
    } catch {
      await opts.shot('auth-rejected');
      const text = (await page.locator('body').textContent())?.replace(/\s+/g, ' ').slice(0, 200);
      throw new DevcheckError(
        'AUTH_REJECTED',
        `still on ${new URL(page.url()).host}: ${text ?? ''}`,
      );
    }
    await page.locator(SHELL).waitFor({ timeout: 30_000 });
  }

  const session = await readSession(page, env);
  if (!session)
    throw new DevcheckError('WRONG_USER', 'signed-in shell but no oidc session in localStorage');
  assertTestUser(session, env.DEVCHECK_SUB);
  await saveState(context, opts.statePath);
  return session;
}
