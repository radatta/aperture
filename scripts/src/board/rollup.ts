// Usage report from the board history (docs/ops/SESSION-BOARD.md → History): what does a given mix of
// working / idle sessions and heavy jobs cost the container, and what does each kind of job peak at?

export type Sample = {
  t: string;
  cg: { anonMiB: number; pids: number; cpuCores: number | null; psiMemFull10?: number };
  sessions?: { state: string; rssMiB: number; thr: number }[];
  mix: { working: number; idle: number; heavy: number };
  gapSec?: number | null;
};

export type JobEvent = {
  kind?: string;
  t: string;
  class: string;
  wallSec: number;
  guard?: boolean;
  loadTest?: boolean; // matrix / edge runs: load-test peaks, not a real job's cost
  verdict?: string;
  peak: { dPids: number; dAnonMiB: number; pids: number; anonMiB: number };
};

export type Stat = { median: number; p95: number; max: number };

// cpuCores the sampler could really have measured. Before the sampler kept a fake cgroup's prev file apart
// (2026-11-07), a test run could make the next tick read thousands of cores; newer ticks write null instead.
export const MAX_PLAUSIBLE_CORES = 64;
export const plausibleCores = (c: number | null | undefined): c is number =>
  typeof c === 'number' && c >= 0 && c <= MAX_PLAUSIBLE_CORES;

// Nearest-rank percentile of xs (0 for none).
export function pct(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
}

export function stat(xs: number[]): Stat {
  if (xs.length === 0) return { median: 0, p95: 0, max: 0 };
  // no Math.max(...xs): a week of idle-session samples (~120k) overflows the argument limit
  return { median: pct(xs, 0.5), p95: pct(xs, 0.95), max: pct(xs, 1) };
}

export type MixRow = { mix: string; ticks: number; anonMiB: Stat; pids: Stat; cores: Stat };
export type JobRow = {
  class: string;
  runs: number;
  dAnonMiB: Stat;
  dPids: Stat;
  wallSec: Stat;
  notClean: number;
};

export type Report = {
  from: string | null;
  to: string | null;
  ticks: number;
  gaps: number;
  mixes: MixRow[];
  idleSession: { rssMiB: Stat; thr: Stat; samples: number };
  perSessionAnonMiB: number | null; // regression slope of anon on session count, heavy-free ticks
  jobs: JobRow[];
  barriers: Barriers;
};

// A hold by the test cap or the hard line (lease.sh `_heavy_event`, the guard's `denied`).
export type BarrierEvent = {
  kind: 'lease';
  lease: 'heavy';
  t: string;
  action: 'waited' | 'gaveUp' | 'denied' | 'wouldWait' | 'lockBusy';
  pid?: number;
  name?: string | null;
  class: string;
  reason?: 'cap' | 'hard' | 'lock';
  waitedSec?: number;
  holders?: { name?: string | null; label?: string; class: string }[];
  mix?: Sample['mix'] | null;
  loadTest?: boolean;
};

export type Count = { key: string; n: number };

// How limiting the cap is. blocks = waited + gaveUp + denied, except that a guard deny followed within
// RERUN_SEC by the same session's held heavy.sh re-run of the same class is ONE block (the user's rule).
export type Barriers = {
  days: number;
  blocks: number;
  perDay: number;
  waited: number;
  gaveUp: number;
  denied: number;
  merged: number; // deny + re-run pairs counted once
  wouldWait: number; // enforce off: what the cap / hard line would have held
  lockBusy: number; // ran without a slot because the board lock stayed busy (fail-open) — not a block
  waitSec: { total: number; p50: number; p90: number; max: number };
  byReason: Count[];
  byClass: Count[];
  byMix: Count[];
  byHolder: Count[];
  byBlocked: Count[];
};

const mixKey = (m: Sample['mix']) => `${m.working}w ${m.idle}i ${m.heavy}h`;

export const RERUN_SEC = 120;

const counts = (keys: string[]): Count[] => {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m.entries()]
    .map(([key, n]) => ({ key, n }))
    .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
};

