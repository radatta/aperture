// The web tower's one derivation (docs/ops/TOWER.md): board state + lane files + GitHub → the View the page
// renders. Pure: every input is passed in, so each lane state and the automatic HOLD are tested on fixtures.
// Truth comes from locks, PRs and Actions runs; lane files add the phase, the step and what Rahul must do.
import { SHAPE_PATHS } from '../../deploy-base.ts';
import { hhmm } from './fmt.ts';
import type { Checks, Cached, GhRun, Minutes } from './gh.ts';
import { ACTIONS_INCLUDED_MIN } from './gh.ts';
import type { Costs, MacRead } from './health.ts';
import type { LaneFile, LaneProblem, Needs } from './lanes.ts';
import type { Lock, TowerState } from './model.ts';
import type { Pr } from './prs.ts';
import { staleFollowups, type Lane } from './queue.ts';

export type Slot = 'dev' | 'devb';
export type State =
  | 'BUILDING'
  | 'TESTING'
  | 'PR'
  | 'CHECKS FAILED'
  | 'MERGE ME'
  | 'HOLD'
  | 'MERGED'
  | 'DEPLOYING'
  | 'DONE'
  | 'DEPLOY FAILED'
  | 'PARKED';
export type Tone = 'normal' | 'dim' | 'good' | 'warn' | 'bad';

export type LaneRow = {
  branch: string;
  session: string | null;
  state: State;
  label: string; // the state in Rahul's words: `TESTING on devb`, `HOLD (dev: …)`, `PR (checks running)`
  detail: string | null;
  tone: Tone;
  since: number | null;
  pr: { number: number; title: string; url: string | null } | null;
  hold: string | null;
  fileAge: number | null; // seconds since the lane file's last write; null = no file
};
export type NeedItem = {
  kind: 'lane' | 'merge' | 'deploy' | 'todo' | 'source';
  what: string;
  link: string | null;
  cmd: string | null;
  unblocks: string | null;
  since: number | null;
  branch: string | null;
};
export type SlotCard = {
  slot: Slot;
  branch: string | null;
  session: string | null;
  detail: string | null;
  since: number | null;
  expiresAt: number | null;
  live: boolean;
  asOf: number | null;
  failed: boolean;
};
export type SourceRow = { name: string; state: 'ok' | 'stale' | 'failed' | 'missing'; at: number | null; detail: string | null };
export type Health = {
  container: {
    at: number;
    anonMiB: number;
    highMiB: number;
    anonSoft: number;
    anonHard: number;
    cpu: number | null;
    cores: number;
    pids: number;
    pidsMax: number;
    tests: number;
    testCap: number | null;
  } | null;
  mac: MacRead;
  actions: { minutes: number; of: number; counted: number; total: number; month: string } | null;
  aws: Costs;
};
export type View = {
  v: 1;
  now: number;
  version: string | null;
  needs: NeedItem[];
  slots: SlotCard[];
  active: LaneRow[]; // NOW: building, testing, PR, checks failed, merged, deploying
  next: {
    queue: { slot: Slot; branch: string; state: string; waitingOn: string | null }[];
    merge: LaneRow[];
    rahul: string | null;
  };
  done: { number: number; title: string; branch: string; mergedAt: number; deploy: string; tone: Tone; url: string | null }[];
  health: Health;
  slipping: { kind: 'followup' | 'parked' | 'quiet'; what: string; owner: string | null; since: number | null }[];
  sources: SourceRow[];
  problems: string[];
};

export type Inputs = {
  now: number;
  version: string | null;
  tower: TowerState;
  lanes: LaneFile[];
  laneProblems: LaneProblem[];
  sessionsByBranch: Record<string, string>;
  runs: Cached<GhRun[]>; // the newest runs: main Deploy + deploy-dev dispatches
  checks: (sha: string) => Checks | null;
  files: (sha: string) => { files: string[] | null; error: string | null } | null;
  minutes: Cached<Minutes | null> | null;
  mac: MacRead;
  aws: Costs;
  tests: number;
  testCap: number | null;
  macInstall: string; // NEEDS YOU's command when the Mac agent is missing or silent
  midnight: number; // local midnight, for DONE TODAY
};

