// The mailroom's `sim` job, container side: the op language for the iOS Simulator on the Mac, a validator with the
// same rules in the same order as the runner's SIM_JQ (tools/mailroom/jobs/sim.sh — the authority; the shared
// fixtures drive both), and the submit → pickup → heartbeat → collect flow the devcheck waits on. A sim run takes
// minutes, so this is not `deliver` (75 s): it waits for the pickup, then for the result while the heartbeat moves.
// docs/ops/IOS-CHECK.md.
import { join } from 'node:path';
import type { Clock } from '../bot/dispatch.ts';
import { isoSeconds, makeId } from './ids.ts';
import { NotInstalled, lastSeen, submit, withdraw } from './submit.ts';
import type { Fs } from './submit.ts';

export const SIM_EXPIRES_IN_MIN = 10;
export const MAX_OPS = 80;
export const MAX_SHOTS = 20;
export const TABS = [
  'Home',
  'Log',
  'Tasks',
  'Recruiting',
  'Habits',
  'Rolls',
  'Flux',
  'Finances',
  'Inbox',
  'Settings',
] as const;
export const ROLES = [
  'AXButton',
  'AXLink',
  'AXTextArea',
  'AXTextField',
  'AXStaticText',
  'AXCheckBox',
] as const;
// The app's write buttons, refused for `tap` at validation (lowercased, trimmed, exact) — and again at run time
// on the element actually matched. A belt: the boundary is the dev test user's own partition.
export const TAP_DENY = [
  'save',
  'save log',
  'save task',
  'save idea',
  'mark done',
  'start',
  'stop',
  'delete',
  'complete',
  'export json',
  'generate token',
  'rotate',
  'connect google calendar',
  'sign out',
  'save password',
  'not now',
  'return',
];

type Tab = (typeof TABS)[number];
type Role = (typeof ROLES)[number];
interface Where {
  near?: { x: number; y: number };
  scan?: { x: number; from: number; to: number };
  radius?: number;
  role?: Role;
}
export type IosOp =
  | { op: 'launch' | 'signIn' | 'blur' | 'readBuild' | 'shutdown' }
  | { op: 'kill'; method: 'terminate' | 'switcher' | 'reboot' }
  | { op: 'nav'; tab: Tab }
  | ({ op: 'find'; label: string; as: string } & Where)
  | ({ op: 'tap'; label: string; as?: string } & Where)
  | { op: 'expect'; signedIn: true }
  | { op: 'expect'; as: string; valueIs: string }
  | { op: 'expect'; as: string; labelIs: string }
  | { op: 'expect'; as: string; enabled: boolean }
  | { op: 'expect'; as: string; aboveKeyboard: true }
  | { op: 'expect'; as: string; sameWidthAs: string }
  | { op: 'keys'; text: string }
  | { op: 'erase'; n: number }
  | { op: 'scroll'; dir: 'up' | 'down'; pt: number }
  | { op: 'expectBuild'; relaunches?: 0 | 1 }
  | { op: 'shot'; name: string }
  | { op: 'wait'; s: number };

export interface SimParams {
  sha: string;
  timeoutSec: number;
  shutdown: boolean;
  steps: IosOp[];
}
export interface SimJob {
  v: 1;
  id: string;
  job: 'sim';
  submittedAt: string;
  expiresInMin: number;
  params: SimParams;
}

export type SimReason = 'BAD_PARAM' | 'TOO_MANY_OPS' | 'BAD_OP' | 'DENIED_TAP';

export interface SimRead {
  role: string;
  label: string;
  value?: string;
  enabled: boolean;
  frame: { x: number; y: number; w: number; h: number };
}
export interface SimStep {
  i: number;
  op: string;
  status: 'pass' | 'fail' | 'error' | 'skipped';
  ms: number;
  note?: string;
}
export interface SimResult {
  v: 1;
  id: string;
  job: 'sim' | null;
  status: 'pass' | 'fail' | 'error' | 'rejected' | 'expired';
  reason: string | null;
  detail?: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  runnerVersion: string;
  device?: {
    name: string;
    udid: string | null;
    runtime: string | null;
    axe: string;
    xcode?: string | null;
  };
  booted?: string;
  signedIn?: string;
  buildsSeen?: string[];
  steps?: SimStep[];
  reads?: Record<string, SimRead>;
  shots?: string[];
}

export function makeSimJob(
  name: string,
  params: SimParams,
  nowMs: number,
  id = makeId(`ios-${name}`, nowMs),
): SimJob {
  return {
    v: 1,
    id,
    job: 'sim',
    submittedAt: isoSeconds(nowMs),
    expiresInMin: SIM_EXPIRES_IN_MIN,
    params,
  };
}

