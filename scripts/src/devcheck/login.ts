// Signing the test user in through dev's classic Cognito Hosted UI, then caching the session (Playwright
// storageState) so later runs skip the form until the 7-day refresh token lapses. Selectors are exact, not
// guessed: if the Hosted UI changes, the run fails AUTH_PAGE_CHANGED with a screenshot rather than typing a
// password into whatever field looks close.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { DEV_ORIGIN, type DevcheckEnv } from './config';
import { DevcheckError } from './errors';
import type { PwContext, PwPage } from './pw-types';
import {
  assertTestUser,
  cognitoAuthority,
  sessionFromStorage,
  userStoreKey,
  type Session,
} from './token';

export const SHELL = 'textarea[aria-label^="Capture "]';
const FORM = {
  username: 'input[name="username"]:visible',
  password: 'input[name="password"]:visible',
  submit: 'input[name="signInSubmitButton"]:visible',
};

export async function readSession(page: PwPage, env: DevcheckEnv): Promise<Session | null> {
  const storage = await page.evaluate<Record<string, string>>(
    'Object.assign({}, window.localStorage)',
  );
  return sessionFromStorage(
    storage,
    userStoreKey(cognitoAuthority(env.DEVCHECK_POOL_ID), env.DEVCHECK_CLIENT_ID),
  );
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
    const key = userStoreKey(cognitoAuthority(env.DEVCHECK_POOL_ID), env.DEVCHECK_CLIENT_ID);
    const session = sessionFromStorage(storage, key);
    if (session) assertTestUser(session, env.DEVCHECK_SUB);
  } catch (err) {
    log(`discarding the cached session (${err instanceof Error ? err.message : 'unreadable'})`);
    unlinkSync(path);
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
    try {
      for (const sel of Object.values(FORM)) await page.locator(sel).waitFor({ timeout: 10_000 });
    } catch {
      await opts.shot('auth-page-changed');
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
      await opts.shot('auth-page-changed');
      throw new DevcheckError(
        'AUTH_PAGE_CHANGED',
        `filling the Hosted UI form at ${page.url()} failed`,
      );
    }
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
  // Written by hand with mode 600 from the start — it holds the refresh token.
  writeFileSync(opts.statePath, JSON.stringify(await context.storageState()), { mode: 0o600 });
  return session;
}
