// The report's text: the same lines go to the terminal and to <usage dir>/report-<day>.md.
import type { FitModel } from './model.ts';

export const f1 = (x: number | null | undefined, d = 1) =>
  x === null || x === undefined || !Number.isFinite(x) ? '–' : x.toFixed(d);
const perPt = (k: number | null | undefined) => (k && k > 0 ? 1 / k : null);
const clock = (ms: number | null) =>
  ms === null
    ? '–'
    : new Date(ms).toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });

export function fitLines(m: FitModel): string[] {
  const out: string[] = ['## k: meter % per QU (1 QU = $1 at API list prices)', ''];
  const a = m.all;
  if (!a.fit) {
    out.push('Not enough data: no interval of 3+ points inside the calls table yet.', '');
  } else {
    const u = a.unc;
    out.push(
      `- **k = ${f1(a.fit.k, 4)} %/QU** (≈ ${f1(perPt(a.fit.k))} QU per point), λ = ${f1(a.fit.lambda, 2)} %/h${a.fit.lambdaFixed ? ' (held at 0: too few intervals or ΔQU and Δt move together)' : ''}, from ${a.fit.n} intervals.`,
      `- ${u?.method === 'bootstrap' ? 'Bootstrap' : u?.method === 'leave-one-out' ? 'Leave-one-out range' : 'No interval'}: k 80% ${f1(u?.k80?.lo, 4)}–${f1(u?.k80?.hi, 4)}, 95% ${f1(u?.k95?.lo, 4)}–${f1(u?.k95?.hi, 4)}.`,
      `- With λ = 0 (all movement charged to agent work, the upper bound): k = ${f1(a.kOnly?.k, 4)} (≈ ${f1(perPt(a.kOnly?.k))} QU per point).`,
    );
    if (m.inferredResets.length)
      out.push(
        `- Weekly resets inferred from resets_at and split on: ${m.inferredResets.map((r) => clock(Date.parse(r))).join(', ')} (PT).`,
      );
    const h = m.history;
    if (h.fit)
      out.push(
        `- History only (manual readings, ${h.fit.n} intervals): k = ${f1(h.fit.k, 4)}, λ = ${f1(h.fit.lambda, 2)}.`,
      );
    const ho = m.live.holdout;
    if (ho)
      out.push(
        `- Held-out live ticks (${ho.n} intervals): the history fit predicted ${f1(ho.predicted)} points, actual ${f1(ho.actual)}; MAE ${f1(ho.mae, 2)} points per interval.`,
      );
    if (m.live.logRatio !== null)
      out.push(
        `- Calls table vs the status line's own cost over the live ticks: ${f1(m.live.logRatio, 2)}× (1.0 = additive; over 1 means the status line leaves something out, e.g. subagents).`,
      );
    out.push('');
    out.push('| Interval | ΔP | ΔQU | Δt h | QU/pt | Source |', '|---|---|---|---|---|---|');
    for (const o of [...m.history.obs, ...m.live.obs])
      out.push(
        `| ${clock(o.t0)} → ${clock(o.t1)} | ${o.dP} | ${f1(o.dQU)} | ${f1(o.dT, 2)} | ${f1(o.dQU / o.dP)} | ${o.src} |`,
      );
    out.push('');
  }
  const b = m.burn;
  out.push(
    '## Burn now',
    '',
    `- Meter ${b.pct ?? '–'}% · ${f1(b.pctPerHour, 2)} %/h · ${f1(b.quPerHour)} QU in the last hour · ~${f1(b.hoursTo100)} h to 100%.`,
    `- Calls table covers ${clock(m.coverage.from)} → ${clock(m.coverage.to)} (PT); ${m.live.windows} meter window(s) in the log, ${m.live.stragglers} stale readings ignored.`,
    '',
  );
  return out;
}

// One line for a status bar or the tower.
export function boardLine(m: FitModel): string {
  const b = m.burn;
  if (b.pct === null) return 'usage –';
  const parts = [`usage ${b.pct}%`];
  if (b.pctPerHour) parts.push(`${f1(b.pctPerHour)}%/h`);
  if (b.hoursTo100 !== null) parts.push(`~${f1(b.hoursTo100)} h to 100%`);
  return parts.join(' · ');
}
