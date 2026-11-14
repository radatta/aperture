// The tower page (docs/ops/TOWER.md): polls /api/state every 5 s and renders it. Rendering only; every rule
// (states, HOLD, NEEDS YOU, freshness) is server-side in derive.ts. Text goes in with textContent, never as HTML.
// Layout (the maintainer, 2026-11-13): big type, one short line per item, details on click, HEALTH above the fold; colour
// only where it means a state, motion only on work in flight.
'use strict';

const POLL_MS = 5000;
let chartsOn = new URLSearchParams(location.search).get('charts') === '1';
let failures = 0;
let lastOk = null;
let served = null; // the commit this page's script came with: a new one reloads the page
let offset = 0; // server clock − ours: timers tick against the server's now (fixtures run on a fixed clock)
const expanded = new Set(); // keys of expanded items, kept across polls
const showAll = new Set(); // panels showing every row
let seen = new Map(); // item key → its last label: a change flashes the row
let lastDone = null; // merges today at the last render: one more is a small cheer

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
function ago(ms, now) {
  if (ms === null || ms === undefined) return '';
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.floor(s / 60)}m`;
  if (s < 172800) return `${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}`;
  return `${Math.round(s / 86400)}d`;
}
// a live elapsed time: re-rendered every second by the ticker below
function timer(since, prefix = '') {
  const t = el('span', 'meta', `${prefix}${ago(since, Date.now() + offset)}`);
  t.dataset.since = String(since);
  t.dataset.prefix = prefix;
  return t;
}
const gib = (mib) => `${(mib / 1024).toFixed(1)}`;
const httpsLink = (url, text) => {
  if (typeof url !== 'string' || !url.startsWith('https://')) return el('span', null, text);
  const a = el('a', null, text);
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.addEventListener('click', (e) => e.stopPropagation());
  return a;
};
// colour = meaning: tone (server) or state → one of the palette's classes
const TONE_C = { good: 'c-good', warn: 'c-hold', bad: 'c-bad', dim: 'c-dim', normal: 'c-build' };
const STATE_C = {
  TESTING: 'c-dev',
  'ON DEV': 'c-dev',
  BUILDING: 'c-build',
  PR: 'c-pr',
  'CHECKS FAILED': 'c-bad',
  'MERGE ME': 'c-good',
  READY: 'c-good',
  DONE: 'c-good',
  HOLD: 'c-hold',
  'NEEDS YOU': 'c-hold',
  DEPLOYING: 'c-deploy',
  'DEPLOY FAILED': 'c-bad',
  MERGED: 'c-deploy',
  WAITING: 'c-dim',
  PARKED: 'c-dim',
};
const LIVE = (r) =>
  r.state === 'TESTING' || r.state === 'DEPLOYING' || r.label === 'PR (checks running)';
const badge = (text, c) => el('span', `badge ${c || 'c-dim'}`, text);
// Long text from outside (queue.json, lane steps) never renders whole in a row: its first clause, capped. A clause
// ends at `.`/`;` + space or a newline, never inside ( ) or [ ] ("clear auto-3, then kickoff (F81; …)" stays whole).
const short = (s, n = 90) => {
  const str = String(s ?? '');
  let depth = 0;
  let end = str.length;
  for (let k = 0; k < str.length; k++) {
    const ch = str[k];
    if (ch === '\n') {
      end = k;
      break;
    }
    if (ch === '(' || ch === '[') depth++;
    else if ((ch === ')' || ch === ']') && depth) depth--;
    else if (!depth && (ch === '.' || ch === ';') && /\s/.test(str[k + 1] ?? '')) {
      end = k + 1;
      break;
    }
  }
  const t = str.slice(0, end).replace(/[.;,]$/, '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function body(id) {
  const b = $(`#${id} .body`);
  b.replaceChildren();
  return b;
}

