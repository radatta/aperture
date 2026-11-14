// The tower page (docs/ops/TOWER.md): polls /api/state every 5 s and renders it. Rendering only; every rule
// (states, HOLD, NEEDS YOU, freshness) is server-side in derive.ts. Text goes in with textContent, never as HTML.
'use strict';

const POLL_MS = 5000;
let chartsOn = new URLSearchParams(location.search).get('charts') === '1';
let failures = 0;
let lastOk = null;

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
const gib = (mib) => `${(mib / 1024).toFixed(1)} GiB`;
const httpsLink = (url, text) => {
  if (typeof url !== 'string' || !url.startsWith('https://')) return el('span', null, text);
  const a = el('a', null, text);
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
};
const badge = (text, tone) => el('span', `badge t-${tone} b-${tone}`, text);

function body(id) {
  const b = $(`#${id} .body`);
  b.replaceChildren();
  return b;
}
const empty = (b, text) => b.append(el('div', 'empty', text));
// Each panel's sources: an empty panel says "can't tell" when one of them isn't ok, never a calm "nothing".
const PANEL_SOURCES = {
  needs: ['lane files', 'gh PRs', 'gh checks', 'gh runs', 'queue.json', 'Mac stats'],
  now: ['dev lock', 'devb lock', 'lane files', 'gh PRs'],
  next: ['queue.json', 'gh PRs', 'gh checks'],
  done: ['gh PRs', 'gh runs'],
  slipping: ['queue.json', 'lane files'],
};
const notOk = (v, id) =>
  v.sources.filter((s) => PANEL_SOURCES[id].includes(s.name) && s.state !== 'ok');
function emptyOr(v, b, id, text) {
  const bad = notOk(v, id);
  if (!bad.length) return empty(b, text);
  b.append(
    el(
      'div',
      't-bad',
      `can't tell: ${bad.map((s) => `${s.name} ${s.state}${s.detail ? ` (${s.detail})` : ''}`).join('; ')}`,
    ),
  );
}

function copyButton(text) {
  const btn = el('button', null, 'copy');
  btn.type = 'button';
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'copied';
    } catch {
      btn.textContent = 'copy failed: select the text';
    }
    setTimeout(() => (btn.textContent = 'copy'), 2000);
  });
  return btn;
}

function needs(v) {
  const b = body('needs');
  $('#needs .count').textContent = `(${v.needs.length})`;
  $('#needs').classList.toggle('has', v.needs.length > 0);
  if (!v.needs.length) return emptyOr(v, b, 'needs', 'nothing needs you');
  for (const n of v.needs) {
    const r = el('div', 'row');
    const w = el('div', 'what');
    w.append(n.link ? httpsLink(n.link, n.what) : el('span', null, n.what));
    if (n.unblocks) w.append(el('div', 'sub', `unblocks: ${n.unblocks}`));
    if (n.cmd) w.append(el('code', null, n.cmd));
    r.append(
      badge(
        n.kind === 'merge'
          ? 'MERGE ME'
          : n.kind === 'deploy'
            ? 'DEPLOY FAILED'
            : n.kind.toUpperCase(),
        n.kind === 'deploy' ? 'bad' : n.kind === 'merge' ? 'good' : 'warn',
      ),
      w,
    );
    if (n.since) r.append(el('span', 'sub', ago(n.since, v.now)));
    if (n.cmd) r.append(copyButton(n.cmd));
    b.append(r);
  }
}

function laneLine(r, now) {
  const row = el('div', 'row');
  row.append(badge(r.label, r.tone === 'normal' ? 'dim' : r.tone));
  const w = el('div', 'what');
  w.append(el('b', null, r.branch));
  if (r.session) w.append(el('span', 'sub', `  ${r.session}`));
  if (r.pr) w.append(el('span', 'sub', '  '), httpsLink(r.pr.url, `PR ${r.pr.number}`));
  if (r.detail) w.append(el('div', 'sub', r.detail));
  row.append(w);
  if (r.since) row.append(el('span', 'sub', `for ${ago(r.since, now)}`));
  if (r.fileAge === null) row.append(el('span', 'sub t-dim', 'no lane file'));
  else
    row.append(
      el(
        'span',
        `sub ${r.fileAge > 86400 ? 't-dim' : r.fileAge > 7200 ? 't-warn' : ''}`,
        `updated ${ago(v_now - r.fileAge * 1000, now)} ago`,
      ),
    );
  return row;
}
let v_now = 0;

function nowPanel(v) {
  const b = body('now');
  const slots = el('div', 'slots');
  for (const s of v.slots) {
    const c = el('div', 'slot');
    c.append(el('div', 'name', s.slot));
    if (s.state === 'unknown')
      c.append(el('div', 'sub t-bad', `unknown: ${s.why}${s.live ? ' · last seen held:' : ''}`));
    if (s.live) {
      c.append(el('div', null, `${s.branch}${s.session ? ` (${s.session})` : ''}`));
      c.append(el('div', 'sub', s.detail ?? 'holding the lock'));
      c.append(
        el(
          'div',
          'sub',
          `${s.since ? `for ${ago(s.since, v.now)} · ` : ''}lock to ${hhmm(s.expiresAt)}`,
        ),
      );
    } else if (s.state === 'free') c.append(el('div', 'sub', 'free'));
    slots.append(c);
  }
  b.append(slots);
  const rows = v.active.filter((r) => r.state !== 'TESTING');
  if (!rows.length) emptyOr(v, b, 'now', 'no lanes building');
  for (const r of rows) b.append(laneLine(r, v.now));
}

