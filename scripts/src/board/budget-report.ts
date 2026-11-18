// `cli.ts budget-report`: what the log-only budget would have decided over a window, against what the live rules did,
// and whether CPU pressure crossed the pace line around those moments (docs/ops/SESSION-BOARD.md → Budget). Pure.
import type { Sample } from './rollup.ts';

// After a job admission, the samples within this window are the job's start; after a lane start, its first minutes.
export const JOB_PSI_SEC = 120;
export const LANE_PSI_SEC = 600;

type Ev = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type PsiSample = Sample & { cg: Sample['cg'] & { psiCpuSome10?: number } };

const inWindow = (t: unknown, since: number, until: number) => {
  const x = typeof t === 'string' ? Date.parse(t) : NaN;
  return x >= since && x <= until;
};

export type BudgetReport = {
  since: string;
  until: string;
  psiLine: number;
  jobs: {
    seen: number;
    byUnit: Record<string, { n: number; wouldWait: number }>;
    // would × actual: the live rules hold at the hard line or a full cap; the budget at its units
    cross: { waitWait: number; waitRan: number; admitWait: number; admitRan: number };
    psi: { wouldWait: { n: number; crossed: number }; wouldAdmit: { n: number; crossed: number } };
    lightUnknown: number; // admissions with no fresh sample (light lanes counted 0)
    unseen: { branch: string; jobs: number }[]; // job runs from branches that logged no budget event (older worktrees)
  };
  lanes: {
    seen: number;
    refusedWouldAdmit: string[]; // the cap refused; the budget would have let it start
    ranWouldRefuse: { branch: string; why: string[] }[];
    psi: { n: number; crossed: number };
  };
  k: { byWhy: Record<string, number>; wouldWaitAtK1: number };
};

// The highest CPU PSI in [t, t + sec] (null with no sample there).
function psiAfter(samples: PsiSample[], t: number, sec: number): number | null {
  let max: number | null = null;
  for (const s of samples) {
    const x = Date.parse(s.t);
    if (x < t || x > t + sec * 1000) continue;
    const p = s.cg?.psiCpuSome10;
    if (typeof p === 'number' && (max === null || p > max)) max = p;
  }
  return max;
}

export function budgetReport(
  events: unknown[],
  samples: Sample[],
  since: Date,
  now: Date,
  psiLine = 40,
): BudgetReport {
  const lo = since.getTime();
  const hi = now.getTime();
  const evs = (events as Ev[]).filter((e) => e && inWindow(e.t, lo, hi));
  const ss = (samples as PsiSample[])
    .filter((s) => s && inWindow(s.t, lo, hi + LANE_PSI_SEC * 1000))
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const jobs = evs.filter((e) => e.kind === 'budget' && e.scope === 'job' && !e.loadTest);
  const lanes = evs.filter((e) => e.kind === 'budget' && e.scope === 'lane');

  const byUnit: BudgetReport['jobs']['byUnit'] = {};
  const cross = { waitWait: 0, waitRan: 0, admitWait: 0, admitRan: 0 };
  const psi = { wouldWait: { n: 0, crossed: 0 }, wouldAdmit: { n: 0, crossed: 0 } };
  const byWhy: Record<string, number> = {};
  let lightUnknown = 0;
  let atK1 = 0;
  for (const e of jobs) {
    const as = String(e.unit?.as ?? '?');
    const u = (byUnit[as] ??= { n: 0, wouldWait: 0 });
    u.n++;
    const wait = e.would === 'wait';
    if (wait) u.wouldWait++;
    const held = !!e.actual?.wait;
    cross[wait ? (held ? 'waitWait' : 'waitRan') : held ? 'admitWait' : 'admitRan']++;
    const p = psiAfter(ss, Date.parse(e.t), JOB_PSI_SEC);
    if (p !== null) {
      const g = wait ? psi.wouldWait : psi.wouldAdmit;
      g.n++;
      if (p >= psiLine) g.crossed++;
    }
    if (e.committed?.lightKnown === false) lightUnknown++;
    byWhy[String(e.kWhy ?? '?')] = (byWhy[String(e.kWhy ?? '?')] ?? 0) + 1;
    const total = Number(e.committed?.total);
    const units = Number(e.unit?.units);
    const limit = Number(e.limit);
    if ([total, units, limit].every(Number.isFinite) && total + units > limit + 1e-9) atK1++;
  }

  // Coverage: a branch running slotted jobs with no budget event is a worktree older than the budget's merge.
  // both sides keyed as a job event names its session: the branch, else the session name (the hub on detached main)
  const key = (e: Ev) => String(e.branch || e.name || '?');
  const logged = new Set(jobs.map(key));
  const unseenMap = new Map<string, number>();
  for (const e of evs) {
    if (e.kind !== 'job' || e.loadTest || e.class === 'test-file' || e.class === 'other') continue;
    if (/^gate-(typecheck|lint|test)/.test(String(e.class))) continue; // steps inside a gate's one slot
    const b = key(e);
    if (!logged.has(b)) unseenMap.set(b, (unseenMap.get(b) ?? 0) + 1);
  }

  const refusedWouldAdmit: string[] = [];
  const ranWouldRefuse: { branch: string; why: string[] }[] = [];
  const lanePsi = { n: 0, crossed: 0 };
  for (const e of lanes) {
    const refused = e.actual?.capResult === 'refused' || e.actual?.pace === 'blocked';
    if (refused && e.would === 'admit') refusedWouldAdmit.push(String(e.branch));
    if (!refused && e.would === 'refuse')
      ranWouldRefuse.push({ branch: String(e.branch), why: e.wouldWhy ?? [] });
    if (refused) continue;
    const p = psiAfter(ss, Date.parse(e.t), LANE_PSI_SEC);
    if (p === null) continue;
    lanePsi.n++;
    if (p >= psiLine) lanePsi.crossed++;
  }

  return {
    since: since.toISOString(),
    until: now.toISOString(),
    psiLine,
    jobs: {
      seen: jobs.length,
      byUnit,
      cross,
      psi,
      lightUnknown,
      unseen: [...unseenMap]
        .map(([branch, n]) => ({ branch, jobs: n }))
        .sort((a, b) => b.jobs - a.jobs),
    },
    lanes: { seen: lanes.length, refusedWouldAdmit, ranWouldRefuse, psi: lanePsi },
    k: { byWhy, wouldWaitAtK1: atK1 },
  };
}

