// Every panel as a pure function of (state, ui, rect) → exactly rect.h lines of rect.w columns, and
// compose() → the whole frame. docs/ops/SESSION-BOARD.md → Control tower says what each panel reads.
import { BASE, NORD, TONE, c, fit, paint, rpad, spread, strip, tone, width } from './ansi.ts';
import { raster, type Band } from './braille.ts';
import { age, countdown, gib, hhmm, hhmmss, wall } from './fmt.ts';
import {
  bucket,
  failed,
  failuresByConcurrency,
  isSuite,
  ticks,
  type Bucket,
  type Tick,
} from './history.ts';
import { layout, type PanelId, type Rect, type Wants } from './layout.ts';
import { ttlProof } from './ledger.ts';
import { RANGE_SEC, type FeedItem, type Range, type TowerState } from './model.ts';
import {
  queueAgeTone,
  type Lane,
  type PlanItem,
  type PlanKind,
  type WaveItem,
  type WaveState,
} from './queue.ts';

export type Ui = { range: Range; cursor: number }; // cursor: cells back from "now" (0 = live)

const DAY = 86400000;

// A bordered panel: title on the top edge, body padded one column each side, cut or filled to fit.
export function box(r: Rect, title: string, body: string[], right = ''): string[] {
  const iw = r.w - 4;
  const edge = (s: string) => c(NORD.edge, s);
  const t = ` ${c(NORD.accent, title, true)} `;
  const rt = right ? ` ${right} ` : '';
  const fill = Math.max(0, r.w - 3 - width(t) - width(rt));
  const top = fit(edge('╭─') + t + edge('─'.repeat(fill)) + rt + edge('╮'), r.w);
  const lines = [top];
  const n = r.h - 2;
  const shown =
    body.length > n ? [...body.slice(0, n - 1), c(NORD.dim, `+${body.length - n + 1} more`)] : body;
  for (let i = 0; i < n; i++)
    lines.push(edge('│') + ' ' + fit(shown[i] ?? '', iw) + ' ' + edge('│'));
  lines.push(edge('╰' + '─'.repeat(Math.max(0, r.w - 2)) + '╯'));
  return lines.slice(0, r.h);
}

// ---- header -------------------------------------------------------------------------------------

function gauge(
  v: number,
  max: number,
  w: number,
  soft: number | null,
  hard: number | null,
): string {
  const col =
    hard !== null && v >= hard ? NORD.red : soft !== null && v >= soft ? NORD.amber : NORD.accent;
  const at = (x: number | null) => (x === null ? -1 : Math.min(w - 1, Math.floor((x / max) * w)));
  const s = at(soft);
  const h = at(hard);
  let out = '';
  for (let i = 0; i < w; i++) {
    const on = v >= ((i + 0.5) / w) * max;
    if (on) out += c(col, '━');
    else if (i === h) out += c(NORD.red, '┊');
    else if (i === s) out += c(NORD.amber, '┊');
    else out += c(NORD.edge, '─');
  }
  return out;
}

function nextLane(s: TowerState): Lane | null {
  return s.queue.data?.devQueue.find((l) => l.state === 'next') ?? null;
}

