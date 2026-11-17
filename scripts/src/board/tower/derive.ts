// The web tower's one derivation (docs/ops/TOWER.md): board state + lane files + GitHub → the View the page
// renders. Pure: every input is passed in, so each lane state and the automatic HOLD are tested on fixtures.
// Truth comes from locks, PRs and Actions runs; lane files add the phase, the step and what the maintainer must do.
import { SHAPE_PATHS } from '../../deploy-base.ts';
import { hhmm } from './fmt.ts';
import type { Behind } from './behind.ts';
import type { Checks, Cached, GhRun } from './gh.ts';
import type { Costs, MacRead } from './health.ts';
import { STEP_PHASES, type LaneFile, type LaneProblem, type Needs, type Range } from './lanes.ts';
import type { Lock, TowerState } from './model.ts';
import { nextAsk, planSoon, planTable, type Ask, type PlanRow } from './plan.ts';
import type { Pr } from './prs.ts';
import { firedFollowups, sinceTime, staleFollowups, type Lane } from './queue.ts';

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
  | 'PARKED'
  // no lane file yet: dispatch's queue.json state, in the maintainer's words
  | 'WAITING'
  | 'NEEDS YOU'
  | 'READY'
  | 'ON DEV';
export type Tone = 'normal' | 'dim' | 'good' | 'warn' | 'bad';

export type LaneRow = {
  branch: string;
  session: string | null;
  state: State;
  label: string; // the state in the maintainer's words: `TESTING on devb`, `HOLD (dev: …)`, `PR (checks running)`
  detail: string | null;
  tone: Tone;
  since: number | null;
  pr: { number: number; title: string; url: string | null } | null;
  hold: string | null;
  fileAge: number | null; // seconds since the lane file's last write; null = no file
  quiet: boolean; // a lane-file state (BUILDING) whose file hasn't moved in STALE.lane: amber on the page
  phase: string | null; // where on the track plan › build › gate › review › local › dev › pr › merged it is
  // the lane file's step plan (TOWER.md → Lane files): each step's estimate and time spent so far, live
  steps: LaneStep[] | null;
  eta: { next: Range | null; pr: Range | null; source: string; late: boolean } | null;
};
export type LaneStep = {
  phase: string;
  lo: number; // minutes
  hi: number;
  source: string;
  spentMin: number;
  state: 'done' | 'now' | 'todo';
};
export type NeedItem = {
  kind: 'lane' | 'merge' | 'deploy' | 'todo' | 'source';
  what: string;
  link: string | null;
  cmd: string | null;
  unblocks: string | null;
  since: number | null;
  sinceDay?: string | null; // `since` was a bare date (MM-DD): show the day, not a timer
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
  state: LockRead['state']; // the page shows `free` only for `free`, never for `unknown`
  why: string | null;
  asOf: number | null;
  failed: boolean;
  deploying: boolean; // dev with no live holder, a dispatch still running (a lock released mid-deploy): not free
};
export type SourceRow = {
  name: string;
  state: 'ok' | 'stale' | 'failed' | 'missing';
  at: number | null;
  detail: string | null;
};
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
  macReady: boolean; // the installer is on main (else the Mac tile says it installs at merge)
  aws: Costs;
};
export type View = {
  v: 1;
  now: number;
  version: string | null;
  behind: Behind | null; // the checkout moved past the served commit in a tower file: run `pnpm board sync-main`
  needs: NeedItem[];
  slots: SlotCard[];
  active: LaneRow[]; // NOW: in-flight lanes (needs you, ready, on dev, building, testing, PR, checks failed)
  next: {
    // dispatch's landing order (queue.json mergeOrder), each entry with its lane's row; merged ones dropped
    order: { branch: string; pr: number | null; note: string | null; row: LaneRow }[];
    queue: { slot: Slot; branch: string; state: string; waitingOn: string | null }[];
    merge: LaneRow[];
    maintainer: string | null;
    more: number; // further NEEDS YOU items after the one `maintainer` shows
    parked: string[];
    // the plan table (plan.ts): every plan[] row with its live marks, the now-line's place, dispatch's notes
    table: PlanRow[];
    nowIndex: number;
    soon: PlanRow[]; // the glance: the next few rows not yet finished
    notes: string[];
    planAt: number | null;
    ask: Ask | null; // when the maintainer is next asked for something
  };
  // each panel's headline number, for the strip an expanded panel keeps of the others
  heads: Record<'needs' | 'now' | 'next' | 'done' | 'slipping' | 'sources', string>;
  done: {
    number: number;
    title: string;
    branch: string;
    mergedAt: number;
    deploy: string; // short: `deployed ✓`, `deploying`, `deploy failed`
    deployDetail: string | null; // the long form, for the tooltip (`by deploy 274, its own superseded`)
    tone: Tone;
    url: string | null;
  }[];
  health: Health;
  slipping: {
    kind: 'followup' | 'fired' | 'parked' | 'quiet';
    what: string;
    owner: string | null;
    since: number | null;
    sinceDay?: string | null;
    after?: string | null; // a fired follow-up's trigger, as written
  }[];
  sources: SourceRow[];
  problems: string[];
};

