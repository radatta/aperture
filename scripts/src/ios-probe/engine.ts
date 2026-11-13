// The probe check's engine: Playwright from the shared ~/pw install (as the dev check: never a repo dependency),
// Chromium by default, WebKit on request — the two agreed to the pixel in the calibration (decisions, 2026-11-12).
// Safe areas go in as CSS (the app reads them through `--safe-top` and `.pb-safe`); the keyboard is a viewport
// resize (check.ts → KEYBOARD_VIEWPORT_H). The page is the stub app: nothing leaves the origin.
import { loadPlaywright } from '../devcheck/browser';
import { readPoint, toAx, type Facts } from './ax';
import { KEYBOARD_VIEWPORT_H, SAFE, VIEWPORT, type ProbePage } from './check';

export type EngineName = 'chromium' | 'webkit';
export const ENGINES: EngineName[] = ['chromium', 'webkit'];

// The slice of Playwright this file uses, typed by hand (pw-types.ts holds the dev check's).
interface Page {
  goto(url: string, o?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  route(
    match: (u: URL) => boolean,
    h: (r: { abort(e: string): Promise<void> }) => Promise<void>,
  ): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  waitForSelector(sel: string, o?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  setViewportSize(s: { width: number; height: number }): Promise<void>;
  mouse: {
    click(x: number, y: number): Promise<void>;
    wheel(dx: number, dy: number): Promise<void>;
    move(x: number, y: number): Promise<void>;
  };
  keyboard: { type(t: string): Promise<void>; press(k: string): Promise<void> };
  screenshot(o: { path: string }): Promise<unknown>;
}
interface Browser {
  newContext(
    o: Record<string, unknown>,
  ): Promise<{ newPage(): Promise<Page>; close(): Promise<void> }>;
  close(): Promise<void>;
  version(): string;
}
type Launcher = { launch(o: Record<string, unknown>): Promise<Browser> };

const LANDMARK = '[aria-label^="Capture "]'; // Home's capture bar, as the runner's launch waits for
const SETTLE_MS = 300;
const css = (bottom: number) =>
  `:root{--safe-top:${SAFE.top}px !important}.pb-safe{padding-bottom:max(1rem,${bottom}px) !important}`;

export interface Engine {
  name: string; // e.g. "chromium 153.0"
  page(origin: string): Promise<ProbePage & { close(): Promise<void> }>;
  close(): Promise<void>;
}

export async function openEngine(name: EngineName, pwRoot?: string): Promise<Engine> {
  const pw = loadPlaywright(pwRoot) as unknown as Record<EngineName, Launcher>;
  const args =
    name === 'chromium' ? ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'] : [];
  const browser = await pw[name].launch({ headless: true, args });
  return {
    name: `${name} ${browser.version()}`,
    close: () => browser.close(),
    async page(origin) {
      const ctx = await browser.newContext({
        viewport: { width: VIEWPORT.w, height: VIEWPORT.h },
        deviceScaleFactor: 3,
        hasTouch: true,
        timezoneId: 'America/Los_Angeles',
      });
      const p = await ctx.newPage();
      await p.route(
        (u) => u.origin !== origin,
        (r) => r.abort('blockedbyclient'),
      );
      const safe = (bottom: number) =>
        p.evaluate(`(() => {
          let s = document.getElementById('ios-probe-safe');
          if (!s) { s = document.createElement('style'); s.id = 'ios-probe-safe'; document.head.append(s); }
          s.textContent = ${JSON.stringify(css(bottom))};
        })()`);
      const settle = () => p.waitForTimeout(SETTLE_MS);
      return {
        async open() {
          await p.setViewportSize({ width: VIEWPORT.w, height: VIEWPORT.h });
          // Vite optimises dependencies on a first load and may reload once.
          for (let i = 0; i < 2; i++) {
            await p.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
            await p.waitForSelector(LANDMARK, { timeout: 60_000 });
          }
          await safe(SAFE.bottom);
          await settle();
        },
        async read({ x, y }) {
          // `__name`: a transpiler's helper the serialised function may carry; the page has none.
          const f = await p.evaluate<Facts | null>(
            `(() => { var __name = (f) => f; return (${readPoint.toString()})([${x}, ${y}]); })()`,
          );
          return f ? toAx(f) : null;
        },
        click: ({ x, y }) => p.mouse.click(x, y),
        type: (t) => p.keyboard.type(t),
        async backspace(n) {
          for (let i = 0; i < n; i++) await p.keyboard.press('Backspace');
        },
        blur: () => p.evaluate(`void (document.activeElement && document.activeElement.blur())`),
        scrollTop: () => p.evaluate(`void window.scrollTo(0, 0)`),
        async scroll(dy) {
          await p.mouse.move(VIEWPORT.w / 2, VIEWPORT.h / 2);
          await p.mouse.wheel(0, dy);
          await settle();
        },
        focusInFixedLayer: () =>
          p.evaluate<boolean>(`(() => {
            for (let e = document.activeElement; e && e !== document.body; e = e.parentElement)
              if (getComputedStyle(e).position === 'fixed' || (e.tagName === 'DIALOG' && e.open)) return true;
            return false;
          })()`),
        async keyboard(up) {
          await p.setViewportSize({
            width: VIEWPORT.w,
            height: up ? KEYBOARD_VIEWPORT_H : VIEWPORT.h,
          });
          await safe(up ? 0 : SAFE.bottom);
        },
        settle,
        shot: (path) => p.screenshot({ path }).then(() => undefined),
        close: () => ctx.close(),
      };
    },
  };
}
