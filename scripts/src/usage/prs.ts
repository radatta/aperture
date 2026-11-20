// Calls → lane → phase → merged PR, the PR table and its type. docs/ops/USAGE-METER.md → PR table.
import type { PR } from './gh.ts';
import { laneOf, type Kind, type Role } from './lanes.ts';
import { clusters, stepAt, timeline, type Phase, type PhaseSrc, type Step } from './phases.ts';
import type { PhaseLogRow } from './phaselog.ts';
import type { Parts } from './prices.ts';
import type { Loaded, SessionRec } from './store.ts';
import type { Marker } from './transcript.ts';

export interface Attributed {
  ts: number;
  qu: number;
  lane: string | null;
  role: Role;
  phase: Phase;
  phaseSrc: PhaseSrc | 'none'; // what set the phase: none = unattributed
  kind: Kind;
  file: string;
  session: string; // project/sid of the main session
  track: string; // session|lane: one lane's work within one session, the unit a phase timeline covers
  model: string;
  agentType?: string; // a subagent's type (from its meta.json); workflow agents and main sessions have none
  ctx: number; // the context this call read: input + cache writes + cache reads
  parts: Parts;
}
export interface Attribution {
  calls: Attributed[];
  timelines: Map<string, Step[]>; // by track
  markers: Map<string, Marker[]>; // main sessions' markers, by track
  orphans: number; // subagent files whose parent session is gone
}

const key = (s: SessionRec) => `${s.project}/${s.sid}`;

// A phase-log row joins a lane track whose main-session calls span its time, give or take this.
export const LOG_SLACK_MS = 2 * 60_000;

// Each call's lane is its own row's (rowLane), else its session's; the hub stays the hub wherever it cd's to. Phase
// timelines are per track (session × lane), since an older session could work on several lanes in turn. The phase
// logger's rows (phaselog.ts) are a lane's, not a session's: each joins every track of its lane whose main calls
// span its time, as an explicit marker, and a track that starts with none opens at the lane's last logged phase.
export function attribute(l: Loaded, hub: string, log: PhaseLogRow[] = []): Attribution {
  const mains = new Map<string, SessionRec>();
  for (const s of l.sessions) if (s.kind === 'main') mains.set(key(s), s);
  const who = new Map<string, { lane: string | null; role: Role }>();
  const whoOf = (s: SessionRec) => {
    const k = key(s);
    let w = who.get(k);
    if (!w) {
      const base = mains.get(k) ?? s;
      w = laneOf(base.project, base.cwd, base.name, hub);
      who.set(k, w);
    }
    return w;
  };
  const resolve = (s: SessionRec, hint: string | undefined) => {
    const w = whoOf(s);
    // the hub stays the hub wherever it cd's; another repo's branch is never an Aperture lane
    if (w.role === 'hub' || w.role === 'other') return w;
    const lane = hint ?? w.lane;
    return lane ? { lane, role: 'lane' as Role } : w;
  };
  const markers = new Map<string, Marker[]>();
  const push = (t: string, m: Marker) => {
    const list = markers.get(t) ?? [];
    list.push(m);
    markers.set(t, list);
  };
  for (const s of mains.values())
    for (const m of l.markers.get(s.rel) ?? [])
      push(`${key(s)}|${resolve(s, m.lane).lane ?? ''}`, m);
  const byFile = new Map(l.sessions.map((s) => [s.rel, s]));
  const pre = l.calls.map((c) => {
    const s = byFile.get(c.file)!;
    const k = key(s);
    const w = resolve(s, c.lane);
    return { c, s, k, w, track: `${k}|${w.lane ?? ''}` };
  });
  if (log.length) {
    const span = new Map<string, { lane: string; lo: number; hi: number }>();
    for (const p of pre) {
      if (p.w.role !== 'lane' || !p.w.lane || p.s.kind !== 'main') continue;
      const sp = span.get(p.track) ?? { lane: p.w.lane, lo: p.c.ts, hi: p.c.ts };
      sp.lo = Math.min(sp.lo, p.c.ts);
      sp.hi = Math.max(sp.hi, p.c.ts);
      span.set(p.track, sp);
    }
    for (const [t, sp] of span) {
      const lane = log.filter((r) => r.lane === sp.lane);
      const inSpan = lane.filter(
        (r) => r.ts >= sp.lo - LOG_SLACK_MS && r.ts <= sp.hi + LOG_SLACK_MS,
      );
      for (const r of inSpan)
        if (r.to) push(t, { ts: r.ts, kind: 'lane-phase', phase: r.to, lane: r.lane, src: 'log' });
      // a session that resumed a lane (after /clear or a restart) opens at the phase the log last saw it in
      const before = lane.filter((r) => r.ts < sp.lo - LOG_SLACK_MS).at(-1);
      if (before?.to && !inSpan.some((r) => r.ts <= sp.lo))
        push(t, { ts: sp.lo, kind: 'lane-phase', phase: before.to, lane: sp.lane, src: 'log' });
    }
  }
  const timelines = new Map([...markers].map(([t, ms]) => [t, timeline(ms)]));
  const firstCall = new Map<string, number>();
  for (const c of l.calls) if (!firstCall.has(c.file)) firstCall.set(c.file, c.ts);
  const orphanFiles = new Set<string>();
  const calls = pre.map(({ c, s, k, w, track }): Attributed => {
    if (!mains.has(k)) orphanFiles.add(c.file);
    const steps = timelines.get(track);
    const at = s.kind === 'main' ? c.ts : (firstCall.get(c.file) ?? c.ts);
    const step = w.role === 'lane' && steps ? stepAt(steps, at) : null;
    return {
      ts: c.ts,
      qu: c.qu,
      lane: w.lane,
      role: w.role,
      phase: step?.phase ?? 'unattributed',
      phaseSrc: step?.src ?? 'none',
      kind: s.kind,
      file: c.file,
      session: k,
      track,
      model: c.model,
      ...(s.agentType ? { agentType: s.agentType } : {}),
      ctx: c.i + c.cw5 + c.cw1 + c.cr,
      parts: c.parts,
    };
  });
  return { calls, timelines, markers, orphans: orphanFiles.size };
}

