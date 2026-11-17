#!/usr/bin/env bash
# Proof frames of the web tower (docs/ops/TOWER.md → Proof): headless Chromium (every frame) and WebKit (the phone
# frames, nearest to iPhone Safari) from the shared ~/pw Playwright install, at the maintainer's phone (440×956 and
# 390×844, dpr 3, touch) and the Mac (1512×860), light and dark. Asserts what a phone must never do — hide text,
# scroll sideways, wrap the header, draw a spark over its numbers, offer a Mac-only button — and exits 1 naming each
# failure. Variants: `plain` (the view as served), `stress` (the same view with every string long and every source
# off), `empty` (nothing in flight).
#   scripts/board/tower-web-capture.sh <out-dir>                 the fixtures at a fixed clock, on a spare port
#   scripts/board/tower-web-capture.sh <out-dir> --url <base>    a running server (a live proof server)
# Run it under scripts/board/heavy.sh -- (it starts browsers).
set -euo pipefail
out=${1:?usage: tower-web-capture.sh <out-dir> [--url <base>]}
here="$(cd "$(dirname "$0")" && pwd)"
[ -d "$HOME/pw/node_modules/playwright" ] || { echo "tower-web-capture: needs Playwright in ~/pw" >&2; exit 1; }
mkdir -p "$out"
out="$(cd "$out" && pwd)"
url=
[ "${2:-}" = --url ] && url=${3:?--url wants a base url}
srv=
trap '[ -n "$srv" ] && kill "$srv" 2>/dev/null || true' EXIT
if [ -z "$url" ]; then
  port=${APERTURE_CAPTURE_PORT:-6192}
  bash "$here/tower-web.sh" --fixtures "$here/../src/board/tower/fixtures" --now 2026-11-08T06:10:00Z \
    --port "$port" --bind 127.0.0.1 >/dev/null 2>&1 &
  srv=$!
  url="http://127.0.0.1:$port"
  for _ in $(seq 50); do curl -s -o /dev/null "$url/api/state" && break; sleep 0.2; done
fi
PW="$HOME/pw" OUT="$out" BASE="$url" node - <<'JS'
const { createRequire } = require('node:module');
const { chromium, webkit } = createRequire(process.env.PW + '/')('playwright');
const OUT = process.env.OUT;
const BASE = process.env.BASE;
const fails = [];
const LONG = (tag) =>
  `${tag}-a-very-long-unbroken-token-that-a-phone-must-wrap-not-hide ` +
  'and then a long tail of ordinary words, long enough to need three or four lines at phone width; ' +
  'the second clause (with a parenthesis; and a semicolon inside it) runs on past any first-clause cut.';

