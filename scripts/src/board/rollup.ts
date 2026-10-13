// Usage report from the board history (docs/ops/SESSION-BOARD.md → History): what does a given mix of
// working / idle sessions and heavy jobs cost the container, and what does each kind of job peak at?

export type Sample = {
  t: string;
  cg: { anonMiB: number; pids: number; cpuCores: number; psiMemFull10?: number };
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
  verdict?: string;
  peak: { dPids: number; dAnonMiB: number; pids: number; anonMiB: number };
};

export type Stat = { median: number; p95: number; max: number };

export function stat(xs: number[]): Stat {
  if (xs.length === 0) return { median: 0, p95: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
  return { median: at(0.5), p95: at(0.95), max: s[s.length - 1]! };
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
};

const mixKey = (m: Sample['mix']) => `${m.working}w ${m.idle}i ${m.heavy}h`;

export function rollup(samples: Sample[], events: JobEvent[], since: Date): Report {
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
      cores: stat(xs.map((x) => x.cg.cpuCores)),
    }))
    .sort((a, b) => b.ticks - a.ticks);

  const idle = s.flatMap((x) => (x.sessions ?? []).filter((y) => y.state === 'idle'));

  const jobsBy = new Map<string, JobEvent[]>();
  for (const e of events) {
    if ((e.kind && e.kind !== 'job') || e.guard || Date.parse(e.t) < since.getTime()) continue;
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
  ];
  return out.join('\n');
}