// One item: a one-line row (dot · badge · text · track · meta), its details below on click. `c` colours the row's
// bar and badge; `sig` changing since the last poll flashes it.
function item(key, parts) {
  const wrap = el('div', `item ${parts.c ?? ''}`);
  wrap.dataset.key = key;
  rendered.add(key);
  if (expanded.has(key)) wrap.classList.add('open');
  const sig = parts.sig ?? null;
  if (sig !== null && seen.has(key) && seen.get(key) !== sig) wrap.classList.add('flash');
  if (sig !== null) next_seen.set(key, sig);
  const row = el('div', 'row');
  if (parts.live) row.append(liveDot());
  if (parts.badge) row.append(badge(parts.badge, parts.c));
  const text = el('span', 'text');
  for (const p of parts.text) text.append(typeof p === 'string' ? document.createTextNode(p) : p);
  row.append(text);
  if (parts.track) row.append(parts.track);
  for (const m of parts.meta ?? [])
    if (m) row.append(typeof m === 'string' ? el('span', 'meta', m) : m);
  wrap.append(row);
  const more = el('div', 'more');
  for (const m of parts.more ?? [])
    if (m) more.append(typeof m === 'string' ? el('div', null, m) : m);
  if (more.childNodes.length) {
    wrap.append(more);
    wrap.classList.add('has-more');
    row.title = 'click for details';
  }
  // every row opens: one with no details still unwraps its line (a phone shows what CSS had cut)
  row.addEventListener('click', () => toggle(key, wrap));
  return wrap;
}
let next_seen = new Map();
function toggle(key, node) {
  if (expanded.has(key)) expanded.delete(key);
  else expanded.add(key);
  node.classList.toggle('open');
}
// a pulsing dot whose phase follows the wall clock, so re-rendering every 5 s doesn't restart its pulse
function liveDot(extra = '') {
  const d = el('span', `dot live${extra}`);
  d.style.animationDelay = `-${Date.now() % 1600}ms`;
  return d;
}

// the phase track: plan › build › gate › review › local › dev › pr › merged, the current one lit
const TRACK = ['plan', 'build', 'gate', 'review', 'local', 'dev', 'pr', 'merged'];
function track(phase) {
  const k = TRACK.indexOf(phase);
  if (k < 0) return null;
  const t = el('span', 'track');
  t.title = `${TRACK.slice(0, k + 1).join(' › ')}`;
  TRACK.forEach((_, i) => t.append(el('i', i < k ? 'done' : i === k ? 'now' : '')));
  return t;
}

// At most `max` rows, then a "+n more" button.
function list(b, id, items, max) {
  const all = showAll.has(id);
  items.slice(0, all ? items.length : max).forEach((i) => b.append(i));
  if (items.length > max) {
    const btn = el('button', 'showall', all ? 'show fewer' : `+${items.length - max} more`);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      if (all) showAll.delete(id);
      else showAll.add(id);
      if (lastView) render(lastView, false); // the view in hand: no second fetch racing the poll
    });
    b.append(btn);
  }
}

// Each panel's sources: an empty panel says "can't tell" when one of them isn't ok, never a calm "nothing".
const PANEL_SOURCES = {
  needs: ['lane files', 'gh PRs', 'gh checks', 'gh runs', 'queue.json'],
  now: ['dev lock', 'devb lock', 'lane files', 'gh PRs', 'gh runs', 'gh checks'],
  next: ['queue.json', 'gh PRs', 'gh checks'],
  done: ['gh PRs', 'gh runs'],
  slipping: ['queue.json', 'lane files'],
};
const notOk = (v, id) =>
  v.sources.filter((s) => PANEL_SOURCES[id].includes(s.name) && s.state !== 'ok');
function emptyOr(v, b, id, text) {
  const bad = notOk(v, id);
  if (!bad.length) return b.append(el('div', 'empty', text));
  b.append(el('div', 'cant', `can't tell: ${bad.map((s) => `${s.name} ${s.state}`).join(', ')}`));
}

function copyButton(text) {
  const btn = el('button', 'only-desk', 'copy');
  btn.type = 'button';
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'copied ✓';
    } catch {
      btn.textContent = 'copy failed: select it below';
      const it = btn.closest('.item');
      if (it) {
        it.classList.add('open');
        expanded.add(it.dataset.key);
      }
    }
    setTimeout(() => (btn.textContent = 'copy'), 2000);
  });
  return btn;
}

const NEED = {
  merge: ['MERGE', 'c-good'],
  lane: ['DO', 'c-hold'],
  deploy: ['DEPLOY FAILED', 'c-bad'],
  todo: ['TODO', 'c-hold'],
  source: ['SETUP', 'c-hold'],
};

function needs(v) {
  const b = body('needs');
  $('#needs .count').textContent = v.needs.length ? `(${v.needs.length})` : '';
  $('#needs').classList.toggle('has', v.needs.length > 0);
  if (!v.needs.length) return emptyOr(v, b, 'needs', 'nothing needs you ✓');
  const items = v.needs.map((n) => {
    const [label, c] = NEED[n.kind] ?? NEED.todo;
    return item(`need:${n.kind}:${n.branch ?? ''}:${n.what.slice(0, 60)}`, {
      c,
      badge: label,
      sig: n.what,
      text: [n.link ? httpsLink(n.link, short(n.what)) : short(n.what)],
      meta: [
        n.cmd ? copyButton(n.cmd) : null,
        // a one-line Mac command can't run from a phone: it says where it runs; the command is in the details
        n.cmd ? el('span', 'meta only-phone', 'on the Mac') : null,
        n.sinceDay ? `since ${n.sinceDay}` : n.since ? timer(n.since) : null,
      ],
      more: [
        short(n.what) !== n.what ? n.what : null,
        n.unblocks ? `unblocks: ${n.unblocks}` : null,
        n.cmd ? el('code', null, n.cmd) : null,
      ],
    });
  });
  list(b, 'needs', items, 6);
}

