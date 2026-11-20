// Lane status files (docs/ops/TOWER.md → Lane files): each feature session writes
// <boardDir>/lanes/<branch>.json at its hub checkpoints and phase changes, with `pnpm board lane <phase> …`.
// The web tower derives NOW and NEEDS YOU from them; locks, PRs and runs stay the truth for state.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clean, hhmm, parseTime } from './fmt.ts';

export const PHASES = [
  'plan',
  'build',
  'gate',
  'review',
  'local',
  'dev',
  'pr',
  'merged',
  'cleanup',
  'parked',
  'blocked',
] as const;
export type Phase = (typeof PHASES)[number];
// Names lanes write that aren't phases: FEATURE-WORKFLOW's phase 7 "Ready for dev" is the hand-off into phase 8's
// local check, so `ready` is written as `local` (it was refused, and the lane's marker lost, before 2026-11-19).
const PHASE_ALIASES: Record<string, Phase> = { ready: 'local' };
export const phaseAlias = (k: string): Phase | undefined =>
  Object.hasOwn(PHASE_ALIASES, k) ? PHASE_ALIASES[k] : undefined;
// The phases a step plan covers, in order (the page's track up to the PR); time in the others counts to no step.
export const STEP_PHASES = ['plan', 'build', 'gate', 'review', 'local', 'dev', 'pr'] as const;
export type StepPhase = (typeof STEP_PHASES)[number];
export const isStepPhase = (p: unknown): p is StepPhase =>
  (STEP_PHASES as readonly unknown[]).includes(p);
export const BRANCH_RE = /^[a-z0-9][a-z0-9-]{0,62}$/; // the mailroom's branch rule: a safe filename too

export type Needs = {
  what: string;
  link: string | null;
  cmd: string | null;
  unblocks: string | null;
};
// The lane's step plan (TOWER.md → Lane files): each step's estimate in minutes, measured from board history or a
// guess, and the time spent in it so far (accrued at each phase change). ETAs are absolute times (ms).
export type Step = {
  phase: StepPhase;
  lo: number;
  hi: number;
  source: 'measured' | 'guess';
  spentMs: number;
};
export type Range = { lo: number; hi: number };
export type LaneEta = { next: Range | null; pr: Range | null; source: 'measured' | 'guess' };
export type LaneFile = {
  branch: string;
  session: string | null;
  phase: Phase;
  step: string | null;
  phaseSince: number | null;
  sha: string | null;
  pr: number | null;
  slot: 'dev' | 'devb' | null;
  needs: Needs | null;
  updatedAt: number;
  files: number | null; // the plan's file count, which the estimates scale by
  plan: Step[] | null;
  eta: LaneEta | null;
};
// a file that is there but can't be used: shown, never dropped
export type LaneProblem = { file: string; problem: string };

const str = (x: unknown) => (typeof x === 'string' && x.length > 0 ? clean(x) : null);
const link = (x: unknown) => {
  const s = str(x);
  return s && /^https:\/\/\S+$/.test(s) ? s : null; // the page renders it as a link: https only
};

const SOURCES = ['measured', 'guess'];
const mins = (x: unknown) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 100000;

// Optional fields: a malformed one reads as absent (the row looks as it did before them), never a problem row.
function parsePlan(x: unknown): Step[] | null {
  if (!Array.isArray(x) || !x.length) return null;
  const steps: Step[] = [];
  for (const y of x as Record<string, unknown>[]) {
    if (!y || !isStepPhase(y.phase) || !mins(y.lo) || !mins(y.hi)) return null;
    if ((y.lo as number) > (y.hi as number) || !SOURCES.includes(y.source as string)) return null;
    if (steps.some((t) => t.phase === y.phase)) return null;
    const spent =
      Number.isInteger(y.spentMs) && (y.spentMs as number) >= 0 ? (y.spentMs as number) : 0;
    steps.push({
      phase: y.phase,
      lo: y.lo as number,
      hi: y.hi as number,
      source: y.source as Step['source'],
      spentMs: spent,
    });
  }
  return steps;
}
function parseRange(x: unknown): Range | null {
  const r = x as Record<string, unknown> | null | undefined;
  const lo = parseTime(r?.lo);
  const hi = parseTime(r?.hi);
  return lo !== null && hi !== null && lo <= hi ? { lo, hi } : null;
}
function parseEta(x: unknown): LaneEta | null {
  const e = x as Record<string, unknown> | null | undefined;
  if (!e || typeof e !== 'object' || !SOURCES.includes(e.source as string)) return null;
  const next = parseRange(e.next);
  const pr = parseRange(e.pr);
  return next || pr ? { next, pr, source: e.source as LaneEta['source'] } : null;
}