// Freshness thresholds, seconds (TOWER.md → Sources): past them a source shows amber with its age.
export const STALE = { sampler: 90, lock: 300, gh: 180, queue: 7200, lane: 7200, laneQuiet: 86400, minutes: 7200 };
const RUN_FRESH_MS = 2 * 3600e3; // a ledger run with no end older than this is an orphan, not in flight

export const liveLock = (l: Lock | null, now: number): l is Lock & { branch: string } =>
  !!l?.branch && l.expiresAt !== null && l.expiresAt > now;

const mainDeploys = (runs: GhRun[]) =>
  runs.filter((r) => r.name === 'Deploy' && r.event === 'push' && r.branch === 'main');
const running = (r: GhRun) => r.status !== 'completed';

// The main Deploy run that carries a merge: its own, or, when that one was cancelled by a later merge (deploy.yml's
// concurrency group), the newest later Deploy run, which deploys main's head and so this merge too.
export function deployFor(mergeSha: string | null, runs: GhRun[]): { run: GhRun; via: GhRun | null } | null {
  if (!mergeSha) return null;
  const deps = mainDeploys(runs);
  const own = deps.find((r) => r.sha === mergeSha);
  if (!own) return null;
  if (own.conclusion !== 'cancelled') return { run: own, via: null };
  const later = deps
    .filter((r) => (r.createdAt ?? 0) > (own.createdAt ?? 0))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
  return later ? { run: later, via: own } : { run: own, via: null };
}

// What a slot's holder is doing, in the order Rahul asks about it.
export function slotDetail(slot: Slot, lock: Lock & { branch: string }, i: Inputs, file: LaneFile | null): string | null {
  const dispatch = lock.sha
    ? i.runs.value.find((r) => r.name.startsWith(`deploy-dev ${lock.sha} `) && running(r))
    : undefined;
  if (dispatch) return 'deploying';
  const run = i.tower.runs.find(
    (r) => r.slot === slot && r.start !== null && r.end === null && i.now - r.start < RUN_FRESH_MS,
  );
  if (run) return `devcheck running since ${hhmm(run.start!)}`;
  if (file?.needs) return `held for Rahul: ${file.needs.what}`;
  return file?.step ?? (file ? file.phase : null);
}

// The automatic merge HOLD (TOWER.md → HOLD): a main merge redeploys dev over a dispatched branch (CLAUDE.md →
// Git workflow), and devb only when the merge changes devb's shape (deploy-base.ts → SHAPE_PATHS). First match wins.
export function holdReason(pr: Pr, queue: Lane | null, i: Inputs): string | null {
  const lock = (slot: Slot) => (slot === 'dev' ? i.tower.lock : i.tower.lockB);
  const dev = lock('dev');
  if (liveLock(dev, i.now) && dev.branch !== pr.branch)
    return `dev: ${dev.branch} is testing, lock to ${hhmm(dev.expiresAt!)}`;
  const devb = lock('devb');
  if (liveLock(devb, i.now) && devb.branch !== pr.branch) {
    const f = pr.sha ? i.files(pr.sha) : null;
    if (!f?.files) return `devb: ${devb.branch} is testing and this PR's files aren't read yet`;
    if (f.files.some(SHAPE_PATHS)) return `devb: ${devb.branch} is testing and this PR changes devb's shape`;
  }
  const dep = mainDeploys(i.runs.value).find(running);
  if (dep) return `main deploy${dep.number ? ` ${dep.number}` : ''} running`;
  return queue?.hold ?? null;
}

type Ctx = { branch: string; file: LaneFile | null; queue: Lane | null; pr: Pr | null };