export type Inputs = {
  now: number;
  version: string | null;
  behind: Behind | null;
  tower: TowerState;
  lanes: LaneFile[];
  laneProblems: LaneProblem[];
  sessionsByBranch: Record<string, string>;
  runs: Cached<GhRun[]>; // the newest runs: main Deploy + deploy-dev dispatches
  checks: (sha: string) => Checks | null;
  files: (sha: string) => { files: string[] | null; error: string | null } | null;
  mac: MacRead;
  aws: Costs;
  tests: number;
  testCap: number | null;
  macInstall: string; // NEEDS YOU's command when the Mac agent is missing
  macInstallReady: boolean; // tools/macstats/install.sh is on origin/main (the install line fetches it from there)
  dayStart: number; // where DONE TODAY begins: local midnight, reaching back 12 h before noon (web/main.ts dayStart)
};

// Freshness thresholds, seconds (TOWER.md → Sources): past them a source shows amber with its age.
export const STALE = {
  checks: 300,
  sampler: 90,
  lock: 300,
  gh: 180,
  queue: 7200,
  lane: 7200,
  laneQuiet: 86400,
};
const PARKED = /^PARKED/i; // dispatch's word for a parked lane, at the start of its waitingOn
const RUN_FRESH_MS = 2 * 3600e3; // a ledger run with no end older than this is an orphan, not in flight

export const liveLock = (l: Lock | null, now: number): l is Lock & { branch: string } =>
  !!l?.branch && l.expiresAt !== null && l.expiresAt > now;

const mainDeploys = (runs: GhRun[]) =>
  runs.filter((r) => r.name === 'Deploy' && r.event === 'push' && r.branch === 'main');
const running = (r: GhRun) => r.status !== 'completed';
const sinceAt = (at: number | null) => (at === null ? '' : `, last read ${hhmm(at)}`);

// A source read the maintainer can act on only when it is fresh: failed, stale or never read is `why`, never "fine".
export function ghFresh(
  c: { at: number | null; error: string | null },
  now: number,
  lim = STALE.gh,
): string | null {
  if (c.error) return `failed: ${c.error}${sinceAt(c.at)}`;
  if (c.at === null) return 'not read yet';
  return now - c.at > lim * 1000 ? `stale${sinceAt(c.at)}` : null;
}

// A dev slot's lock as the page may claim it: live, free, or unknown (no cache, no good read in 5 min, an unreadable
// expiry). An unknown lock is never shown as free and always holds a merge.
export type LockRead = { state: 'live' | 'free' | 'unknown'; why: string | null };
export function lockRead(l: Lock | null, now: number): LockRead {
  if (!l) return { state: 'unknown', why: 'no lock cache' };
  if (l.bad) return { state: 'unknown', why: l.bad };
  // devlock.sh's rule: a failed refresh matters once the last good read is stale (refreshes there fail now and then)
  if (l.asOf === null || now - l.asOf > STALE.lock * 1000)
    return {
      state: 'unknown',
      why: `${l.failed ? `refresh failed${l.failedWhy ? ` (${l.failedWhy})` : ''}` : 'cache stale'}${sinceAt(l.asOf)}`,
    };
  if (l.branch && l.expiresAt === null)
    return { state: 'unknown', why: 'holder expiry unreadable' };
  return liveLock(l, now) ? { state: 'live', why: null } : { state: 'free', why: null };
}

// An open devcheck run on a slot (a ledger run-start with no end, under 2 h: older is an orphan).
const openRun = (i: Inputs, slot: Slot) =>
  i.tower.runs.find(
    (r) => r.slot === slot && r.start !== null && r.end === null && i.now - r.start < RUN_FRESH_MS,
  );
// A dev dispatch in flight, matched by its run-name (display_title `deploy-dev <sha> <key>`).
const dispatching = (i: Inputs, sha?: string | null) =>
  i.runs.value.find(
    (r) =>
      running(r) &&
      (sha ? r.title.startsWith(`deploy-dev ${sha} `) : r.title.startsWith('deploy-dev ')),
  );

// A running dispatch that isn't devb's (devb's carries devb's holder sha): it may be dev's — a lock released or lapsed
// mid-deploy — so it holds dev. Every running one is checked: the newest may be devb's while an older one is dev's.
export const unattributedDispatch = (i: Inputs) => {
  const bSha = i.tower.lockB?.sha ?? null;
  return i.runs.value.find(
    (r) =>
      running(r) &&
      r.title.startsWith('deploy-dev ') &&
      !(bSha && r.title.startsWith(`deploy-dev ${bSha} `)),
  );
};

// The main Deploy run that carries a merge: its own, or, when that one was cancelled by a later merge (deploy.yml's
// concurrency group), the first later Deploy run that wasn't cancelled too: it deploys main's head and so this merge.
// (Not the newest: a run three merges on could still be running, or fail, after this one deployed.)
export function deployFor(
  mergeSha: string | null,
  runs: GhRun[],
): { run: GhRun; via: GhRun | null } | null {
  if (!mergeSha) return null;
  const deps = mainDeploys(runs);
  const own = deps.find((r) => r.sha === mergeSha);
  if (!own) return null;
  if (own.conclusion !== 'cancelled') return { run: own, via: null };
  const later = deps
    .filter((r) => (r.createdAt ?? 0) > (own.createdAt ?? 0) && r.conclusion !== 'cancelled')
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0];
  return later ? { run: later, via: own } : { run: own, via: null };
}