// `o`: a landing-order row (NEXT): its own key, its place, dispatch's note
function laneItem(r, o = null) {
  const text = [el('b', null, r.branch)];
  if (r.session) text.push(el('span', 'who', `  ${r.session}`));
  if (r.hold) text.push(`  ·  ${short(r.hold, 70)}`);
  else if (r.detail) text.push(`  ·  ${short(r.detail, 70)}`);
  return item(o ? `order:${r.branch}` : `lane:${r.branch}`, {
    c: STATE_C[r.state] ?? TONE_C[r.tone] ?? 'c-build',
    live: LIVE(r),
    badge: `${o ? `${o.pos} · ` : ''}${r.label.startsWith('HOLD') ? 'HOLD' : r.label}`,
    sig: r.label,
    text,
    track: track(r.phase),
    meta: [
      r.quiet ? el('span', 'meta t-warn', `quiet ${ago(v_now - r.fileAge * 1000, v_now)}`) : null,
      r.since ? timer(r.since) : null,
    ],
    more: [
      o?.note ? `landing order: ${o.note}` : null,
      r.hold ? `held: ${r.hold}` : null,
      // under a HOLD the row shows the hold, so the detail is only here
      r.detail && (r.hold || short(r.detail, 70) !== r.detail) ? r.detail : null,
      r.pr ? httpsLink(r.pr.url, `PR ${r.pr.number}: ${r.pr.title}`) : null,
      r.phase ? `phase: ${track(r.phase)?.title ?? r.phase}` : null,
      r.fileAge !== null ? `lane file updated ${ago(v_now - r.fileAge * 1000, v_now)} ago` : null,
    ],
  });
}
let v_now = 0;

function nowPanel(v) {
  const b = body('now');
  const slots = el('div', 'slots');
  for (const s of v.slots) {
    const busy = !!s.branch;
    const tone =
      s.state === 'unknown' ? 'c-hold' : busy ? 'c-dev' : s.deploying ? 'c-deploy' : 'c-good';
    const key = `slot:${s.slot}`;
    rendered.add(key);
    const c = el('div', `slot ${tone}`);
    if (expanded.has(key)) c.classList.add('open');
    c.addEventListener('click', () => toggle(key, c));
    const name = el('div', 'name');
    const working = (busy && /running|deploying/.test(s.detail ?? '')) || s.deploying;
    name.append(
      working ? liveDot() : el('span', 'dot'),
      document.createTextNode(s.slot.toUpperCase()),
    );
    c.append(name);
    if (busy) {
      c.append(el('div', 'who', `${s.branch}${s.session ? ` · ${s.session}` : ''}`));
      const what = el(
        'div',
        'what',
        `${short(s.detail ?? 'holding the lock', 40)} · to ${hhmm(s.expiresAt)}`,
      );
      c.append(what);
    } else if (s.deploying) c.append(el('div', 'who', 'no holder · a dev deploy is running'));
    else if (s.state === 'free') c.append(el('div', 'who', 'free'));
    // known noise stays quiet: a lock read under 5 min old is just "as of"; past that it is unknown, and says so
    // (briefly on the card, the server's why in full in its details)
    if (s.state === 'unknown')
      c.append(
        el('div', 'what t-warn', `lock unknown${s.asOf ? ` · last read ${hhmm(s.asOf)}` : ''}`),
      );
    else if (s.asOf) c.append(el('div', `what${busy ? '' : ' asof'}`, `as of ${hhmm(s.asOf)}`));
    const more = el('div', 'more');
    if (busy && s.detail && short(s.detail, 40) !== s.detail)
      more.append(el('div', null, s.detail));
    if (s.why) more.append(el('div', null, s.why));
    if (s.failed && s.state !== 'unknown')
      more.append(el('div', null, 'the last refresh failed; this read stands'));
    if (more.childNodes.length) c.append(more);
    slots.append(c);
  }
  b.append(slots);
  const rows = v.active.filter((r) => r.state !== 'TESTING');
  if (!rows.length) return emptyOr(v, b, 'now', 'no lanes building');
  list(
    b,
    'now',
    rows.map((r) => laneItem(r)),
    8,
  );
}

