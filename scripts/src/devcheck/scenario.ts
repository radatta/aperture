// A scenario is a plain module: an id, the tiers it runs in, and ordered steps. A step gets a Ctx — the page,
// UI helpers, the guarded API client, screenshots in both themes — and throws to fail. A failed step is
// recorded with a screenshot and the rest of that scenario is skipped (later steps build on it); the next
// scenario still runs, and cleanup always does. Writing one from a runbook: docs/ops/DEV-CHECK.md.
import { join } from 'node:path';
import type { ApiClient } from './api';
import { DEV_ORIGIN, assertDevOrigin } from './config';
import { SHELL } from './login';
import type { PwPage } from './pw-types';

export type Tier = 'smoke' | 'full';

export interface Step {
  id: string;
  title: string;
  run(ctx: Ctx): Promise<void>;
}

export interface Scenario {
  id: string;
  title: string;
  tiers: Tier[];
  steps: Step[];
}

export interface Dates {
  today: string; // YYYY-MM-DD in America/Los_Angeles
  tomorrow: string;
}

export interface Ctx {
  page: PwPage;
  api: ApiClient;
  nonce: string; // unique per run — makes a title findable on screen; never a cleanup key
  dates: Dates;
  ui: Ui;
  shot(name: string): Promise<void>;
  createdIds(): string[]; // ids the ledger got from this run's UI creates, oldest first
  consoleErrors(): string[]; // console errors + uncaught page errors so far
  log(msg: string): void;
}

export interface Ui {
  goto(path: string): Promise<void>;
  captureTask(line: string): Promise<void>;
  expectText(text: string | RegExp, timeoutMs?: number): Promise<void>;
  setTheme(theme: 'light' | 'dark'): Promise<void>;
  settle(): Promise<void>;
}

// Resolves once every finite CSS transition/animation on the page has finished — a theme flip animates the
// palette, and a shot taken mid-way mixes both themes. Infinite ones (spinners) are left out.
const SETTLE = `Promise.all(document.getAnimations()
  .filter((a) => a.effect && a.effect.getComputedTiming().endTime !== Infinity)
  .map((a) => a.finished.catch(() => null))).then(() => null)`;

export const laDay = (d: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(d);

export function datesFor(now: Date): Dates {
  return { today: laDay(now), tomorrow: laDay(new Date(now.getTime() + 86_400_000)) };
}

export function createUi(page: PwPage): Ui {
  const ui: Ui = {
    async goto(path) {
      const url = `${DEV_ORIGIN}${path}`;
      assertDevOrigin(url);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.locator(SHELL).waitFor({ timeout: 30_000 });
    },
    async captureTask(line) {
      await page.getByRole('button', { name: 'Task', exact: true }).click();
      const field = page.locator('textarea[aria-label="Capture task"]');
      await field.fill(line);
      await field.press('Enter');
      await ui.expectText(/Task added/, 15_000);
    },
    async expectText(text, timeoutMs = 10_000) {
      await page.getByText(text).first().waitFor({ state: 'visible', timeout: timeoutMs });
    },
    // ThemeProvider writes data-theme only when the setting changes, so a direct flip holds for a shot.
    async setTheme(theme) {
      await page.evaluate(`document.documentElement.setAttribute('data-theme', '${theme}')`);
      await ui.settle();
    },
    async settle() {
      await page.evaluate(SETTLE);
    },
  };
  return ui;
}

// Light then dark, then back to whatever the app had set.
export function makeShot(page: PwPage, ui: Ui, dir: string, prefix: () => string, index: string[]) {
  return async (name: string) => {
    await ui.settle(); // whatever the last click started (a lens pill's fade) finishes first
    const before = await page.evaluate<string | null>(
      `document.documentElement.getAttribute('data-theme')`,
    );
    for (const theme of ['light', 'dark'] as const) {
      await ui.setTheme(theme);
      const file = `${prefix()}-${name}-${theme}.png`;
      await page.screenshot({ path: join(dir, file), fullPage: true });
      index.push(file);
    }
    if (before) await ui.setTheme(before as 'light' | 'dark');
  };
}