// --- the mirror of SIM_JQ --------------------------------------------------------------------------------------
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const whole = (x: unknown, re: RegExp) => typeof x === 'string' && !x.includes('\n') && re.test(x);
const int = (x: unknown, lo: number, hi: number) =>
  typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi;
const keysOk = (o: Obj, req: string[], opt: string[]) =>
  Object.keys(o).every((k) => req.includes(k) || opt.includes(k)) && req.every((k) => k in o);
const text = (x: unknown) =>
  typeof x === 'string' &&
  [...x].length <= 200 &&
  [...x].every((c) => {
    const n = c.codePointAt(0) ?? 0;
    return n >= 32 && n !== 127;
  });
const LABEL_RE = /^[A-Za-z0-9 .,:;()/+_&'?…-]{1,60}$/;
const AS_RE = /^[a-z][a-z0-9-]{0,23}$/;
const lbl = (x: unknown) => whole(x, LABEL_RE);
const asName = (x: unknown) => whole(x, AS_RE);

function where(o: Obj): boolean {
  if ('near' in o === 'scan' in o) return false;
  if ('near' in o) {
    const n = o.near;
    if (!isObj(n) || !keysOk(n, ['x', 'y'], []) || !int(n.x, 0, 402) || !int(n.y, 0, 874))
      return false;
  } else {
    const s = o.scan;
    if (
      !isObj(s) ||
      !keysOk(s, ['x', 'from', 'to'], []) ||
      !int(s.x, 0, 402) ||
      !int(s.from, 0, 874) ||
      !int(s.to, 0, 874) ||
      Math.floor(Math.abs((s.to as number) - (s.from as number)) / 30) + 1 > 20
    )
      return false;
  }
  if ('radius' in o && !('near' in o && int(o.radius, 10, 80))) return false;
  if ('role' in o && !(ROLES as readonly unknown[]).includes(o.role)) return false;
  return true;
}

function opOk(o: unknown): boolean {
  if (!isObj(o) || typeof o.op !== 'string') return false;
  switch (o.op) {
    case 'launch':
    case 'signIn':
    case 'blur':
    case 'readBuild':
    case 'shutdown':
      return keysOk(o, ['op'], []);
    case 'kill':
      return (
        keysOk(o, ['op', 'method'], []) &&
        ['terminate', 'switcher', 'reboot'].includes(o.method as string)
      );
    case 'nav':
      return (
        keysOk(o, ['op', 'tab'], []) &&
        typeof o.tab === 'string' &&
        (TABS as readonly string[]).includes(o.tab)
      );
    case 'find':
      return (
        keysOk(o, ['op', 'label', 'as'], ['near', 'scan', 'radius', 'role']) &&
        lbl(o.label) &&
        asName(o.as) &&
        where(o)
      );
    case 'tap':
      return (
        keysOk(o, ['op', 'label'], ['near', 'scan', 'radius', 'role', 'as']) &&
        lbl(o.label) &&
        (!('as' in o) || asName(o.as)) &&
        where(o)
      );
    case 'expect':
      if ('signedIn' in o) return keysOk(o, ['op', 'signedIn'], []) && o.signedIn === true;
      if (!asName(o.as) || Object.keys(o).length !== 3) return false;
      if ('valueIs' in o) return text(o.valueIs);
      if ('labelIs' in o) return text(o.labelIs);
      if ('enabled' in o) return typeof o.enabled === 'boolean';
      if ('aboveKeyboard' in o) return o.aboveKeyboard === true;
      if ('sameWidthAs' in o) return asName(o.sameWidthAs);
      return false;
    case 'keys':
      return keysOk(o, ['op', 'text'], []) && whole(o.text, /^[a-z ]{1,24}$/);
    case 'erase':
      return keysOk(o, ['op', 'n'], []) && int(o.n, 1, 24);
    case 'scroll':
      return (
        keysOk(o, ['op', 'dir', 'pt'], []) &&
        (o.dir === 'up' || o.dir === 'down') &&
        int(o.pt, 100, 600)
      );
    case 'expectBuild':
      return keysOk(o, ['op'], ['relaunches']) && (!('relaunches' in o) || int(o.relaunches, 0, 1));
    case 'shot':
      return keysOk(o, ['op', 'name'], []) && whole(o.name, /^[a-z0-9-]{1,32}$/);
    case 'wait':
      return keysOk(o, ['op', 's'], []) && int(o.s, 1, 30);
    default:
      return false;
  }
}

const normLabel = (s: string) => s.toLowerCase().replace(/^ +/, '').replace(/ +$/, '');
const denied = (o: Obj) => o.op === 'tap' && TAP_DENY.includes(normLabel(o.label as string));

function crossOk(steps: Obj[]): boolean {
  if (steps.filter((s) => s.op === 'shot').length > MAX_SHOTS) return false;
  for (const [i, s] of steps.entries()) {
    if (s.op === 'kill' && steps[i + 1]?.op !== 'launch') return false;
    if (s.op === 'shutdown' && i !== steps.length - 1) return false;
  }
  const defs: string[] = [];
  for (const s of steps) {
    if (s.op === 'expect' && 'as' in s) {
      if (!defs.includes(s.as as string)) return false;
      if ('sameWidthAs' in s && !defs.includes(s.sameWidthAs as string)) return false;
    }
    if ((s.op === 'find' || s.op === 'tap') && 'as' in s) {
      if (defs.includes(s.as as string)) return false;
      defs.push(s.as as string);
    }
  }
  return true;
}

// The runner's plan checks in its order; null when the plan would run.
export function validateSimParams(p: unknown): SimReason | null {
  if (!isObj(p)) return 'BAD_PARAM';
  if (JSON.stringify(Object.keys(p).sort()) !== '["sha","shutdown","steps","timeoutSec"]')
    return 'BAD_PARAM';
  if (!whole(p.sha, /^[0-9a-f]{40}$/)) return 'BAD_PARAM';
  if (!int(p.timeoutSec, 60, 600)) return 'BAD_PARAM';
  if (typeof p.shutdown !== 'boolean') return 'BAD_PARAM';
  if (!Array.isArray(p.steps) || p.steps.length < 1) return 'BAD_PARAM';
  if (p.steps.length > MAX_OPS) return 'TOO_MANY_OPS';
  for (const s of p.steps as unknown[]) {
    if (!opOk(s)) return 'BAD_OP';
    if (denied(s as Obj)) return 'DENIED_TAP';
  }
  return crossOk(p.steps as Obj[]) ? null : 'BAD_OP';
}

export const SIM_REASON_HINT: Record<SimReason, string> = {
  BAD_PARAM: 'sim params: sha (40 hex), timeoutSec 60–600, shutdown (boolean), steps (1–80 ops)',
  TOO_MANY_OPS: `a sim plan holds at most ${MAX_OPS} ops`,
  BAD_OP:
    'an op off the allowlist, a bad argument, an unknown `as`, a kill not followed by launch, or shutdown not last (docs/ops/IOS-CHECK.md → Ops)',
  DENIED_TAP: 'that label is one of the app’s write buttons — the sim never saves',
};

// --- submit, wait, collect -------------------------------------------------------------------------------------
export const PICKUP_MS = 90_000;
// Ops refresh progress.json; a sign-in (Keychain, form, reboot, relaunch) is the longest stretch without one.
export const HEARTBEAT_MS = 300_000;
const POLL_MS = 2_000;
const GRACE_MS = 60_000;

// The sim couldn't run (Mac asleep, Device Hub down, no password, …): the rows are "needs you", never a failure.
export class IosUnavailable extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(`${reason}: ${message}`);
    this.reason = reason;
  }
}
// The sim ran and an assertion didn't hold: the row fails.
export class IosAssert extends Error {
  readonly result: SimResult;
  constructor(message: string, result: SimResult) {
    super(message);
    this.result = result;
  }
}

