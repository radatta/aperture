#!/usr/bin/env bash
# Proof frames of the web tower (docs/ops/TOWER.md → Proof): headless Chromium (every frame) and WebKit (the phone
# frames, nearest to iPhone Safari) from the shared ~/pw Playwright install, at the maintainer's phone (440×956 and
# 390×844, dpr 3, touch) and the Mac (1512×860), light and dark. Asserts what a phone must never do — hide text,
# scroll sideways, wrap the header, draw a spark over its numbers, offer a Mac-only button — and exits 1 naming each
# failure. Variants: `plain` (the view as served), `stress` (the same view with every string long and every source
# off), `empty` (nothing in flight), and expanded (TOWER.md → Expand): `xnext` and `xneeds` (the plain view at #next,
# #needs), `xstress` (stress at #next). One pass per engine also drives the expand: a poll, a reload, Esc, Back, keys.
# Plus an installed and a tab frame at 440 per engine for the status-bar floor.
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
  // a conflict chip naming a long branch, its check old (TOWER.md → Conflicts), on a row NOW shows (it drops TESTING)
  const cfLane = v.active.find((r) => r.state !== 'TESTING');
  if (cfLane) cfLane.conflicts = { main: ['a.ts'], lanes: [{ branch: 'a-fifty-character-branch-name-for-the-dev-slot-card', files: [LONG('file')] }], oldMin: 12 };
  v.slots[1] = { ...v.slots[1], branch: null, live: false, state: 'unknown', why: `refresh failed (${LONG('why')}), last read 05:59`, asOf: now - 400000 };
  v.sources = v.sources.map((s, i) => (i < 12 ? { ...s, state: 'failed', detail: LONG('src') } : s));
  v.next.table = v.next.table.map((r) => ({ ...r, what: LONG('plan'), you: LONG('you').slice(0, 70) }));
  v.next.soon = v.next.table.filter((r) => !r.done).slice(0, 3);
  v.next.notes = [LONG('note'), LONG('note2')];
  v.next.ask = { lo: now - 600000, hi: now - 60000, what: LONG('ask'), branch: 'echo-branch', source: 'lane', late: true };
  for (const r of v.active) if (r.eta?.pr) r.eta = { ...r.eta, late: true };
  v.heads = Object.fromEntries(Object.keys(v.heads).map((k) => [k, '12 lanes · ask late']));
  v.next.more = 4;
  v.slipping.push({ kind: 'fired', what: `F99: ${LONG('fired')}`, owner: 'lane', since: now - 7200000, after: 'tower-web merge' });
  // a red board: long items, a count gh can't vouch for (the chip reads "n? stale")
  v.board = { ...v.board, tone: 'bad', why: LONG('why'), unsure: `gh PRs ${LONG('unsure')}`,
    items: [...(v.board?.items ?? []), { kind: 'queue-state', what: LONG('board'), fix: LONG('fix'), branch: 'echo-branch', since: now - 3600000 }] };
  // context (F240): several sessions over 50 % with long names
  v.ctx = { at: now, stale: false, warn: [{ name: 'a-forty-character-session-name-for-ctx-x', pct: 44 }], bad: [1, 2, 3].map((k) => ({ name: `a-forty-character-session-name-for-ctx-${k}`, pct: 50 + k * 9 })) };
  if (v.sparks) v.sparks.mac = Array(58).fill(null).concat([30000, 31000]); // two points: no line to draw
  // F120: every power alert at once, and a slow container
  v.health.power = { known: true, line: 'battery 12% discharging (0:50 left) · Low Power Mode on · limit: CPU speed 80%, thermal warning 2', alerts: ['battery 12%', 'Low Power Mode', 'CPU speed 80%', 'thermal warning 2'], advice: '≤ 3 lanes (on battery under 30% or Low Power Mode)' };
  v.health.slowdown = { ...v.health.slowdown, worst: { cls: 'typecheck', ratio: 2.4 }, tone: 'bad', line: 'typecheck ×2.4 (3/41) · lint ×2.0 (2/37) · test ×1.2 (2/12) · ui – (no data since 14:02) · gate-lint ×1.8 (3/40) · gate-narrow ×1.4 (3/21) · gate-wide ×1.1 (4/9 7d)' };
  return v;
}
function empty(v) {
  // a server older than the page (a rollback): no power or slowdown in HEALTH must not break the render
  delete v.health.power;
  delete v.health.slowdown;
  v.needs = [];
  v.active = [];
  v.next = { order: [], queue: [], merge: [], maintainer: null, more: 0, parked: [], table: [], nowIndex: 0, soon: [], notes: [], planAt: null, ask: null };
  v.done = [];
  v.slipping = [];
  delete v.board; // a server older than the page: no board chip, no BOARD rows
  delete v.ctx; // nor a context count
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

// Board freshness (TOWER.md → Board freshness): the fixtures' queue.json contradicts the derived board, so the count
// shows amber or red — its own chip on the desktop, inside the sources chip on the phone (no room for a third
// button) — wherever a board is served; an older server's view has none; stress's SLIPPING (opened) has BOARD rows.
async function boardChecks(page, tag, variant, phone) {
  const r = await page.evaluate(() => {
    const shown = (c) => !!c && c.offsetParent !== null && getComputedStyle(c).display !== 'none';
    const b = document.querySelector('#board-chip');
    const s = document.querySelector('#sources-chip');
    const rows = [...document.querySelectorAll('#slipping .badge')].filter((e) => e.textContent === 'BOARD' && e.offsetParent !== null).length;
    const cx = document.querySelector('#ctx-chip');
    const ctxRow = [...document.querySelectorAll('#now .meta')].some((e) => /^ctx \d+%$/.test(e.textContent) && e.offsetParent !== null);
    const cfs = [...document.querySelectorAll('#now .meta.cf')].filter((e) => /^✗ /.test(e.textContent) && e.offsetParent !== null);
    const cfRow = cfs.some((e) => e.closest('.row')); // a lane row's, not only the slot card's
    // an amber chip's tone shows: a row meta's own colour once outranked .t-warn, so every meta read the same grey
    const plainMeta = [...document.querySelectorAll('#now .row .meta')].find((e) => !/\bt-/.test(e.className));
    const cfToned = !plainMeta || cfs.filter((e) => e.classList.contains('t-warn')).every((e) => getComputedStyle(e).color !== getComputedStyle(plainMeta).color);
    const cfDim = cfs.some((e) => e.classList.contains('t-dim')); // stress's chip is 12 min old
    const cfSlot = [...document.querySelectorAll('#now .slot .meta.cf')].some((e) => e.offsetParent !== null); // the dev holder's
    // every chip, rows' and slot cards', shows whole: never past its box, never in a box that clips (an ellipsis)
    const cfCut = [...document.querySelectorAll('#now .meta.cf, #next .meta.cf')].filter((e) => e.offsetParent !== null && (e.getBoundingClientRect().right > (e.closest('.row, .slot') ?? e.parentElement).getBoundingClientRect().right + 1 || (getComputedStyle(e.parentElement).overflow === 'hidden' && e.parentElement.scrollWidth > e.parentElement.clientWidth + 1))).map((e) => e.textContent);
    // innerText: what shows, not a hidden span
    return { board: shown(b), bText: b?.innerText ?? '', bCls: b?.className ?? '', sText: s?.innerText ?? '', sCls: s?.className ?? '', rows, ctx: shown(cx), cCls: cx?.className ?? '', ctxRow, cfRow, cfToned, cfDim, cfSlot, cfCut };
  });
  const loud = /t-(warn|bad)/;
  if (variant === 'empty') {
    if (r.board || /stale/.test(r.sText)) fails.push(`${tag}: a board count with no board in the view`);
    if (r.ctx || /ctx/.test(r.sText)) fails.push(`${tag}: a context count with no ctx in the view`);
    return;
  }
  // context (F240): the fixtures have a session over 50 %, so it leads the phone chip and shows on the desktop
  if (phone ? !/^\d+ ctx≥50/.test(r.sText) : !r.ctx || !/t-bad/.test(r.cCls)) fails.push(`${tag}: no context count (${phone ? r.sText : r.cCls})`);
  if (!variant.startsWith('x') && !r.ctxRow) fails.push(`${tag}: no row shows its session's ctx %`);
  // conflicts: the fixture's overlap.json has echo-branch, a NOW row, against main
  if (!variant.startsWith('x') && !r.cfRow) fails.push(`${tag}: no row shows a conflict chip`);
  if (!r.cfToned) fails.push(`${tag}: a conflict chip shows in a row meta's plain colour, not its tone`);
  // the fixture's dev holder, bravo-branch, conflicts with main: its slot card carries the chip
  if (!variant.startsWith('x') && !r.cfSlot) fails.push(`${tag}: the dev slot card shows no conflict chip`);
  if (variant === 'stress' && !r.cfDim) fails.push(`${tag}: stress's 12-min-old conflict chip isn't dim`);
  if (r.cfCut.length) fails.push(`${tag}: a conflict chip is cut or runs past its box: ${r.cfCut.join(' | ')}`);
  if (phone) {
    if (r.board) fails.push(`${tag}: the board chip shows on the phone (the header has no room)`);
    // the chip holds the first two of ctx≥50, behind, stale, ctx≥40, off: a session over 50 % may push stale out
    if (!/stale|^\d+ ctx≥50/.test(r.sText) || !loud.test(r.sCls)) fails.push(`${tag}: sources chip lacks the board count (${r.sCls} "${r.sText}")`);
  } else if (!r.board || !loud.test(r.bCls) || !/^board .* stale$/.test(r.bText))
    fails.push(`${tag}: board chip missing or quiet (${r.bCls} "${r.bText}")`);
  if (variant === 'stress' && !r.rows) fails.push(`${tag}: no BOARD row in the opened SLIPPING`);
}

// The Home Screen app at 440, in a real engine's cascade: no browser here emulates display-mode (Playwright has no
// option; Chromium ignores it over CDP), so the installed frame is served the page with the floor's display-mode
// terms dropped (portrait stays), and headless reports a 0 inset, as iOS 26 can. Installed, the header clears the
// 62 px floor; the page as served (a tab) keeps its own 8 px.
async function standalone(b, name) {
  // `flagged`: the page as served, but navigator.standalone true (iOS 26 can open a Home Screen app in a mode
  // display-mode misses): app.js's `installed` class must floor it the same way
  for (const mode of ['installed', 'flagged', 'tab']) {
    const tag = `${name}-${mode}-p440-light`;
    const ctx = await b.newContext({ ...SIZES.p440, colorScheme: 'light' });
    const page = await ctx.newPage();
    if (mode === 'flagged')
      await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
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
    if (mode !== 'tab' ? top < 62 + 8 : top !== 8) fails.push(`${tag}: header padding-top ${top}px`);
    await page.screenshot({ path: `${OUT}/${tag}.png` });
    console.log(`${OUT}/${tag}.png`);
    if (mode !== 'tab') {
      // an expanded panel's sticky strip sits below the same floor
      await page.evaluate(() => (location.hash = '#next'));
      await page.waitForTimeout(300);
      const st = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#strip')).top));
      if (!(st >= 62)) fails.push(`${tag}: the expand strip sticks at ${st}px, under the status bar`);
      await page.evaluate(() => (location.hash = ''));
      await page.waitForTimeout(300);
    }
    await page.unrouteAll({ behavior: 'ignoreErrors' }); // a poll still in flight mustn't throw on close
    await ctx.close();
  }
  // F161's readout: ?debug=1 shows it with the header's real padding; five taps on "serving" toggle it, a tap closes
  {
    const tag = `${name}-debug-p440-light`;
    const ctx = await b.newContext({ ...SIZES.p440, colorScheme: 'light' });
    const page = await ctx.newPage();
    await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
    await page.goto(BASE + '/?debug=1');
    await page.waitForSelector('#meta .ver', { state: 'attached' });
    const r = await page.evaluate(() => ({
      text: document.querySelector('#dbg')?.textContent ?? '',
      top: parseFloat(getComputedStyle(document.querySelector('header')).paddingTop),
    }));
    if (!r.text.includes(`header padding-top ${r.top}px`)) fails.push(`${tag}: readout ${JSON.stringify(r)}`);
    if (!r.text.includes('navigator.standalone: true') || /undefined|null|NaN/.test(r.text))
      fails.push(`${tag}: readout ${JSON.stringify(r.text)}`);
    await page.screenshot({ path: `${OUT}/${tag}.png` });
    console.log(`${OUT}/${tag}.png`);
    await page.click('#dbg');
    if (await page.$('#dbg')) fails.push(`${tag}: a tap didn't close the readout`);
    await page.goto(BASE + '/'); // no ?debug: off until five taps
    await page.waitForSelector('.serving', { state: 'attached' });
    if (await page.$('#dbg')) fails.push(`${tag}: readout open without ?debug`);
    // SOURCES sits folded on the phone (opened by a tap); the handler is what's under test, so dispatch the taps
    await page.evaluate(() => { for (let i = 0; i < 5; i++) document.querySelector('.serving').click(); });
    if (!(await page.$('#dbg'))) fails.push(`${tag}: five taps on "serving" didn't open the readout`);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await ctx.close();
  }
}

// An expanded frame: the open panel alone, the strip of the five others on top; NEXT's plan table carries a struck
// row, a slipping one and the now-line (the fixtures have each).
async function expandChecks(page, tag, id) {
  const r = await page.evaluate((id) => {
    const bad = [];
    const shown = (sel) => {
      const e = document.querySelector(sel);
      return !!e && getComputedStyle(e).display !== 'none';
    };
    if (document.body.dataset.open !== id) bad.push(`not expanded: data-open ${document.body.dataset.open}`);
    if (shown('#health')) bad.push('HEALTH shows behind an expanded panel');
    if (!shown('#strip')) bad.push('no strip');
    const chips = document.querySelectorAll('#strip .chip').length;
    if (chips !== 5) bad.push(`strip has ${chips} chips, want 5`);
    for (const s of document.querySelectorAll('main > section'))
      if (s.id !== id && shown(`#${s.id}`)) bad.push(`#${s.id} shows behind #${id}`);
    if (id === 'next') {
      const struck = document.querySelector('table.plan tr.done td.time');
      if (!struck || !getComputedStyle(struck).textDecorationLine.includes('line-through')) bad.push('no struck plan row');
      if (![...document.querySelectorAll('table.plan .slip')].some((e) => /now \d\d:\d\d/.test(e.textContent)))
        bad.push('no slip marker');
      if (!document.querySelector('table.plan tr.nowline')) bad.push('no now-line');
      if (document.querySelector('#next .showall')) bad.push('an expanded panel still caps its rows');
    }
    return bad;
  }, id);
  for (const b of r) fails.push(`${tag}: ${b}`);
}

// Drives the expand in one engine at the phone's size: a poll keeps it and its scroll, a reload keeps it, Esc and
// Back close it, keys open and close it, a bad hash is the glance, a slot card opened on the glance stays open.
async function expandPass(b, name) {
  const tag = `${name}-expand`;
  const ctx = await b.newContext({ ...SIZES.p390, colorScheme: 'light' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => fails.push(`${tag}: page error ${e.message}`));
  const state = () => page.evaluate(() => ({ hash: location.hash, open: document.body.dataset.open ?? null, y: Math.round(scrollY) }));
  const want = async (step, open) => {
    await page.waitForTimeout(300);
    const s = await state();
    if (s.open !== open || s.hash !== (open ? `#${open}` : '')) fails.push(`${tag}: ${step}: ${JSON.stringify(s)}, want ${open ?? 'closed'}`);
    return s;
  };
  await page.goto(BASE + '/');
  await page.waitForSelector('#meta .ver', { state: 'attached' });
  await page.locator('.slot').first().click(); // opened on the glance
  await page.click('#next h2');
  await want('a title tap', 'next');
  await page.evaluate(() => scrollTo(0, 120));
  const y0 = (await state()).y;
  await page.waitForTimeout(6000); // a poll redraws everything
  const s1 = await want('after a poll', 'next');
  if (s1.y !== y0) fails.push(`${tag}: a poll moved the scroll ${y0} → ${s1.y}`);
  await page.keyboard.press('Escape');
  await want('Esc', null);
  // in-page state (not a reload's: that starts the page afresh) comes back with the glance
  if (!(await page.locator('.slot').first().evaluate((e) => e.classList.contains('open'))))
    fails.push(`${tag}: a slot card opened on the glance closed across the expand`);
  await page.evaluate(() => scrollTo(0, 300)); // the glance's place, which closing after a reload returns to
  const gy = (await state()).y;
  await page.keyboard.press('3');
  await want('key 3', 'next');
  await page.evaluate(() => scrollTo(0, 120));
  const y1 = (await state()).y;
  await page.reload();
  await page.waitForSelector('#meta .ver', { state: 'attached' });
  await page.waitForTimeout(400);
  const s2 = await want('after a reload', 'next');
  if (Math.abs(s2.y - y1) > 2) fails.push(`${tag}: a reload lost the scroll ${y1} → ${s2.y}`);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#meta .ver', { state: 'attached' });
  const s3 = await want('Esc after a reload', null);
  if (Math.abs(s3.y - gy) > 2) fails.push(`${tag}: Esc after a reload lost the glance's place ${gy} → ${s3.y}`);
  await page.keyboard.press('3');
  await want('key 3', 'next');
  await page.keyboard.press('2');
  await want('key 2 switches', 'now');
  await page.keyboard.press('2');
  await want('key 2 again closes', null);
  await page.keyboard.press('1');
  await want('key 1', 'needs');
  await page.goBack();
  await page.waitForSelector('#meta .ver', { state: 'attached' });
  await want('Back', null);
  await page.keyboard.press('Control+3');
  await want('a key with a modifier', null);
  await page.goto(BASE + '/#zzz');
  await page.waitForSelector('#meta .ver', { state: 'attached' });
  const z = await page.evaluate(() => document.body.dataset.open ?? null);
  if (z !== null) fails.push(`${tag}: #zzz opened ${z}`);
  // loaded straight at #next (no entry of ours to go back to): Esc stays on the page
  const fresh = await ctx.newPage();
  await fresh.goto(BASE + '/#next');
  await fresh.waitForSelector('#meta .ver', { state: 'attached' });
  await fresh.keyboard.press('Escape');
  await fresh.waitForTimeout(300);
  const f = await fresh.evaluate(() => ({ url: location.href, open: document.body.dataset.open ?? null }));
  if (f.open !== null || !f.url.startsWith(BASE) || f.url.includes('#')) fails.push(`${tag}: Esc on a direct #next: ${JSON.stringify(f)}`);
  console.log(`${tag}: done`);
  await ctx.close();
}

// A tap opens a row with details, which then shows them in full; a slot card stays open across a poll.
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
        for (const variant of ['plain', 'stress', 'empty', 'xnext', 'xneeds', 'xstress']) {
          const ctx = await b.newContext({ ...opts, colorScheme: scheme });
          const page = await ctx.newPage();
          page.on('pageerror', (e) => fails.push(`${name}-${variant}-${size}-${scheme}: page error ${e.message}`));
          const data = variant === 'xstress' ? 'stress' : variant.startsWith('x') ? 'plain' : variant;
          const at = variant === 'xneeds' ? 'needs' : variant.startsWith('x') ? 'next' : null;
          if (data !== 'plain')
            await page.route('**/api/state*', async (route) => {
              const res = await route.fetch();
              const v = await res.json();
              await route.fulfill({ response: res, json: data === 'stress' ? stress(v) : empty(v) });
            });
          await page.goto(BASE + '/' + (at ? `#${at}` : ''));
          await page.waitForSelector('#meta .ver', { state: 'attached' });
          await page.waitForTimeout(400);
          const tag = `${name}-${variant}-${size}-${scheme}`;
          // the folded panels open, so the frame shows (and checks) them too
          if (variant === 'stress') for (const id of ['slipping', 'sources']) await page.click(`#${id} h2`);
          await check(page, tag, size !== 'desk');
          await boardChecks(page, tag, variant, size !== 'desk');
          if (at) await expandChecks(page, tag, at);
          await page.screenshot({ path: `${OUT}/${tag}.png`, fullPage: true });
          if (variant === 'stress' && scheme === 'light' && size !== 'desk') await taps(page, tag);
          console.log(`${OUT}/${tag}.png`);
          await page.unrouteAll({ behavior: 'ignoreErrors' }); // a poll still in flight mustn't throw on close
          await ctx.close();
        }
    }
    await standalone(b, name);
    await expandPass(b, name);
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
