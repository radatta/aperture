// Lane status files (docs/ops/TOWER.md → Lane files): each feature session writes
// <boardDir>/lanes/<branch>.json at its hub checkpoints and phase changes, with `pnpm board lane <phase> …`.
// The web tower derives NOW and NEEDS YOU from them; locks, PRs and runs stay the truth for state.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clean, parseTime } from './fmt.ts';

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
export const BRANCH_RE = /^[a-z0-9][a-z0-9-]{0,62}$/; // the mailroom's branch rule: a safe filename too

export type Needs = {
  what: string;
  link: string | null;
  cmd: string | null;
  unblocks: string | null;
};
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
};
// a file that is there but can't be used: shown, never dropped
export type LaneProblem = { file: string; problem: string };

const str = (x: unknown) => (typeof x === 'string' && x.length > 0 ? clean(x) : null);
const link = (x: unknown) => {
  const s = str(x);
  return s && /^https:\/\/\S+$/.test(s) ? s : null; // the page renders it as a link: https only
};

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
  };
}

export const isProblem = (x: LaneFile | LaneProblem): x is LaneProblem => 'problem' in x;

// Every lane file in <boardDir>/lanes; a missing dir is no lanes, a bad file a problem row.
export function readLanes(boardDir: string): { lanes: LaneFile[]; problems: LaneProblem[] } {
  const dir = join(boardDir, 'lanes');
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return { lanes: [], problems: [] };
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
  step: string | null;
  pr: number | null;
  slot: 'dev' | 'devb' | null;
  session: string | null;
  needs: Needs | null;
};

export const LANE_USAGE =
  'usage: pnpm board lane <phase> [--step <text>] [--pr <n>] [--slot dev|devb] [--session <name>]\n' +
  '         [--needs <what> (--link <https url> | --cmd <one-line Mac command>) [--unblocks <text>]]\n' +
  '       pnpm board lane --clear\n' +
  `  phase: ${PHASES.join(' | ')}`;

export function parseLaneArgs(argv: string[]): LaneArgs {
  const a: LaneArgs = {
    clear: false,
    phase: null,
    step: null,
    pr: null,
    slot: null,
    session: null,
    needs: null,
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
    else if (k === '--pr') {
      const v = val(++i, k);
      if (!/^\d+$/.test(v)) throw new Error('--pr wants a number');
      a.pr = Number(v);
    } else if (k === '--slot') {
      const v = val(++i, k);
      if (v !== 'dev' && v !== 'devb') throw new Error('--slot wants dev or devb');
      a.slot = v;
    } else if (k.startsWith('--')) throw new Error(`unknown flag ${k}`);
    else if (a.phase === null && (PHASES as readonly string[]).includes(k)) a.phase = k as Phase;
    else throw new Error(`unknown phase or argument ${JSON.stringify(k)}`);
  }
  if (a.clear) {
    if (a.phase || what) throw new Error('--clear takes nothing else');
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
  const t = env.now.toISOString();
  const keepSince = prev && prev.phase === a.phase && prev.phaseSince !== null;
  const out = {
    v: 1,
    branch: env.branch,
    session: a.session ?? env.session ?? prev?.session ?? null,
    phase: a.phase,
    step: a.step,
    phaseSince: keepSince ? new Date(prev!.phaseSince!).toISOString() : t,
    sha: env.sha,
    pr: a.pr ?? prev?.pr ?? null,
    slot: a.slot ?? (a.phase === prev?.phase ? prev.slot : null),
    needs: a.needs, // cleared by any write without --needs: a stale "needs you" is worse than none
    updatedAt: t,
  };
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  renameSync(tmp, file);
  return `lane ${env.branch}: ${a.phase}${a.step ? ` · ${a.step}` : ''}${a.needs ? ` · needs you: ${a.needs.what}` : ''}`;
}
