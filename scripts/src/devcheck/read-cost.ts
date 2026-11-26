// @aperture/scripts — the dev check's read-cost reader (docs/ops/DEV-CHECK.md → Read cost). Joins the dev slots'
// `ddb_units` lines and Lambda REPORT lines (fetched with `pnpm bot logs`) to a devcheck report's step windows, and
// prints units and Lambda ms per phase, scenario, step, op and access. Pure: the CLI (read-cost-cli.ts) does the I/O.
// Plain `node`: erasable syntax, node: builtins only.
import type { RunPhases, RunResult, StepResult } from './report.ts';

export const FETCH_CAP = 20_000; // fetch-dev-logs.mjs's MAX_EVENTS: a file this long was cut off
export const EDGE_MS = 250; // a request this close to a step boundary may belong to either side

export type Entry = [access: string, calls: number, units: number, items: number, dead: number];
export interface UnitsLine {
  event: 'ddb_units';
  v: 1;
  edge: 'bff' | 'mcp';
  op: string;
  status: number | 'threw';
  at: number;
  ms: number;
  ru: number;
  wu: number;
  n: number;
  by: Entry[];
}
export interface Req extends UnitsLine {
  reqId: string;
  durationMs?: number; // the REPORT line's Duration
}

export interface Parsed {
  reqs: Req[]; // one per request id with a units line
  reports: Map<string, number>; // request id → Duration ms, every REPORT line
  reportAt: Map<string, number>; // request id → the REPORT line's own time (epoch ms)
  malformed: number; // a line naming ddb_units that didn't parse
  duplicates: number; // the same request id seen again (overlapping fetches)
}

// A fetched line: `<iso> <stream> <message>`; the Node runtime's message is `<iso>\t<request id>\t<LEVEL>\t<text>`.
const LINE = /^(\S+) (\S+) (.*)$/;
const REPORT = /^REPORT RequestId: (\S+)\s+Duration: ([\d.]+) ms/;

export function parseLogs(texts: string[]): Parsed {
  const out: Parsed = {
    reqs: [],
    reports: new Map(),
    reportAt: new Map(),
    malformed: 0,
    duplicates: 0,
  };
  const seen = new Set<string>();
  for (const text of texts)
    for (const raw of text.split('\n')) {
      const m = LINE.exec(raw);
      if (!m) {
        if (raw.includes('"ddb_units"')) out.malformed++; // never vanishes uncounted
        continue;
      }
      const msg = m[3]!;
      const rep = REPORT.exec(msg);
      if (rep) {
        out.reports.set(rep[1]!, Number(rep[2]));
        out.reportAt.set(rep[1]!, Date.parse(m[1]!));
        continue;
      }
      if (!msg.includes('"ddb_units"')) continue;
      const parts = msg.split('\t');
      const reqId = parts[1] ?? '';
      try {
        const line = JSON.parse(msg.slice(msg.indexOf('{'))) as UnitsLine;
        const nums = [line.at, line.ru, line.wu, line.n, line.ms];
        if (line.event !== 'ddb_units' || line.v !== 1 || nums.some((x) => typeof x !== 'number'))
          throw new Error('shape');
        if (!Array.isArray(line.by) || line.by.some((e) => !Array.isArray(e) || e.length !== 5))
          throw new Error('shape');
        const key = reqId || `${line.edge}:${line.at}:${line.op}`;
        if (seen.has(key)) {
          out.duplicates++;
          continue;
        }
        seen.add(key);
        out.reqs.push({ ...line, reqId: key });
      } catch {
        out.malformed++;
      }
    }
  for (const r of out.reqs) {
    const d = out.reports.get(r.reqId);
    if (d !== undefined) r.durationMs = d;
  }
  return out;
}

export interface Window {
  label: string; // a phase name, or `<scenario>/<step>`
  scenario?: string;
  step?: StepResult;
  from: number;
  to: number;
}

const PHASES: (keyof RunPhases)[] = ['deployWaitMs', 'openMs', 'setupMs', 'stepsMs', 'cleanupMs'];
const phaseName = (k: keyof RunPhases) => k.replace(/Ms$/, '');