// What a slot's holder is doing, in the order the maintainer asks about it.
export function slotDetail(
  slot: Slot,
  lock: Lock & { branch: string },
  i: Inputs,
  file: LaneFile | null,
): string | null {
  if (lock.sha && dispatching(i, lock.sha)) return 'deploying';
  const run = openRun(i, slot);
  if (run) return `devcheck running since ${hhmm(run.start!)}`;
  if (file?.needs) return `held for you: ${file.needs.what}`;
  return file?.step ?? (file ? file.phase : null);
}

// The automatic merge HOLD (TOWER.md → HOLD): a main merge redeploys dev over a dispatched branch (CI-BOT.md →
// Dev deploys), and devb only when the merge changes devb's shape (deploy-base.ts → SHAPE_PATHS). First match wins.
export function holdReason(pr: Pr, queue: Lane | null, i: Inputs): string | null {
  const dev = lockRead(i.tower.lock, i.now);
  if (dev.state === 'unknown') return `dev lock unknown (${dev.why})`;
  const devLock = i.tower.lock!;
  if (dev.state === 'live' && devLock.branch !== pr.branch)
    return `dev: ${devLock.branch} is testing, lock to ${hhmm(devLock.expiresAt!)}`;
  const devRun = openRun(i, 'dev');
  if (devRun) return `dev: a devcheck is running since ${hhmm(devRun.start!)}`;
  const runs = ghFresh(i.runs, i.now);
  if (runs) return `main deploy state unknown (gh runs ${runs})`;
  // a running dispatch is devb's only when it carries devb's holder sha; any other may be dev's (a lock released
  // mid-deploy, a lapsed lock): unknown means hold
  const bSha = i.tower.lockB?.sha ?? null;
  const devbDispatch = bSha ? dispatching(i, bSha) : undefined;
  if (unattributedDispatch(i)) return 'a dev deploy is running';

  // devb only matters when the merge changes devb's shape
  const b = lockRead(i.tower.lockB, i.now);
  const bLock = i.tower.lockB;
  const bBusy =
    b.state === 'unknown'
      ? `devb lock unknown (${b.why})`
      : b.state === 'live' && bLock!.branch !== pr.branch
        ? `devb: ${bLock!.branch} is testing`
        : openRun(i, 'devb')
          ? 'devb: a devcheck is running'
          : devbDispatch
            ? 'a devb deploy is running'
            : null;
  if (bBusy) {
    const f = pr.sha ? i.files(pr.sha) : null;
    if (!f?.files)
      return `${bBusy} and this PR's files aren't read yet${f?.error ? ` (${f.error})` : ''}`;
    if (f.files.some(SHAPE_PATHS)) return `${bBusy} and this PR changes devb's shape`;
  }
  const dep = mainDeploys(i.runs.value).find(running);
  if (dep) return `main deploy${dep.number ? ` ${dep.number}` : ''} running`;
  // dispatch's own hold: unknown when queue.json, or this lane's entry in it, can't be read
  const q = i.tower.queue;
  if (!q.data)
    return `queue.json ${q.status === 'missing' ? 'missing' : 'unreadable'}: dispatch's hold unknown`;
  if (q.unread === 'all' || q.unread?.includes(pr.branch))
    return "queue.json: this lane's entry is unreadable, dispatch's hold unknown";
  return queue?.hold ?? null;
}

// The phase track's position: the lane file's phase, else what the state proves (a lock = dev, an open PR = pr).
export const TRACK = ['plan', 'build', 'gate', 'review', 'local', 'dev', 'pr', 'merged'] as const;
function trackPhase(state: State, file: LaneFile | null): string | null {
  if (state === 'TESTING') return 'dev';
  if (['PR', 'CHECKS FAILED', 'MERGE ME', 'HOLD'].includes(state)) return 'pr';
  if (['MERGED', 'DEPLOYING', 'DONE', 'DEPLOY FAILED'].includes(state)) return 'merged';
  return file && (TRACK as readonly string[]).includes(file.phase) ? file.phase : null;
}

type Ctx = { branch: string; file: LaneFile | null; queue: Lane | null; pr: Pr | null };

// The lane file's step plan, live: the current step's time includes the time in it so far. Its ETA is the lane's
// last word; `late` once the PR's window has passed with no PR open.
function laneSteps(file: LaneFile | null, now: number, pr: Pr | null) {
  if (!file?.plan) return { steps: null, eta: lateEta(file, now, pr) };
  const at = (STEP_PHASES as readonly string[]).indexOf(file.phase);
  const steps: LaneStep[] = file.plan.map((s) => {
    const k = STEP_PHASES.indexOf(s.phase);
    const live = s.phase === file.phase && file.phaseSince !== null ? now - file.phaseSince : 0;
    return {
      phase: s.phase,
      lo: s.lo,
      hi: s.hi,
      source: s.source,
      spentMin: Math.round((s.spentMs + Math.max(0, live)) / 60e3),
      // off the track: merged or cleanup has done every step; parked or blocked has none current and none done
      state:
        s.phase === file.phase
          ? 'now'
          : (at >= 0 && k < at) || file.phase === 'merged' || file.phase === 'cleanup'
            ? 'done'
            : 'todo',
    };
  });
  return { steps, eta: lateEta(file, now, pr) };
}
// once its PR is open or merged, the lane's PR window is spent: none shows (a re-test on dev included)
function lateEta(file: LaneFile | null, now: number, pr: Pr | null) {
  if (!file?.eta) return null;
  const spent = pr?.state === 'OPEN' || pr?.state === 'MERGED';
  const prEta = spent ? null : file.eta.pr;
  return { ...file.eta, pr: prEta, late: !!prEta && prEta.hi < now };
}