function next(v) {
  const b = body('next');
  const items = [];
  if (v.next.maintainer)
    items.push(
      item('next:maintainer', {
        c: 'c-hold',
        badge: 'YOU NEXT',
        sig: v.next.maintainer,
        text: [short(v.next.maintainer)],
        meta: [v.next.more ? `+${v.next.more} in NEEDS YOU` : null],
        more: [short(v.next.maintainer) !== v.next.maintainer ? v.next.maintainer : null],
      }),
    );
  // dispatch's landing order, each lane as it stands; its merge rows aren't repeated below
  const order = v.next.order ?? [];
  order.forEach((o, k) => items.push(laneItem(o.row, { pos: k + 1, note: o.note })));
  for (const r of v.next.merge)
    if (!order.some((o) => o.branch === r.branch)) items.push(laneItem(r));
  for (const slot of ['dev', 'devb'])
    v.next.queue
      .filter((l) => l.slot === slot)
      .forEach((l, i) =>
        items.push(
          item(`q:${slot}:${l.branch}`, {
            c: 'c-dim',
            badge: `${slot} ${i + 1}`,
            text: [el('b', null, l.branch), l.waitingOn ? `  ·  ${short(l.waitingOn, 60)}` : ''],
            more: [l.waitingOn && short(l.waitingOn, 60) !== l.waitingOn ? l.waitingOn : null],
          }),
        ),
      );
  for (const p of v.next.plan ?? [])
    items.push(
      item(`plan:${p.slice(0, 60)}`, {
        c: 'c-hold',
        badge: 'PLAN',
        sig: p,
        text: [short(p)],
        more: [short(p) !== p ? p : null],
      }),
    );
  if (v.next.parked.length)
    items.push(
      item('next:parked', {
        c: 'c-dim',
        badge: 'PARKED',
        text: [el('span', 'who', v.next.parked.join(', '))],
      }),
    );
  if (!items.length) return emptyOr(v, b, 'next', 'nothing queued');
  list(b, 'next', items, 6);
}

function done(v) {
  const b = body('done');
  if (!v.done.length) return emptyOr(v, b, 'done', 'no merges yet today');
  const items = v.done.map((d) =>
    item(`done:${d.number}`, {
      c: TONE_C[d.tone],
      live: d.deploy === 'deploying',
      badge: d.deploy,
      sig: d.deploy,
      text: [`PR ${d.number}  ${d.title}`],
      // the day reaches back into last night before noon (web/main.ts dayStart): those say so
      meta: [`${d.mergedAt < localMidnight(v.now) ? 'yest ' : ''}${hhmm(d.mergedAt)}`],
      more: [
        d.branch,
        d.deployDetail,
        d.url ? httpsLink(d.url, /\/pull\/\d+$/.test(d.url) ? 'the PR' : 'the deploy run') : null,
      ],
    }),
  );
  list(b, 'done', items, 6);
}

const localMidnight = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

function kv(rows) {
  const g = el('div', 'kv');
  for (const [k, val] of rows) g.append(el('span', 'k', k), el('span', null, val));
  return g;
}

// A sparkline (hand-rolled SVG): one series, its own scale 0..max, gaps where the minute had no sample.
function spark(points, max) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('viewBox', '0 0 60 20');
  svg.setAttribute('preserveAspectRatio', 'none');
  // under 3 points there is no line to read (a fresh server, a Mac just back): no spark, not two dots
  if (!points || !max || points.filter((y) => y !== null).length < 3) {
    svg.classList.add('none');
    return svg;
  }
  const segs = [];
  let cur = [];
  points.forEach((y, x) => {
    if (y === null) {
      if (cur.length) segs.push(cur);
      cur = [];
    } else cur.push(`${x},${(19 - Math.min(1, y / max) * 18).toFixed(1)}`);
  });
  if (cur.length) segs.push(cur);
  for (const s of segs) {
    const line = document.createElementNS(ns, 'polyline');
    // a lone point between gaps: a one-minute tick, not a zero-length line
    const [x0, y0] = s[0].split(',').map(Number);
    line.setAttribute(
      'points',
      s.length === 1 ? `${x0 - 0.5},${y0} ${x0 + 0.5},${y0}` : s.join(' '),
    );
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'var(--c, var(--series))');
    line.setAttribute('stroke-width', '1.6');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    line.setAttribute('stroke-linejoin', 'round');
    svg.append(line);
  }
  return svg;
}

function tile(key, label, value, sub, c, details, extra) {
  const t = el('div', `tile ${c} k-${label.toLowerCase()}`);
  if (expanded.has(key)) t.classList.add('open');
  const val = el('div', 'value');
  if (Array.isArray(value))
    val.append(document.createTextNode(value[0]), el('small', null, value[1]));
  else val.textContent = value;
  t.append(el('div', 'label', label), val);
  if (extra) t.append(extra);
  t.append(el('div', 'sub', sub));
  const more = el('div', 'more');
  more.append(kv(details));
  t.append(more);
  t.addEventListener('click', () => toggle(key, t));
  return t;
}

