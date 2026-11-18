// Headless Chromium from the shared ~/pw Playwright install (never a repo dependency — pw-types.ts).
// A phone-sized context in the user's timezone, so what the check sees is what the iPhone PWA shows.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DevcheckError } from './errors';
import type { PwBrowser, PwContext, PwModule } from './pw-types';

// iPhone 18 Pro Max (Pro Max class since the 16): 440×956 CSS px — the phone the PWA runs on. 390×844 is the floor
// the run-app Phone pass still covers; the check shows the phone the user holds.
export const PHONE = { width: 440, height: 956 } as const;
export const TIMEZONE = 'America/Los_Angeles';

export function loadPlaywright(
  root = process.env.DEVCHECK_PW_ROOT ?? join(homedir(), 'pw'),
): PwModule {
  const entry = join(root, 'node_modules', 'playwright');
  if (!existsSync(entry))
    throw new DevcheckError(
      'PW_MISSING',
      `no Playwright at ${entry} — install it outside the repo: mkdir -p ~/pw && cd ~/pw && npm init -y && npm install playwright && npx playwright install chromium`,
    );
  return createRequire(join(root, 'package.json'))('playwright') as PwModule;
}

// The session to start from: a storageState file's path, or the state itself (login.ts cachedState renews it in
// memory before the browser loads anything).
export async function launch(
  pw: PwModule,
  storageState?: string | object,
): Promise<{ browser: PwBrowser; context: PwContext }> {
  const browser = await pw.chromium.launch({
    headless: true,
    // claude.ai/claude.com resolve nowhere — the wall that stops the MCP sign-in's redirect to the callback
    // (a route never sees a redirect), and no proxy, which would resolve the host itself and bypass it. The
    // sign-in checks the callback failed regardless (mcp-login.ts). The harness never has a reason to reach them.
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-proxy-server',
      '--host-resolver-rules=MAP claude.ai ~NOTFOUND, MAP *.claude.ai ~NOTFOUND, MAP claude.com ~NOTFOUND, MAP *.claude.com ~NOTFOUND',
    ],
    ...(process.env.DEVCHECK_CHROMIUM ? { executablePath: process.env.DEVCHECK_CHROMIUM } : {}),
  });
  const context = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    timezoneId: TIMEZONE,
    locale: 'en-US',
    // Settings' Enable asks for it inside the tap. Granted here, but headless Chromium still reports
    // Notification.permission as 'denied', so on a headless run Settings shows the denied line instead of
    // the button (timed-reminders' ui-enable row accepts either); a headed run would get the prompt-less grant.
    permissions: ['notifications'],
    ...(typeof storageState === 'object' || (storageState && existsSync(storageState))
      ? { storageState }
      : {}),
  });
  return { browser, context };
}
