// The tower page (docs/ops/TOWER.md): polls /api/state every 5 s and renders it. Rendering only; every rule
// (states, HOLD, NEEDS YOU, freshness) is server-side in derive.ts. Text goes in with textContent, never as HTML.
// Layout rule (Rahul, 2026-11-13): big type, one short line per item, details on click, HEALTH above the fold.
'use strict';

const POLL_MS = 5000;
let chartsOn = new URLSearchParams(location.search).get('charts') === '1';
let failures = 0;
let lastOk = null;
let served = null; // the commit this page's script came with: a new one reloads the page
const expanded = new Set(); // keys of expanded items, kept across polls
const showAll = new Set(); // panels showing every row

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
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
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
const badge = (text, tone) => el('span', `badge t-${tone || 'dim'}`, text);
// Long text from outside (queue.json, lane steps) never renders whole in a row: its first clause, capped.
const short = (s, n = 90) => {
  const t = String(s ?? '')
    .split(/(?<=[.;])\s|\n/)[0]
    .replace(/[.;,]$/, '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function body(id) {
  const b = $(`#${id} .body`);
  b.replaceChildren();
  return b;
}

// One item: a one-line row (badge · text · meta), and its details below, shown on click.
function item(key, parts) {
  const wrap = el('div', 'item');
  if (expanded.has(key)) wrap.classList.add('open');
  const row = el('div', 'row');
  if (parts.badge) row.append(badge(parts.badge[0], parts.badge[1]));
  const text = el('span', 'text');
  for (const p of parts.text) text.append(typeof p === 'string' ? document.createTextNode(p) : p);
  row.append(text);
  for (const m of parts.meta ?? [])
    if (m) row.append(typeof m === 'string' ? el('span', 'meta', m) : m);
  wrap.append(row);
  const more = el('div', 'more');
  for (const m of parts.more ?? [])
    if (m) more.append(typeof m === 'string' ? el('div', null, m) : m);
  if (more.childNodes.length) {
    wrap.append(more);
    row.addEventListener('click', () => {
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      wrap.classList.toggle('open');
    });
    row.title = 'click for details';
  }
  return wrap;
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
      tick();
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
  const btn = el('button', null, 'copy');
  btn.type = 'button';
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'copied';
    } catch {
      btn.textContent = 'copy failed: select it below';
    }
    setTimeout(() => (btn.textContent = 'copy'), 2000);
  });
  return btn;
}

const NEED_BADGE = {
  merge: ['MERGE', 'good'],
  lane: ['DO', 'warn'],
  deploy: ['DEPLOY FAILED', 'bad'],
  todo: ['TODO', 'warn'],
  source: ['SETUP', 'warn'],
};

function needs(v) {
  const b = body('needs');
  $('#needs .count').textContent = v.needs.length ? `(${v.needs.length})` : '';
  $('#needs').classList.toggle('has', v.needs.length > 0);
  if (!v.needs.length) return emptyOr(v, b, 'needs', 'nothing needs you');
  const items = v.needs.map((n, i) =>
    item(`need:${n.kind}:${n.branch ?? ''}:${n.what.slice(0, 40)}:${i}`, {
      badge: NEED_BADGE[n.kind] ?? ['TODO', 'warn'],
      text: [n.link ? httpsLink(n.link, short(n.what)) : short(n.what)],
      meta: [n.cmd ? copyButton(n.cmd) : null, n.since ? ago(n.since, v.now) : null],
      more: [
        short(n.what, 600) !== short(n.what) ? n.what : null,
        n.unblocks ? `unblocks: ${n.unblocks}` : null,
        n.cmd ? el('code', null, n.cmd) : null,
      ],
    }),
  );
  list(b, 'needs', items, 6);
}

function laneItem(r, now) {
  const text = [el('b', null, r.branch)];
  if (r.session) text.push(el('span', 'who', `  ${r.session}`));
  if (r.hold) text.push(`  ·  ${short(r.hold, 70)}`);
  else if (r.detail) text.push(`  ·  ${short(r.detail, 70)}`);
  return item(`lane:${r.branch}`, {
    badge: [r.label.startsWith('HOLD') ? 'HOLD' : r.label, r.tone === 'normal' ? 'dim' : r.tone],
    text,
    meta: [r.since ? ago(r.since, now) : null],
    more: [
      r.hold ? `held: ${r.hold}` : null,
      r.detail && short(r.detail, 70) !== r.detail ? r.detail : null,
      r.pr ? httpsLink(r.pr.url, `PR ${r.pr.number}: ${r.pr.title}`) : null,
      r.fileAge !== null ? `lane file updated ${ago(now - r.fileAge * 1000, now)} ago` : null,
    ],
  });
}