export function laneRow(c: Ctx, i: Inputs): LaneRow {
  const { branch, file, queue, pr } = c;
  const base = {
    branch,
    session: file?.session ?? queue?.session ?? i.sessionsByBranch[branch] ?? null,
    pr: pr ? { number: pr.number, title: pr.title, url: pr.url } : null,
    hold: null as string | null,
    fileAge: file ? Math.max(0, (i.now - file.updatedAt) / 1000) : null,
  };
  const row = (state: State, label: string, detail: string | null, tone: Tone, since: number | null, hold: string | null = null): LaneRow =>
    ({ ...base, state, label, detail, tone, since, hold });

  if (file?.phase === 'parked' || /^PARKED/i.test(queue?.waitingOn ?? ''))
    return row('PARKED', 'PARKED', queue?.waitingOn ?? file?.step ?? null, 'dim', file?.phaseSince ?? null);

  if (pr?.state === 'MERGED') {
    const d = deployFor(pr.mergeSha, i.runs.value);
    if (!d) return row('MERGED', 'MERGED', 'deploy run not seen yet', 'warn', pr.mergedAt);
    const dep = d.run;
    const via = d.via ? ` (its own was superseded)` : '';
    if (running(dep)) return row('DEPLOYING', 'DEPLOYING', `main deploy${dep.number ? ` ${dep.number}` : ''}${via}`, 'warn', dep.startedAt);
    if (dep.conclusion === 'success') return row('DONE', 'DONE', d.via ? `by main deploy ${dep.number ?? ''}${via}`.trim() : null, 'good', pr.mergedAt);
    return row('DEPLOY FAILED', 'DEPLOY FAILED', `${dep.conclusion ?? 'failed'}${via}`, 'bad', dep.startedAt);
  }

  for (const slot of ['dev', 'devb'] as const) {
    const lock = slot === 'dev' ? i.tower.lock : i.tower.lockB;
    if (liveLock(lock, i.now) && lock.branch === branch)
      return row('TESTING', `TESTING on ${slot}`, slotDetail(slot, lock, i, file), 'warn', file?.phase === 'dev' ? file.phaseSince : null);
  }

  if (pr?.state === 'OPEN') {
    const ch = pr.sha ? i.checks(pr.sha) : null;
    const runs = ch?.runs ?? [];
    if (pr.draft) return row('PR', 'PR (draft)', null, 'dim', pr.createdAt);
    if (!runs.length)
      return row('PR', 'PR (no checks seen)', ch?.error ? `checks: ${ch.error}` : null, 'warn', pr.createdAt);
    if (runs.some(running)) return row('PR', 'PR (checks running)', runs.filter(running).map((r) => r.name).join(', '), 'warn', pr.createdAt);
    const bad = runs.filter((r) => r.conclusion !== 'success' && r.conclusion !== 'skipped' && r.conclusion !== 'neutral');
    if (bad.length) return row('CHECKS FAILED', 'CHECKS FAILED', bad.map((r) => `${r.name} ${r.conclusion}`).join(', '), 'bad', pr.createdAt);
    const hold = holdReason(pr, queue, i);
    if (hold) return row('HOLD', `HOLD (${hold})`, null, 'warn', pr.createdAt, hold);
    return row('MERGE ME', 'MERGE ME', null, 'good', pr.createdAt);
  }

  if (!file) return row('BUILDING', 'BUILDING', 'no status file', 'dim', null);
  const word: Record<string, string> = {
    plan: 'Plan', build: 'Build', gate: 'Gate', review: 'Review', local: 'Local', dev: 'Dev test',
    pr: 'PR', merged: 'Merged', cleanup: 'Cleanup', blocked: 'Blocked',
  };
  const w = word[file.phase] ?? file.phase;
  return row('BUILDING', 'BUILDING', file.step ? `${w} · ${file.step}` : w, file.phase === 'blocked' ? 'bad' : 'normal', file.phaseSince);
}