function health(v) {
  const h = v.health;
  const box = $('#health');
  box.replaceChildren();
  const src = (name) => v.sources.find((s) => s.name === name);

  // TODAY: the day's merges, the hero number
  const deployed = v.done.filter((d) => d.tone === 'good').length;
  const inFlight = v.done.filter((d) => d.deploy === 'deploying').length;
  const unknown = v.done.filter((d) => d.tone === 'warn' && d.deploy !== 'deploying').length;
  // green only when every deploy is known good and the reads behind it are ok
  const doneBad = notOk(v, 'done');
  const today = tile(
    'h:t',
    'TODAY',
    [String(v.done.length), ' merged'],
    doneBad.length
      ? `can't tell: ${doneBad.map((s) => `${s.name} ${s.state}`).join(', ')}`
      : v.done.length
        ? [
            `${deployed} deployed ✓`,
            inFlight ? `${inFlight} deploying` : '',
            unknown ? `${unknown} deploy unknown` : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : 'nothing merged yet',
    v.done.some((d) => d.tone === 'bad')
      ? 'c-bad'
      : doneBad.length || unknown || inFlight
        ? 'c-hold'
        : v.done.length
          ? 'c-good'
          : 'c-dim',
    v.done.map((d) => [`PR ${d.number}`, `${d.deploy} · ${hhmm(d.mergedAt)}`]),
  );
  if (lastDone !== null && v.done.length > lastDone) today.classList.add('cheer');
  lastDone = v.done.length;
  box.append(today);

  const c = h.container;
  if (!c) box.append(tile('h:c', 'CONTAINER', 'no data', 'the sampler has no sample', 'c-bad', []));
  else {
    const stale = src('sampler')?.state !== 'ok'; // the server's rule (derive.ts STALE.sampler)
    const cc = stale
      ? 'c-hold'
      : c.anonMiB > c.anonHard
        ? 'c-bad'
        : c.anonMiB > c.anonSoft
          ? 'c-hold'
          : 'c-dev';
    box.append(
      tile(
        'h:c',
        'CONTAINER',
        [gib(c.anonMiB), ` / ${gib(c.highMiB)} GiB`],
        stale
          ? `sampler silent since ${hhmm(c.at)}`
          : `${c.cpu === null ? '?' : c.cpu.toFixed(1)} cores · tests ${c.tests}/${c.testCap ?? '?'}`,
        cc,
        [
          ['memory', `soft ${gib(c.anonSoft)} · hard ${gib(c.anonHard)} GiB · line: last hour`],
          [
            'cpu',
            c.cpu === null ? 'unknown (bad tick)' : `${c.cpu.toFixed(1)} of ${c.cores} cores`,
          ],
          ['pids', `${c.pids} of ${c.pidsMax}`],
          ['as of', `${hhmm(c.at)} (${ago(c.at, v.now)} ago)`],
        ],
        spark(v.sparks?.anon, c.highMiB),
      ),
    );
  }

  const m = h.mac;
  if (!m.stats) {
    const notYet = m.state === 'missing' && !h.macReady;
    box.append(
      tile(
        'h:m',
        'MAC',
        m.state === 'missing' ? 'not installed' : 'unreadable',
        notYet
          ? 'installs at merge (one line)'
          : m.state === 'missing'
            ? 'install line in NEEDS YOU'
            : m.error,
        notYet ? 'c-dim' : m.state === 'missing' ? 'c-hold' : 'c-bad',
        [
          [
            'detail',
            m.error ??
              (notYet ? 'tools/macstats/install.sh is not on main yet' : 'agent not installed'),
          ],
        ],
      ),
    );
  } else {
    const s = m.stats;
    const cc =
      m.state === 'ok'
        ? s.mem.pressure === 'critical'
          ? 'c-bad'
          : s.mem.pressure === 'warn'
            ? 'c-hold'
            : 'c-dev'
        : m.state === 'stale'
          ? 'c-hold'
          : 'c-bad';
    const age =
      m.state === 'ok'
        ? `pressure ${s.mem.pressure}`
        : m.state === 'stale'
          ? `stale: as of ${hhmm(s.t)}`
          : m.state === 'bad'
            ? m.error // e.g. a time ahead of ours: never "silent since <the future>"
            : `silent since ${hhmm(s.t)}`;
    box.append(
      tile(
        'h:m',
        'MAC',
        [gib(s.mem.usedMiB), ` / ${gib(s.memTotalMiB)} GiB`],
        `${age}${s.vm ? ` · VM ${gib(s.vm.rssMiB)}` : ''}`,
        cc,
        [
          ['free', `${gib(s.mem.freeMiB)} GiB`],
          ['compressor', `${gib(s.mem.compressedMiB)} GiB`],
          ['swap', s.swap ? `${gib(s.swap.usedMiB)} of ${gib(s.swap.totalMiB)} GiB` : 'unknown'],
          ['VM', s.vm ? `${s.vm.comm} ${gib(s.vm.rssMiB)} GiB` : 'no VM process'],
          [
            'load',
            `${s.load ? s.load.map((x) => x.toFixed(1)).join(' ') : 'unknown'} (${s.cpus ?? '?'} cpus)`,
          ],
          ['as of', `${hhmm(s.t)} (${ago(s.t, v.now)} ago)`],
        ],
        spark(v.sparks?.mac, s.memTotalMiB),
      ),
    );
  }

  const ms = src('Actions minutes');
  const a = h.actions;
  if (!a)
    box.append(
      tile(
        'h:a',
        'ACTIONS',
        ms?.state === 'failed' ? 'failed' : 'counting…',
        ms?.detail ?? 'first estimate within the hour',
        ms?.state === 'failed' ? 'c-bad' : 'c-dim',
        [],
      ),
    );
  else {
    const srcBad = ms?.state === 'ok' ? null : ms?.state === 'stale' ? 'c-hold' : 'c-bad';
    const cc =
      srcBad ??
      (a.minutes > a.of ? 'c-bad' : a.capped || a.minutes > a.of * 0.8 ? 'c-hold' : 'c-good');
    const bar = el('div', 'bar');
    const fill = el('span');
    fill.style.width = `${Math.min(100, (a.minutes / a.of) * 100).toFixed(1)}%`;
    bar.append(fill);
    box.append(
      tile(
        'h:a',
        'ACTIONS',
        [
          `${a.capped ? '≥' : '≈'}${a.minutes.toLocaleString()}`,
          ` / ${(a.of / 1000).toFixed(0)}k min`,
        ],
        srcBad ? `estimate ${ms.state}` : `${a.month} UTC · estimate`,
        cc,
        [
          [
            'how',
            'job times, each rounded up to a minute (billing is unreadable to the container)',
          ],
          [
            'counted',
            `${a.counted} of ${a.total} runs${a.capped ? ' · a day hit the 1,000-run cap: lower bound' : ''}`,
          ],
          ['as of', ms?.at ? `${hhmm(ms.at)} (${ago(ms.at, v.now)} ago)` : '—'],
        ],
        bar,
      ),
    );
  }

  const w = h.aws;
  const acct = Object.entries(w.byAccount)
    .map(([k, x]) => `${k} $${x.toFixed(2)}`)
    .join(' · ');
  box.append(
    w.state === 'missing'
      ? tile('h:w', 'AWS', 'no pull', 'costs-daily.json missing', 'c-hold', [])
      : w.state === 'bad'
        ? tile('h:w', 'AWS', 'unreadable', w.error, 'c-bad', [])
        : tile(
            'h:w',
            'AWS',
            [`$${w.total.toFixed(2)}`, ' this month'],
            w.error ? w.error : `${w.state === 'stale' ? 'stale: ' : ''}through ${w.through}`,
            w.state === 'ok' ? 'c-good' : 'c-hold',
            [
              ['accounts', acct || '—'],
              ['pulled', `${new Date(w.at).toLocaleDateString()} ${hhmm(w.at)}`],
            ],
          ),
  );
}

function slipping(v) {
  const b = body('slipping');
  $('#slipping .count').textContent = `(${v.slipping.length})`;
  if (!v.slipping.length) return emptyOr(v, b, 'slipping', 'nothing slipping');
  const KIND = {
    followup: ['STALE', 'c-hold'],
    fired: ['DUE', 'c-hold'],
    parked: ['PARKED', 'c-dim'],
    quiet: ['QUIET', 'c-hold'],
  };
  list(
    b,
    'slipping',
    v.slipping.map((s) =>
      item(`slip:${s.kind}:${s.what.slice(0, 60)}`, {
        c: KIND[s.kind][1],
        badge: KIND[s.kind][0],
        text: [short(s.what)],
        meta: [s.owner, s.sinceDay ? `since ${s.sinceDay}` : s.since ? ago(s.since, v.now) : null],
        more: [
          short(s.what) !== s.what ? s.what : null,
          s.after
            ? `trigger: ${s.after} (fired ${hhmm(s.since)}, ${ago(s.since, v.now)} ago)`
            : null,
        ],
      }),
    ),
    8,
  );
}

function sources(v) {
  const b = body('sources');
  const off = v.sources.filter((s) => s.state !== 'ok');
  $('#sources .count').textContent = off.length ? `(${off.length} not ok)` : '(all ok)';
  const chip = $('#sources-chip');
  chip.textContent = off.length
    ? `${off.length} source${off.length > 1 ? 's' : ''} off`
    : 'sources ok';
  chip.className = off.length
    ? off.some((s) => s.state === 'failed')
      ? 't-bad'
      : 't-warn'
    : 't-dim';
  $('#live-dot').className =
    `dot live ${off.some((s) => s.state === 'failed') ? 'c-bad' : off.length ? 'c-hold' : 'c-good'}`;
  for (const s of v.sources) {
    const c = s.state === 'ok' ? 'c-good' : s.state === 'stale' ? 'c-hold' : 'c-bad';
    b.append(
      item(`src:${s.name}`, {
        c,
        badge: s.state,
        text: [s.name, s.detail ? `  ·  ${s.detail}` : ''],
        meta: [s.at ? `${ago(s.at, v.now)} ago` : 'never'],
      }),
    );
  }
  for (const p of v.problems) b.append(el('div', 'cant', p));
  // the code this server runs: read at its start (a restart moves it)
  b.append(
    el(
      'div',
      'empty',
      `serving ${v.version ? v.version.slice(0, 8) : 'an unknown commit'}${v.startedAt ? `, started ${hhmm(v.startedAt)}` : ''}`,
    ),
  );
  for (const id of ['needs', 'now', 'done']) {
    const a = $(`#${id} .age`);
    // NOW's lock sources speak on their own slot cards: not repeated in its header
    const bad = notOk(v, id).filter((s) => id !== 'now' || !s.name.endsWith(' lock'));
    const worst = bad.find((s) => s.state !== 'stale') ?? bad[0];
    a.className = `age ${worst ? (worst.state === 'stale' ? 't-warn' : 't-bad') : 't-dim'}`;
    a.textContent = worst ? `${worst.name}: ${worst.state}` : '';
  }
}

// One series per chart (one axis each), crosshair + value on hover; reference lines recessive.
function lineChart(title, pts, max, refs, fmt) {
  const box = el('div', 'chart');
  box.append(el('div', 'title', title));
  const cv = document.createElement('canvas');
  const tip = el('div', 'tip');
  box.append(cv, tip);
  requestAnimationFrame(() => draw());
  const css = getComputedStyle(document.documentElement);
  const color = css.getPropertyValue('--series').trim();
  const mark = css.getPropertyValue('--mark').trim();
  let hover = null;
  function draw() {
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr;
    cv.height = h * dpr;
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    if (pts.length < 2) {
      g.fillStyle = mark;
      g.fillText('not enough data yet', 8, h / 2);
      return;
    }
    const t0 = pts[0][0];
    const t1 = pts[pts.length - 1][0];
    const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * (w - 4) + 2;
    const y = (val) => h - 4 - (val / max) * (h - 8);
    g.setLineDash([3, 3]);
    g.strokeStyle = mark;
    g.lineWidth = 1;
    for (const r of refs) {
      g.beginPath();
      g.moveTo(0, y(r));
      g.lineTo(w, y(r));
      g.stroke();
    }
    g.setLineDash([]);
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.beginPath();
    let pen = false;
    for (const [t, val] of pts) {
      if (val === null) {
        pen = false;
        continue;
      }
      if (pen) g.lineTo(x(t), y(val));
      else g.moveTo(x(t), y(val));
      pen = true;
    }
    g.stroke();
    if (hover) {
      g.strokeStyle = mark;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x(hover[0]), 0);
      g.lineTo(x(hover[0]), h);
      g.stroke();
    }
  }
  cv.addEventListener('mousemove', (e) => {
    if (pts.length < 2) return;
    const rect = cv.getBoundingClientRect();
    const t0 = pts[0][0];
    const t = t0 + ((e.clientX - rect.left) / rect.width) * (pts[pts.length - 1][0] - t0);
    hover = pts.reduce((a, p) => (Math.abs(p[0] - t) < Math.abs(a[0] - t) ? p : a), pts[0]);
    tip.textContent = `${hhmm(hover[0])}  ${hover[1] === null ? 'unknown' : fmt(hover[1])}`;
    tip.style.display = 'block';
    tip.style.left = `${Math.min(rect.width - 120, Math.max(0, e.clientX - rect.left + 8))}px`;
    draw();
  });
  cv.addEventListener('mouseleave', () => {
    hover = null;
    tip.style.display = 'none';
    draw();
  });
  return box;
}

