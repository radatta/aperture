---
name: run-app
description: Launch the Aperture PWA and screenshot/drive it with headless Chromium. Use when asked to run the app, visually verify a UI change, or screenshot a page/component. Covers the default stub + auth-bypass, browser setup, and driving/screenshotting.
---

# Run the Aperture app + screenshot it

Use this when you need a *rendered* UI (screenshots, click paths) — not just lint/tests. Vitest covers logic; this covers "does it actually look/behave right." This is the local stub app; for the **deployed dev stage** use the dev check instead (`devcheck` skill, `docs/ops/DEV-CHECK.md`).

## The app runs auth-free by default

Aperture defaults to **stub mode** (`API_MODE='stub'` unless `VITE_API_MODE=http` is injected). In stub mode:

- **Auth is bypassed** — `AuthProvider` returns a fixed `local@aperture.dev` identity and `RequireAuth` is a pass-through. No Cognito, no sign-in screen.
- **Data is the in-memory stub** (`src/data/stubClient.ts`, seeded from `src/data/seed.ts`) — nothing hits the network.

So you launch with **no env flags** — `pnpm dev` is already in a screenshot-able state. Do NOT set `VITE_API_MODE=http` for visual work; that turns on real Cognito + a real API and there's nothing to talk to locally.

## Launch Vite

Inside the container, launch it through the session board's heavy wrapper so other sessions see it and its
peak usage lands in the history (`docs/ops/SESSION-BOARD.md`). Shell variables don't survive between Bash
tool calls, so its PID and output go to files (`$SCRATCH` is the session scratchpad, _Browser setup_ below):

```bash
cd /path/to/aperture
{ HEAVY_CLASS=dev scripts/board/heavy.sh -- pnpm dev >"$SCRATCH/vite.log" 2>&1 & }
echo $! >"$SCRATCH/dev.pid"   # the wrapper's PID — `cd … && … &` would background the whole list instead
```

(On a bare Mac there is no board: plain `pnpm dev`, same redirect.)

**The port depends on where you are, and Vite walks upward if it's taken** — so read it, don't assume
it. Inside a COI container the base is `6173`; on a bare Mac it's `5173` (`app/vite.config.ts`, and
`docs/ops/COI-SANDBOX.md` → *Ports*). Other sessions may have their own Vite listening, so take the port
from **this** server's output, not from whatever is listening:

```bash
for _ in $(seq 40); do
  PORT=$(sed 's/\x1b\[[0-9;]*m//g' "$SCRATCH/vite.log" | grep -oE 'localhost:[0-9]+' | head -1 | cut -d: -f2)
  [ -n "$PORT" ] && break; sleep 1
done
echo "vite on $PORT"   # a later Bash call re-reads it with the same sed line
```

Poll for readiness (portable — works on macOS and Linux; don't assume `curl`). Keep the probe in a
`node -` heredoc rather than an inline one-liner — interpreter one-liners carrying a `host:port` are what
the COI monitor watches for (CLAUDE.md → _Commands_):

```bash
for _ in $(seq 40); do
  PORT=$PORT node - <<'JS' && break
fetch(`http://localhost:${process.env.PORT}`).then(() => process.exit(0), () => process.exit(1));
JS
  sleep 1
done
```

Stop it by its PID: `kill "$(cat "$SCRATCH/dev.pid")"` (the wrapper stops its whole process tree). Never
`pkill -f vite` — other sessions' dev servers match too.

## Browser setup — install OUTSIDE the repo

Playwright is a **dev-only tool, not a project dependency** — never add it to any `package.json` (dependency discipline). One shared install in `~/pw`, which the dev check loads too — reuse it if it's there:

```bash
mkdir -p ~/pw && cd ~/pw && npm init -y && npm install playwright && npx playwright install chromium
```

Write your driver scripts beside it (`~/pw/*.mjs`) so `import 'playwright'` resolves.

- **macOS host:** Playwright's bundled Chromium works out of the box — `npx playwright install chromium`, then launch with no `executablePath`.
- **Linux container (e.g. a sandboxed runtime):** the bundled Chromium may miss libs. Install the system package (`apt-get install -y chromium` on Debian/Ubuntu, `apk add --no-cache chromium` on Alpine) and pass `executablePath` + `--no-sandbox` (see the template's commented lines).

## Drive + screenshot

Run from `~/pw`. Routes: `/` (home), `/log`, `/tasks`, `/recruiting`, `/recruiting/stories`, `/habits`, `/rolls`, `/inbox`, `/settings`.

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

Save it as `shot.mjs` and, inside the container, run it through the wrapper too, so the browser's
threads count on the board: `PORT=$PORT HEAVY_CLASS=ui /path/to/aperture/scripts/board/heavy.sh -- node shot.mjs`.

Then **Read the PNGs and actually look at them.** Check the `ERRORS:` line before declaring success — the shell can render fine while data logic throws.

Interactions (`fill`, `click`, `press`) go through the real input pipeline, so React controlled inputs behave normally.

## Gotchas

- Light/dark is a CSS-variable flip on `<html data-theme>`. For a shot pair, set it directly — `page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))` — `ThemeProvider` only rewrites it when the theme setting changes, so the flip holds.