// Which PR is a branch's: the open one, else the newest merged one.
function prFor(branch: string, prs: Pr[], queuePr: number | null, filePr: number | null): Pr | null {
  const mine = prs.filter((p) => p.branch === branch);
  const byNum = (n: number | null) => (n === null ? undefined : prs.find((p) => p.number === n));
  return (
    mine.find((p) => p.state === 'OPEN') ??
    byNum(filePr) ??
    byNum(queuePr) ??
    mine.filter((p) => p.state === 'MERGED').sort((a, b) => (b.mergedAt ?? 0) - (a.mergedAt ?? 0))[0] ??
    null
  );
}

export function derive(i: Inputs): View {
  const t = i.tower;
  const q = t.queue.data;
  const prs = t.prs.list;
  const files = new Map(i.lanes.map((l) => [l.branch, l]));
  const queued = new Map((q?.devQueue ?? []).map((l) => [l.branch, l]));

  // The lane universe: dispatch's queue first (its order), then lane files, open PRs, lock holders, today's merges.
  const names: string[] = [...queued.keys()];
  const add = (b: string | null | undefined) => {
    if (b && !names.includes(b)) names.push(b);
  };
  [...i.lanes.map((l) => l.branch)].sort().forEach(add);
  prs.filter((p) => p.state === 'OPEN' && !p.draft).map((p) => p.branch).sort().forEach(add);
  add(t.lock?.branch);
  add(t.lockB?.branch);
  prs.filter((p) => p.state === 'MERGED' && (p.mergedAt ?? 0) >= i.midnight).forEach((p) => add(p.branch));

  const rows = names.map((b) => {
    const file = files.get(b) ?? null;
    const queue = queued.get(b) ?? null;
    return laneRow({ branch: b, file, queue, pr: prFor(b, prs, queue?.pr ?? null, file?.pr ?? null) }, i);
  });

  // NEEDS YOU: lane asks, merges, failed deploys, dispatch's to-dos for Rahul, sources only Rahul can fix.
  const needs: NeedItem[] = [];
  for (const l of i.lanes) if (l.needs) needs.push(fromNeeds(l.needs, l.branch, l.updatedAt));
  for (const r of rows.filter((r) => r.state === 'MERGE ME' && r.pr)) {
    const waiting = (q?.devQueue ?? []).filter((l) => l.branch !== r.branch && (l.waitingOn ?? '').includes(`PR ${r.pr!.number}`));
    needs.push({
      kind: 'merge',
      what: `Merge PR ${r.pr!.number}: ${r.pr!.title}`,
      link: r.pr!.url,
      cmd: null,
      unblocks: waiting.length ? waiting.map((l) => l.branch).join(', ') : null,
      since: r.since,
      branch: r.branch,
    });
  }
  for (const r of rows.filter((r) => r.state === 'DEPLOY FAILED')) {
    const dep = deployFor(prs.find((p) => p.number === r.pr?.number)?.mergeSha ?? null, i.runs.value)?.run;
    needs.push({ kind: 'deploy', what: `Main deploy failed after PR ${r.pr?.number}`, link: dep?.url ?? null, cmd: null, unblocks: null, since: r.since, branch: r.branch });
  }
  for (const todo of q?.rahul ?? [])
    needs.push({ kind: 'todo', what: todo.text, link: null, cmd: null, unblocks: null, since: todo.since ? Date.parse(todo.since) || null : null, branch: null });
  if (i.mac.state === 'missing' || i.mac.state === 'silent')
    needs.push({
      kind: 'source',
      what: i.mac.state === 'missing' ? 'Install the Mac stats agent' : 'Mac stats silent: is the Mac asleep, or the agent stopped?',
      link: null,
      cmd: i.mac.state === 'missing' ? i.macInstall : null,
      unblocks: 'HEALTH → Mac',
      since: i.mac.at,
      branch: null,
    });

  const slots: SlotCard[] = (['dev', 'devb'] as const).map((slot) => {
    const lock = slot === 'dev' ? t.lock : t.lockB;
    const live = liveLock(lock, i.now);
    const file = live ? (files.get(lock.branch) ?? null) : null;
    return {
      slot,
      branch: live ? lock.branch : null,
      session: live ? (file?.session ?? lock.session ?? i.sessionsByBranch[lock.branch] ?? null) : null,
      detail: live ? slotDetail(slot, lock, i, file) : null,
      since: live && file?.phase === 'dev' ? file.phaseSince : null,
      expiresAt: live ? lock.expiresAt : null,
      live,
      asOf: lock?.asOf ?? null,
      failed: lock?.failed ?? false,
    };
  });

  const nowStates: State[] = ['BUILDING', 'TESTING', 'PR', 'CHECKS FAILED', 'MERGED', 'DEPLOYING', 'DEPLOY FAILED'];
  const next = {
    queue: (q?.devQueue ?? [])
      .filter((l) => l.state === 'next' || l.state === 'waiting')
      .map((l) => ({ slot: l.slot, branch: l.branch, state: l.state, waitingOn: l.waitingOn })),
    merge: rows.filter((r) => r.state === 'MERGE ME' || r.state === 'HOLD'),
    rahul:
      needs[0]?.what ??
      q?.plan.find((p) => p.kind === 'rahul' && p.at !== null && p.at >= i.now - 2 * 3600e3)?.what ??
      null,
  };

  const done = prs
    .filter((p) => p.state === 'MERGED' && p.mergedAt !== null && p.mergedAt >= i.midnight)
    .sort((a, b) => b.mergedAt! - a.mergedAt!)
    .map((p) => {
      const d = deployFor(p.mergeSha, i.runs.value);
      const dep = d?.run;
      const via = d?.via ? ` (by deploy ${dep!.number ?? ''}, its own superseded)` : '';
      const [deploy, tone]: [string, Tone] = !dep
        ? [i.runs.at === null ? 'deploy unknown (no runs read)' : 'deploy not seen', 'warn']
        : running(dep)
          ? [`deploying${via}`, 'warn']
          : dep.conclusion === 'success'
            ? [`deployed${via}`, 'good']
            : [`deploy ${dep.conclusion ?? 'failed'}${via}`, 'bad'];
      return { number: p.number, title: p.title, branch: p.branch, mergedAt: p.mergedAt!, deploy, tone, url: dep?.url ?? p.url };
    });

  const slipping: View['slipping'] = [
    ...staleFollowups(q?.followups ?? [], i.now).map((f) => ({ kind: 'followup' as const, what: `${f.id}: ${f.what}`, owner: f.owner, since: f.since })),
    ...rows.filter((r) => r.state === 'PARKED').map((r) => ({ kind: 'parked' as const, what: `${r.branch}${r.detail ? `: ${r.detail}` : ''}`, owner: r.session, since: r.since })),
    ...rows
      .filter((r) => r.state === 'BUILDING' && r.fileAge !== null && r.fileAge > STALE.laneQuiet)
      .map((r) => ({ kind: 'quiet' as const, what: `${r.branch}: no lane update`, owner: r.session, since: files.get(r.branch)!.updatedAt })),
  ];

  const g = t.gauges;
  const m = i.minutes?.state.value ?? null;
  return {
    v: 1,
    now: i.now,
    version: i.version,
    needs,
    slots,
    active: rows.filter((r) => nowStates.includes(r.state)),
    next,
    done,
    health: {
      container: g
        ? { at: g.t, anonMiB: g.anonMiB, highMiB: g.highMiB, anonSoft: g.anonSoft, anonHard: g.anonHard, cpu: g.cpu, cores: g.cores, pids: g.pids, pidsMax: g.pidsMax, tests: i.tests, testCap: i.testCap }
        : null,
      mac: i.mac,
      actions: m ? { minutes: m.minutes, of: ACTIONS_INCLUDED_MIN, counted: m.counted, total: m.total, month: m.month } : null,
      aws: i.aws,
    },
    slipping,
    sources: sources(i),
    problems: [...t.queue.problems.map((p) => `queue.json: ${p}`), ...i.laneProblems.map((p) => `lanes/${p.file}: ${p.problem}`)],
  };
}