export type PRType = 'research' | 'infra-ci' | 'small-fix' | 'feature';
export const PR_TYPES: PRType[] = ['research', 'infra-ci', 'small-fix', 'feature'];

const INFRA =
  /^(cdk|\.github|scripts|tools|\.claude)\/|^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json|eslint\.config\.[cm]?js|\.nvmrc|\.prettierrc[^/]*)$/;
const DOCS = /^docs\/|\.md$/i;

// First match wins: research (docs-only, or mostly workflow-agent work), infra/CI (over half the files in tooling
// or infra paths), small fix (≤ 7 files), feature.
export function prType(pr: Pick<PR, 'files' | 'changedFiles'>, workflowShare = 0): PRType {
  const f = pr.files;
  if ((f.length && f.every((p) => DOCS.test(p))) || workflowShare > 0.5) return 'research';
  if (f.length && f.filter((p) => INFRA.test(p)).length / f.length > 0.5) return 'infra-ci';
  if (pr.changedFiles <= 7) return 'small-fix';
  return 'feature';
}

export const POST_MS = 6 * 3_600_000;

// The paths whose change needs a browser or device check: the analysis's strongest predictor after diff size.
export const UI_PATHS = /^(app|extension)\//;
// A review round's start: the old review marker, or any review lens's spawn (code-reviewer, review-*, the fix
// recheck review-fixes included — it carries no review marker of its own).
export const isReviewLens = (t: string | undefined) =>
  t === 'code-reviewer' || !!t?.startsWith('review-');
const reviewStart = (m: Marker) =>
  m.kind === 'review' || (m.kind === 'spawn' && isReviewLens(m.agentType));

export interface AgentRun {
  agentType: string; // 'workflow' for a workflow agent, 'general-purpose' when meta.json named none
  model: string; // the run's model by most QU
  qu: number;
}

export interface PRRow {
  number: number;
  branch: string;
  type: PRType;
  mergedAt: number;
  files: number;
  lines: number;
  qu: number;
  byPhase: Partial<Record<Phase, number>>;
  turns: number; // main-session calls
  subagents: number; // subagent + workflow agent runs with calls
  workflowShare: number;
  rounds: number;
  roundStarts: number[];
  rechecks: number; // review-fixes runs
  filesCut: boolean; // more files changed than gh listed, so ui was read from part of the list
  ui: boolean;
  runs: AgentRun[];
  mainQU: number;
  ctxSumM: number; // the main session's context summed over its turns, in millions of tokens
  lensRegime: boolean; // the current review workflow: at least one review-* lens ran
  localRuns: number;
  devRuns: number;
  start: number | null;
  sessions: string[]; // tracks
}