export function laneRow(c: Ctx, i: Inputs): LaneRow {
  const { branch, file, queue, pr } = c;
  const base = {
    branch,
    session: file?.session ?? queue?.session ?? i.sessionsByBranch[branch] ?? null,
    pr: pr ? { number: pr.number, title: pr.title, url: pr.url } : null,
    hold: null as string | null,
    fileAge: file ? Math.max(0, (i.now - file.updatedAt) / 1000) : null,
    quiet: false,
    ...laneSteps(file, i.now, pr),
  };
  const row = (
    state: State,
    label: string,
    detail: string | null,
    tone: Tone,
    since: number | null,
    hold: string | null = null,
  ): LaneRow => ({
    ...base,
    state,
    label,
    detail,
    tone,
    since,
    hold,
    phase: trackPhase(state, file),
  });

  if (file?.phase === 'parked' || PARKED.test(queue?.waitingOn ?? ''))
    return row(
      'PARKED',
      'PARKED',
      queue?.waitingOn ?? file?.step ?? null,
      'dim',
      file?.phaseSince ?? null,
    );

  if (pr?.state === 'MERGED') {
    const d = deployFor(pr.mergeSha, i.runs.value);
    if (!d) {
      const r = ghFresh(i.runs, i.now);
      return row(
        'MERGED',
        'MERGED',
        r ? `deploy unknown (gh runs ${r})` : 'deploy run not seen yet',
        'warn',
        pr.mergedAt,
      );
    }
    const dep = d.run;
    const via = d.via ? ` (its own was superseded)` : '';
    if (running(dep))
      return row(
        'DEPLOYING',
        'DEPLOYING',
        `main deploy${dep.number ? ` ${dep.number}` : ''}${via}`,
        'warn',
        dep.startedAt,
      );
    if (dep.conclusion === 'success')
      return row(
        'DONE',
        'DONE',
        d.via ? `by main deploy ${dep.number ?? ''}${via}`.trim() : null,
        'good',
        pr.mergedAt,
      );
    return row(
      'DEPLOY FAILED',
      'DEPLOY FAILED',
      `${dep.conclusion ?? 'failed'}${via}`,
      'bad',
      dep.startedAt,
    );
  }

  // a lane file past its merge, with no open PR (none in the newest 40, or a closed one): finished, so off NOW even
  // while it still holds a lock (its slot card shows that). An open PR wins: PRs are truth over lane files.
  if (file && (file.phase === 'merged' || file.phase === 'cleanup') && pr?.state !== 'OPEN')
    return row(
      'MERGED',
      'MERGED',
      pr
        ? `lane file says ${file.phase}; PR ${pr.number} is ${pr.state.toLowerCase()}`
        : 'PR not in the newest 40 read; `pnpm board lane --clear` at Cleanup',
      'warn',
      file.phaseSince,
    );

  for (const slot of ['dev', 'devb'] as const) {
    const lock = slot === 'dev' ? i.tower.lock : i.tower.lockB;
    if (liveLock(lock, i.now) && lock.branch === branch) {
      const r = lockRead(lock, i.now);
      return r.state === 'unknown'
        ? row('TESTING', `TESTING on ${slot}?`, `lock ${r.why}`, 'warn', null) // the last read said so; it may be over
        : row(
            'TESTING',
            `TESTING on ${slot}`,
            slotDetail(slot, lock, i, file),
            'warn',
            file?.phase === 'dev' ? file.phaseSince : null,
          );
    }
  }

  if (pr?.state === 'OPEN') {
    const ch = pr.sha ? i.checks(pr.sha) : null;
    const runs = ch?.runs ?? [];
    if (pr.draft) return row('PR', 'PR (draft)', null, 'dim', pr.createdAt);
    if (!runs.length)
      return row(
        'PR',
        'PR (no checks seen)',
        ch?.error ? `checks: ${ch.error}` : null,
        'warn',
        pr.createdAt,
      );
    if (runs.some(running))
      return row(
        'PR',
        'PR (checks running)',
        'running: ' +
          runs
            .filter(running)
            .map((r) => r.name)
            .join(', '),
        'warn',
        pr.createdAt,
      );
    const bad = runs.filter(
      (r) => r.conclusion !== 'success' && r.conclusion !== 'skipped' && r.conclusion !== 'neutral',
    );
    if (bad.length)
      return row(
        'CHECKS FAILED',
        'CHECKS FAILED',
        bad.map((r) => `${r.name} ${r.conclusion}`).join(', '),
        'bad',
        pr.createdAt,
      );
    // Green only from fresh reads: the PR list (its head may have moved) and this head's checks.
    const unsure =
      ghFresh(i.tower.prs, i.now) ?? (ch ? ghFresh(ch, i.now, STALE.checks) : 'not read yet');
    if (unsure) return row('PR', 'PR (checks unknown)', `gh ${unsure}`, 'warn', pr.createdAt);
    const hold = holdReason(pr, queue, i);
    if (hold) return row('HOLD', `HOLD (${hold})`, null, 'warn', pr.createdAt, hold);
    return row('MERGE ME', 'MERGE ME', null, 'good', pr.createdAt);
  }

  // No lane file yet (lanes write them from this PR on): dispatch's words for the lane, quietly.
  if (!file) {
    const words = queue?.waitingOn ?? queue?.note ?? null;
    switch (queue?.state) {
      case 'waiting':
      case 'next':
        return row(
          'WAITING',
          queue.state === 'next' ? 'NEXT FOR DEV' : 'WAITING',
          words,
          'dim',
          null,
        );
      case 'needs-you':
        return row('NEEDS YOU', 'NEEDS YOU', words, 'warn', null);
      case 'pr-open': // dispatch's word that the PR is open; the PR list hasn't shown it (a real one wins above)
        return row('PR', 'PR (opened)', words, 'normal', null);
      case 'ready':
        return row('READY', 'READY', words, 'good', null);
      case 'on-dev': // the lock says otherwise (no live lock for it): the queue's claim, marked
        return row(
          'ON DEV',
          `ON ${queue.slot}?`,
          words ?? 'the queue says on dev; no live lock seen',
          'warn',
          null,
        );
      default:
        return row('BUILDING', 'BUILDING', words, 'normal', null);
    }
  }
  const word: Record<string, string> = {
    plan: 'Plan',
    build: 'Build',
    gate: 'Gate',
    review: 'Review',
    local: 'Local',
    dev: 'Dev test',
    pr: 'PR',
    merged: 'Merged',
    cleanup: 'Cleanup',
    blocked: 'Blocked',
  };
  const w = word[file.phase] ?? file.phase;
  return {
    ...row(
      'BUILDING',
      'BUILDING',
      file.step ? `${w} · ${file.step}` : w,
      file.phase === 'blocked' ? 'bad' : 'normal',
      file.phaseSince,
    ),
    quiet: base.fileAge! > STALE.lane,
  };
}

