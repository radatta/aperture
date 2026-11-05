// A scenario is a plain module: an id, the tiers it runs in, and ordered steps. A step gets a Ctx — the page,
// UI helpers, the guarded API client, screenshots in both themes — and throws to fail. A failed step is
// recorded with a screenshot and the rest of that scenario is skipped (later steps build on it); the next
// scenario still runs, and cleanup always does. Its rows are the feature's coverage matrix (entry point ×
// case); each step names the rows it proves. Writing one from a runbook: docs/ops/DEV-CHECK.md.
import { join } from 'node:path';
import type { ApiClient } from './api';
import type { McpClient } from './mcp';
import { DEV_ORIGIN, assertDevOrigin } from './config';
import { SHELL } from './login';
import type { PwPage } from './pw-types';

export type Tier = 'smoke' | 'full';

// Where a user or client enters the feature. A step drives one of STEP_ENTRIES; the rest name surfaces
// headless Chromium can't reach, so their rows are needsYou.
export type EntryPoint = 'ui' | 'api' | 'mcp' | 'ios' | 'raycast' | 'extension';
export const STEP_ENTRIES: readonly EntryPoint[] = ['ui', 'api', 'mcp'];
export type RowKind = 'nominal' | 'edge';

// Dev can't make this failure happen, so a unit or handler test is the proof. `file` is repo-relative,
// `test` the it() title verbatim. A test-only switch in shipped code never stands in for this.
export interface OffDevTest {
  file: string;
  test: string;
  why: string;
}

export interface Row {
  id: string; // the key steps name in `proves`
  entry: EntryPoint;
  kind: RowKind;
  what: string; // the case as the user would say it
  offDev?: OffDevTest;
  needsYou?: string; // why only the user can reach it
}

export interface Step {
  id: string;
  title: string;
  entry: EntryPoint; // how this step drives the app — 'api' for setup and verify-only steps
  proves?: string[]; // row ids; a row needs at least one proving step through its own entry
  run(ctx: Ctx): Promise<void>;
}

export interface Scenario {
  id: string;
  title: string;
  tiers: Tier[];
  rows: Row[]; // [] only for smoke, which proves the harness, not a feature
  steps: Step[];
}

export interface Dates {
  today: string; // YYYY-MM-DD in America/Los_Angeles
  tomorrow: string;
}

export interface Ctx {
  page: PwPage;
  api: ApiClient;
  mcp: McpClient; // dev's /mcp as the test user, through the claude client (mcp-login.ts)
  nonce: string; // unique per run — makes a title findable on screen; never a cleanup key
  dates: Dates;
  ui: Ui;
  shot(name: string): Promise<void>;
  createdIds(): string[]; // ids the ledger got from this run's UI creates, oldest first
  consoleErrors(): string[]; // console errors + uncaught page errors so far
  // Fails dev's /api/<method> from the harness side (Playwright route), never a switch in shipped code: the
  // next `times` calls (default: every call) get `status`, or a dropped connection with `abort`. While any is
  // active, the console's resource-load lines are this run's own doing and are left out of consoleErrors
  // (DEV-CHECK.md → Injected failures). Release it to pass through again; the pipeline releases any a step
  // left behind when its scenario ends.
  intercept(method: string, opts?: InterceptOpts): Promise<Interception>;
  log(msg: string): void;
}

export interface InterceptOpts {
  status?: number; // default 429 — the one the app retries for every call
  times?: number;
  abort?: boolean;
}

export interface Interception {
  hits(): number; // calls it failed
  passed(): number; // calls it let through (after `times` ran out)
  release(): Promise<void>;
}

export interface Ui {
  goto(path: string): Promise<void>;
  captureTask(line: string): Promise<void>;
  expectText(text: string | RegExp, timeoutMs?: number): Promise<void>;
  setTheme(theme: 'light' | 'dark'): Promise<void>;
  settle(): Promise<void>;
}

// A scenario's last step: the run's console so far is clean. Its own step, proving no row, so a console error
// (a throttled call, DEV-CHECK.md → Throttles (429)) fails it without unproving the feature's rows.
export const noConsoleErrors: Step = {
  id: 'no-console-errors',
  title: 'No console errors on the way',
  entry: 'ui',
  async run(ctx) {
    const errors = ctx.consoleErrors();
    if (errors.length) throw new Error(`console errors: ${errors.join(' | ')}`);
  },
};

// A stretch of a step that may put a secret on screen (the place token's show-once reveal). On any throw the
// page goes to about:blank before the error leaves — the pipeline's failure shot comes after — so not even a
// reveal that appeared once a wait had given up is shot; and the error is marked so the pipeline takes no
// failure shot at all (a page that wouldn't navigate is the case that needs it).
const withheld = new WeakSet<object>();
export const shotWithheld = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && withheld.has(err);
export async function hidingSecret<T>(
  page: Pick<PwPage, 'goto'>,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    withheld.add(e);
    await page.goto('about:blank').catch(() => undefined);
    throw e;
  }
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
      // A save clears the field at once. A refusal keeps the text: on a throttled dev the category or place
      // list can still be loading ("Loading places…" — the notice goes once it lands), so press again then.
      // Only while the text is still there — a press after the field cleared could save it twice.
      const added = page.getByText(/Task added/).first();
      for (let i = 0; ; i++) {
        await field.press('Enter');
        if (
          await added.waitFor({ state: 'visible', timeout: 3_000 }).then(
            () => true,
            () => false,
          )
        )
          return;
        if ((await field.inputValue()) !== line || i === 4) break;
      }
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