// The run's contiguous windows: deployWait, open, setup, each step that ran (to the next one's start), cleanup.
export function windows(r: RunResult): Window[] {
  if (r.startedAt === undefined || !r.phases)
    throw new Error('report has no startedAt/phases: a run before the stamps');
  const ran = r.steps.filter((s) => s.at !== undefined).sort((a, b) => a.at! - b.at!);
  if (!ran.length && r.steps.some((s) => s.status === 'pass' || s.status === 'fail'))
    throw new Error('report steps carry no `at`: a run before the stamps');
  const out: Window[] = [];
  let t = r.startedAt;
  for (const k of PHASES) {
    const end = t + r.phases[k];
    if (k === 'stepsMs') {
      if (ran.length && ran[0]!.at! > t) out.push({ label: 'steps-gap', from: t, to: ran[0]!.at! });
      ran.forEach((s, i) =>
        out.push({
          label: `${s.scenario}/${s.step}`,
          scenario: s.scenario,
          step: s,
          from: s.at!,
          to: i + 1 < ran.length ? ran[i + 1]!.at! : end,
        }),
      );
      if (!ran.length) out.push({ label: 'steps', from: t, to: end });
    } else out.push({ label: phaseName(k), from: t, to: end });
    t = end;
  }
  return out;
}

export interface Bucket {
  label: string;
  reqs: number;
  ru: number;
  wu: number;
  calls: number;
  lambdaMs: number; // REPORT Duration, else the handler's own ms
  harnessMs?: number;
}
const bucket = (label: string): Bucket => ({ label, reqs: 0, ru: 0, wu: 0, calls: 0, lambdaMs: 0 });
const add = (b: Bucket, r: Req) => {
  b.reqs++;
  b.ru += r.ru;
  b.wu += r.wu;
  b.calls += r.n;
  b.lambdaMs += r.durationMs ?? r.ms;
};

export interface Analysis {
  runId: string;
  totals: Bucket;
  before: number; // requests before the run's start (another run, the poller's page) — not in the totals
  after: number;
  nearEdge: number;
  unitsWithoutReport: number;
  reportsWithoutUnits: number; // REPORT lines stamped inside the run: a timeout, or an unmetered build
  malformed: number;
  duplicates: number;
  phases: Bucket[];
  scenarios: Bucket[];
  steps: Bucket[];
  ops: (Bucket & { items: number })[];
  top: (Req & { where: string })[];
  access: { access: string; calls: number; units: number; items: number; dead: number }[];
}

// Refused: two users in one report. Parallel lanes share one window; a serial run's iPhone lane goes first, its
// steps before the browser lane's startedAt and its deploy wait in the merged phases, so its windows are wrong.
export function oneUser(r: RunResult): void {
  if (r.lanes?.mode === 'parallel')
    throw new Error('a parallel two-lane run: step windows overlap, read it per run');
  if (r.lanes?.iphoneMs !== undefined)
    throw new Error(
      "a two-user run (an iPhone lane ran): the merged report keeps one lane's windows",
    );
  if (r.startedAt !== undefined && r.steps.some((s) => s.at !== undefined && s.at < r.startedAt!))
    throw new Error("a step started before the run did: another lane's steps are in this report");
}