export function header(s: TowerState, w: number): string[] {
  const badge = paint(' TOWER ', { fg: NORD.bg, bg: NORD.accent, bold: true });
  let lock: string;
  const L = s.lock;
  if (!L) lock = c(NORD.dim, 'dev lock: no cache yet');
  else if (!L.branch) lock = c(NORD.green, 'dev lock free', true);
  else {
    const left = L.expiresAt !== null ? L.expiresAt - s.now : null;
    const cd =
      left === null
        ? ''
        : left <= 0
          ? c(NORD.red, ' EXPIRED', true)
          : c(left < 5 * 60000 ? NORD.red : NORD.amber, ` ${countdown(L.expiresAt!, s.now)} left`);
    lock =
      c(NORD.amber, 'dev lock ') +
      c(NORD.bright, L.branch, true) +
      (L.session ? c(NORD.frost, ` (${L.session})`) : '') +
      (L.expiresAt !== null ? c(NORD.dim, ` until ${hhmm(L.expiresAt)}`) : '') +
      cd;
  }
  if (L?.asOf && s.now - L.asOf > 5 * 60000)
    lock += c(NORD.dim, ` (as of ${hhmm(L.asOf)}${L.failed ? ', refresh failed' : ''})`);
  const nx = nextLane(s);
  const next = nx
    ? c(NORD.dim, '   next ') +
      c(NORD.accent, nx.branch) +
      (nx.session ? c(NORD.dim, ` (${nx.session})`) : '')
    : '';
  const line1 = spread(
    `${badge} ${lock}${next}`,
    c(NORD.dim, w >= 140 ? `${hhmmss(s.now)}  q quit` : hhmm(s.now)),
    w,
  );

  const g = s.gauges;
  let line2: string;
  if (!g) line2 = c(NORD.dim, ' no sampler data yet: board.sh sampler start');
  else {
    const gw = w >= 160 ? 26 : w >= 120 ? 16 : 10;
    const stale = s.now - g.t > 90000;
    const lab = (t: string) => c(NORD.frost, t);
    const val = (t: string) => c(stale ? NORD.dim : NORD.bright, t);
    line2 =
      ' ' +
      lab('mem ') +
      gauge(g.anonMiB, g.highMiB, gw, g.anonSoft, g.anonHard) +
      ' ' +
      val(`${gib(g.anonMiB)}/${Math.round(g.highMiB / 1024)}G`) +
      '   ' +
      lab('pids ') +
      gauge(g.pids, g.pidsMax, gw, g.pidsSoft, g.pidsHard) +
      ' ' +
      val(`${g.pids}/${g.pidsMax}`) +
      '   ' +
      lab('cpu ') +
      gauge(g.cpu ?? 0, g.cores, gw, null, null) +
      ' ' +
      val(`${g.cpu === null ? '?' : g.cpu.toFixed(1)}/${g.cores}`) +
      (stale ? c(NORD.amber, `   sampler stale ${age((s.now - g.t) / 1000)}`) : '') +
      (g.enforcing ? '' : c(NORD.amber, '   cap off'));
  }
  return [fit(line1, w), fit(line2, w)];
}

// ---- queue panels --------------------------------------------------------------------------------

const LANE_BADGE: Record<Lane['state'], string> = {
  'on-dev': c(NORD.green, 'ON DEV', true),
  next: c(NORD.accent, 'NEXT  ', true),
  waiting: c(NORD.amber, 'WAIT  ', true),
  building: c(NORD.frost, 'BUILD ', true),
  ready: c(NORD.green, 'READY ', true), // PR check green, Rahul's merge
  'needs-you': c(NORD.amber, 'RAHUL ', true), // blocked on a Rahul step
};

function queueTrouble(s: TowerState): string[] | null {
  const q = s.queue;
  if (q.status === 'missing')
    return [
      c(NORD.dim, 'no queue.json yet. dispatch writes it:'),
      c(NORD.dim, 'cp scripts/board/queue.example.json'),
      c(NORD.dim, '   /workspace/localNotes/board/queue.json'),
    ];
  if (q.status === 'bad' && !q.data) return q.problems.slice(0, 3).map((p) => c(NORD.red, p));
  return null;
}

function queueAge(s: TowerState): string {
  const d = s.queue.data;
  if (!d) return '';
  const a = (s.now - d.updatedAt) / 1000;
  return (
    tone(queueAgeTone(a), `queue ${age(a)} old`) +
    (s.queue.status === 'bad' ? c(NORD.red, ' · bad write') : '')
  );
}

export function devQueue(s: TowerState, r: Rect): string[] {
  const body = queueTrouble(s) ?? [];
  if (!body.length) {
    if (s.queue.status === 'bad') body.push(c(NORD.red, s.queue.problems[0] ?? ''));
    for (const l of s.queue.data!.devQueue) {
      const pr = l.pr !== null ? c(NORD.dim, ` PR ${l.pr}`) : '';
      let tail = '';
      if (l.state === 'on-dev' && l.eta !== null)
        tail = c(NORD.green, `  ${countdown(l.eta, s.now)}`);
      if ((l.state === 'waiting' || l.state === 'needs-you') && l.waitingOn)
        tail = c(NORD.amber, `  on ${l.waitingOn}`);
      if (l.note) tail += c(NORD.dim, `  ${l.note}`);
      const who = l.session && l.session !== l.branch ? c(NORD.dim, ` ${l.session}`) : '';
      body.push(`${LANE_BADGE[l.state]} ${c(NORD.bright, l.branch)}${pr}${who}${tail}`);
    }
    if (!s.queue.data!.devQueue.length) body.push(c(NORD.dim, 'nothing queued'));
  }
  return box(r, 'DEV QUEUE', body, queueAge(s));
}