// A landing-order entry's row when it isn't in the lane universe: its lane as far as anything knows it, or, with no
// lane file, queue entry or PR at all, NOT STARTED.
function orderRow(
  o: { branch: string; pr: number | null },
  i: Inputs,
  prs: Pr[],
  files: Map<string, LaneFile>,
  queued: Map<string, Lane>,
): LaneRow {
  const file = files.get(o.branch) ?? null;
  const queue = queued.get(o.branch) ?? null;
  const pr = prFor(o.branch, prs, o.pr, file?.pr ?? null);
  if (file || queue || pr) return laneRow({ branch: o.branch, file, queue, pr }, i);
  return {
    branch: o.branch,
    session: i.sessionsByBranch[o.branch] ?? null,
    state: 'WAITING',
    label: 'NOT STARTED',
    steps: null,
    eta: null,
    detail: null,
    tone: 'dim',
    since: null,
    pr: null,
    hold: null,
    fileAge: null,
    quiet: false,
    phase: null,
  };
}

// Which PR is a branch's: the open one, else the newest merged one.
function prFor(
  branch: string,
  prs: Pr[],
  queuePr: number | null,
  filePr: number | null,
): Pr | null {
  const mine = prs.filter((p) => p.branch === branch);
  const byNum = (n: number | null) => (n === null ? undefined : prs.find((p) => p.number === n));
  return (
    mine.find((p) => p.state === 'OPEN') ??
    byNum(filePr) ??
    byNum(queuePr) ??
    mine
      .filter((p) => p.state === 'MERGED')
      .sort((a, b) => (b.mergedAt ?? 0) - (a.mergedAt ?? 0))[0] ??
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
  prs
    .filter((p) => p.state === 'OPEN' && !p.draft)
    .map((p) => p.branch)
    .sort()
    .forEach(add);
  add(t.lock?.branch);
  add(t.lockB?.branch);
  prs
    .filter((p) => p.state === 'MERGED' && (p.mergedAt ?? 0) >= i.dayStart)
    .forEach((p) => add(p.branch));
  // dispatch's landing order (NEXT only: it names lanes that may not have started, which NOW never shows); an entry
  // whose PR merged (in the PR list's newest 40) has landed
  const landed = (o: { branch: string; pr: number | null }) =>
    prs.some(
      (p) => p.state === 'MERGED' && (o.pr !== null ? p.number === o.pr : p.branch === o.branch),
    );
  const order = (q?.mergeOrder ?? []).filter((o) => !landed(o));

  const rows = names.map((b) => {
    const file = files.get(b) ?? null;
    const queue = queued.get(b) ?? null;
    return laneRow(
      { branch: b, file, queue, pr: prFor(b, prs, queue?.pr ?? null, file?.pr ?? null) },
      i,
    );
  });

  // NEEDS YOU: lane asks, merges, failed deploys, dispatch's to-dos for the maintainer, sources only the maintainer can fix.
  const needs: NeedItem[] = [];
  for (const l of i.lanes) {
    if (!l.needs) continue;
    // an ask written before its lane's PR merged is finished with the lane; one written after is deliberate
    const p = prFor(l.branch, prs, queued.get(l.branch)?.pr ?? null, l.pr ?? null);
    if (p?.state === 'MERGED' && p.mergedAt !== null && l.updatedAt < p.mergedAt) continue;
    needs.push(fromNeeds(l.needs, l.branch, l.updatedAt));
  }
  // an unreadable lane file may have carried a needs item: say so where the maintainer looks first
  for (const p of i.laneProblems)
    needs.push({
      kind: 'source',
      what: `Lane file lanes/${p.file} is unreadable (${p.problem}): what it asked is unknown`,
      link: null,
      cmd: null,
      unblocks: null,
      since: null,
      branch: null,
    });
  // a lane in NEEDS YOU with no ask of its own (dispatch's queue says needs-you): its words are the ask
  for (const r of rows.filter((r) => r.state === 'NEEDS YOU' && !files.get(r.branch)?.needs))
    needs.push({
      kind: 'lane',
      what: `${r.branch}: ${r.detail ?? 'needs you (no detail in queue.json)'}`,
      link: null,
      cmd: null,
      unblocks: null,
      since: r.since,
      branch: r.branch,
    });
  for (const r of rows.filter((r) => r.state === 'MERGE ME' && r.pr)) {
    const waiting = (q?.devQueue ?? []).filter(
      (l) => l.branch !== r.branch && (l.waitingOn ?? '').includes(`PR ${r.pr!.number}`),
    );
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
    const dep = deployFor(
      prs.find((p) => p.number === r.pr?.number)?.mergeSha ?? null,
      i.runs.value,
    )?.run;
    needs.push({
      kind: 'deploy',
      what: `Main deploy failed after PR ${r.pr?.number}`,
      link: dep?.url ?? null,
      cmd: null,
      unblocks: null,
      since: r.since,
      branch: r.branch,
    });
  }
  for (const todo of q?.maintainer ?? []) {
    const since = sinceTime(todo.since);
    needs.push({
      kind: 'todo',
      what: todo.text,
      link: null,
      cmd: null,
      unblocks: null,
      since: since.at,
      sinceDay: since.day,
      branch: null,
    });
  }
  // the install line only once the installer is on main (before that it would 404): until then HEALTH says so
  if ((i.mac.state === 'missing' && i.macInstallReady) || i.mac.state === 'silent')
    needs.push({
      kind: 'source',
      what:
        i.mac.state === 'missing'
          ? 'Install the Mac stats agent'
          : 'Mac stats silent: is the Mac asleep, or the agent stopped?',
      link: null,
      cmd: i.mac.state === 'missing' ? i.macInstall : null,
      unblocks: 'HEALTH → Mac',
      since: i.mac.at,
      branch: null,
    });

  const slots: SlotCard[] = (['dev', 'devb'] as const).map((slot) => {
    const lock = slot === 'dev' ? t.lock : t.lockB;
    const read = lockRead(lock, i.now);
    const live = liveLock(lock, i.now); // a holder from a stale cache still shows, marked unknown
    const file = live ? (files.get(lock.branch) ?? null) : null;
    return {
      slot,
      branch: live ? lock.branch : null,
      session: live
        ? (file?.session ?? lock.session ?? i.sessionsByBranch[lock.branch] ?? null)
        : null,
      detail: live ? slotDetail(slot, lock, i, file) : null,
      since: live && file?.phase === 'dev' ? file.phaseSince : null,
      expiresAt: live ? lock.expiresAt : null,
      live,
      state: read.state,
      why: read.why,
      asOf: lock?.asOf ?? null,
      failed: lock?.failed ?? false,
      deploying: slot === 'dev' && !live && !!unattributedDispatch(i),
    };
  });

  // WAITING lanes show in NEXT's dev order, not in NOW; finished ones (merged, deploying, deployed, failed) only in
  // DONE TODAY, whose deploy marks and the DEPLOY FAILED need come from the PRs, not from NOW
  const nowStates: State[] = [
    'NEEDS YOU',
    'READY',
    'ON DEV',
    'BUILDING',
    'TESTING',
    'PR',
    'CHECKS FAILED',
  ];
  const byBranch = new Map(rows.map((r) => [r.branch, r]));
  const table = planTable(
    q?.plan ?? [],
    (b) => files.get(b)?.eta ?? null,
    (b) => prFor(b, prs, queued.get(b)?.pr ?? null, files.get(b)?.pr ?? null),
    i.now,
  );
  // the maintainer's next step: the first NEEDS YOU item, else the next plan[] step of theirs (undated, or timed
  // within 2 h of now either way: tomorrow evening's step never jumps the undated ones); the rest follow it
  const mine = (q?.plan ?? []).filter(
    (p) =>
      p.kind === 'maintainer' && !p.done && (p.at === null || Math.abs(p.at - i.now) <= 2 * 3600e3),
  );
  const first = needs[0]?.what ?? mine[0]?.what ?? null;
  const ask = nextAsk(
    table.rows,
    rows
      .filter((r) => nowStates.includes(r.state))
      .map((r) => ({
        branch: r.branch,
        eta: files.get(r.branch)?.eta ?? null,
        prOpen: prs.some((p) => p.branch === r.branch && p.state === 'OPEN'),
      })),
    i.now,
  );
  const next = {
    order: order
      .map((o) => ({ ...o, row: byBranch.get(o.branch) ?? orderRow(o, i, prs, files, queued) }))
      .filter((o) => !['MERGED', 'DEPLOYING', 'DONE', 'DEPLOY FAILED'].includes(o.row.state)),
    // parked lanes aren't next for dev: they get one muted line instead
    queue: (q?.devQueue ?? [])
      .filter(
        (l) => (l.state === 'next' || l.state === 'waiting') && !PARKED.test(l.waitingOn ?? ''),
      )
      .map((l) => ({ slot: l.slot, branch: l.branch, state: l.state, waitingOn: l.waitingOn })),
    parked: rows.filter((r) => r.state === 'PARKED').map((r) => r.branch),
    merge: rows.filter((r) => r.state === 'MERGE ME' || r.state === 'HOLD'),
    maintainer: first,
    more: Math.max(0, needs.length - 1),
    nowIndex: table.nowIndex,
    soon: planSoon(
      // the rows YOU NEXT and NEXT ASK already show aren't repeated
      table.rows.filter(
        (r) => r.what !== first && !(ask?.source === 'plan' && r.what === ask.what),
      ),
      i.now,
    ),
    table: table.rows,
    notes: q?.planNotes ?? [],
    planAt: q?.planAt ?? null,
    ask,
  };

  const done = prs
    .filter((p) => p.state === 'MERGED' && p.mergedAt !== null && p.mergedAt >= i.dayStart)
    .sort((a, b) => b.mergedAt! - a.mergedAt!)
    .map((p) => {
      const d = deployFor(p.mergeSha, i.runs.value);
      const dep = d?.run;
      const via = d?.via
        ? `by main deploy ${dep!.number ?? ''}: its own was superseded by a later merge`
        : dep?.number
          ? `main deploy ${dep.number}`
          : null;
      const r = ghFresh(i.runs, i.now);
      const [deploy, tone, detail]: [string, Tone, string | null] = !dep
        ? r
          ? ['deploy unknown', 'warn', `gh runs ${r}`]
          : ['deploy not seen', 'warn', 'not in the newest 100 runs']
        : running(dep)
          ? ['deploying', 'warn', via]
          : dep.conclusion === 'success'
            ? ['deployed ✓', 'good', via]
            : [`deploy ${dep.conclusion ?? 'failed'}`, 'bad', via];
      return {
        number: p.number,
        title: p.title,
        branch: p.branch,
        mergedAt: p.mergedAt!,
        deploy,
        deployDetail: detail,
        tone,
        url: dep?.url ?? p.url,
      };
    });

  const slipping: View['slipping'] = [
    ...staleFollowups(q?.followups ?? [], i.now).map((f) => ({
      kind: 'followup' as const,
      what: `${f.id}: ${f.what}`,
      owner: f.owner,
      since: f.since,
      sinceDay: f.sinceDay,
    })),
    // a follow-up whose trigger (a merge, a date) has happened: due, whatever its age
    ...firedFollowups(
      q?.followups ?? [],
      prs.flatMap((p) =>
        p.state === 'MERGED' && p.mergedAt !== null
          ? [{ branch: p.branch, number: p.number, mergedAt: p.mergedAt }]
          : [],
      ),
      i.now,
    ).map((f) => ({
      kind: 'fired' as const,
      what: `${f.id}: ${f.what}`,
      owner: f.owner,
      since: f.firedAt,
      after: f.after,
    })),
    ...rows
      .filter((r) => r.state === 'PARKED')
      .map((r) => ({
        kind: 'parked' as const,
        what: `${r.branch}${r.detail ? `: ${r.detail}` : ''}`,
        owner: r.session,
        since: r.since,
      })),
    ...rows
      .filter((r) => r.state === 'BUILDING' && r.fileAge !== null && r.fileAge > STALE.laneQuiet)
      .map((r) => ({
        kind: 'quiet' as const,
        what: `${r.branch}: no lane update`,
        owner: r.session,
        since: files.get(r.branch)!.updatedAt,
      })),
  ];

  const active = rows.filter((r) => nowStates.includes(r.state));
  const srcs = sources(i);
  const off = srcs.filter((s) => s.state !== 'ok').length;
  const heads: View['heads'] = {
    needs: String(needs.length),
    now: `${active.length} lane${active.length === 1 ? '' : 's'}`,
    next: next.ask
      ? `ask ${next.ask.late ? 'late' : next.ask.lo <= i.now ? 'now' : `~${hhmm(next.ask.lo)}`}`
      : `${next.order.length} to land`,
    done: String(done.length),
    slipping: String(slipping.length),
    sources: off ? `${off} off` : 'ok',
  };

  const g = t.gauges;
  return {
    v: 1,
    now: i.now,
    version: i.version,
    behind: i.behind,
    needs,
    slots,
    active,
    next,
    heads,
    done,
    health: {
      container: g
        ? {
            at: g.t,
            anonMiB: g.anonMiB,
            highMiB: g.highMiB,
            anonSoft: g.anonSoft,
            anonHard: g.anonHard,
            cpu: g.cpu,
            cores: g.cores,
            pids: g.pids,
            pidsMax: g.pidsMax,
            tests: i.tests,
            testCap: i.testCap,
          }
        : null,
      mac: i.mac,
      macReady: i.macInstallReady,
      aws: i.aws,
    },
    slipping,
    sources: srcs,
    problems: [
      ...t.queue.problems.map((p) => `queue.json: ${p}`),
      ...i.laneProblems.map((p) => `lanes/${p.file}: ${p.problem}`),
    ],
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
  for (const [name, l] of [
    ['dev lock', t.lock],
    ['devb lock', t.lockB],
  ] as const)
    out.push(
      !l
        ? { name, state: 'missing', at: null, detail: 'no lock cache' }
        : l.bad
          ? { name, state: 'failed', at: l.asOf, detail: l.bad }
          : fresh(l.asOf, STALE.lock) === 'stale'
            ? {
                name,
                state: l.failed ? 'failed' : 'stale',
                at: l.asOf,
                detail: l.failed ? `refresh failing${l.failedWhy ? `: ${l.failedWhy}` : ''}` : null,
              }
            : l.branch && l.expiresAt === null
              ? { name, state: 'failed', at: l.asOf, detail: 'holder expiry unreadable' }
              : {
                  name,
                  state: 'ok',
                  at: l.asOf,
                  detail: l.failed
                    ? `the last refresh failed${l.failedWhy ? ` (${l.failedWhy})` : ''}; this read stands`
                    : null,
                },
    );
  const q = t.queue;
  out.push(
    q.status === 'missing'
      ? { name: 'queue.json', state: 'missing', at: null, detail: null }
      : q.status === 'bad'
        ? {
            name: 'queue.json',
            state: 'failed',
            at: q.data?.updatedAt ?? null,
            detail: q.problems[0] ?? 'bad',
          }
        : {
            name: 'queue.json',
            state: fresh(q.data!.updatedAt, STALE.queue),
            at: q.data!.updatedAt,
            detail: null,
          },
  );
  const forks = t.prs.forks ?? 0;
  const prRow = gh('gh PRs', { at: t.prs.at, error: t.prs.error }, i.now);
  // fork PRs are dropped at the read, so the newest-40 window held that many fewer of ours
  if (forks && !prRow.detail)
    prRow.detail = `${forks} fork PR${forks > 1 ? 's' : ''} dropped of the newest 40`;
  out.push(prRow);
  out.push(gh('gh runs', i.runs, i.now));
  const open = t.prs.list.filter((p) => p.state === 'OPEN' && !p.draft && p.sha);
  const bad = open.map((p) => ({ p, c: i.checks(p.sha!) })).filter(({ c }) => !c || c.error);
  out.push(
    !open.length
      ? { name: 'gh checks', state: 'ok', at: t.prs.at, detail: 'no open PRs' }
      : bad.length
        ? {
            name: 'gh checks',
            state: bad.some(({ c }) => c?.error) ? 'failed' : 'missing',
            at: null,
            detail: bad
              .map(({ p, c }) => `PR ${p.number}: ${c?.error ?? 'not read yet'}`)
              .join('; '),
          }
        : {
            name: 'gh checks',
            state: open.some((p) => i.now - (i.checks(p.sha!)!.at ?? 0) > STALE.checks * 1000)
              ? 'stale'
              : 'ok',
            at: Math.min(...open.map((p) => i.checks(p.sha!)!.at ?? 0)),
            detail: `${open.length} open PRs`,
          },
  );
  const mac = i.mac;
  out.push({
    name: 'Mac stats',
    state:
      mac.state === 'ok'
        ? 'ok'
        : mac.state === 'stale'
          ? 'stale'
          : mac.state === 'missing'
            ? 'missing'
            : 'failed',
    at: mac.at,
    detail:
      mac.state === 'missing'
        ? 'agent not installed'
        : mac.state === 'silent'
          ? 'silent'
          : mac.error,
  });
  out.push({
    name: 'AWS costs',
    state:
      i.aws.state === 'ok'
        ? 'ok'
        : i.aws.state === 'stale'
          ? 'stale'
          : i.aws.state === 'missing'
            ? 'missing'
            : 'failed',
    at: i.aws.at,
    detail: i.aws.error ?? (i.aws.through ? `through ${i.aws.through}` : null),
  });
  out.push({
    name: 'lane files',
    state: i.laneProblems.length ? 'failed' : 'ok',
    at: i.lanes.reduce<number | null>(
      (a, l) => (a === null || l.updatedAt > a ? l.updatedAt : a),
      null,
    ),
    detail: i.laneProblems.length
      ? `${i.laneProblems.length} unreadable`
      : `${i.lanes.length} lanes`,
  });
  return out;
}

function gh(name: string, c: { at: number | null; error: string | null }, now: number): SourceRow {
  if (c.error) return { name, state: 'failed', at: c.at, detail: c.error };
  if (c.at === null) return { name, state: 'missing', at: null, detail: 'not read yet' };
  return { name, state: (now - c.at) / 1000 > STALE.gh ? 'stale' : 'ok', at: c.at, detail: null };
}