export function prTable(a: Attribution, prs: PR[], since: number): PRRow[] {
  const byBranch = new Map<string, PR[]>();
  for (const p of [...prs].sort((x, y) => x.mergedAt - y.mergedAt)) {
    const list = byBranch.get(p.branch) ?? [];
    list.push(p);
    byBranch.set(p.branch, list);
  }
  const laneCalls = new Map<string, Attributed[]>();
  for (const c of a.calls) {
    if (c.role !== 'lane' || !c.lane) continue;
    const list = laneCalls.get(c.lane) ?? [];
    list.push(c);
    laneCalls.set(c.lane, list);
  }
  const rows: PRRow[] = [];
  for (const [branch, list] of byBranch) {
    list.forEach((pr, i) => {
      if (pr.mergedAt < since) return;
      const lo = i ? list[i - 1]!.mergedAt : -Infinity;
      const last = i === list.length - 1;
      // after the merge: cleanup and the deploy watch, up to POST_MS; later work on the branch name is not this PR's
      const hi = last ? pr.mergedAt + POST_MS : pr.mergedAt;
      const calls = (laneCalls.get(branch) ?? []).filter((c) => c.ts > lo && c.ts <= hi);
      const byPhase: Partial<Record<Phase, number>> = {};
      let qu = 0;
      let wf = 0;
      for (const c of calls) {
        const ph: Phase = c.ts > pr.mergedAt ? 'post' : c.phase;
        byPhase[ph] = (byPhase[ph] ?? 0) + c.qu;
        qu += c.qu;
        if (c.kind === 'workflow') wf += c.qu;
      }
      const sessions = [...new Set(calls.map((c) => c.track))];
      const ms = sessions
        .flatMap((s) => a.markers.get(s) ?? [])
        .filter((m) => m.ts > lo && m.ts <= pr.mergedAt);
      const roundStarts = clusters(ms, reviewStart, 10);
      const runs = agentRuns(calls);
      const workflowShare = qu ? wf / qu : 0;
      rows.push({
        number: pr.number,
        branch,
        type: prType(pr, workflowShare),
        mergedAt: pr.mergedAt,
        files: pr.changedFiles,
        lines: pr.additions + pr.deletions,
        qu,
        byPhase,
        turns: calls.filter((c) => c.kind === 'main').length,
        subagents: new Set(calls.filter((c) => c.kind !== 'main').map((c) => c.file)).size,
        workflowShare,
        rounds: roundStarts.length,
        roundStarts,
        // by tool-use id: a fork copies its parent's rows, spawns and all
        rechecks: new Set(
          ms
            .filter((m) => m.kind === 'spawn' && m.agentType === 'review-fixes')
            .map((m, i) => m.toolUseId ?? `#${i}`),
        ).size,
        ui: pr.files.some((f) => UI_PATHS.test(f)),
        filesCut: pr.changedFiles > pr.files.length, // gh lists 100 files at most
        runs,
        mainQU: calls.filter((c) => c.kind === 'main').reduce((x, c) => x + c.qu, 0),
        ctxSumM: calls.filter((c) => c.kind === 'main').reduce((x, c) => x + c.ctx, 0) / 1e6,
        lensRegime: runs.some((r) => r.agentType.startsWith('review-')),
        localRuns: clusters(ms, ['local'], 5).length,
        devRuns: clusters(ms, ['devcheck'], 5).length,
        start: calls[0]?.ts ?? null,
        sessions,
      });
    });
  }
  return rows.sort((x, y) => x.mergedAt - y.mergedAt);
}

// One run per subagent or workflow-agent file among a PR's calls, with its type and its model by most QU.
export function agentRuns(calls: Attributed[]): AgentRun[] {
  const byFile = new Map<string, { agentType: string; qu: number; models: Map<string, number> }>();
  for (const c of calls) {
    if (c.kind === 'main') continue;
    const r = byFile.get(c.file) ?? {
      agentType: c.kind === 'workflow' ? 'workflow' : (c.agentType ?? 'general-purpose'),
      qu: 0,
      models: new Map<string, number>(),
    };
    r.qu += c.qu;
    r.models.set(c.model, (r.models.get(c.model) ?? 0) + c.qu);
    byFile.set(c.file, r);
  }
  return [...byFile.values()].map((r) => ({
    agentType: r.agentType,
    model: [...r.models].sort((x, y) => y[1] - x[1])[0]![0],
    qu: r.qu,
  }));
}

export interface Overhead {
  hubQU: number;
  adhocQU: number;
  otherQU: number;
  unmerged: { lane: string; qu: number }[]; // lanes with calls in the window and no merged PR
  perPR: number | null; // hub QU spread over the merged PRs in the window
  from: number | null;
  to: number | null;
}

export function overhead(a: Attribution, rows: PRRow[], prs: PR[] = []): Overhead {
  const covered = rows.filter((r) => r.qu > 0);
  const from = covered.length ? Math.min(...covered.map((r) => r.start ?? r.mergedAt)) : null;
  const to = covered.length ? Math.max(...covered.map((r) => r.mergedAt)) : null;
  const inWin = (t: number) => from !== null && to !== null && t >= from && t <= to;
  let hubQU = 0;
  let adhocQU = 0;
  let otherQU = 0;
  // a branch in the table is merged; one whose PR merged only in the lookback counts as merged up to that PR's post
  // window, after which a reused name is new, unmerged work
  const merged = new Set(rows.map((r) => r.branch));
  const lookback = new Map<string, number>();
  for (const p of prs)
    if (!merged.has(p.branch))
      lookback.set(p.branch, Math.max(lookback.get(p.branch) ?? -Infinity, p.mergedAt));
  const unmerged = new Map<string, number>();
  for (const c of a.calls) {
    if (!inWin(c.ts)) continue;
    if (c.role === 'hub') hubQU += c.qu;
    else if (c.role === 'adhoc') adhocQU += c.qu;
    else if (c.role === 'other') otherQU += c.qu;
    else if (c.lane && !merged.has(c.lane) && c.ts > (lookback.get(c.lane) ?? -Infinity) + POST_MS)
      unmerged.set(c.lane, (unmerged.get(c.lane) ?? 0) + c.qu);
  }
  return {
    hubQU,
    adhocQU,
    otherQU,
    unmerged: [...unmerged].map(([lane, qu]) => ({ lane, qu })).sort((x, y) => y.qu - x.qu),
    perPR: covered.length ? hubQU / covered.length : null,
    from,
    to,
  };
}