// a to-do's age: '' today (no column) · 1d · 3d (a date) or the text as given
export function since(x: string, now: number): string {
  const t = Date.parse(x.length === 10 ? `${x}T00:00:00` : x);
  if (Number.isNaN(t)) return x;
  const d = Math.floor(
    (new Date(now).setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / 86400000,
  );
  return d <= 0 ? '' : `${d}d`;
}

export function rahul(s: TowerState, r: Rect): string[] {
  const body = queueTrouble(s)
    ? []
    : (s.queue.data?.rahul ?? []).map((t, i) =>
        spread(
          `${c(NORD.amber, `${i + 1}.`)} ${t.text}`,
          t.since ? c(NORD.dim, since(t.since, s.now)) : '',
          r.w - 4,
        ),
      );
  if (!queueTrouble(s) && !body.length) body.push(c(NORD.green, 'nothing waiting on you'));
  return box(r, 'WAITING ON RAHUL', body);
}

const WAVE_ORDER: WaveState[] = ['in-flight', 'open', 'not-started', 'merged'];
const WAVE_COLOR: Record<WaveState, string> = {
  merged: NORD.green,
  open: NORD.accent,
  'in-flight': NORD.amber,
  'not-started': NORD.dim,
};
const WAVE_BADGE: Record<WaveState, string> = {
  merged: 'done',
  open: 'open',
  'in-flight': 'wip ',
  'not-started': 'todo',
};

// queue.json's items, upgraded to merged when gh says their PR merged (never downgraded: the hub may know better)
export function waveItems(s: TowerState): WaveItem[] {
  const items = s.queue.data?.wave?.items ?? [];
  return items.map((it) => {
    // only a named PR can mark an item merged: a reused branch name may carry an old merged PR. By branch,
    // an open PR just lends its number and title.
    const pr =
      it.pr !== null
        ? s.prs.list.find((p) => p.number === it.pr)
        : s.prs.list.find((p) => p.branch === it.branch && p.state === 'OPEN');
    const merged = it.pr !== null && pr?.state === 'MERGED' && it.state !== 'merged';
    return {
      ...it,
      state: merged ? 'merged' : it.state,
      pr: it.pr ?? pr?.number ?? null,
      title: it.title ?? pr?.title ?? null,
    };
  });
}

export function wave(s: TowerState, r: Rect): string[] {
  const trouble = queueTrouble(s);
  const w = s.queue.data?.wave;
  if (trouble || !w) return box(r, 'WAVE', trouble ?? [c(NORD.dim, 'no wave in queue.json')]);
  const items = waveItems(s);
  const iw = r.w - 4;
  const n = items.length || 1;
  const count = (st: WaveState) => items.filter((i) => i.state === st).length;
  const merged = count('merged');
  let bar = '';
  let used = 0;
  for (const st of ['merged', 'open', 'in-flight', 'not-started'] as WaveState[]) {
    const k = Math.round(((used + count(st)) / n) * iw) - Math.round((used / n) * iw);
    bar += c(WAVE_COLOR[st], (st === 'not-started' ? '─' : '━').repeat(Math.max(0, k)));
    used += count(st);
  }
  const legend = WAVE_ORDER.map((st) =>
    c(WAVE_COLOR[st], `${WAVE_BADGE[st].trim()} ${count(st)}`),
  ).join(c(NORD.dim, ' · '));
  const body = [bar, legend];
  for (const st of WAVE_ORDER.filter((x) => x !== 'merged'))
    for (const it of items.filter((i) => i.state === st)) {
      const pr = it.pr !== null ? c(NORD.dim, ` PR ${it.pr}`) : '';
      const who = it.session && it.session !== it.branch ? c(NORD.dim, ` ${it.session}`) : '';
      const title = it.title ? c(NORD.dim, `  ${it.title}`) : '';
      body.push(
        `${c(WAVE_COLOR[st], WAVE_BADGE[st], true)} ${c(NORD.bright, it.branch)}${pr}${who}${title}`,
      );
    }
  // merged items list nowhere: the bar, the legend and the title count them
  return box(r, w.name.toUpperCase(), body, c(NORD.green, `${merged}/${items.length} merged`));
}

// ---- sessions ------------------------------------------------------------------------------------

// A row for each working session and each holding a branch; the rest share one `idle:` line (name order:
// source.ts sorts working first, then by name).
function sessionSplit(s: TowerState) {
  const row = (x: TowerState['sessions'][number]) => x.state === 'working' || x.branch !== null;
  return [s.sessions.filter(row), s.sessions.filter((x) => !row(x))] as const;
}

export function sessions(s: TowerState, r: Rect): string[] {
  const iw = r.w - 4;
  const full = iw >= 60; // narrower: no thr / heavy columns (heavy shows in STATUS)
  const bw = Math.max(8, iw - 17 - 8 - 7 - (full ? 11 : 0));
  const row = (a: string, b: string, br: string, m: string, t: string, h: string) =>
    fit(a, 16) +
    ' ' +
    fit(b, 8) +
    fit(br, bw) +
    m.padStart(7) +
    (full ? t.padStart(5) + ' ' + fit(h, 5) : '');
  const body = [c(NORD.dim, row('name', 'state', 'branch', 'MiB', 'thr', 'heavy'))];
  const [listed, idle] = sessionSplit(s);
  for (const x of listed) {
    const st = x.state === 'working' ? c(NORD.green, 'working') : c(NORD.dim, x.state);
    body.push(
      row(
        c(x.state === 'working' ? NORD.bright : NORD.fg, x.name),
        st,
        c(NORD.frost, x.branch ?? ''),
        String(Math.round(x.rssMiB)),
        String(x.thr),
        c(NORD.amber, x.heavy ?? ''),
      ),
    );
  }
  if (idle.length)
    body.push(c(NORD.dim, 'idle: ') + c(NORD.fg, idle.map((x) => x.name).join(', ')));
  const working = s.sessions.filter((x) => x.state === 'working').length;
  return box(
    r,
    'SESSIONS',
    body,
    c(NORD.dim, `${working} working · ${s.sessions.length - working} idle`),
  );
}

// ---- history -------------------------------------------------------------------------------------

type Series = {
  key: 'cpu' | 'anon' | 'pids' | 'heavy' | 'working';
  label: string;
  color: string;
  max: number;
  bands: Band[];
  fmt: (v: number) => string;
};

const TICK: Record<NonNullable<Tick>, string> = {
  fail: c(NORD.red, '✗', true),
  'devcheck-fail': c(NORD.red, '◆'),
  merge: c(NORD.purple, '▲'),
  'devcheck-pass': c(NORD.green, '◆'),
  suite: c(NORD.dim, '·'),
};

const STEP_MIN: Record<Range, number> = { '1h': 10, '6h': 60, '24h': 180 };

const LABEL_W = 13;
const chartW = (r: Rect) => Math.max(10, r.w - 4 - LABEL_W);

// The history chart's width in cells at this size (0 without one): the readout cursor's range.
export function chartCols(s: TowerState, cols: number, rows: number): number {
  const r = layout(cols, rows, wants(s)).rects.history;
  return r ? chartW(r) : 0;
}

export function history(s: TowerState, ui: Ui, r: Rect): string[] {
  const iw = r.w - 4;
  const L = LABEL_W;
  const cw = chartW(r);
  const to = s.now;
  const from = to - RANGE_SEC[ui.range] * 1000;
  const bk = bucket(s.points, from, to, cw * 2);
  const g = s.gauges;
  const high = g?.highMiB ?? 18432;
  const peak = (k: Series['key']) => bk.reduce((m, b) => Math.max(m, b[k] ?? 0), 0);
  const pidsMax = Math.max(512, Math.ceil(peak('pids') / 256) * 256);
  const series: Series[] = [
    {
      key: 'cpu',
      label: 'cpu',
      color: NORD.accent,
      max: g?.cores ?? 9,
      bands: [],
      fmt: (v) => v.toFixed(1),
    },
    {
      key: 'anon',
      label: 'mem',
      color: NORD.blue,
      max: high,
      bands: g
        ? [
            { at: g.anonSoft, color: NORD.amber },
            { at: g.anonHard, color: NORD.red },
          ]
        : [],
      fmt: gib,
    },
    {
      key: 'pids',
      label: 'pids',
      color: NORD.frost,
      max: pidsMax,
      bands: g
        ? [
            { at: g.pidsSoft, color: NORD.amber },
            { at: g.pidsHard, color: NORD.red },
          ]
        : [],
      fmt: (v) => String(Math.round(v)),
    },
    {
      key: 'heavy',
      label: 'heavy',
      color: NORD.purple,
      max: Math.max(4, peak('heavy')),
      bands: [],
      fmt: (v) => String(Math.round(v)),
    },
    {
      key: 'working',
      label: 'working',
      color: NORD.green,
      max: Math.max(4, peak('working')),
      bands: [],
      fmt: (v) => String(Math.round(v)),
    },
  ];
  const fixedRows = 3; // ticks, axis, readout
  const room = r.h - 2 - fixedRows;
  const per = room >= series.length * 2 ? 2 : 1;
  const shown = series.slice(0, Math.max(1, Math.min(series.length, Math.floor(room / per))));
  const cell = Math.max(0, Math.min(cw - 1, cw - 1 - ui.cursor));
  const cellVal = (k: Series['key'], x: number) => {
    const a = bk[2 * x]?.[k] ?? null;
    const b = bk[2 * x + 1]?.[k] ?? null;
    return a === null ? b : b === null ? a : Math.max(a, b);
  };
  const body: string[] = [];
  for (const se of shown) {
    const vals = bk.map((b) => b[se.key]);
    const rows = raster(vals, cw, per, se.max, se.color, se.bands, ui.cursor > 0 ? cell : null);
    const v = cellVal(se.key, cell);
    rows.forEach((line, i) => {
      const lab =
        i === 0
          ? c(NORD.frost, se.label.padEnd(8)) +
            c(NORD.bright, (v === null ? '-' : se.fmt(v)).padStart(5))
          : c(NORD.dim, `/${se.fmt(se.max)}`.padStart(13));
      body.push(fit(lab, L) + line);
    });
  }
  const tk = ticks(
    cw,
    from,
    to,
    s.jobs,
    s.runs,
    s.prs.list.map((p) => p.mergedAt).filter((t): t is number => t !== null),
  );
  body.push(fit(c(NORD.dim, 'events'), L) + tk.map((t) => (t ? TICK[t] : ' ')).join(''));
  body.push(fit('', L) + axis(from, to, cw, STEP_MIN[ui.range]));
  body.push(readout(bk, cell, ui.cursor, iw));
  const tabs = (['1h', '6h', '24h'] as Range[])
    .map((x) =>
      x === ui.range
        ? paint(` ${x} `, { fg: NORD.bg, bg: NORD.accent, bold: true })
        : c(NORD.dim, ` ${x} `),
    )
    .join('');
  return box(r, 'MACHINE', body, tabs + c(NORD.dim, '  1/6/2 range · ←→ readout · esc live'));
}

// HH:MM labels at whole steps, placed where they fit; the right end says now.
export function axis(from: number, to: number, cols: number, stepMin: number): string {
  const chars = Array.from({ length: cols }, () => ' ');
  const step = stepMin * 60000;
  const off = new Date(from).getTimezoneOffset() * 60000; // steps on local wall-clock boundaries
  let t = Math.ceil((from - off) / step) * step + off;
  for (; t < to; t += step) {
    const x = Math.floor(((t - from) / (to - from)) * cols);
    const lab = '╵' + hhmm(t);
    if (x + lab.length > cols - 4) break;
    if (chars.slice(Math.max(0, x - 1), x + lab.length + 1).some((ch) => ch !== ' ')) continue;
    for (let i = 0; i < lab.length; i++) chars[x + i] = lab[i]!;
  }
  chars.splice(cols - 3, 3, 'n', 'o', 'w');
  return c(NORD.dim, chars.join(''));
}

function readout(bk: Bucket[], cell: number, cursor: number, w: number): string {
  const a = bk[2 * cell];
  const b = bk[2 * cell + 1];
  if (!a || !b) return '';
  const pick = (k: 'anon' | 'pids' | 'cpu' | 'heavy' | 'working') => {
    const x = a[k];
    const y = b[k];
    return x === null ? y : y === null ? x : Math.max(x, y);
  };
  const last = b.src ?? a.src;
  const when =
    cursor === 0
      ? c(NORD.green, 'live ') + c(NORD.bright, last ? hhmm(last.t) : '--:--')
      : c(NORD.amber, `${hhmm(a.from)}–${hhmm(b.to)}`);
  if (pick('cpu') === null) return fit(`${when}  ${c(NORD.dim, 'no samples (sampler gap)')}`, w);
  const kv = (k: string, v: string) => c(NORD.dim, `${k} `) + c(NORD.bright, v);
  const names = last?.names.length ? c(NORD.green, `: ${last.names.join(', ')}`) : '';
  return fit(
    [
      when,
      kv('cpu', pick('cpu')!.toFixed(1)),
      kv('mem', gib(pick('anon')!)),
      kv('pids', String(pick('pids'))),
      kv('heavy', String(pick('heavy'))),
      kv('working', String(pick('working'))) + names,
    ].join(c(NORD.dim, ' · ')),
    w,
  );
}

// ---- failures ------------------------------------------------------------------------------------

export function failures(s: TowerState, r: Rect): string[] {
  const rows = failuresByConcurrency(s.jobs, s.now - 7 * DAY);
  const aw = Math.max(6, r.w - 4 - 24);
  const line = (a: string, b: string, f: string, d: string) =>
    fit(a, aw) + rpad(b, 6) + rpad(f, 10) + rpad(d, 8);
  const body = [c(NORD.dim, line('with', 'suites', 'failed', 'p50'))];
  for (const x of rows) {
    const pct = x.runs ? Math.round((x.failed / x.runs) * 100) : 0;
    const f = x.runs
      ? c(x.failed ? NORD.red : NORD.green, `${x.failed} ${String(pct).padStart(3)}%`)
      : c(NORD.dim, '-');
    body.push(line(x.bin, String(x.runs), f, x.p50Sec === null ? '-' : wall(x.p50Sec)));
  }
  return box(
    r,
    'TEST FAILURES',
    body,
    c(NORD.dim, r.w >= 52 ? 'by heavy jobs alongside · 7 d' : 'by jobs alongside'),
  );
}

// ---- activity ------------------------------------------------------------------------------------

// What changed, not what ran: failed jobs (not the Vite dev server's), devcheck runs (their end; the start
// while in flight), merges, PRs opened, the dev lock taken (a `pnpm bot deploy-dev`) and leases that gave up
// or were denied. Passing jobs stay in MACHINE and STATUS.
export function feedItems(s: TowerState): FeedItem[] {
  const since = s.now - DAY;
  const out: FeedItem[] = [];
  for (const j of s.jobs) {
    if (j.t < since || j.excluded || !failed(j)) continue;
    if (j.cls === 'other' || j.cls === 'test-file' || j.cls === 'dev') continue;
    const who = j.name ?? '?';
    const ex = `exit ${j.exit}`; // failed() means an exit code
    out.push({
      t: j.t,
      kind: 'job',
      text: `${who}  ${j.label || j.cls}  ${wall(j.wallSec)}  ${ex}${j.verdict && j.verdict !== 'clean' ? `  ${j.verdict}` : ''}`,
      tone: 'bad',
    });
  }
  for (const r of s.runs) {
    const tier = r.run.replace(/^.*-/, '');
    if (r.end === null && r.start !== null && r.start >= since)
      // started shows only while in flight
      out.push({ t: r.start, kind: 'run', text: `devcheck ${tier} started`, tone: 'dim' });
    if (r.end !== null && r.end >= since) {
      const dur = r.start !== null ? `  ${wall((r.end - r.start) / 1000)}` : '';
      out.push({
        t: r.end,
        kind: 'run',
        text: `devcheck ${tier} ${r.status ?? 'ended'}${dur}`,
        tone: r.status === 'PASS' ? 'good' : 'bad',
      });
    }
  }
  for (const p of s.prs.list)
    if (p.mergedAt !== null && p.mergedAt >= since)
      out.push({
        t: p.mergedAt,
        kind: 'merge',
        text: `merged PR ${p.number}  ${p.title}`,
        tone: 'normal',
      });
  for (const p of s.prs.list)
    if (p.createdAt !== null && p.createdAt >= since)
      out.push({
        t: p.createdAt,
        kind: 'pr',
        text: `PR ${p.number} opened  ${p.title}`,
        tone: 'normal',
      });
  out.push(
    ...s.lockFeed.filter((f) => f.tone !== 'good'), // taken, not freed
    ...s.leaseFeed.filter((f) => f.t >= since && f.tone === 'bad'),
  );
  return out.sort((a, b) => b.t - a.t);
}

const KIND: Record<FeedItem['kind'], string> = {
  job: c(NORD.frost, 'job  '),
  run: c(NORD.accent, 'dev  '),
  merge: c(NORD.purple, 'merge'),
  pr: c(NORD.purple, 'pr   '),
  lock: c(NORD.amber, 'lock '),
  lease: c(NORD.amber, 'cap  '),
};

export function feed(s: TowerState, r: Rect): string[] {
  const items = feedItems(s).slice(0, Math.max(0, r.h - 2));
  const body = items.map(
    (f) =>
      `${c(NORD.dim, hhmm(f.t))} ${KIND[f.kind]} ${f.kind === 'merge' ? c(NORD.purple, f.text) : c(TONE[f.tone], f.text)}`,
  );
  if (!body.length) body.push(c(NORD.dim, 'nothing in the last 24 h'));
  return box(r, 'ACTIVITY', body, c(NORD.dim, '24 h, newest first'));
}

// ---- plan ----------------------------------------------------------------------------------------

const PLAN_STALE = 2 * 3600000; // past due longer than this drops off
const PLAN_KIND: Record<PlanKind, string> = {
  dev: c(NORD.accent, 'dev  '),
  merge: c(NORD.green, 'merge', true),
  rahul: c(NORD.amber, 'rahul', true),
  ci: c(NORD.frost, 'ci   '),
};

// The first merge with a time, among items not dropped as stale: the PLAN title. The statusline
// (localNotes/board/next-merge.sh) takes the same item.
export function nextMerge(plan: PlanItem[]): PlanItem | null {
  return plan.find((p) => p.kind === 'merge' && p.at !== null) ?? null;
}

export const livePlan = (plan: PlanItem[], now: number) =>
  plan.filter((p) => p.at === null || p.at >= now - PLAN_STALE);

export function plan(s: TowerState, r: Rect): string[] {
  const trouble = queueTrouble(s);
  const items = livePlan(s.queue.data?.plan ?? [], s.now);
  if (trouble || !items.length)
    return box(r, 'PLAN', trouble ?? [c(NORD.dim, 'no plan in queue.json (dispatch writes it)')]);
  const body = items.map((p) => {
    const past = p.at !== null && p.at < s.now;
    const when = p.at === null ? '--:--' : hhmm(p.at);
    const cd = p.at === null ? '' : past ? '?' : countdown(p.at, s.now);
    const who = p.who ? ` (${p.who})` : '';
    if (past) return c(NORD.dim, `${when} ${cd.padStart(6)} ${p.kind.padEnd(5)} ${p.what}${who}`);
    const hot = p.kind === 'merge' || p.kind === 'rahul';
    return (
      c(NORD.fg, when) +
      ' ' +
      c(hot ? NORD.bright : NORD.dim, cd.padStart(6)) + // 10h05m
      ' ' +
      PLAN_KIND[p.kind] +
      ' ' +
      c(hot ? NORD.bright : NORD.fg, p.what, hot) +
      c(NORD.dim, who)
    );
  });
  const m = nextMerge(items);
  const right = m
    ? c(NORD.green, `next merge ${m.at! < s.now ? '?' : '~'}${hhmm(m.at!)}`)
    : c(NORD.dim, `${items.length} planned`);
  return box(r, 'PLAN', body, right);
}

// ---- tiles ---------------------------------------------------------------------------------------

export function tiles(s: TowerState, r: Rect): string[] {
  const kv = (k: string, v: string) => c(NORD.frost, k.padEnd(11)) + v;
  const body: string[] = [];
  const d = s.queue.data?.deadRows;
  if (d) {
    const p = ttlProof(s.runs, d);
    const done = p.passed >= p.target;
    body.push(
      kv(
        'TTL proof',
        c(done ? NORD.green : NORD.bright, `${p.passed}/${p.target}`, true) +
          c(NORD.dim, ' full runs') +
          (p.failed ? c(NORD.red, ` · ${p.failed} failed`) : ''),
      ),
    );
  } else body.push(kv('TTL proof', c(NORD.dim, 'no window in queue.json')));
  if (s.bench) {
    const b = s.bench;
    const st = b.state ? strip(b.state).replace(/^(\d\d:\d\d):\d\d (.*)$/, '$1 $2') : '';
    body.push(
      kv(
        'bench',
        c(NORD.bright, `${b.runs} runs`) +
          (b.failedRows ? c(NORD.red, ` · ${b.failedRows} red`) : '') +
          c(NORD.dim, st ? ` · ${st}` : ''),
      ),
    );
  }
  const q = s.queue.data;
  if (q) {
    const a = (s.now - q.updatedAt) / 1000;
    body.push(
      kv(
        'queue.json',
        tone(queueAgeTone(a), `${age(a)} old`) +
          (s.queue.status === 'bad' ? c(NORD.red, ' · bad write') : ''),
      ),
    );
  } else
    body.push(kv('queue.json', c(s.queue.status === 'bad' ? NORD.red : NORD.dim, s.queue.status)));
  if (s.prs.error) body.push(kv('gh', c(NORD.red, s.prs.error)));
  else
    body.push(
      kv(
        'gh',
        s.prs.at
          ? c(
              NORD.dim,
              `${age((s.now - s.prs.at) / 1000)} ago · ${s.prs.list.filter((p) => p.state === 'OPEN').length} open`,
            )
          : c(NORD.dim, 'off'),
      ),
    );
  const g = s.gauges;
  body.push(
    kv(
      'sampler',
      g
        ? tone(s.now - g.t > 90000 ? 'warn' : 'dim', `${age((s.now - g.t) / 1000)} ago`)
        : c(NORD.amber, 'no data'),
    ),
  );
  const day = s.jobs.filter((j) => isSuite(j) && j.t >= s.now - DAY);
  const red = day.filter(failed).length;
  body.push(
    kv(
      'suites 24h',
      c(NORD.bright, String(day.length)) +
        (red ? c(NORD.red, ` · ${red} failed`) : c(NORD.green, ' · all green')),
    ),
  );
  const heavy = s.sessions.filter((x) => x.heavy).map((x) => `${x.heavy} (${x.name})`);
  body.push(kv('heavy now', heavy.length ? c(NORD.amber, heavy.join(', ')) : c(NORD.dim, 'none')));
  return box(r, 'STATUS', body);
}

// ---- frame ---------------------------------------------------------------------------------------

export function wants(s: TowerState): Wants {
  const q = s.queue.data;
  return {
    queue: q ? Math.max(1, q.devQueue.length) : 3,
    rahul: q ? Math.max(1, q.rahul.length) : 3,
    wave: q?.wave ? q.wave.items.filter((i) => i.state !== 'merged').length + 2 : 1,
    plan: Math.max(1, q?.plan.length ?? 1),
    sessions: sessionSplit(s)[0].length + 2, // + the column header and the idle line
  };
}

// The whole frame: exactly `rows` lines of exactly `cols` columns, each starting on the base colours.
export function compose(s: TowerState, ui: Ui, cols: number, rows: number): string[] {
  const lay = layout(cols, rows, wants(s));
  const frame: { x: number; s: string }[][] = Array.from({ length: rows }, () => []);
  const put = (r: Rect | undefined, lines: string[]) => {
    if (!r) return;
    lines.forEach((l, i) => frame[r.y + i]?.push({ x: r.x, s: fit(l, r.w) }));
  };
  const R = lay.rects;
  put(R.header, header(s, cols));
  if (lay.mode === 'small') {
    put({ x: 0, y: 2, w: cols, h: 1 }, [
      c(NORD.amber, ` the tower needs at least 95×24 (now ${cols}×${rows})`),
    ]);
  } else {
    const draw: [PanelId, () => string[]][] = [
      ['queue', () => devQueue(s, R.queue!)],
      ['rahul', () => rahul(s, R.rahul!)],
      ['wave', () => wave(s, R.wave!)],
      ['plan', () => plan(s, R.plan!)],
      ['history', () => history(s, ui, R.history!)],
      ['sessions', () => sessions(s, R.sessions!)],
      ['failures', () => failures(s, R.failures!)],
      ['feed', () => feed(s, R.feed!)],
      ['tiles', () => tiles(s, R.tiles!)],
    ];
    for (const [id, f] of draw) if (R[id] && R[id]!.h >= 3) put(R[id], f());
  }
  return frame.map((segs) => {
    let out = BASE;
    let x = 0;
    for (const g of segs.sort((a, b) => a.x - b.x)) {
      if (g.x > x) out += ' '.repeat(g.x - x);
      out += g.s;
      x = g.x + width(g.s);
    }
    return out + ' '.repeat(Math.max(0, cols - x));
  });
}
