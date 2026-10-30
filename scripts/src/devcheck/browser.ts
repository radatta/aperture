// Headless Chromium from the shared ~/pw Playwright install (never a repo dependency — pw-types.ts).
// A phone-sized context in the user's timezone, so what the check sees is what the iPhone PWA shows.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DevcheckError } from './errors';
import type { PwBrowser, PwContext, PwModule } from './pw-types';

export const PHONE = { width: 390, height: 844 } as const;
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

export async function launch(
  pw: PwModule,
  storageStatePath?: string,
): Promise<{ browser: PwBrowser; context: PwContext }> {
  const browser = await pw.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(process.env.DEVCHECK_CHROMIUM ? { executablePath: process.env.DEVCHECK_CHROMIUM } : {}),
  });
  const context = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    timezoneId: TIMEZONE,
    locale: 'en-US',
    ...(storageStatePath && existsSync(storageStatePath) ? { storageState: storageStatePath } : {}),
  });
  return { browser, context };
}