export function barriers(events: unknown[], since: Date, now: Date): Barriers {
  const all = (events as BarrierEvent[])
    .filter(
      (e) =>
        e?.kind === 'lease' &&
        e.lease === 'heavy' &&
        !e.loadTest &&
        Date.parse(e.t) >= since.getTime(),
    )
    .sort((a, b) => a.t.localeCompare(b.t));
  const of = (a: BarrierEvent['action']) => all.filter((e) => e.action === a);
  // pid 0 = no claude ancestor found: unknown, so fall back to the name rather than merge strangers
  const who = (e: BarrierEvent) => (e.pid ? String(e.pid) : (e.name ?? '?'));
  // A held run's event is written when the wait ends; it started waitedSec earlier.
  const began = (e: BarrierEvent) => Date.parse(e.t) - (e.waitedSec ?? 0) * 1000;
  const denies = of('denied');
  const used = new Set<BarrierEvent>();
  let merged = 0;
  for (const h of all.filter((e) => e.action === 'waited' || e.action === 'gaveUp')) {
    const d = denies.find(
      (x) =>
        !used.has(x) &&
        who(x) === who(h) &&
        x.class === h.class &&
        began(h) - Date.parse(x.t) >= 0 &&
        began(h) - Date.parse(x.t) <= RERUN_SEC * 1000,
    );
    if (!d) continue;
    used.add(d);
    merged++;
  }
  // The breakdowns count blocks, so they add up to the headline: a merged deny is folded into its re-run.
  const blocking = all.filter(
    (e) =>
      (e.action === 'waited' || e.action === 'gaveUp' || e.action === 'denied') && !used.has(e),
  );
  const blocks = blocking.length;
  const span = Math.max(1 / 24, (now.getTime() - since.getTime()) / 86400_000); // the real window, in days
  const days = Math.round(span * 10) / 10;
  const waits = all
    .filter((e) => e.action === 'waited' || e.action === 'gaveUp')
    .map((e) => e.waitedSec ?? 0);
  return {
    days,
    blocks,
    perDay: Math.round((blocks / span) * 10) / 10,
    waited: of('waited').length,
    gaveUp: of('gaveUp').length,
    denied: denies.length,
    merged,
    wouldWait: of('wouldWait').length,
    lockBusy: of('lockBusy').length,
    waitSec: {
      total: waits.reduce((a, b) => a + b, 0),
      p50: pct(waits, 0.5),
      p90: pct(waits, 0.9),
      max: pct(waits, 1),
    },
    byReason: counts(blocking.map((e) => e.reason ?? 'hard')),
    byClass: counts(blocking.map((e) => e.class)),
    byMix: counts(blocking.flatMap((e) => (e.mix ? [mixKey(e.mix)] : []))),
    byHolder: counts(
      blocking.flatMap((e) => (e.holders ?? []).map((h) => h.name ?? h.label ?? '?')),
    ),
    byBlocked: counts(blocking.map((e) => e.name ?? who(e))),
  };
}

export function formatBarriers(b: Barriers): string {
  const would =
    (b.wouldWait ? ` · would have held ${b.wouldWait}× (enforce off)` : '') +
    (b.lockBusy ? ` · ${b.lockBusy}× ran unslotted (board lock busy)` : '');
  if (b.blocks === 0) return `barriers (${b.days} d): none${would}`;
  const reasons = b.byReason.map((r) => `${r.key} ${r.n}`).join(' / ');
  return (
    `barriers (${b.days} d): ${b.blocks} block${b.blocks === 1 ? '' : 's'} (${b.perDay}/day) · ${b.waited} waited · ` +
    `${b.gaveUp} gave up · ${b.denied} denied${b.merged ? ` (${b.merged} re-run, counted once)` : ''} · ` +
    `waited ${b.waitSec.total} s total, p50 ${b.waitSec.p50} s, p90 ${b.waitSec.p90} s · ${reasons}${would}`
  );
}

