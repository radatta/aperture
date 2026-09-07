---
name: run-app
description: Launch the Aperture PWA and screenshot/drive it with headless Chromium. Use when asked to run the app, visually verify a UI change, or screenshot a page/component. Covers the default stub + auth-bypass, browser setup, and driving/screenshotting.
---

# Run the Aperture app + screenshot it

Use this when you need a *rendered* UI (screenshots, click paths) — not just lint/tests. Vitest covers logic; this covers "does it actually look/behave right."

## The app runs auth-free by default

Aperture defaults to **stub mode** (`API_MODE='stub'` unless `VITE_API_MODE=http` is injected). In stub mode:

- **Auth is bypassed** — `AuthProvider` returns a fixed `local@aperture.dev` identity and `RequireAuth` is a pass-through. No Cognito, no sign-in screen.
- **Data is the in-memory stub** (`src/data/stubClient.ts`, seeded from `src/data/seed.ts`) — nothing hits the network.

So you launch with **no env flags** — `pnpm dev` is already in a screenshot-able state. Do NOT set `VITE_API_MODE=http` for visual work; that turns on real Cognito + a real API and there's nothing to talk to locally.

## Launch Vite

```bash
cd /path/to/aperture && pnpm dev   # root script → @aperture/app (run in background)
```

**The port depends on where you are, and Vite walks upward if it's taken** — so read it, don't assume
it. Inside a COI container the base is `6173`; on a bare Mac it's `5173` (`app/vite.config.ts`, and
docs/COI-SANDBOX.md → *Ports*). Resolve it from what's actually listening:

```bash
PORT=$(ss -ltn 2>/dev/null | grep -oE ':(5|6)[12][78][0-9]' | tr -d ':' | sort -u | head -1)
echo "vite on $PORT"
```

Poll for readiness (portable — works on macOS and Linux; don't assume `curl`):

```bash
timeout 40 bash -c "until node -e \"fetch('http://localhost:$PORT').then(()=>process.exit(0)).catch(()=>process.exit(1))\"; do sleep 1; done"
```

Stop with `pkill -f vite`.

## Browser setup — install OUTSIDE the repo

Playwright is a **dev-only tool, not a project dependency** — never add it to any `package.json` (dependency discipline). Install it into your session scratchpad:

```bash
mkdir -p "$SCRATCH/pw" && cd "$SCRATCH/pw" && npm init -y && npm install playwright
```

`$SCRATCH` = the session scratchpad directory from the system prompt.

- **macOS host:** Playwright's bundled Chromium works out of the box — `npx playwright install chromium`, then launch with no `executablePath`.
- **Linux container (e.g. a sandboxed runtime):** the bundled Chromium may miss libs. Install the system package (`apt-get install -y chromium` on Debian/Ubuntu, `apk add --no-cache chromium` on Alpine) and pass `executablePath` + `--no-sandbox` (see the template's commented lines).

## Drive + screenshot

Run from `$SCRATCH/pw`. Routes: `/` (home), `/log`, `/tasks`, `/habits`, `/inbox`, `/settings`.

```js
import { chromium } from 'playwright';

const browser = await chromium.launch({
  // executablePath: '/usr/bin/chromium', args: ['--no-sandbox'],  // uncomment on a Linux container
  headless: true,
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
page.on('console', m => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', e => errors.push(String(e)));

await page.goto(`http://localhost:${process.env.PORT ?? 5173}/tasks`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('text=Tasks', { timeout: 30000 }); // first Vite compile is slow — wait-for, never sleep

await page.screenshot({ path: 'page.png', fullPage: true });
// Component crop — Tailwind utility classes aren't hashed, so match on visible text or a data attr:
// await page.locator('text=Estimate').first().screenshot({ path: 'component.png' });

console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
```

Then **Read the PNGs and actually look at them.** Check the `ERRORS:` line before declaring success — the shell can render fine while data logic throws.

Interactions (`fill`, `click`, `press`) go through the real input pipeline, so React controlled inputs behave normally.

## Gotchas

- Launch with **no env flags** — `VITE_API_MODE=http` breaks visual work (real Cognito + no backend).
- First Vite compile is slow → always `waitForSelector`, never `sleep`.
- Tailwind classes aren't hashed → select on text / `data-*`, not class substrings.
- Don't add Playwright (or any browser driver) to a `package.json` — scratchpad only.
- Light/dark is a CSS-variable flip; if you're verifying a theme, toggle it in-app rather than assuming a default.