export function parseLane(text: string, file: string): LaneFile | LaneProblem {
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    return { file, problem: `not JSON: ${clean((e as Error).message)}` };
  }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { file, problem: 'not an object' };
  if (r.v !== 1) return { file, problem: `v is ${JSON.stringify(r.v)}, want 1` };
  const branch = typeof r.branch === 'string' && BRANCH_RE.test(r.branch) ? r.branch : null;
  if (!branch || `${branch}.json` !== file)
    return { file, problem: 'branch missing or not the file name' };
  if (!(PHASES as readonly unknown[]).includes(r.phase))
    return { file, problem: `phase ${JSON.stringify(r.phase)}` };
  const updatedAt = parseTime(r.updatedAt);
  if (updatedAt === null) return { file, problem: 'updatedAt is not an ISO time' };
  const n = r.needs as Record<string, unknown> | null | undefined;
  const what = str(n?.what);
  return {
    branch,
    session: str(r.session),
    phase: r.phase as Phase,
    step: str(r.step),
    phaseSince: parseTime(r.phaseSince),
    sha: typeof r.sha === 'string' && /^[0-9a-f]{40}$/.test(r.sha) ? r.sha : null,
    pr: Number.isInteger(r.pr) ? (r.pr as number) : null,
    slot: r.slot === 'dev' || r.slot === 'devb' ? r.slot : null,
    needs: what
      ? { what, link: link(n?.link), cmd: str(n?.cmd), unblocks: str(n?.unblocks) }
      : null,
    updatedAt,
    files: Number.isInteger(r.files) && (r.files as number) >= 0 ? (r.files as number) : null,
    plan: parsePlan(r.plan),
    eta: parseEta(r.eta),
  };
}

export const isProblem = (x: LaneFile | LaneProblem): x is LaneProblem => 'problem' in x;

// Every lane file in <boardDir>/lanes; a missing dir is no lanes, a bad file a problem row.
export function readLanes(boardDir: string): { lanes: LaneFile[]; problems: LaneProblem[] } {
  const dir = join(boardDir, 'lanes');
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (e) {
    // no dir yet is no lanes; anything else (EACCES, EIO) is a problem, never a quiet "0 lanes"
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { lanes: [], problems: [] };
    return { lanes: [], problems: [{ file: 'lanes/', problem: clean((e as Error).message) }] };
  }
  const lanes: LaneFile[] = [];
  const problems: LaneProblem[] = [];
  for (const f of files.sort()) {
    let text: string;
    try {
      text = readFileSync(join(dir, f), 'utf8');
    } catch (e) {
      problems.push({ file: clean(f), problem: clean((e as Error).message) });
      continue;
    }
    const l = parseLane(text, f);
    if (isProblem(l)) problems.push({ ...l, file: clean(f) });
    else lanes.push(l);
  }
  return { lanes, problems };
}

export type LaneArgs = {
  clear: boolean;
  phase: Phase | null;
  alias?: string; // the name written, when it was an alias
  step: string | null;
  pr: number | null;
  slot: 'dev' | 'devb' | null;
  session: string | null;
  needs: Needs | null;
  plan: { phase: StepPhase; lo: number; hi: number; guess: boolean }[] | null;
  files: number | null;
  etaNext: { lo: number; hi: number; guess: boolean } | null;
  etaPr: { lo: number; hi: number; guess: boolean } | null;
};

export const LANE_USAGE =
  'usage: pnpm board lane <phase> [--step <text>] [--pr <n>] [--slot dev|devb] [--session <name>]\n' +
  '         [--needs <what> (--link <https url> | --cmd <one-line Mac command>) [--unblocks <text>]]\n' +
  '         [--plan <step>=<lo>-<hi>[?],…] [--files <n>] [--eta-next <lo>-<hi>[?]] [--eta-pr <lo>-<hi>[?]]\n' +
  '       pnpm board lane --clear\n' +
  `  phase: ${PHASES.join(' | ')} (ready = local)\n` +
  `  step:  ${STEP_PHASES.join(' | ')}; minutes, a trailing ? marks a guess (else measured)\n` +
  '  the plan is kept until replaced; time per step accrues at each phase change; the ETAs follow from it\n' +
  '  unless --eta-next / --eta-pr (minutes from now) set them';

// `60-90` or `60-90?` (a guess): whole minutes, lo ≤ hi
const RANGE = /^(\d{1,5})-(\d{1,5})(\?)?$/;
function range(v: string, k: string) {
  const m = RANGE.exec(v);
  if (!m || +m[1]! > +m[2]!)
    throw new Error(`${k} wants <lo>-<hi> minutes, lo ≤ hi (e.g. 20-35 or 20-35?)`);
  return { lo: +m[1]!, hi: +m[2]!, guess: !!m[3] };
}
function planSpec(v: string): NonNullable<LaneArgs['plan']> {
  const out: NonNullable<LaneArgs['plan']> = [];
  for (const part of v.split(',')) {
    const bits = part.split('=');
    if (bits.length !== 2)
      throw new Error(`--plan: ${JSON.stringify(part)} wants <step>=<lo>-<hi>`);
    const [phase, r] = bits;
    if (!isStepPhase(phase))
      throw new Error(`--plan: ${JSON.stringify(phase)} is not a step (${STEP_PHASES.join(' ')})`);
    if (out.some((s) => s.phase === phase)) throw new Error(`--plan: ${phase} twice`);
    out.push({ phase, ...range(r ?? '', `--plan ${phase}`) });
  }
  return out;
}

