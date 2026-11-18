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
const folded = new Set(); // keys of items folded inside an expanded panel (where every item starts open)
// An expanded panel (TOWER.md → Expand): the URL hash names it, so a reload or a poll keeps it; Esc or Back closes.
const PANELS = ['needs', 'now', 'next', 'done', 'slipping', 'sources']; // keys 1–6
const NAMES = {
  needs: 'NEEDS YOU',
  now: 'NOW',
  next: 'NEXT',
  done: 'DONE',
  slipping: 'SLIPPING',
  sources: 'SOURCES',
};
let openId = null; // the expanded panel's id
let inFull = false; // the panel being drawn is the expanded one: every row open, no "+n more"
let glanceY = 0; // the glance's scroll, restored on close
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
  if (inFull ? !folded.has(key) : expanded.has(key)) wrap.classList.add('open');
  if (inFull) wrap.dataset.full = '1';
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
  const set = node.dataset.full ? folded : expanded;
  if (set.has(key)) set.delete(key);
  else set.add(key);
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

// The lane's step bar, when its lane file carries a step plan: a pip per step, the current one filled by its time so
// far against its estimate's high end, amber past it.
function stepBar(steps) {
  const t = el('span', 'track steps');
  t.title = steps
    .map(
      (s) =>
        `${s.phase} ${s.lo}–${s.hi} min${s.source === 'guess' ? '?' : ''}${s.spentMin ? ` · ${s.spentMin} so far` : ''}`,
    )
    .join('\n');
  for (const s of steps) {
    const pip = el('i', s.state);
    if (s.state === 'now') {
      const f = el('b');
      f.style.width = `${Math.min(100, Math.round((s.spentMin / Math.max(1, s.hi)) * 100))}%`;
      pip.append(f);
      if (s.spentMin > s.hi) pip.classList.add('over');
    }
    t.append(pip);
  }
  return t;
}
const range = (r) => `${hhmm(r.lo)}–${hhmm(r.hi)}`;
// "PR ~19:10–19:40", amber once the window has passed with no PR
function prEta(r) {
  const e = r.eta;
  // before its PR exists: building, waiting on you, or testing on dev
  if (!e?.pr || !['BUILDING', 'NEEDS YOU', 'TESTING'].includes(r.state)) return null;
  return e.late
    ? el('span', 'meta t-warn', `PR late · was ~${hhmm(e.pr.hi)}`)
    : el('span', 'meta', `PR ~${range(e.pr)}${e.source === 'guess' ? '?' : ''}`);
}
// est vs actual per step, for a lane's details
function stepTable(steps) {
  return kv(
    steps.map((s) => [
      s.phase,
      `est ${s.lo}–${s.hi} min${s.source === 'guess' ? ' (guess)' : ''}` +
        (s.state === 'todo' && !s.spentMin
          ? ''
          : ` · ${s.state === 'done' ? 'took' : 'so far'} ${s.spentMin} min`),
    ]),
  );
}