function nowPanel(v) {
  const b = body('now');
  const slots = el('div', 'slots');
  for (const s of v.slots) {
    const c = el('div', 'slot');
    c.append(el('div', 'name', s.slot));
    if (s.branch) {
      c.append(el('div', 'who', `${s.branch}${s.session ? ` (${s.session})` : ''}`));
      c.append(
        el('div', 'what', `${short(s.detail ?? 'holding the lock', 40)} · to ${hhmm(s.expiresAt)}`),
      );
    } else if (s.state === 'free') c.append(el('div', 'who t-good', 'free'));
    // known noise stays quiet: a lock read under 5 min old is just "as of"; past that it is unknown, and says so
    if (s.state === 'unknown') c.append(el('div', 'what t-warn', `lock unknown: ${s.why}`));
    else if (s.asOf) c.append(el('div', 'what', `as of ${hhmm(s.asOf)}`));
    slots.append(c);
  }
  b.append(slots);
  const rows = v.active.filter((r) => r.state !== 'TESTING');
  if (!rows.length) return emptyOr(v, b, 'now', 'no lanes building');
  list(
    b,
    'now',
    rows.map((r) => laneItem(r, v.now)),
    8,
  );
}

function next(v) {
  const b = body('next');
  const items = [];
  if (v.next.rahul)
    items.push(
      item('next:rahul', {
        badge: ['YOU NEXT', 'warn'],
        text: [short(v.next.rahul)],
        more: [short(v.next.rahul) !== v.next.rahul ? v.next.rahul : null],
      }),
    );
  for (const r of v.next.merge) items.push(laneItem(r, v.now));
  for (const slot of ['dev', 'devb'])
    v.next.queue
      .filter((l) => l.slot === slot)
      .forEach((l, i) =>
        items.push(
          item(`q:${slot}:${l.branch}`, {
            badge: [`${slot} ${i + 1}`, 'dim'],
            text: [el('b', null, l.branch), l.waitingOn ? `  ·  ${short(l.waitingOn, 60)}` : ''],
            more: [l.waitingOn && short(l.waitingOn, 60) !== l.waitingOn ? l.waitingOn : null],
          }),
        ),
      );
  if (v.next.parked.length)
    items.push(
      item('next:parked', {
        badge: ['PARKED', 'dim'],
        text: [el('span', 'who', v.next.parked.join(', '))],
      }),
    );
  if (!items.length) return emptyOr(v, b, 'next', 'nothing queued');
  list(b, 'next', items, 6);
}

function done(v) {
  const b = body('done');
  if (!v.done.length) return emptyOr(v, b, 'done', 'no merges today');
  const items = v.done.map((d) =>
    item(`done:${d.number}`, {
      badge: [d.deploy, d.tone],
      text: [`PR ${d.number}  ${d.title}`],
      meta: [hhmm(d.mergedAt)],
      more: [d.branch, d.deployDetail, d.url ? httpsLink(d.url, 'the deploy run') : null],
    }),
  );
  list(b, 'done', items, 6);
}

function kv(rows) {
  const g = el('div', 'kv');
  for (const [k, val] of rows) g.append(el('span', 'k', k), el('span', null, val));
  return g;
}

function tile(key, label, value, sub, tone, details) {
  const t = el('div', `tile s-${tone}`);
  if (expanded.has(key)) t.classList.add('open');
  t.append(el('div', 'label', label), el('div', 'value', value), el('div', 'sub', sub));
  const more = el('div', 'more');
  more.append(kv(details));
  t.append(more);
  t.addEventListener('click', () => {
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    t.classList.toggle('open');
  });
  return t;
}