function charts(v) {
  $('#charts').classList.toggle('on', chartsOn);
  if (!chartsOn || !v.history) return;
  const b = body('charts');
  const c = v.health.container;
  const hc = v.history.container;
  if (c) {
    b.append(
      lineChart(
        'container memory (GiB)',
        hc.map((p) => [p[0], p[1] / 1024]),
        c.highMiB / 1024,
        [c.anonSoft / 1024, c.anonHard / 1024],
        (x) => `${x.toFixed(1)} GiB`,
      ),
    );
    b.append(
      lineChart(
        'container cpu (cores)',
        hc.map((p) => [p[0], p[2]]),
        c.cores,
        [c.cores],
        (x) => `${x.toFixed(1)} cores`,
      ),
    );
  }
  const hm = v.history.mac;
  const total = hm.length ? hm[hm.length - 1][2] / 1024 : 1;
  b.append(
    lineChart(
      'Mac memory used (GiB)',
      hm.map((p) => [p[0], p[1] / 1024]),
      total,
      [],
      (x) => `${x.toFixed(1)} GiB`,
    ),
  );
}

let lastView = null;
let rendered = new Set(); // keys drawn this render: `expanded` keeps only these (and the tiles')
let seq = 0; // the newest poll: an older response arriving late is dropped
const SELECT_HOLD_MS = 15000;