export function parseLaneArgs(argv: string[]): LaneArgs {
  const a: LaneArgs = {
    clear: false,
    phase: null,
    step: null,
    pr: null,
    slot: null,
    session: null,
    needs: null,
    plan: null,
    files: null,
    etaNext: null,
    etaPr: null,
  };
  let what: string | null = null;
  let lnk: string | null = null;
  let cmd: string | null = null;
  let unblocks: string | null = null;
  const val = (i: number, k: string) => {
    const v = argv[i];
    if (v === undefined || v === '') throw new Error(`${k} wants a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (k === '--clear') a.clear = true;
    else if (k === '--step') a.step = val(++i, k);
    else if (k === '--session') a.session = val(++i, k);
    else if (k === '--needs') what = val(++i, k);
    else if (k === '--link') lnk = val(++i, k);
    else if (k === '--cmd') cmd = val(++i, k);
    else if (k === '--unblocks') unblocks = val(++i, k);
    else if (k === '--plan') a.plan = planSpec(val(++i, k));
    else if (k === '--eta-next') a.etaNext = range(val(++i, k), k);
    else if (k === '--eta-pr') a.etaPr = range(val(++i, k), k);
    else if (k === '--files') {
      const v = val(++i, k);
      if (!/^\d{1,5}$/.test(v)) throw new Error('--files wants a number');
      a.files = Number(v);
    } else if (k === '--pr') {
      const v = val(++i, k);
      if (!/^\d+$/.test(v)) throw new Error('--pr wants a number');
      a.pr = Number(v);
    } else if (k === '--slot') {
      const v = val(++i, k);
      if (v !== 'dev' && v !== 'devb') throw new Error('--slot wants dev or devb');
      a.slot = v;
    } else if (k.startsWith('--')) throw new Error(`unknown flag ${k}`);
    else if (a.phase === null && (PHASES as readonly string[]).includes(k)) a.phase = k as Phase;
    else if (a.phase === null && phaseAlias(k)) {
      a.phase = phaseAlias(k)!;
      a.alias = k;
    } else throw new Error(`unknown phase or argument ${JSON.stringify(k)}`);
  }
  if (a.clear) {
    if (a.phase || what || a.plan || a.files !== null || a.etaNext || a.etaPr)
      throw new Error('--clear takes nothing else');
    return a;
  }
  if (!a.phase) throw new Error('a phase is required');
  if ((lnk || cmd || unblocks) && !what)
    throw new Error('--link, --cmd and --unblocks go with --needs');
  if (what) {
    if (!lnk === !cmd) throw new Error('--needs wants exactly one of --link or --cmd');
    if (lnk && !/^https:\/\/\S+$/.test(lnk)) throw new Error('--link wants an https URL');
    if (cmd && /[\n\r]/.test(cmd)) throw new Error('--cmd must be one line');
    a.needs = { what, link: lnk, cmd, unblocks };
  }
  return a;
}

export type LaneEnv = { branch: string; sha: string | null; session: string | null; now: Date };

// Writes (tmp + rename) or clears this branch's file; returns the one-line echo.
export function writeLane(boardDir: string, a: LaneArgs, env: LaneEnv): string {
  if (!BRANCH_RE.test(env.branch))
    throw new Error(`branch ${JSON.stringify(env.branch)} is not a lane name (${BRANCH_RE})`);
  const dir = join(boardDir, 'lanes');
  const file = join(dir, `${env.branch}.json`);
  if (a.clear) {
    rmSync(file, { force: true });
    return `lane ${env.branch}: cleared`;
  }
  let prev: LaneFile | null = null;
  try {
    const p = parseLane(readFileSync(file, 'utf8'), `${env.branch}.json`);
    if (!isProblem(p)) prev = p;
  } catch {
    // first write
  }
  // `ready` past local would be the queue's READY (merge-ready, the hub's to set), not phase 7: never a step back
  if (a.alias && prev && (['dev', 'pr', 'merged', 'cleanup'] as Phase[]).includes(prev.phase))
    throw new Error(
      `${a.alias} is phase 7, written as ${a.phase}; this lane is at ${prev.phase}. Merge-ready (the queue's READY) is the hub's to set`,
    );
  const t = env.now.toISOString();
  const now = env.now.getTime();
  const keepSince = prev && prev.phase === a.phase && prev.phaseSince !== null;
  const phaseSince = keepSince ? prev!.phaseSince! : now;
  const plan = nextPlan(prev, a, now);
  const eta = laneEta(plan, a, a.phase!, now - phaseSince, now);
  const out = {
    v: 1,
    branch: env.branch,
    session: a.session ?? env.session ?? prev?.session ?? null,
    phase: a.phase,
    step: a.step,
    phaseSince: new Date(phaseSince).toISOString(),
    sha: env.sha,
    pr: a.pr ?? prev?.pr ?? null,
    slot: a.slot ?? (a.phase === prev?.phase ? prev.slot : null),
    needs: a.needs, // cleared by any write without --needs: a stale "needs you" is worse than none
    updatedAt: t,
    files: a.files ?? prev?.files ?? null,
    plan: plan?.map((s) => ({ ...s })) ?? null,
    eta: eta && {
      next: eta.next && iso(eta.next),
      pr: eta.pr && iso(eta.pr),
      source: eta.source,
    },
  };
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  renameSync(tmp, file);
  const prEta = eta?.pr ? ` · PR ~${hhmm(eta.pr.lo)}–${hhmm(eta.pr.hi)}` : '';
  return `lane ${env.branch}: ${a.phase}${a.step ? ` · ${a.step}` : ''}${prEta}${a.needs ? ` · needs you: ${a.needs.what}` : ''}`;
}

const iso = (r: Range) => ({ lo: new Date(r.lo).toISOString(), hi: new Date(r.hi).toISOString() });

// The plan after this write: --plan replaces it (keeping each step's time spent so far), else the last one carries.
// On a phase change, the time in the phase just left accrues to its step, so est vs actual records itself.
function nextPlan(prev: LaneFile | null, a: LaneArgs, now: number): Step[] | null {
  const spent = new Map((prev?.plan ?? []).map((s) => [s.phase, s.spentMs]));
  if (prev && prev.phase !== a.phase && prev.phaseSince !== null && isStepPhase(prev.phase))
    spent.set(prev.phase, (spent.get(prev.phase) ?? 0) + Math.max(0, now - prev.phaseSince));
  const base: Omit<Step, 'spentMs'>[] | null = a.plan
    ? a.plan.map((p) => ({
        phase: p.phase,
        lo: p.lo,
        hi: p.hi,
        source: p.guess ? 'guess' : 'measured',
      }))
    : (prev?.plan ?? null);
  if (!base) return null;
  return base.map((s) => ({ ...s, spentMs: spent.get(s.phase) ?? 0 }));
}

// When the next step and the PR land, from the plan: the current step's remaining time (its estimate less what it
// has taken, never below now), then each later step up to and including `pr`. A flag sets its own ETA instead. No
// plan and no flags: none (a stale ETA is worse than none). Past `pr` (merged, cleanup) there is nothing to estimate.
export function laneEta(
  plan: Step[] | null,
  a: Pick<LaneArgs, 'etaNext' | 'etaPr'>,
  phase: Phase,
  inPhaseMs: number,
  now: number,
): (LaneEta & { next: Range | null; pr: Range | null }) | null {
  const flag = (f: LaneArgs['etaNext']) =>
    f && { range: { lo: now + f.lo * 60e3, hi: now + f.hi * 60e3 }, guess: f.guess };
  const fNext = flag(a.etaNext);
  const fPr = flag(a.etaPr);
  let next: Range | null = null;
  let pr: Range | null = null;
  let guess = false;
  const at = STEP_PHASES.indexOf(phase as StepPhase);
  if (plan && at >= 0) {
    const cur = plan.find((s) => s.phase === phase);
    const spent = (cur?.spentMs ?? 0) + inPhaseMs;
    const left = (m: number) => Math.max(0, m * 60e3 - spent);
    next = cur ? { lo: now + left(cur.lo), hi: now + left(cur.hi) } : { lo: now, hi: now };
    guess = cur?.source === 'guess';
    const later = plan.filter((s) => STEP_PHASES.indexOf(s.phase) > at);
    pr = later.reduce((r, s) => ({ lo: r.lo + s.lo * 60e3, hi: r.hi + s.hi * 60e3 }), { ...next });
    if (later.some((s) => s.source === 'guess')) guess = true;
    if (!cur && !later.length) next = pr = null;
  }
  if (fNext) next = fNext.range;
  if (fPr) pr = fPr.range;
  if (!next && !pr) return null;
  // a flag's own `?` decides its part; the plan's guesses count only for what the plan set
  const src = [
    fNext ? fNext.guess : plan && next ? guess : false,
    fPr ? fPr.guess : plan && pr ? guess : false,
  ];
  return { next, pr, source: src.some(Boolean) ? 'guess' : 'measured' };
}
