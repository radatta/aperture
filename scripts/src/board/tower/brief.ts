// The brief (docs/ops/TOWER.md → Derived files): one fixed block the tower writes every 30 s as brief.txt, and
// `pnpm board brief` prints for the hub to paste verbatim when the maintainer asks for status — a script prints, no
// model composes. Every heading is always there, in this order, with "none" or "unknown" written out. A new line is
// one more entry in SECTIONS. Pure.
import { BUDGET_PREFIX } from '../budget.ts';
import { macLine } from '../machine.ts';
import type { LaneRow, View } from './derive.ts';
import { gib, hhmm as hhmmLocal } from './fmt.ts';
import type { UsageLine } from './stale.ts';

export const BRIEF_FILE = 'brief.txt';
export const BRIEF_STALE_MS = 180_000; // six missed 30 s writes: the tower is down or stuck
export const LIST_MAX = 5; // rows under QUEUED before `+n more`
const TEXT_MAX = 60;

// budget: the log-only budget's status line (budget-read.ts budgetNow), null when there is none to read
export type BriefView = View & { usage?: UsageLine | null; budget?: string | null };
type Fmt = (t: number) => string;

// one line, no control bytes, capped: lane and PR text is the board's, never trusted as terminal-safe
const one = (s: string, max = TEXT_MAX) => {
  const t = Array.from(s, (c) => {
    const n = c.charCodeAt(0);
    return n < 32 || (n >= 127 && n < 160) ? ' ' : c;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const range = (r: { lo: number; hi: number }, f: Fmt) => `~${f(r.lo)}–${f(r.hi)}`;
const minAgo = (t: number, now: number) => `${Math.max(0, Math.round((now - t) / 60e3))}m`;

function laneLine(r: LaneRow, f: Fmt, w: number): string {
  const bits = [one(r.label)];
  if (r.pr && !r.label.includes(`PR ${r.pr.number}`)) bits.push(`PR ${r.pr.number}`);
  if (r.eta?.pr && !r.pr) bits.push(`PR ${range(r.eta.pr, f)}${r.eta.late ? ' late' : ''}`);
  if (r.ctx !== null && r.ctx >= 40) bits.push(`ctx ${Math.round(r.ctx)}%`);
  return `  ${one(r.branch, 40).padEnd(w)}  ${bits.join(' · ')}`;
}

// a count by state, in the order the states show up: `2 BUILDING · 1 TESTING`
const byState = (rows: LaneRow[]) => {
  const n = new Map<string, number>();
  for (const r of rows) n.set(r.state, (n.get(r.state) ?? 0) + 1);
  return [...n].map(([s, c]) => `${c} ${s.toLowerCase()}`).join(' · ');
};

const SECTIONS: ((v: BriefView, f: Fmt) => string[])[] = [
  (v, f) => {
    const st = v.board.items.length;
    return [
      `BRIEF ${f(v.now)} · board ${v.board.updatedAt === null ? '?' : minAgo(v.board.updatedAt, v.now)} · ${st}${v.board.unsure ? '?' : ''} stale · tower ${v.version ? v.version.slice(0, 8) : '?'}`,
    ];
  },
  (v, f) => {
    if (!v.active.length) return ['LANES none'];
    const w = Math.min(28, Math.max(...v.active.map((r) => r.branch.length)));
    return [
      `LANES ${v.active.length} · ${byState(v.active)}`,
      ...v.active.map((r) => laneLine(r, f, w)),
    ];
  },
  (v, f) => [
    `SLOTS ${v.slots
      .map((s) => {
        if (s.state === 'free' && !s.deploying) return `${s.slot} free`;
        // a holder read from a stale or failed cache is said as such: the hub pastes this as fact
        if (s.branch)
          return `${s.slot} ${one(s.branch, 40)}${s.expiresAt ? ` until ${f(s.expiresAt)}` : ''}${s.state === 'unknown' ? ' (lock unknown)' : ''}`;
        if (s.deploying) return `${s.slot} no holder · a dev deploy is running`;
        return `${s.slot} unknown${s.why ? ` (${one(s.why, 40)})` : ''}`;
      })
      .join(' · ')}`,
  ],
  (v) => {
    const gh = v.sources.find((s) => s.name === 'gh PRs');
    const unsure =
      gh && gh.state !== 'ok'
        ? ` (gh PRs ${gh.state}${gh.detail ? `: ${one(gh.detail, 40)}` : ''})`
        : '';
    const me = v.next.merge.filter((r) => r.state === 'MERGE ME');
    const held = v.next.merge.filter((r) => r.state === 'HOLD');
    if (!me.length && !held.length) return [`MERGE ${unsure ? `unknown${unsure}` : 'none'}`];
    const pr = (r: LaneRow) =>
      r.pr ? `PR ${r.pr.number} ${one(r.branch, 40)} "${one(r.pr.title, 50)}"` : one(r.branch, 40);
    return [
      `MERGE ${me.length}${held.length ? ` · ${held.length} on hold` : ''}${unsure}`,
      ...me.map((r) => `  ${pr(r)}`),
      ...held.map((r) => `  HOLD ${pr(r)}${r.hold ? `: ${one(r.hold, 50)}` : ''}`),
    ];
  },
  (v) => {
    const q = v.queued;
    if (!q.length) return ['QUEUED none'];
    const ready = q.filter((x) => x.state === 'ready').length;
    const held = q.filter((x) => x.state === 'held').length;
    return [
      `QUEUED ${q.length} · ${ready} ready${held ? ` · ${held} held` : ''}`,
      ...q.slice(0, LIST_MAX).map((x) => `  ${one(x.line, 90)}`),
      ...(q.length > LIST_MAX ? [`  +${q.length - LIST_MAX} more`] : []),
    ];
  },
  (v, f) => [
    v.next.ask
      ? `ASK ${range(v.next.ask, f)}${v.next.ask.late ? ' late' : ''} ${one(v.next.ask.what)}`
      : 'ASK none',
  ],
  (v) => [
    v.needs.length
      ? `NEEDS ${v.needs.length} · ${one(v.needs[0]!.what)}${v.needs.length > 1 ? ` (+${v.needs.length - 1})` : ''}`
      : 'NEEDS none',
  ],
  (v, f) => [
    v.usage
      ? `USAGE ${one(v.usage.text.replace(/^usage:?\s*/i, ''), 100)} (${f(v.usage.at)})`
      : 'USAGE unknown',
  ],
  (v) => [`MAC ${macLine(v.health.mac).replace(/^mac: /, '')}${macLoad(v)}`],
  (v) => {
    const c = v.health.container;
    const vm = c
      ? `anon ${gib(c.anonMiB)}/${gib(c.highMiB)} · cpu ${c.cpu === null ? '?' : c.cpu.toFixed(1)}/${c.cores}`
      : 'no sample';
    return [`VM ${vm} · slow ${one(v.health.slowdown.line, 80)}`];
  },
  // the smart cap's units beside the live caps (SESSION-BOARD.md → Budget); log-only, so it says so
  (v) => [
    v.budget
      ? `BUDGET ${one(v.budget.startsWith(BUDGET_PREFIX) ? v.budget.slice(BUDGET_PREFIX.length) : v.budget, 100)} (log-only)`
      : 'BUDGET unknown',
  ],
  (v) => {
    const x = v.ctx;
    if (!x) return ['CTX unknown (no ctx.json)'];
    if (x.stale) return ['CTX unknown (ctx.json stale)'];
    if (!x.bad.length && !x.warn.length) return ['CTX none over 40%'];
    const names = (l: typeof x.bad) =>
      l.map((e) => `${one(e.name, 30)} ${Math.round(e.pct)}%`).join(', ');
    return [
      `CTX ${[x.bad.length ? `≥50 ${names(x.bad)}` : null, x.warn.length ? `≥40 ${names(x.warn)}` : null].filter(Boolean).join(' · ')}`,
    ];
  },
];

const macLoad = (v: BriefView) => {
  const s = v.health.mac.stats;
  if (!s?.load || (v.health.mac.state !== 'ok' && v.health.mac.state !== 'stale')) return '';
  return ` · load ${s.load.map((l) => l.toFixed(1)).join(' ')}${s.cpus ? ` /${s.cpus}` : ''}`;
};

export function briefText(v: BriefView, f: Fmt = hhmmLocal): string {
  return SECTIONS.flatMap((s) => s(v, f)).join('\n') + '\n';
}

// `pnpm board brief`: the file as written, with a banner once it is too old to trust.
export function briefOut(text: string, mtimeMs: number, now: number, f: Fmt = hhmmLocal): string {
  const body = text.replace(/\n$/, '');
  return now - mtimeMs > BRIEF_STALE_MS
    ? `TOWER DOWN: this brief is from ${f(mtimeMs)} (board.sh tower status; board.sh tower start)\n${body}`
    : body;
}