export function analyse(r: RunResult, p: Parsed): Analysis {
  oneUser(r);
  const ws = windows(r);
  const start = ws[0]!.from;
  const end = ws[ws.length - 1]!.to;
  const phases = new Map<string, Bucket>();
  const scenarios = new Map<string, Bucket>();
  const steps = new Map<string, Bucket>();
  const ops = new Map<string, Bucket & { items: number }>();
  const access = new Map<
    string,
    { access: string; calls: number; units: number; items: number; dead: number }
  >();
  const totals = bucket('run');
  let before = 0;
  let after = 0;
  let nearEdge = 0;
  const top: (Req & { where: string })[] = [];
  for (const q of [...p.reqs].sort((a, b) => a.at - b.at)) {
    if (q.at < start) {
      before++;
      continue;
    }
    if (q.at >= end) {
      after++;
      continue;
    }
    const w = ws.find((x) => q.at >= x.from && q.at < x.to)!;
    // Its own window's inner edges: a clock skew this size would move it to the neighbour.
    if ((w.from !== start && q.at - w.from < EDGE_MS) || (w.to !== end && w.to - q.at < EDGE_MS))
      nearEdge++;
    add(totals, q);
    const phase = w.step ? 'steps' : w.label;
    if (!phases.has(phase)) phases.set(phase, bucket(phase));
    add(phases.get(phase)!, q);
    if (w.step) {
      if (!scenarios.has(w.scenario!)) scenarios.set(w.scenario!, bucket(w.scenario!));
      add(scenarios.get(w.scenario!)!, q);
      if (!steps.has(w.label)) steps.set(w.label, { ...bucket(w.label), harnessMs: w.step.ms });
      add(steps.get(w.label)!, q);
    }
    const opKey = `${q.edge}:${q.op}`;
    if (!ops.has(opKey)) ops.set(opKey, { ...bucket(opKey), items: 0 });
    const o = ops.get(opKey)!;
    add(o, q);
    for (const [a, calls, units, items, dead] of q.by) {
      o.items += items;
      const e = access.get(a) ?? { access: a, calls: 0, units: 0, items: 0, dead: 0 };
      e.calls += calls;
      e.units += units;
      e.items += items;
      e.dead += dead;
      access.set(a, e);
    }
    top.push({ ...q, where: w.label });
  }
  const inRun = new Set(p.reqs.filter((q) => q.at >= start && q.at < end).map((q) => q.reqId));
  const byRu = <T extends { ru: number }>(xs: Iterable<T>) => [...xs].sort((a, b) => b.ru - a.ru);
  // The run's order for phases and steps; the rest by units.
  const order = new Map(ws.map((w, i) => [w.label, i]));
  const hasUnits = new Set(p.reqs.map((q) => q.reqId));
  if (!totals.reqs)
    throw new Error(
      `no ddb_units line inside the run (${p.reqs.length} outside it): the wrong slot's --groups, a window that misses the run, or a build without the meter`,
    );
  const phaseOrder = ['deployWait', 'open', 'setup', 'steps-gap', 'steps', 'cleanup'];
  return {
    runId: r.runId,
    totals,
    before,
    after,
    nearEdge,
    unitsWithoutReport: [...inRun].filter((id) => !p.reports.has(id)).length,
    reportsWithoutUnits: [...p.reportAt].filter(
      ([id, at]) => at >= start && at < end && !hasUnits.has(id),
    ).length,
    malformed: p.malformed,
    duplicates: p.duplicates,
    phases: [...phases.values()].sort(
      (a, b) => phaseOrder.indexOf(a.label) - phaseOrder.indexOf(b.label),
    ),
    scenarios: byRu(scenarios.values()),
    steps: [...steps.values()].sort((a, b) => order.get(a.label)! - order.get(b.label)!),
    ops: byRu(ops.values()),
    top: byRu(top).slice(0, 10),
    access: [...access.values()].sort((a, b) => b.units - a.units),
  };
}

const n1 = (x: number) => (Math.round(x * 10) / 10).toLocaleString('en-US');
const per = (x: number, d: number) => (d ? n1(x / d) : '–');
const delta = (now: number, was: number | undefined) =>
  was === undefined
    ? ''
    : ` | ${was ? `${now >= was ? '+' : ''}${Math.round(((now - was) / was) * 100)}%` : 'new'}`;

function table(
  title: string,
  rows: Bucket[],
  was?: Bucket[],
  extra?: { head: string; cell: (b: Bucket) => string },
): string[] {
  const prev = new Map((was ?? []).map((b) => [b.label, b]));
  const d = was ? ' | ru before | Δ ru' : '';
  const out = [
    `### ${title}`,
    '',
    `| what | requests | read units | write units | calls | ru/request | Lambda ms${extra ? ` | ${extra.head}` : ''}${d} |`,
    `|---|--:|--:|--:|--:|--:|--:|${extra ? '--:|' : ''}${was ? '--:|--:|' : ''}`,
  ];
  for (const b of rows) {
    const p = prev.get(b.label);
    out.push(
      `| ${b.label} | ${b.reqs} | ${n1(b.ru)} | ${n1(b.wu)} | ${b.calls} | ${per(b.ru, b.reqs)} | ${Math.round(b.lambdaMs).toLocaleString('en-US')}${extra ? ` | ${extra.cell(b)}` : ''}${was ? ` | ${p ? n1(p.ru) : '–'}${delta(b.ru, p?.ru)}` : ''} |`,
    );
  }
  return [...out, ''];
}