export function rollup(
  samples: Sample[],
  events: JobEvent[],
  since: Date,
  now = new Date(),
): Report {
  const s = samples
    .filter((x) => Date.parse(x.t) >= since.getTime())
    .sort((a, b) => a.t.localeCompare(b.t));
  const groups = new Map<string, Sample[]>();
  for (const x of s) {
    const k = mixKey(x.mix);
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  const mixes = [...groups.entries()]
    .map(([mix, xs]) => ({
      mix,
      ticks: xs.length,
      anonMiB: stat(xs.map((x) => x.cg.anonMiB)),
      pids: stat(xs.map((x) => x.cg.pids)),
      cores: stat(xs.map((x) => x.cg.cpuCores).filter(plausibleCores)),
    }))
    .sort((a, b) => b.ticks - a.ticks);

  const idle = s.flatMap((x) => (x.sessions ?? []).filter((y) => y.state === 'idle'));

  const jobsBy = new Map<string, JobEvent[]>();
  for (const e of events) {
    if ((e.kind && e.kind !== 'job') || e.guard || e.loadTest || Date.parse(e.t) < since.getTime())
      continue;
    jobsBy.set(e.class, [...(jobsBy.get(e.class) ?? []), e]);
  }
  const jobs = [...jobsBy.entries()]
    .map(([cls, xs]) => ({
      class: cls,
      runs: xs.length,
      dAnonMiB: stat(xs.map((x) => x.peak.dAnonMiB)),
      dPids: stat(xs.map((x) => x.peak.dPids)),
      wallSec: stat(xs.map((x) => x.wallSec)),
      notClean: xs.filter((x) => x.verdict && x.verdict !== 'clean').length,
    }))
    .sort((a, b) => b.runs - a.runs);

  const quiet = s.filter((x) => x.mix.heavy === 0);
  return {
    from: s[0]?.t ?? null,
    to: s[s.length - 1]?.t ?? null,
    ticks: s.length,
    gaps: s.filter((x) => x.gapSec).length,
    mixes,
    idleSession: {
      rssMiB: stat(idle.map((x) => x.rssMiB)),
      thr: stat(idle.map((x) => x.thr)),
      samples: idle.length,
    },
    perSessionAnonMiB: slope(
      quiet.map((x) => x.mix.working + x.mix.idle),
      quiet.map((x) => x.cg.anonMiB),
    ),
    jobs,
    barriers: barriers(events, since, now),
  };
}

// Least-squares slope; null when x never varies (one session count only — nothing to learn yet).
export function slope(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i]! - mx) ** 2;
    sxy += (xs[i]! - mx) * (ys[i]! - my);
  }
  return sxx === 0 ? null : Math.round(sxy / sxx);
}

const fmt = (x: Stat, unit = '') => `${x.median}${unit} / ${x.p95}${unit} / ${x.max}${unit}`;

export function formatReport(r: Report): string {
  const out = [
    `Board history ${r.from ?? '—'} → ${r.to ?? '—'}: ${r.ticks} ticks${r.gaps ? `, ${r.gaps} gaps (container frozen / VM asleep)` : ''}`,
    '',
    'By mix (w working · i idle · h heavy jobs) — median / p95 / max:',
    ...r.mixes.map(
      (m) =>
        `  ${m.mix.padEnd(11)} ${String(m.ticks).padStart(5)} ticks · anon ${fmt(m.anonMiB, ' MiB')} · pids ${fmt(m.pids)} · cores ${fmt(m.cores)}`,
    ),
    '',
    `Idle session: ${fmt(r.idleSession.rssMiB, ' MiB')} RSS, ${fmt(r.idleSession.thr)} threads (${r.idleSession.samples} samples)` +
      (r.perSessionAnonMiB === null
        ? ''
        : ` · each extra session adds ~${r.perSessionAnonMiB} MiB anon (heavy-free ticks)`),
    '',
    'Jobs (heavy.sh, not load-test runs) — Δ from start, median / p95 / max:',
    ...r.jobs.map(
      (j) =>
        `  ${j.class.padEnd(10)} ${String(j.runs).padStart(4)} runs · Δanon ${fmt(j.dAnonMiB, ' MiB')} · Δpids ${fmt(j.dPids)} · wall ${fmt(j.wallSec, 's')}${j.notClean ? ` · ${j.notClean} not clean` : ''}`,
    ),
    '',
    'Barriers (test cap / hard-line holds; blocks = waited + gave up + denied, a deny and its re-run once):',
    `  ${formatBarriers(r.barriers)}`,
    ...(r.barriers.blocks
      ? [
          `  by mix: ${r.barriers.byMix.map((c) => `${c.key} ×${c.n}`).join(', ') || '—'}`,
          `  held by: ${r.barriers.byHolder.map((c) => `${c.key} ×${c.n}`).join(', ') || '—'}`,
          `  blocked: ${r.barriers.byBlocked.map((c) => `${c.key} ×${c.n}`).join(', ') || '—'}`,
        ]
      : []),
  ];
  return out.join('\n');
}