export interface SimDeps {
  fs: Fs;
  clock: Clock;
  dir: string; // .hostjobs
  log: (s: string) => void;
}

const failingNote = (r: SimResult) => {
  const s = r.steps?.find((x) => x.status !== 'pass' && x.status !== 'skipped');
  return `${r.reason ?? r.status}${r.detail ? `/${r.detail}` : ''}${s ? ` at op ${s.i} ${s.op}${s.note ? `: ${s.note}` : ''}` : ''}`;
};

function settle(r: SimResult): SimResult {
  if (r.status === 'pass') return r;
  if (r.status === 'fail') throw new IosAssert(failingNote(r), r);
  if (r.status === 'rejected')
    throw new Error(
      `the Mac refused the sim plan: ${r.reason} — a harness bug (IOS-CHECK.md → Ops)`,
    );
  const code = r.status === 'expired' ? 'MAC_UNREACHABLE' : (r.reason ?? 'SIM_UNAVAILABLE');
  throw new IosUnavailable(r.detail ? `${code}/${r.detail}` : code, failingNote(r));
}

// Submit, wait for the Mac to take it (its result dir appears), then for the result while the heartbeat moves.
export async function runSimJob(d: SimDeps, job: SimJob): Promise<SimResult> {
  try {
    submit(d.fs, d.dir, job);
  } catch (err) {
    if (err instanceof NotInstalled) throw new IosUnavailable('MAC_UNREACHABLE', err.message);
    throw err;
  }
  const rdir = join(d.dir, 'results', job.id);
  const picked = d.clock.now();
  for (;;) {
    if (d.fs.isDir(rdir)) break;
    if (d.clock.now() - picked >= PICKUP_MS) {
      if (withdraw(d.fs, d.dir, job.id)) {
        const seen = lastSeen(d.fs, d.dir);
        const age =
          seen.lastResultMs === null
            ? 'no result ever'
            : `last result ${Math.round((d.clock.now() - seen.lastResultMs) / 60_000)} min ago`;
        throw new IosUnavailable(
          'MAC_UNREACHABLE',
          `no pickup in ${PICKUP_MS / 1000} s — Mac asleep or mailroom not running (${age})`,
        );
      }
      break; // taken just now
    }
    await d.clock.sleep(POLL_MS);
  }
  d.log(`  sim job ${job.id} picked up`);
  // Heartbeat by change, on the container's clock: a skewed Mac clock can't fake a stall.
  const progress = join(rdir, 'progress.json');
  const deadline = d.clock.now() + job.params.timeoutSec * 1000 + GRACE_MS;
  let lastMtime = d.fs.mtimeMs(progress);
  let lastChange = d.clock.now();
  for (;;) {
    const raw = d.fs.read(join(rdir, 'result.json'));
    let r: SimResult | null = null;
    try {
      r = raw ? (JSON.parse(raw) as SimResult) : null;
    } catch {
      // partial write — next poll
    }
    if (r?.id === job.id) return settle(r); // outside the try: settle's throws are the verdict
    const m = d.fs.mtimeMs(progress);
    if (m !== lastMtime) {
      lastMtime = m;
      lastChange = d.clock.now();
    }
    if (d.clock.now() - lastChange > HEARTBEAT_MS)
      throw new IosUnavailable(
        'MAC_STALLED',
        `no heartbeat for ${HEARTBEAT_MS / 1000} s — the Mac may have slept mid-job`,
      );
    if (d.clock.now() > deadline)
      throw new IosUnavailable(
        'MAC_STALLED',
        `no result within the job's ${job.params.timeoutSec} s + ${GRACE_MS / 1000} s`,
      );
    await d.clock.sleep(POLL_MS);
  }
}