const fromNeeds = (n: Needs, branch: string, since: number): NeedItem => ({
  kind: 'lane',
  what: `${branch}: ${n.what}`,
  link: n.link,
  cmd: n.cmd,
  unblocks: n.unblocks,
  since,
  branch,
});

// Every source with its age and state: a failed source is `failed` with its error, never quietly empty.
export function sources(i: Inputs): SourceRow[] {
  const t = i.tower;
  const age = (at: number | null) => (at === null ? Infinity : (i.now - at) / 1000);
  const fresh = (at: number | null, lim: number) => (age(at) > lim ? 'stale' : 'ok');
  const out: SourceRow[] = [];
  out.push(
    t.gauges
      ? { name: 'sampler', state: fresh(t.gauges.t, STALE.sampler), at: t.gauges.t, detail: null }
      : { name: 'sampler', state: 'missing', at: null, detail: 'no sample yet' },
  );
  for (const [name, l] of [['dev lock', t.lock], ['devb lock', t.lockB]] as const)
    out.push(
      !l
        ? { name, state: 'missing', at: null, detail: 'no lock cache' }
        : l.failed
          ? { name, state: 'failed', at: l.asOf, detail: 'last refresh failed' }
          : { name, state: fresh(l.asOf, STALE.lock), at: l.asOf, detail: null },
    );
  const q = t.queue;
  out.push(
    q.status === 'missing'
      ? { name: 'queue.json', state: 'missing', at: null, detail: null }
      : q.status === 'bad'
        ? { name: 'queue.json', state: 'failed', at: q.data?.updatedAt ?? null, detail: q.problems[0] ?? 'bad' }
        : { name: 'queue.json', state: fresh(q.data!.updatedAt, STALE.queue), at: q.data!.updatedAt, detail: null },
  );
  out.push(gh('gh PRs', { at: t.prs.at, error: t.prs.error }, i.now));
  out.push(gh('gh runs', i.runs, i.now));
  if (i.minutes) {
    const s = i.minutes.state;
    const m = s.value;
    const r = gh('Actions minutes', s, i.now, STALE.minutes);
    if (m && m.counted < m.total && r.state === 'ok') r.detail = `estimate, ${m.counted} of ${m.total} runs counted`;
    else if (m && r.state === 'ok') r.detail = 'estimate from job times';
    out.push(r);
  } else out.push({ name: 'Actions minutes', state: 'missing', at: null, detail: 'gh off' });
  const mac = i.mac;
  out.push({
    name: 'Mac stats',
    state: mac.state === 'ok' ? 'ok' : mac.state === 'stale' ? 'stale' : mac.state === 'missing' ? 'missing' : 'failed',
    at: mac.at,
    detail: mac.state === 'missing' ? 'agent not installed' : mac.state === 'silent' ? 'silent' : mac.error,
  });
  out.push({
    name: 'AWS costs',
    state: i.aws.state === 'ok' ? 'ok' : i.aws.state === 'stale' ? 'stale' : i.aws.state === 'missing' ? 'missing' : 'failed',
    at: i.aws.at,
    detail: i.aws.error ?? (i.aws.through ? `through ${i.aws.through}` : null),
  });
  out.push({
    name: 'lane files',
    state: i.laneProblems.length ? 'failed' : 'ok',
    at: i.lanes.reduce<number | null>((a, l) => (a === null || l.updatedAt > a ? l.updatedAt : a), null),
    detail: i.laneProblems.length ? `${i.laneProblems.length} unreadable` : `${i.lanes.length} lanes`,
  });
  return out;
}

function gh(name: string, c: { at: number | null; error: string | null }, now: number, lim = STALE.gh): SourceRow {
  if (c.error) return { name, state: 'failed', at: c.at, detail: c.error };
  if (c.at === null) return { name, state: 'missing', at: null, detail: 'not read yet' };
  return { name, state: (now - c.at) / 1000 > lim ? 'stale' : 'ok', at: c.at, detail: null };
}