// `fresh`: a view just fetched. A re-render of the view in hand keeps the clock offset (its `now` is old).
function render(v, fresh = true) {
  // a restart onto new code: this page's script is old, so load the new one
  if (served && v.version && v.version !== served) return location.reload();
  served = served ?? v.version;
  v_now = v.now;
  if (fresh) offset = v.now - Date.now();
  next_seen = new Map();
  rendered = new Set();
  lastView = v;
  $('#meta').replaceChildren(
    el('span', 'only-desk', 'as of '),
    el('span', null, hhmm(v.now)),
    el('span', 'ver', ` · ${v.version ? v.version.slice(0, 8) : 'version unknown'}`),
  );
  health(v);
  needs(v);
  nowPanel(v);
  next(v);
  done(v);
  slipping(v);
  sources(v);
  charts(v);
  seen = next_seen;
  for (const k of [...expanded]) if (!k.startsWith('h:') && !rendered.has(k)) expanded.delete(k);
}

async function tick() {
  const mine = ++seq;
  let v;
  try {
    const res = await fetch(`/api/state${chartsOn ? '?history=1' : ''}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    v = await res.json();
    if (v.error) throw new Error(v.error);
  } catch (e) {
    return fail(
      `tower server unreachable${lastOk ? ` since ${hhmm(lastOk)}` : ''}: everything below is old`,
      e,
    );
  }
  if (mine !== seq) return; // a newer poll started: its answer wins
  // a text selection in a panel survives a redraw or two, never longer: past SELECT_HOLD_MS the panels redraw
  // anyway (a held selection mustn't freeze a MERGE ME that has turned HOLD), and the banner says it's paused
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && $('main').contains(sel.anchorNode) && lastOk) {
    const held = Date.now() - lastOk;
    if (held < SELECT_HOLD_MS) {
      const ban = $('#banner');
      ban.textContent = `paused while text is selected: redraws in ${Math.ceil((SELECT_HOLD_MS - held) / 1000)} s`;
      ban.style.display = 'block';
      return;
    }
  }
  try {
    render(v);
  } catch (e) {
    return fail('page render error: what is shown may be incomplete', e, true);
  }
  {
    failures = 0;
    lastOk = Date.now();
    $('#banner').style.display = 'none';
  }
}

function fail(text, e, now = false) {
  failures++;
  $('#live-dot').className = 'dot c-bad'; // no pulse: nothing is live
  const chip = $('#sources-chip');
  chip.textContent = 'sources ?';
  chip.className = 't-bad';
  if (failures >= 2 || now || !lastOk) {
    const ban = $('#banner');
    ban.textContent = `${text} (${e.message})`;
    ban.style.display = 'block';
  }
}

for (const id of ['slipping', 'sources'])
  $(`#${id} h2`).addEventListener('click', () => $(`#${id}`).classList.toggle('open'));
$('#sources-chip').addEventListener('click', () => {
  $('#sources').classList.add('open');
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('#sources').scrollIntoView({ behavior: calm ? 'auto' : 'smooth' });
});
$('#charts-toggle').addEventListener('click', () => {
  chartsOn = !chartsOn;
  const u = new URL(location.href);
  if (chartsOn) u.searchParams.set('charts', '1');
  else u.searchParams.delete('charts');
  history.replaceState(null, '', u);
  tick();
});
tick();
setInterval(tick, POLL_MS);
// the live timers: every second, against the server's clock
setInterval(() => {
  const now = Date.now() + offset;
  for (const t of document.querySelectorAll('[data-since]'))
    t.textContent = `${t.dataset.prefix}${ago(Number(t.dataset.since), now)}`;
}, 1000);