// `pnpm mailroom sim-probe [--sign-in]` / `sim-shutdown`: the whole Mac path (inbox → launchd → Device Hub → AXe →
// the web app) with no assertions, or just a shutdown. Exit 0 ok, 1 an assertion/harness problem, 3 unavailable.
export async function simCommand(
  d: SimDeps,
  cmd: 'probe' | 'shutdown',
  signIn = false,
): Promise<number> {
  const steps: IosOp[] =
    cmd === 'shutdown'
      ? [{ op: 'shutdown' }]
      : [
          { op: 'launch' },
          ...(signIn ? [{ op: 'signIn' } as const] : []),
          { op: 'shot', name: 'probe' },
        ];
  const job = makeSimJob(
    cmd,
    { sha: '0'.repeat(40), timeoutSec: 300, shutdown: false, steps },
    d.clock.now(),
  );
  try {
    const r = await runSimJob(d, job);
    const dev = r.device;
    d.log(
      `sim ${cmd} ok in ${Math.round(r.durationMs / 1000)} s: ${dev?.name} ${dev?.runtime ?? ''} (axe ${dev?.axe}, ${dev?.xcode ?? 'Xcode ?'}), booted ${r.booted}, signed in: ${r.signedIn}`,
    );
    for (const s of r.shots ?? []) d.log(`  screenshot: ${join(d.dir, 'results', job.id, s)}`);
    if (cmd === 'probe' && r.signedIn === 'false')
      d.log(
        'the web app is signed out — rerun with --sign-in (reads the password from the Mac Keychain)',
      );
    return 0;
  } catch (err) {
    if (err instanceof IosUnavailable) {
      d.log(`sim ${cmd} unavailable — ${err.message} (IOS-CHECK.md → Failures)`);
      return 3;
    }
    if (err instanceof IosAssert) {
      d.log(`sim ${cmd} failed — ${err.message}`);
      return 1;
    }
    throw err;
  }
}
