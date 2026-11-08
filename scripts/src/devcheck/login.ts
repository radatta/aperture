// Signing the test user in through dev's classic Cognito Hosted UI, then caching the session (Playwright
// storageState) so later runs skip the form until the 7-day refresh token lapses. Selectors are exact, not
// guessed: if the Hosted UI changes, the run fails AUTH_PAGE_CHANGED with a screenshot rather than typing a
// password into whatever field looks close.
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { DEV_ORIGIN, type DevcheckEnv } from './config';
import { DevcheckError } from './errors';
import type { PwContext, PwPage } from './pw-types';
import type { FetchLike } from './api';
import {
  assertTestUser,
  cognitoAuthority,
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
  const refresh = raw ? (JSON.parse(raw) as { refresh_token?: unknown }).refresh_token : undefined;
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

// The cached session must be the test user's BEFORE any page loads: loading the app already writes (getDay
// materialises recurring tasks), so a wrong cached identity would write to that account. A mismatch or an
// unreadable cache is deleted and the run signs in fresh.
export function validateCachedState(
  path: string,
  env: DevcheckEnv,
  log: (msg: string) => void,
): void {
  if (!existsSync(path)) return;
  try {
    const state = JSON.parse(readFileSync(path, 'utf8')) as {
      origins?: { origin: string; localStorage?: { name: string; value: string }[] }[];
    };
    const ls = state.origins?.find((o) => o.origin === DEV_ORIGIN)?.localStorage ?? [];
    const storage = Object.fromEntries(ls.map((x) => [x.name, x.value]));
    // Every oidc user entry, not just the env's key: a drifted client id would leave another one unchecked,
    // and the app would load it.
    for (const key of Object.keys(storage).filter((k) => k.startsWith('oidc.user:'))) {
      const session = sessionFromStorage(storage, key);
      if (session) assertTestUser(session, env.DEVCHECK_SUB);
    }
  } catch (err) {
    log(`discarding the cached session (${err instanceof Error ? err.message : 'unreadable'})`);
    unlinkSync(path);
  }
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
  await page.goto(`${DEV_ORIGIN}/tasks`, { waitUntil: 'domcontentloaded' });
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
      await page.waitForURL((u) => u.origin === DEV_ORIGIN, { timeout: 20_000 });
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