// At most `max` rows, then a "+n more" button.
function list(b, id, items, max) {
  if (inFull) return items.forEach((i) => b.append(i)); // expanded: everything
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

function needItem(n) {
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
}

function needs(v) {
  const b = body('needs');
  $('#needs .count').textContent = v.needs.length ? `(${v.needs.length})` : '';
  $('#needs').classList.toggle('has', v.needs.length > 0);
  if (!v.needs.length) return emptyOr(v, b, 'needs', 'nothing needs you ✓');
  list(b, 'needs', v.needs.map(needItem), 6);
}

// `o`: a landing-order row (NEXT): its own key, its place, dispatch's note
// a session's context use (F240): amber at 40 %, red at 50 % (ctx.ts)
const ctxTone = (p) => (p >= 50 ? 't-bad' : p >= 40 ? 't-warn' : 't-dim');
const ctxMeta = (p) =>
  p === null || p === undefined ? null : el('span', `meta ${ctxTone(p)}`, `ctx ${Math.round(p)}%`);
// what git can't merge the lane with (overlap.json, TOWER.md → Conflicts): amber, dim once the check is old
const cfTargets = (cf) => [
  ...(cf.main ? [{ name: 'main', files: cf.main }] : []),
  ...cf.lanes.map((x) => ({ name: x.branch, files: x.files })),
];
function cfMeta(cf) {
  if (!cf) return null;
  const t = cfTargets(cf);
  const names = t.slice(0, 2).map((x) => x.name);
  const m = el(
    'span',
    `meta cf ${cf.oldMin === null ? 't-warn' : 't-dim'}`,
    `✗ ${names.join(', ')}${t.length > 2 ? ` +${t.length - 2}` : ''}`,
  );
  m.title = t.map((x) => `${x.name}: ${x.files.join(', ')}`).join(' · ');
  return m;
}
// phones have no hover: the files go in the details too
const cfMore = (cf) =>
  cf
    ? cfTargets(cf).map(
        (x, n) =>
          `conflicts with ${x.name}: ${x.files.join(', ')}${n === 0 && cf.oldMin !== null ? ` (${cf.oldMin} min old: is the sampler running?)` : ''}`,
      )
    : [];

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
    track: r.steps ? stepBar(r.steps) : track(r.phase),
    meta: [
      cfMeta(r.conflicts),
      ctxMeta(r.ctx),
      r.quiet ? el('span', 'meta t-warn', `quiet ${ago(v_now - r.fileAge * 1000, v_now)}`) : null,
      prEta(r),
      r.since ? timer(r.since) : null,
    ],
    more: [
      o?.note ? `landing order: ${o.note}` : null,
      r.hold ? `held: ${r.hold}` : null,
      ...cfMore(r.conflicts),
      // under a HOLD the row shows the hold, so the detail is only here
      r.detail && (r.hold || short(r.detail, 70) !== r.detail) ? r.detail : null,
      r.pr ? httpsLink(r.pr.url, `PR ${r.pr.number}: ${r.pr.title}`) : null,
      r.phase ? `phase: ${track(r.phase)?.title ?? r.phase}` : null,
      r.fileAge !== null ? `lane file updated ${ago(v_now - r.fileAge * 1000, v_now)} ago` : null,
      r.eta?.next ? `next step ~${range(r.eta.next)}` : null,
      r.steps ? stepTable(r.steps) : null,
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
      const who = el('div', 'who', `${s.branch}${s.session ? ` · ${s.session}` : ''}`);
      if (s.ctx !== null && s.ctx !== undefined) who.append(' ', ctxMeta(s.ctx));
      c.append(who);
      // its own line: the who line is cut with an ellipsis on the desktop, and the chip must show whole
      if (s.conflicts) {
        const line = el('div', 'what cf-line');
        line.append(cfMeta(s.conflicts));
        c.append(line);
      }
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
    if (busy) for (const m of cfMore(s.conflicts)) more.append(el('div', null, m));
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

// A plan row on the glance: its time, its first clause, what it costs the maintainer, a slip marker.
const planKey = (r) => `plan:${r.what.slice(0, 60)}`;
function planItem(r) {
  return item(planKey(r), {
    c: r.slip || r.overdue || r.kind === 'maintainer' || r.kind === 'merge' ? 'c-hold' : 'c-dim',
    badge: r.at ? hhmm(r.at) : 'PLAN',
    sig: r.what,
    text: [short(r.what)],
    meta: [
      r.you ? el('span', 'you', `you: ${r.you}`) : null,
      r.overdue
        ? el('span', 'meta slip', 'late')
        : r.slip
          ? el('span', 'meta slip', `now ${hhmm(r.slip)}`)
          : null,
    ],
    more: [short(r.what) !== r.what ? r.what : null, r.lane ? `waits on ${r.lane}` : null],
  });
}

function askItem(a) {
  return item('next:ask', {
    c: 'c-hold',
    badge: 'NEXT ASK',
    sig: `${a.lo}`,
    text: [a.late ? `late (was ~${hhmm(a.hi)})` : `~${range(a)}`, `  ·  ${short(a.what, 70)}`],
    meta: [a.source === 'lane' ? 'lane ETA' : 'plan'],
    more: [short(a.what, 70) !== a.what ? a.what : null],
  });
}

// The plan table (expanded NEXT): Time | What | You, a now-line, finished rows struck with est vs actual, a slipping
// row's "now HH:MM" in amber; dispatch's notes below.
function planTable(v) {
  const box = el('div', 'plan-box');
  const head = el('h3', null, 'PLAN');
  if (v.next.planAt) {
    const old = v.now - v.next.planAt > 6 * 3600e3;
    head.append(el('span', `age ${old ? 't-warn' : 't-dim'}`, `as of ${hhmm(v.next.planAt)}`));
  }
  box.append(head);
  const rows = v.next.table;
  if (!rows.length) {
    box.append(el('div', 'empty', 'no plan in queue.json'));
    return box;
  }
  const t = el('table', 'plan');
  const hr = el('tr');
  for (const h of ['Time', 'What', 'You']) hr.append(el('th', null, h));
  t.append(el('thead'));
  t.firstChild.append(hr);
  const tb = el('tbody');
  const nowLine = () => {
    const tr = el('tr', 'nowline');
    const td = el('td', null, `now ${hhmm(v.now)}`);
    td.colSpan = 3;
    tr.append(td);
    return tr;
  };
  rows.forEach((r, k) => {
    if (k === v.next.nowIndex) tb.append(nowLine());
    const tr = el('tr', r.done ? 'done' : r.slip || r.overdue ? 'slipping' : '');
    const time = el('td', 'time', r.at ? hhmm(r.at) : '—');
    if (r.eta) {
      time.append(el('div', 'eta', `→ ${hhmm(r.eta.from)}–${hhmm(r.eta.to)}`));
      time.append(el('div', `src ${r.eta.source}`, r.eta.source));
    }
    const what = el('td', 'what');
    what.append(el('span', null, r.what));
    if (r.who) what.append(el('span', 'who', `  ${r.who}`));
    if (r.overdue)
      what.append(
        el(
          'div',
          'slip',
          r.slip
            ? `late: ${r.lane}'s ETA ${hhmm(r.slip)} has passed too`
            : 'late: past due, not marked done',
        ),
      );
    else if (r.slip)
      what.append(el('div', 'slip', `now ${hhmm(r.slip)}${r.lane ? ` · ${r.lane}'s ETA` : ''}`));
    if (r.done)
      what.append(
        el(
          'div',
          'actual',
          r.doneAt === null
            ? 'done'
            : `est ${r.due ? hhmm(r.due) : '?'} · actual ${hhmm(r.doneAt)}` +
                (r.deltaMin === null ? '' : ` (${r.deltaMin > 0 ? '+' : ''}${r.deltaMin} min)`),
        ),
      );
    tr.append(time, what, el('td', 'you', r.you ?? (r.kind === 'maintainer' ? 'yes' : '')));
    tb.append(tr);
  });
  if (v.next.nowIndex >= rows.length) tb.append(nowLine());
  t.append(tb);
  box.append(t);
  if (v.next.notes.length) {
    const ul = el('ul', 'notes');
    for (const n of v.next.notes) ul.append(el('li', null, n));
    box.append(ul);
  }
  return box;
}

function next(v) {
  const b = body('next');
  const items = [];
  const group = (title) => (inFull ? items.push(el('h3', null, title)) : null);
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
  if (v.next.ask) items.push(askItem(v.next.ask));
  // dispatch's landing order, each lane as it stands; its merge rows aren't repeated in the merge queue
  const order = v.next.order ?? [];
  const merge = v.next.merge.filter((r) => !order.some((o) => o.branch === r.branch));
  // QUEUED: approved autoStart lanes not started, in start order (queued.ts). The glance folds them into one row,
  // ahead of the merge and plan rows (neither has a limit) so the 8-row cap never hides it; expanded, a group of their
  // own further down.
  const queued = v.queued ?? [];
  if (queued.length && !inFull) {
    const ready = queued.filter((q) => q.state === 'ready');
    items.push(
      item('next:queued', {
        c: 'c-dim',
        badge: 'QUEUED',
        sig: queued.map((q) => `${q.branch}:${q.state}`).join(','),
        text: [
          `${queued.length} · ${ready.length} ready`,
          ready.length ? el('span', 'who', `: ${ready.map((q) => q.branch).join(', ')}`) : '',
        ],
        more: queued.map((q) => q.line),
      }),
    );
  }
  // the glance: a merge waiting on you, then the next few plan rows with what they cost you; expanded, the
  // whole plan table first
  if (inFull) {
    items.push(planTable(v));
    for (const r of v.next.soon) rendered.add(planKey(r)); // a glance row opened stays open for the glance's return
  } else {
    for (const r of merge) items.push(laneItem(r));
    for (const r of v.next.soon) items.push(planItem(r));
  }
  if (order.length) group('Landing order');
  order.forEach((o, k) => items.push(laneItem(o.row, { pos: k + 1, note: o.note })));
  if (inFull && merge.length) group('Merge queue');
  if (inFull) for (const r of merge) items.push(laneItem(r));
  if (inFull && v.needs.length) {
    group('Your items (NEEDS YOU)');
    for (const n of v.needs) items.push(needItem(n));
  }
  if (queued.length && inFull) {
    group('Queued to start (autoStart)');
    for (const q of queued)
      items.push(
        item(`queued:${q.branch}`, {
          c: q.state === 'ready' ? '' : 'c-dim',
          badge: q.state === 'ready' ? 'READY' : q.state === 'held' ? 'HELD' : 'AFTER',
          text: [
            el('b', null, q.branch),
            `  ·  ${short(q.line.split(' · ').slice(1).join(' · '), 60)}`,
          ],
          meta: [q.cls, q.order !== null ? `#${q.order}` : null],
          // the row says the state; the note adds why, unless it is the row's own text (a held note)
          more: [q.state === 'held' ? null : q.note],
        }),
      );
  }
  if (v.next.queue.length) group('Dev order');
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
  if (v.next.parked.length)
    items.push(
      item('next:parked', {
        c: 'c-dim',
        badge: 'PARKED',
        text: [el('span', 'who', v.next.parked.join(', '))],
      }),
    );
  if (!items.length) return emptyOr(v, b, 'next', 'nothing queued');
  list(b, 'next', items, 8);
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
  // heavy.sh wall times, last 30 min vs the 24 h before (slowdown.ts); absent from a server older than this page
  const sd = h.slowdown ?? {
    windowMin: 30,
    worst: null,
    tone: 'ok',
    line: 'unknown (server too old)',
  };
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
          : `${c.cpu === null ? '?' : c.cpu.toFixed(1)} cores · tests ${c.tests}/${c.testCap ?? '?'}${
              sd.worst && sd.tone !== 'ok'
                ? ` · slow ×${sd.worst.ratio.toFixed(1)} ${sd.worst.cls}`
                : ''
            }`,
        stale || cc === 'c-bad' || sd.tone === 'ok' ? cc : sd.tone === 'bad' ? 'c-bad' : 'c-hold',
        [
          ['memory', `soft ${gib(c.anonSoft)} · hard ${gib(c.anonHard)} GiB · line: last hour`],
          [
            'cpu',
            c.cpu === null ? 'unknown (bad tick)' : `${c.cpu.toFixed(1)} of ${c.cores} cores`,
          ],
          ['pids', `${c.pids} of ${c.pidsMax}`],
          [`slowdown (${sd.windowMin} min vs 24 h)`, sd.line],
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
    // battery / Low Power Mode / thermal (F120): red on an alert; an older agent shows nothing here
    const pw = h.power ?? { known: false, line: '', alerts: [], advice: null };
    const mt = tile(
      'h:m',
      'MAC',
      [gib(s.mem.usedMiB), ` / ${gib(s.memTotalMiB)} GiB`],
      `${age}${s.vm ? ` · VM ${gib(s.vm.rssMiB)}` : ''}`,
      pw.alerts.length ? 'c-bad' : cc,
      [
        ['free', `${gib(s.mem.freeMiB)} GiB`],
        ['compressor', `${gib(s.mem.compressedMiB)} GiB`],
        ['swap', s.swap ? `${gib(s.swap.usedMiB)} of ${gib(s.swap.totalMiB)} GiB` : 'unknown'],
        ['VM', s.vm ? `${s.vm.comm} ${gib(s.vm.rssMiB)} GiB` : 'no VM process'],
        [
          'load',
          `${s.load ? s.load.map((x) => x.toFixed(1)).join(' ') : 'unknown'} (${s.cpus ?? '?'} cpus)`,
        ],
        [
          'power',
          pw.known
            ? `${pw.line}${pw.alerts.length ? ` — red: ${pw.alerts.join(', ')}` : ''}`
            : s.power === undefined
              ? 'unknown (an older agent: reinstall, NEEDS YOU)'
              : `unknown (stats ${m.state})`,
        ],
        ...(pw.advice ? [['lanes', pw.advice]] : []),
        ['as of', `${hhmm(s.t)} (${ago(s.t, v.now)} ago)`],
      ],
      spark(v.sparks?.mac, s.memTotalMiB),
    );
    if (pw.known)
      mt.querySelector('.sub').after(
        el('div', `sub power${pw.alerts.length ? ' alert' : ''}`, pw.line),
      );
    if (pw.alerts.length && cc === 'c-dev') mt.classList.add('calm-mem'); // red for power: memory's line stays ink
    box.append(mt);
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

// The board freshness chip (TOWER.md → Board freshness): queue.json's age and how many of its facts the tower's
// derived ones contradict. Desktop only: the phone's one-line header has no room for a third button (390 px), so
// there the count joins the sources chip, as behind main does (sources()).
function boardChip(v) {
  const chip = $('#board-chip');
  const bd = v.board;
  if (!bd) return void (chip.hidden = true); // an older server: no board yet
  chip.hidden = false;
  const n = `${bd.items.length}${bd.unsure ? '?' : ''}`;
  const age = bd.updatedAt === null ? '?' : agoShort(bd.updatedAt, v.now);
  chip.textContent = `board ${age} · ${bd.items.length || bd.unsure ? `${n} stale` : 'fresh'}`;
  chip.className = `only-desk ${bd.tone === 'bad' ? 't-bad' : bd.tone === 'warn' ? 't-warn' : 't-dim'}`;
  chip.title = bd.why ?? (bd.unsure ? `can't tell all: ${bd.unsure}` : '');
}
// sessions over the context lines (F240), desktop: "ctx ≥50 lc-catalog 78% · 3 ≥40"; the phone's count is in the
// sources chip (sources())
function ctxChip(v) {
  const c = $('#ctx-chip');
  const x = v.ctx;
  const n = x ? x.warn.length + x.bad.length : 0;
  c.hidden = !n;
  if (!n) return;
  // one session over 50 % is named; more are counted (every name and % in the tooltip)
  const b1 = x.bad[0];
  c.textContent = [
    x.bad.length === 1
      ? `ctx ≥50 ${b1.name} ${Math.round(b1.pct)}%`
      : x.bad.length
        ? `ctx ≥50 ×${x.bad.length}`
        : null,
    x.warn.length ? `${x.bad.length ? '' : 'ctx '}${x.warn.length} ≥40` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  c.className = `meta only-desk ${x.bad.length ? 't-bad' : 't-warn'}`;
  c.title = [...x.bad, ...x.warn].map((e) => `${e.name} ${e.pct}%`).join(' · ');
}

// `pnpm usage line` beside it (desktop): the weekly meter, burn rate and forecast; the server runs it every 5 min
function usageChip(v) {
  const u = $('#usage-chip');
  const old = v.usage && v.now - v.usage.at > 15 * 60000;
  u.textContent = v.usage ? `${v.usage.text}${old ? ` (as of ${hhmm(v.usage.at)})` : ''}` : '';
  u.hidden = !v.usage;
}
const agoShort = (ms, now) => {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

function slipping(v) {
  const b = body('slipping');
  // the board's own items (follow-ups already have their rows below): queue.json facts the tower contradicts
  const board = (v.board?.items ?? []).filter((x) => x.kind !== 'followup');
  $('#slipping .count').textContent = `(${v.slipping.length + board.length})`;
  if (v.board?.unsure) b.append(el('div', 'cant', `board: can't tell all: ${v.board.unsure}`));
  if (!v.slipping.length && !board.length) return emptyOr(v, b, 'slipping', 'nothing slipping');
  const KIND = {
    followup: ['STALE', 'c-hold'],
    fired: ['DUE', 'c-hold'],
    parked: ['PARKED', 'c-dim'],
    quiet: ['QUIET', 'c-hold'],
  };
  const boardRows = board.map((x) =>
    item(`board:${x.kind}:${x.what.slice(0, 60)}`, {
      c: v.board.tone === 'bad' ? 'c-bad' : 'c-hold',
      badge: 'BOARD',
      text: [short(x.what)],
      meta: [x.since ? ago(x.since, v.now) : null],
      more: [short(x.what) !== x.what ? x.what : null, `fix: ${x.fix}`],
    }),
  );
  list(
    b,
    'slipping',
    [
      ...boardRows,
      ...v.slipping.map((s) =>
        item(`slip:${s.kind}:${s.what.slice(0, 60)}`, {
          c: KIND[s.kind][1],
          badge: KIND[s.kind][0],
          text: [short(s.what)],
          meta: [
            s.owner,
            s.sinceDay ? `since ${s.sinceDay}` : s.since ? ago(s.since, v.now) : null,
          ],
          more: [
            short(s.what) !== s.what ? s.what : null,
            s.after
              ? `trigger: ${s.after} (fired ${hhmm(s.since)}, ${ago(s.since, v.now)} ago)`
              : null,
          ],
        }),
      ),
    ],
    8,
  );
}

function sources(v) {
  const b = body('sources');
  const off = v.sources.filter((s) => s.state !== 'ok');
  $('#sources .count').textContent = off.length ? `(${off.length} not ok)` : '(all ok)';
  const chip = $('#sources-chip');
  const failed = off.some((s) => s.state === 'failed');
  // behind main joins the chip (a third header button doesn't fit at 390 px): "behind main · 2 off"; on the phone a
  // stale board joins it too (its own chip is desktop-only, boardChip), the first two of behind, stale, off
  const bd = v.board && v.board.tone !== 'dim' ? v.board : null;
  const offText = off.length ? `${off.length} off` : null;
  // context (F240): a session at 50 % leads (he wants it urgently); at 40 % it follows the board's count
  const cx = v.ctx && (v.ctx.bad.length || v.ctx.warn.length) ? v.ctx : null;
  const ctxText = cx
    ? cx.bad.length
      ? `${cx.bad.length} ctx≥50`
      : `${cx.warn.length} ctx≥40`
    : null;
  chip.replaceChildren(
    el(
      'span',
      'only-desk',
      v.behind
        ? `behind main${offText ? ` · ${offText}` : ''}`
        : offText
          ? `${off.length} source${off.length > 1 ? 's' : ''} off`
          : 'sources ok',
    ),
    el(
      'span',
      'only-phone',
      [
        cx?.bad.length ? ctxText : null,
        v.behind ? 'behind' : null,
        bd ? `${bd.items.length}${bd.unsure ? '?' : ''} stale` : null,
        cx && !cx.bad.length ? ctxText : null,
        offText,
      ]
        .filter(Boolean)
        .slice(0, 2)
        .join(' · ') || 'sources ok',
    ),
  );
  // the worse of the two tones; on the desktop the board's own chip carries its tone, so it counts on the phone only
  const srcTone = failed ? 2 : off.length || v.behind ? 1 : 0;
  const bdTone = Math.max(bd?.tone === 'bad' ? 2 : bd ? 1 : 0, cx ? (cx.bad.length ? 2 : 1) : 0);
  const t = (n) => ['t-dim', 't-warn', 't-bad'][n];
  chip.className = bdTone > srcTone ? `${t(srcTone)} phone-${t(bdTone)}` : t(srcTone);
  $('#live-dot').className = `dot live ${failed ? 'c-bad' : off.length ? 'c-hold' : 'c-good'}`; // data, not code
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
  if (v.behind) {
    const n = v.behind.files;
    const why =
      n < 0
        ? 'git does not know the served commit'
        : `${n} tower file${n === 1 ? '' : 's'} changed`;
    const row = el(
      'div',
      'cant behind',
      `tower behind main: serving ${(v.version ?? '?').slice(0, 8)}, the checkout is at ${v.behind.head.slice(0, 8)} (${why}). In the container: pnpm board sync-main `,
    );
    row.append(copyButton('pnpm board sync-main'));
    b.append(row);
  }
  // the code this server runs: read at its start (a restart moves it)
  const serving = el(
    'div',
    'empty serving',
    `serving ${v.version ? v.version.slice(0, 8) : 'an unknown commit'}${v.startedAt ? `, started ${hhmm(v.startedAt)}` : ''}`,
  );
  // five taps open the status-bar readout: a listener on the element itself, since iOS sends no click up from a
  // tap on a plain div to a document listener
  serving.addEventListener('click', servingTap);
  b.append(serving);
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
  // a redraw never moves the page: the same scroll after as before
  const y = window.scrollY;
  health(v);
  boardChip(v);
  usageChip(v);
  ctxChip(v);
  for (const [id, draw] of [
    ['needs', needs],
    ['now', nowPanel],
    ['next', next],
    ['done', done],
    ['slipping', slipping],
    ['sources', sources],
  ]) {
    inFull = openId === id;
    draw(v);
  }
  inFull = false;
  charts(v);
  strip(v);
  seen = next_seen;
  for (const k of [...expanded]) if (!k.startsWith('h:') && !rendered.has(k)) expanded.delete(k);
  for (const k of [...folded]) if (!rendered.has(k)) folded.delete(k);
  if (window.scrollY !== y) window.scrollTo(0, y);
}

// The strip an expanded panel keeps of the others: ✕, then each other panel's headline number (View.heads).
function strip(v) {
  const s = $('#strip');
  s.replaceChildren();
  if (!openId) return;
  const x = el('button', 'close', '✕');
  x.type = 'button';
  x.title = 'close (Esc)';
  x.setAttribute('aria-label', `close ${NAMES[openId]}`);
  x.addEventListener('click', closePanel);
  s.append(x, el('span', 'title', NAMES[openId]));
  PANELS.forEach((id, k) => {
    if (id === openId) return;
    const b = el('button', 'chip');
    b.type = 'button';
    b.title = `${NAMES[id]} (key ${k + 1})`;
    b.append(el('span', 'k', NAMES[id]), document.createTextNode(` ${v.heads?.[id] ?? ''}`));
    b.addEventListener('click', () => openPanel(id));
    s.append(b);
  });
}

// ---- expand: the hash names the open panel ------------------------------------------------------
const hashPanel = () => {
  const h = location.hash.slice(1);
  return PANELS.includes(h) ? h : null;
};
const saveY = () => {
  try {
    sessionStorage.setItem(`tower:y:${openId ?? ''}`, String(window.scrollY));
  } catch {
    // no storage (private mode): a reload starts at the top
  }
};
// `start`: the page just loaded. Opened at a hash (a reload), the glance's place is the one saved before it.
function applyOpen(start = false) {
  const was = openId;
  openId = hashPanel();
  if (openId === was) return;
  if (!was) {
    // the glance's place, kept for a reload: closing after one still lands where the glance was
    try {
      if (start) glanceY = Number(sessionStorage.getItem('tower:y:')) || 0;
      else sessionStorage.setItem('tower:y:', String((glanceY = window.scrollY)));
    } catch {
      if (!start) glanceY = window.scrollY; // no storage: closing after a reload starts at the top
    }
  }
  if (openId) document.body.dataset.open = openId;
  else delete document.body.dataset.open;
  for (const id of PANELS) $(`#${id}`).classList.toggle('x-open', id === openId);
  if (lastView) render(lastView, false);
  window.scrollTo(0, openId ? 0 : glanceY);
}
// The first open pushes a history entry, so Back closes; switching from the strip replaces it.
function openPanel(id) {
  if (openId === id) return closePanel();
  const u = `${location.pathname}${location.search}#${id}`;
  if (openId) history.replaceState(history.state, '', u);
  else history.pushState({ tower: 1 }, '', u);
  applyOpen();
}
function closePanel() {
  if (!openId) return;
  if (history.state?.tower) return history.back(); // popstate applies it
  history.replaceState(null, '', `${location.pathname}${location.search}`); // opened by a link or a reload
  applyOpen();
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
$('#board-chip').addEventListener('click', () => openPanel('slipping'));
$('#sources-chip').addEventListener('click', () => {
  if (openId) return openPanel('sources'); // the glance's SOURCES is hidden behind an expanded panel
  $('#sources').classList.add('open');
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('#sources').scrollIntoView({ behavior: calm ? 'auto' : 'smooth' });
});
$('#charts-toggle').addEventListener('click', () => {
  chartsOn = !chartsOn;
  const u = new URL(location.href);
  if (chartsOn) u.searchParams.set('charts', '1');
  else u.searchParams.delete('charts');
  history.replaceState(history.state, '', u); // keeps an open panel's entry: Back still closes it
  tick();
});
for (const id of ['needs', 'now', 'next', 'done']) {
  const h = $(`#${id} h2`);
  h.classList.add('exp');
  h.title = `expand (key ${PANELS.indexOf(id) + 1})`;
  h.addEventListener('click', () => openPanel(id));
}
// Installed on the Home Screen: iOS 26 may open the page in a mode its display-mode query doesn't match, with a 0
// inset (WebKit bug 301994), so the status-bar floor also keys on this class (TOWER.md → Phone).
if (
  navigator.standalone === true ||
  matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches
)
  document.documentElement.classList.add('installed');

// F161: what the page sees about the status bar, for the one case no headless engine reproduces (the installed app on
// the phone, docs/ops/TOWER.md → Phone). On with ?debug=1, or five taps within 3 s on SOURCES' "serving" line (the
// installed app has no URL bar); a tap on the box closes it. Read-only, and nothing leaves the page.
const DEBUG_KEY = 'tower:debug';
const debugOn = () => {
  try {
    return sessionStorage.getItem(DEBUG_KEY) === '1';
  } catch {
    return false;
  }
};
function setDebug(on) {
  try {
    if (on) sessionStorage.setItem(DEBUG_KEY, '1');
    else sessionStorage.removeItem(DEBUG_KEY);
  } catch {
    // no storage (a private window): the box still follows this tap
  }
  debugForced = on; // this tab's word wins over storage, which may have failed one way and not the other
  debugReadout();
}
let debugForced = null;
function debugReadout() {
  let box = $('#dbg');
  if (!(debugForced ?? debugOn())) return box?.remove();
  if (!box) {
    box = el('pre', null);
    box.id = 'dbg';
    box.title = 'tap to close';
    box.addEventListener('click', () => setDebug(false));
    document.body.append(box);
  }
  const probe = el('div', null);
  probe.style.cssText =
    'position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)';
  document.body.append(probe);
  const ps = getComputedStyle(probe);
  const inset = [ps.paddingTop, ps.paddingBottom];
  probe.remove();
  const hd = document.querySelector('header');
  const r = hd.getBoundingClientRect();
  const modes = ['standalone', 'fullscreen', 'minimal-ui', 'browser'].filter(
    (m) => matchMedia(`(display-mode: ${m})`).matches,
  );
  const na = (x) => (x === undefined || x === null ? 'n/a' : String(x));
  box.textContent = [
    `display-mode: ${modes.join(', ') || 'none matched'}`,
    `navigator.standalone: ${na(navigator.standalone)}`,
    `html.installed: ${document.documentElement.classList.contains('installed')}`,
    `safe-area-inset top ${inset[0]} · bottom ${inset[1]}`,
    `header padding-top ${parseFloat(getComputedStyle(hd).paddingTop)}px · top ${Math.round(r.top)} · height ${Math.round(r.height)}`,
    `window ${innerWidth}×${innerHeight} · screen ${screen.width}×${screen.height} · dpr ${devicePixelRatio}`,
    `visualViewport offsetTop ${na(window.visualViewport?.offsetTop)} · ${matchMedia('(orientation: portrait)').matches ? 'portrait' : 'landscape'}`,
    navigator.userAgent,
  ].join('\n');
}
let taps = [];
function servingTap() {
  const t = Date.now();
  taps = taps.filter((x) => t - x < 3000).concat(t);
  if (taps.length >= 5) {
    taps = [];
    setDebug(!(debugForced ?? debugOn()));
  }
}
window.addEventListener('resize', debugReadout);
if (new URLSearchParams(location.search).get('debug') === '1') setDebug(true);

window.addEventListener('popstate', () => applyOpen());
window.addEventListener('hashchange', () => applyOpen());
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || e.repeat) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName ?? '')) return;
  if (e.key === 'Escape') return closePanel();
  const k = Number(e.key);
  if (Number.isInteger(k) && k >= 1 && k <= PANELS.length) openPanel(PANELS[k - 1]);
});
window.addEventListener('pagehide', saveY);
history.scrollRestoration = 'manual'; // the page restores its own scroll (below), once the first render is in
applyOpen(true);
tick().then(() => {
  let y = 0;
  try {
    y = Number(sessionStorage.getItem(`tower:y:${openId ?? ''}`)) || 0;
  } catch {
    // no storage (a private window): the top
  }
  window.scrollTo(0, y); // also over the browser's own jump to the #next anchor, which the strip would cover
  debugReadout(); // back at once after the version reload, not a poll later
});
setInterval(() => tick().then(debugReadout), POLL_MS);
// the live timers: every second, against the server's clock
setInterval(() => {
  const now = Date.now() + offset;
  for (const t of document.querySelectorAll('[data-since]'))
    t.textContent = `${t.dataset.prefix}${ago(Number(t.dataset.since), now)}`;
}, 1000);