function health(v) {
  const h = v.health;
  const box = $('#health');
  box.replaceChildren();
  const src = (name) => v.sources.find((s) => s.name === name);

  const c = h.container;
  if (!c) box.append(tile('h:c', 'CONTAINER', 'no data', 'the sampler has no sample', 'bad', []));
  else {
    const stale = (v.now - c.at) / 1000 > 90;
    const tone = stale
      ? 'warn'
      : c.anonMiB > c.anonHard
        ? 'bad'
        : c.anonMiB > c.anonSoft
          ? 'warn'
          : 'good';
    box.append(
      tile(
        'h:c',
        'CONTAINER',
        `${gib(c.anonMiB)} / ${gib(c.highMiB)} GiB`,
        stale
          ? `sampler silent since ${hhmm(c.at)}`
          : `${c.cpu === null ? '?' : c.cpu.toFixed(1)} cores · tests ${c.tests}/${c.testCap ?? '?'}`,
        tone,
        [
          ['memory', `soft ${gib(c.anonSoft)} · hard ${gib(c.anonHard)} GiB`],
          [
            'cpu',
            c.cpu === null ? 'unknown (bad tick)' : `${c.cpu.toFixed(1)} of ${c.cores} cores`,
          ],
          ['pids', `${c.pids} of ${c.pidsMax}`],
          ['as of', `${hhmm(c.at)} (${ago(c.at, v.now)} ago)`],
        ],
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
            : short(m.error, 50),
        notYet ? 'dim' : m.state === 'missing' ? 'warn' : 'bad',
        [
          ['state', m.state],
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
    const tone =
      m.state === 'ok'
        ? s.mem.pressure === 'critical'
          ? 'bad'
          : s.mem.pressure === 'warn'
            ? 'warn'
            : 'good'
        : m.state === 'stale'
          ? 'warn'
          : 'bad';
    const age =
      m.state === 'ok'
        ? `pressure ${s.mem.pressure}`
        : m.state === 'stale'
          ? `stale: as of ${hhmm(s.t)}`
          : `silent since ${hhmm(s.t)}`;
    box.append(
      tile(
        'h:m',
        'MAC',
        `${gib(s.mem.usedMiB)} / ${gib(s.memTotalMiB)} GiB`,
        `${age}${s.vm ? ` · VM ${gib(s.vm.rssMiB)}` : ''}`,
        tone,
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
        short(ms?.detail ?? 'first estimate within the hour', 50),
        ms?.state === 'failed' ? 'bad' : 'dim',
        [],
      ),
    );
  else {
    const srcTone = ms?.state === 'ok' ? null : ms?.state === 'stale' ? 'warn' : 'bad';
    const tone =
      srcTone ?? (a.minutes > a.of ? 'bad' : a.capped || a.minutes > a.of * 0.8 ? 'warn' : 'good');
    box.append(
      tile(
        'h:a',
        'ACTIONS',
        `${a.capped ? '≥' : '≈'} ${a.minutes.toLocaleString()} / ${a.of.toLocaleString()} min`,
        srcTone ? `estimate ${ms.state}` : `${a.month} UTC · estimate`,
        tone,
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
      ),
    );
  }

  const w = h.aws;
  const acct = Object.entries(w.byAccount)
    .map(([k, x]) => `${k} $${x.toFixed(2)}`)
    .join(' · ');
  box.append(
    w.state === 'missing'
      ? tile('h:w', 'AWS', 'no pull', 'localNotes/costs-daily.json missing', 'warn', [])
      : w.state === 'bad'
        ? tile('h:w', 'AWS', 'unreadable', short(w.error, 50), 'bad', [])
        : tile(
            'h:w',
            'AWS',
            `$${w.total.toFixed(2)} this month`,
            w.error ? short(w.error, 50) : `through ${w.through}`,
            w.state === 'ok' ? 'good' : 'warn',
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
  const KIND = { followup: ['STALE', 'warn'], parked: ['PARKED', 'dim'], quiet: ['QUIET', 'warn'] };
  list(
    b,
    'slipping',
    v.slipping.map((s, i) =>
      item(`slip:${i}:${s.what.slice(0, 30)}`, {
        badge: KIND[s.kind],
        text: [short(s.what)],
        meta: [s.owner, s.since ? ago(s.since, v.now) : null],
        more: [short(s.what) !== s.what ? s.what : null],
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
  for (const s of v.sources) {
    const tone = s.state === 'ok' ? 'good' : s.state === 'stale' ? 'warn' : 'bad';
    b.append(
      item(`src:${s.name}`, {
        badge: [s.state, tone],
        text: [s.name, s.detail ? `  ·  ${s.detail}` : ''],
        meta: [s.at ? `${ago(s.at, v.now)} ago` : 'never'],
      }),
    );
  }
  for (const p of v.problems) b.append(el('div', 'cant', p));
  for (const id of ['needs', 'now', 'done']) {
    const a = $(`#${id} .age`);
    const bad = notOk(v, id);
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

function render(v) {
  // a restart onto new code: this page's script is old, so load the new one
  if (served && v.version && v.version !== served) return location.reload();
  served = served ?? v.version;
  $('#meta').textContent =
    `as of ${hhmm(v.now)} · ${v.version ? v.version.slice(0, 8) : 'version unknown'}`;
  health(v);
  needs(v);
  nowPanel(v);
  next(v);
  done(v);
  slipping(v);
  sources(v);
  charts(v);
}

async function tick() {
  try {
    const res = await fetch(`/api/state${chartsOn ? '?history=1' : ''}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const v = await res.json();
    if (v.error) throw new Error(v.error);
    render(v);
    failures = 0;
    lastOk = Date.now();
    $('#banner').style.display = 'none';
  } catch (e) {
    failures++;
    if (failures >= 2) {
      const ban = $('#banner');
      ban.textContent = `tower server unreachable${lastOk ? ` since ${hhmm(lastOk)}` : ''}: everything below is old (${e.message})`;
      ban.style.display = 'block';
    }
  }
}

for (const id of ['slipping', 'sources'])
  $(`#${id} h2`).addEventListener('click', () => $(`#${id}`).classList.toggle('open'));
$('#sources-chip').addEventListener('click', () => {
  $('#sources').classList.add('open');
  $('#sources').scrollIntoView({ behavior: 'smooth' });
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