const pct = (a: number, n: number) => (n ? `${Math.round((a / n) * 100)}%` : '-');

export function formatBudgetReport(r: BudgetReport): string {
  const j = r.jobs;
  const units = Object.entries(j.byUnit)
    .sort((a, b) => b[1].n - a[1].n)
    .map(([k, v]) => `${k} ${v.n}${v.wouldWait ? ` (${v.wouldWait} would wait)` : ''}`)
    .join(', ');
  const why = Object.entries(r.k.byWhy)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  const out = [
    `budget report ${r.since.slice(0, 16)}Z → ${r.until.slice(0, 16)}Z (log-only; PSI line ${r.psiLine})`,
    `jobs: ${j.seen} admissions logged${units ? ` — ${units}` : ''}`,
    `  would wait: ${j.cross.waitWait + j.cross.waitRan} (live rules held ${j.cross.waitWait}, ran ${j.cross.waitRan}) · would admit: ${j.cross.admitWait + j.cross.admitRan} (live rules held ${j.cross.admitWait})`,
    `  CPU PSI ≥ ${r.psiLine} within ${JOB_PSI_SEC} s: would-wait ${j.psi.wouldWait.crossed}/${j.psi.wouldWait.n} (${pct(j.psi.wouldWait.crossed, j.psi.wouldWait.n)}) · would-admit ${j.psi.wouldAdmit.crossed}/${j.psi.wouldAdmit.n} (${pct(j.psi.wouldAdmit.crossed, j.psi.wouldAdmit.n)})`,
    `  k: ${why || 'none'}; at k 1 would wait ${r.k.wouldWaitAtK1}${j.lightUnknown ? ` · ${j.lightUnknown} with no fresh sample (light lanes counted 0)` : ''}`,
    `lanes: ${r.lanes.seen} starts logged · refused by the cap or pace, budget would admit: ${r.lanes.refusedWouldAdmit.length ? r.lanes.refusedWouldAdmit.join(', ') : 'none'}`,
    `  started, budget would refuse: ${r.lanes.ranWouldRefuse.length ? r.lanes.ranWouldRefuse.map((x) => `${x.branch} (${x.why.join('+')})`).join(', ') : 'none'}`,
    `  CPU PSI ≥ ${r.psiLine} within ${LANE_PSI_SEC / 60} min of a start: ${r.lanes.psi.crossed}/${r.lanes.psi.n}`,
  ];
  if (j.unseen.length)
    out.push(
      `not seen (worktrees older than the budget): ${j.unseen.map((u) => `${u.branch} ${u.jobs}`).join(', ')}`,
    );
  return out.join('\n');
}