// Steps that ran in one run only: their units sit in one total, so the totals compare different work.
function onlyOne(a: Analysis, was: Analysis): string[] {
  const now = new Set(a.steps.map((s) => s.label));
  const then = new Set(was.steps.map((s) => s.label));
  const gone = [...then].filter((l) => !now.has(l));
  const added = [...now].filter((l) => !then.has(l));
  if (!gone.length && !added.length) return ['- Same steps ran in both runs.'];
  return [
    `- **Steps in one run only** (the totals compare different work; read the per-step rows): before only ${gone.join(', ') || 'none'}; this run only ${added.join(', ') || 'none'}.`,
  ];
}

export function render(a: Analysis, was?: Analysis): string {
  const t = a.totals;
  const out = [
    `## Read cost — run \`${a.runId}\``,
    '',
    `- **${n1(t.ru)} read units**, ${n1(t.wu)} write units, ${t.calls} DynamoDB calls over ${t.reqs} requests; Lambda ${Math.round(t.lambdaMs).toLocaleString('en-US')} ms.` +
      (was
        ? ` Before (\`${was.runId}\`): ${n1(was.totals.ru)} read units, ${Math.round(was.totals.lambdaMs).toLocaleString('en-US')} ms${delta(t.ru, was.totals.ru).replace(' | ', ' → ')}.`
        : ''),
    `- Outside the run: ${a.before} before, ${a.after} after (not counted). Within ${EDGE_MS} ms of their window's edge (a clock skew that size would move them): ${a.nearEdge}.`,
    `- Joins: ${a.unitsWithoutReport} units lines with no REPORT line, ${a.reportsWithoutUnits} REPORT lines with no units line (a timeout, or an unmetered build). ${a.malformed} malformed, ${a.duplicates} duplicates dropped.`,
    ...(was ? onlyOne(a, was) : []),
    '',
    ...table('Phases', a.phases, was?.phases),
    ...table('Scenarios', a.scenarios, was?.scenarios),
    ...table('Steps (run order)', a.steps, was?.steps, {
      head: 'harness ms',
      cell: (b) => (b.harnessMs === undefined ? '–' : b.harnessMs.toLocaleString('en-US')),
    }),
    ...table('Ops', a.ops, was?.ops, {
      head: 'items/request',
      cell: (b) => per((b as Bucket & { items: number }).items, b.reqs),
    }),
    '### Top 10 requests',
    '',
    '| op | where | read units | calls | top access |',
    '|---|---|--:|--:|---|',
    ...a.top.map(
      (q) =>
        `| ${q.edge}:${q.op} | ${q.where} | ${n1(q.ru)} | ${q.n} | ${q.by[0] ? `${q.by[0][0]} ×${q.by[0][1]}, ${n1(q.by[0][2])} units, ${q.by[0][3]} items` : '–'} |`,
    ),
    '',
    '### By access (verb, `c` consistent, key kind)',
    '',
    '| access | calls | units | items | dead | dead share | units/call |',
    '|---|--:|--:|--:|--:|--:|--:|',
    ...a.access.map(
      (e) =>
        `| ${e.access} | ${e.calls} | ${n1(e.units)} | ${e.items} | ${e.dead} | ${e.items ? `${Math.round((e.dead / e.items) * 100)}%` : '–'} | ${per(e.units, e.calls)} |`,
    ),
    '',
  ];
  return out.join('\n');
}

// A fetched file at the cap was cut off: refuse it rather than sum part of a run.
export function checkCap(name: string, text: string): void {
  const lines = text.split('\n').filter(Boolean).length;
  if (lines >= FETCH_CAP)
    throw new Error(`${name}: ${lines} lines, at the fetch cap — narrow the window and refetch`);
  if (text.startsWith('(fetch failed')) throw new Error(`${name}: ${text.trim()}`);
}

// The run's fetch window (one minute before its start, two after its end) and the slot's groups, from report.json.
export function fetchLines(r: RunResult): string[] {
  if (r.startedAt === undefined || !r.phases) throw new Error('report has no startedAt/phases');
  const end = r.startedAt + PHASES.reduce((t, k) => t + r.phases![k], 0);
  const slot = (r.target ?? '').split(' ')[0];
  const groups = slot === 'devb' ? 'bff-devb,mcp-devb' : 'bff,mcp';
  const span = `--groups ${groups} --start ${new Date(r.startedAt - 60_000).toISOString()} --end ${new Date(end + 120_000).toISOString()}`;
  return [`pnpm bot logs ${span} --filter '%ddb_units%'`, `pnpm bot logs ${span} --filter REPORT`];
}