const SIZES = {
  p440: { viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  p390: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  desk: { viewport: { width: 1512, height: 860 }, deviceScaleFactor: 2 },
};

function stress(v) {
  const now = v.now;
  v.needs = [
    { kind: 'lane', what: LONG('need'), link: null, cmd: 'cd <mac-repo> && pnpm mailroom open-pr --title "a title"', unblocks: LONG('unblocks'), since: now - 600000, branch: 'india-branch' },
    { kind: 'todo', what: LONG('todo'), link: null, cmd: null, unblocks: null, since: now - 1, sinceDay: '11-07', branch: null },
    ...v.needs,
  ];
  for (const r of v.active.slice(0, 2)) r.detail = LONG('detail');
  if (v.active[2]) {
    v.active[2].hold = LONG('hold');
    v.active[2].label = 'HOLD (long)';
    v.active[2].state = 'HOLD';
  }
  v.slots[0] = { ...v.slots[0], branch: 'a-fifty-character-branch-name-for-the-dev-slot-card', session: 'auto-6', detail: LONG('slot'), live: true, state: 'live' };
  v.behind = { head: 'f'.repeat(40), files: 12 }; // the header chip reads "behind main · N off"
  v.slots[1] = { ...v.slots[1], branch: null, live: false, state: 'unknown', why: `refresh failed (${LONG('why')}), last read 05:59`, asOf: now - 400000 };
  v.sources = v.sources.map((s, i) => (i < 12 ? { ...s, state: 'failed', detail: LONG('src') } : s));
  v.next.plan = [LONG('plan')];
  v.next.more = 4;
  v.slipping.push({ kind: 'fired', what: `F99: ${LONG('fired')}`, owner: 'lane', since: now - 7200000, after: 'tower-web merge' });
  if (v.sparks) v.sparks.mac = Array(58).fill(null).concat([30000, 31000]); // two points: no line to draw
  return v;
}
function empty(v) {
  v.needs = [];
  v.active = [];
  v.next = { order: [], queue: [], merge: [], maintainer: null, more: 0, plan: [], parked: [] };
  v.done = [];
  v.slipping = [];
  return v;
}

// What a frame must never do; `phone` adds the phone-only rules.
async function check(page, tag, phone) {
  const r = await page.evaluate((phone) => {
    const bad = [];
    const vis = (e) => e.offsetParent !== null && getComputedStyle(e).display !== 'none';
    const words = document.body.innerText.match(/\b(undefined|NaN|null|\[object Object\])\b/g);
    if (words) bad.push(`renders ${[...new Set(words)].join(', ')}`);
    if (document.documentElement.scrollWidth > innerWidth + 1)
      bad.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${innerWidth}`);
    for (const e of document.querySelectorAll('header > *')) {
      const lh = parseFloat(getComputedStyle(e).lineHeight) || parseFloat(getComputedStyle(e).fontSize) * 1.35;
      if (vis(e) && e.getBoundingClientRect().height > lh * 1.6 + 12) bad.push(`header wraps: ${e.id || e.className || e.tagName} ${Math.round(e.getBoundingClientRect().height)}px`);
    }
    const textBox = (e) => {
      const rg = document.createRange();
      rg.selectNodeContents(e);
      return rg.getBoundingClientRect();
    };
    const hit = (a, b) => a.width && b.width && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    for (const t of document.querySelectorAll('.tile')) {
      const sp = t.querySelector('svg.spark');
      if (!sp || !vis(sp)) continue;
      const s = sp.getBoundingClientRect();
      for (const sel of ['.value', '.sub'])
        if (hit(s, textBox(t.querySelector(sel)))) bad.push(`spark over ${sel} in ${t.querySelector('.label').textContent}`);
    }
    for (const sp of document.querySelectorAll('svg.spark'))
      if (vis(sp) && sp.querySelectorAll('polyline').length === 0) bad.push('an empty spark is drawn');
    if (phone) {
      for (const e of document.querySelectorAll('.row .text, .slot .who, .slot .what, .tile .sub, .tile .value'))
        if (vis(e) && e.scrollWidth > e.clientWidth + 1) bad.push(`text cut: ${e.className} "${e.textContent.slice(0, 50)}"`);
      for (const b of document.querySelectorAll('.only-desk')) if (vis(b)) bad.push('a Mac-only button shows on the phone');
      const h = document.querySelector('#health').getBoundingClientRect().width;
      const td = document.querySelector('.tile.k-today');
      if (td && td.getBoundingClientRect().width > h * 0.6) bad.push('TODAY takes a full row');
    } else {
      for (const b of document.querySelectorAll('.only-phone')) if (vis(b)) bad.push('a phone-only label shows on the desktop');
    }
    return bad;
  }, phone);
  for (const b of r) fails.push(`${tag}: ${b}`);
}

// A tap opens a row with details, which then shows them in full; a slot card stays open across a poll.
// The Home Screen app at 440, in a real engine's cascade: no browser here emulates display-mode (Playwright has no
// option; Chromium ignores it over CDP), so the installed frame is served the page with the floor's display-mode
// terms dropped (portrait stays), and headless reports a 0 inset, as iOS 26 can. Installed, the header clears the
// 62 px floor; the page as served (a tab) keeps its own 8 px.
async function standalone(b, name) {
  for (const mode of ['installed', 'tab']) {
    const tag = `${name}-${mode}-p440-light`;
    const ctx = await b.newContext({ ...SIZES.p440, colorScheme: 'light' });
    const page = await ctx.newPage();
    let forced = 0;
    if (mode === 'installed')
      await page.route(BASE + '/', async (route) => {
        const res = await route.fetch();
        const html = (await res.text()).replace(/\(display-mode: (standalone|fullscreen)\) and /g, () => (forced++, ''));
        await route.fulfill({ response: res, body: html });
      });
    await page.goto(BASE + '/');
    await page.waitForSelector('#meta .ver', { state: 'attached' });
    if (mode === 'installed' && forced !== 2) fails.push(`${tag}: found ${forced} of the 2 floor terms to force`);
    const top = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('header')).paddingTop));
    if (mode === 'installed' ? top < 62 + 8 : top !== 8) fails.push(`${tag}: header padding-top ${top}px`);
    await page.screenshot({ path: `${OUT}/${tag}.png` });
    console.log(`${OUT}/${tag}.png`);
    await ctx.close();
  }
}

async function taps(page, tag) {
  const n = await page.locator('#needs .item.has-more').count();
  if (n) {
    const it = page.locator('#needs .item.has-more').first();
    await it.locator('.row').click();
    if (!(await it.locator('.more').isVisible())) fails.push(`${tag}: a tap on a NEEDS YOU row shows no details`);
    const full = await it.locator('.more').innerText();
    if (/…/.test(full)) fails.push(`${tag}: a row's details are still cut`);
    await it.locator('.row').click();
  }
  const slot = page.locator('.slot').first();
  await slot.click();
  await page.waitForTimeout(6000); // a poll redraws everything
  if (!(await page.locator('.slot').first().evaluate((e) => e.classList.contains('open'))))
    fails.push(`${tag}: an open slot card closed on the next poll`);
  await page.locator('.slot').first().click();
}

(async () => {
  const engines = [['chromium', chromium]];
  try {
    const w = await webkit.launch();
    await w.close();
    engines.push(['webkit', webkit]);
  } catch (e) {
    console.log(`webkit unavailable here (${e.message.split('\n')[0]}): chromium only`);
  }
  for (const [name, engine] of engines) {
    const b = await engine.launch(name === 'chromium' ? { args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] } : {});
    for (const [size, opts] of Object.entries(SIZES)) {
      if (name === 'webkit' && size === 'desk') continue;
      for (const scheme of ['light', 'dark'])
        for (const variant of ['plain', 'stress', 'empty']) {
          const ctx = await b.newContext({ ...opts, colorScheme: scheme });
          const page = await ctx.newPage();
          page.on('pageerror', (e) => fails.push(`${name}-${variant}-${size}-${scheme}: page error ${e.message}`));
          if (variant !== 'plain')
            await page.route('**/api/state*', async (route) => {
              const res = await route.fetch();
              const v = await res.json();
              await route.fulfill({ response: res, json: variant === 'stress' ? stress(v) : empty(v) });
            });
          await page.goto(BASE + '/');
          await page.waitForSelector('#meta .ver', { state: 'attached' });
          await page.waitForTimeout(400);
          const tag = `${name}-${variant}-${size}-${scheme}`;
          // the folded panels open, so the frame shows (and checks) them too
          if (variant === 'stress') for (const id of ['slipping', 'sources']) await page.click(`#${id} h2`);
          await check(page, tag, size !== 'desk');
          await page.screenshot({ path: `${OUT}/${tag}.png`, fullPage: true });
          if (variant === 'stress' && scheme === 'light' && size !== 'desk') await taps(page, tag);
          console.log(`${OUT}/${tag}.png`);
          await ctx.close();
        }
    }
    await standalone(b, name);
    await b.close();
  }
  if (fails.length) {
    console.error(`\n${fails.length} failed:\n${fails.join('\n')}`);
    process.exit(1);
  }
  console.log('all checks passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
JS