function next(v) {
  const b = body('next');
  if (v.next.rahul) {
    const r = el('div', 'row');
    r.append(badge('YOUR NEXT STEP', 'warn'), el('div', 'what', v.next.rahul));
    b.append(r);
  }
  for (const r of v.next.merge) b.append(laneLine(r, v.now));
  for (const slot of ['dev', 'devb']) {
    const q = v.next.queue.filter((l) => l.slot === slot);
    if (!q.length) continue;
    b.append(el('div', 'sub', `${slot} order`));
    q.forEach((l, i) => {
      const r = el('div', 'row');
      r.append(
        el('span', 'sub', `${i + 1}.`),
        el('div', 'what', `${l.branch}  ${l.state}${l.waitingOn ? ` · ${l.waitingOn}` : ''}`),
      );
      b.append(r);
    });
  }
  if (!b.children.length) emptyOr(v, b, 'next', 'nothing queued');
}

function done(v) {
  const b = body('done');
  if (!v.done.length) return emptyOr(v, b, 'done', 'no merges today');
  for (const d of v.done) {
    const r = el('div', 'row');
    r.append(el('span', 'sub', hhmm(d.mergedAt)));
    const w = el('div', 'what');
    w.append(el('span', null, `PR ${d.number} ${d.title}`), el('div', 'sub', d.branch));
    r.append(w, badge(d.deploy, d.tone));
    if (d.url) r.append(httpsLink(d.url, 'run'));
    b.append(r);
  }
}

function kv(rows) {
  const g = el('div', 'kv');
  for (const [k, val, tone] of rows)
    g.append(el('span', 'k', k), el('span', tone ? `t-${tone}` : null, val));
  return g;
}

function health(v) {
  const b = body('health');
  const h = v.health;
  const c = h.container;
  b.append(el('div', 'sub', 'container'));
  if (!c) b.append(el('div', 't-bad', 'no sampler data'));
  else {
    const stale = (v.now - c.at) / 1000 > 90;
    b.append(
      kv([
        [
          'memory',
          `${gib(c.anonMiB)} of ${gib(c.highMiB)} (soft ${gib(c.anonSoft)}, hard ${gib(c.anonHard)})`,
          c.anonMiB > c.anonHard ? 'bad' : c.anonMiB > c.anonSoft ? 'warn' : null,
        ],
        [
          'cpu',
          c.cpu === null ? 'unknown (bad tick)' : `${c.cpu.toFixed(1)} of ${c.cores} cores`,
          c.cpu !== null && c.cpu > c.cores * 0.9 ? 'warn' : null,
        ],
        ['pids', `${c.pids} of ${c.pidsMax}`, null],
        [
          'test slots',
          `${c.tests} of ${c.testCap ?? '?'}`,
          c.testCap !== null && c.tests >= c.testCap ? 'warn' : null,
        ],
        [
          'as of',
          `${hhmm(c.at)} (${ago(c.at, v.now)} ago)${stale ? ': sampler silent' : ''}`,
          stale ? 'warn' : null,
        ],
      ]),
    );
  }
  b.append(el('div', 'sub', 'Mac'));
  const m = h.mac;
  if (!m.stats)
    b.append(
      el(
        'div',
        't-bad',
        m.state === 'missing'
          ? 'Mac stats agent not installed (see NEEDS YOU)'
          : `Mac stats unreadable: ${m.error}`,
      ),
    );
  else {
    const s = m.stats;
    const tone = m.state === 'ok' ? null : m.state === 'stale' ? 'warn' : 'bad';
    b.append(
      kv([
        [
          'memory',
          `${gib(s.mem.usedMiB)} used of ${gib(s.memTotalMiB)} · ${gib(s.mem.freeMiB)} free`,
          null,
        ],
        ['compressor', gib(s.mem.compressedMiB), null],
        [
          'pressure',
          s.mem.pressure,
          s.mem.pressure === 'normal' ? null : s.mem.pressure === 'warn' ? 'warn' : 'bad',
        ],
        [
          'swap',
          s.swap ? `${gib(s.swap.usedMiB)} of ${gib(s.swap.totalMiB)}` : 'unknown (unreadable)',
          s.swap ? null : 'warn',
        ],
        ['VM', s.vm ? `${s.vm.comm} ${gib(s.vm.rssMiB)}` : 'no VM process found', null],
        ['load', s.load.map((x) => x.toFixed(2)).join(' ') + ` (${s.cpus} cpus)`, null],
        [
          'as of',
          `${hhmm(s.t)} (${ago(s.t, v.now)} ago)${m.state === 'stale' ? ': stale' : m.state === 'silent' ? ': SILENT, asleep or stopped' : ''}`,
          tone,
        ],
      ]),
    );
  }
  b.append(el('div', 'sub', 'GitHub Actions'));
  const minutesSrc = v.sources.find((x) => x.name === 'Actions minutes');
  if (!h.actions)
    b.append(
      el(
        'div',
        minutesSrc?.state === 'failed' ? 't-bad' : 't-warn',
        minutesSrc?.state === 'failed'
          ? `estimate failed: ${minutesSrc.detail}`
          : 'estimate not ready yet',
      ),
    );
  else {
    const a = h.actions;
    const srcTone =
      minutesSrc?.state === 'ok' ? null : minutesSrc?.state === 'stale' ? 'warn' : 'bad';
    if (srcTone)
      b.append(
        el(
          'div',
          `t-${srcTone}`,
          `estimate ${minutesSrc.state}: ${minutesSrc.detail ?? ''} (the figure below is the last good one)`,
        ),
      );
    b.append(
      kv([
        [
          'minutes',
          `${a.capped ? '≥' : '≈'} ${a.minutes.toLocaleString()} of ${a.of.toLocaleString()} (plan) · ${a.month} UTC${a.capped ? ' (a day hit the 1,000-run listing cap: a lower bound)' : ''}`,
          srcTone ??
            (a.capped || a.minutes > a.of * 0.8 ? (a.minutes > a.of ? 'bad' : 'warn') : null),
        ],
        [
          'how',
          `estimate: job times, each rounded up · ${a.counted} of ${a.total} runs counted`,
          a.counted < a.total ? 'warn' : null,
        ],
      ]),
    );
  }
  b.append(el('div', 'sub', 'AWS'));
  const w = h.aws;
  if (w.state === 'missing')
    b.append(el('div', 't-bad', 'no costs pull (localNotes/costs-daily.json)'));
  else if (w.state === 'bad') b.append(el('div', 't-bad', `costs unreadable: ${w.error}`));
  else if (w.error) b.append(el('div', 't-warn', `costs: ${w.error}`));
  else {
    const acct = Object.entries(w.byAccount)
      .map(([k, x]) => `${k} $${x.toFixed(2)}`)
      .join(' · ');
    b.append(
      kv([
        ['month to date', `$${w.total.toFixed(2)}${acct ? ` (${acct})` : ''}`, null],
        [
          'as of',
          `pulled ${new Date(w.at).toLocaleDateString()} ${hhmm(w.at)}, through ${w.through ?? '?'}${w.state === 'stale' ? ': older than 3 days' : ''}`,
          w.state === 'stale' ? 'warn' : null,
        ],
      ]),
    );
  }
}

function slipping(v) {
  const b = body('slipping');
  $('#slipping .count').textContent = `(${v.slipping.length})`;
  if (!v.slipping.length) return emptyOr(v, b, 'slipping', 'nothing slipping');
  for (const s of v.slipping) {
    const r = el('div', 'row');
    r.append(
      badge(
        s.kind === 'followup' ? 'STALE' : s.kind === 'parked' ? 'PARKED' : 'QUIET',
        s.kind === 'parked' ? 'dim' : 'warn',
      ),
      el('div', 'what', s.what),
    );
    if (s.owner) r.append(el('span', 'sub', s.owner));
    if (s.since) r.append(el('span', 'sub', ago(s.since, v.now)));
    b.append(r);
  }
}

function sources(v) {
  const b = body('sources');
  for (const s of v.sources) {
    const tone = s.state === 'ok' ? 'good' : s.state === 'stale' ? 'warn' : 'bad';
    const r = el('div', 'row');
    r.append(
      badge(s.state, tone),
      el('span', null, s.name),
      el('span', 'sub', s.at ? `${ago(s.at, v.now)} ago` : 'never'),
    );
    if (s.detail) r.append(el('span', 'sub', s.detail));
    b.append(r);
  }
  for (const p of v.problems) b.append(el('div', 'row t-bad', p));
  for (const id of ['needs', 'now', 'done']) {
    const a = $(`#${id} .age`);
    const bad = notOk(v, id);
    const worst = bad.find((s) => s.state !== 'stale') ?? bad[0];
    a.className = `age ${worst ? (worst.state === 'stale' ? 't-warn' : 't-bad') : 'sub'}`;
    a.textContent = worst
      ? `${worst.name}: ${worst.state}`
      : v.sources
          .filter((s) => PANEL_SOURCES[id].includes(s.name) && s.at)
          .map((s) => ago(s.at, v.now))
          .join(' · ');
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
  const sec = $('#charts');
  sec.classList.toggle('on', chartsOn);
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
  v_now = v.now;
  $('#meta').textContent =
    `as of ${hhmm(v.now)} · ${v.version ? v.version.slice(0, 8) : 'version unknown'}`;
  needs(v);
  nowPanel(v);
  next(v);
  done(v);
  health(v);
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
