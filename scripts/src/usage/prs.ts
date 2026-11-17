// Calls → lane → phase → merged PR, the PR table and its type. docs/ops/USAGE-METER.md → PR table.
import type { PR } from './gh.ts';
import { laneOf, type Kind, type Role } from './lanes.ts';
import { clusters, phaseAt, timeline, type Phase, type Step } from './phases.ts';
import type { Loaded, SessionRec } from './store.ts';
import type { Marker } from './transcript.ts';

export interface Attributed {
  ts: number;
  qu: number;
  lane: string | null;
  role: Role;
  phase: Phase;
  kind: Kind;
  file: string;
  session: string; // project/sid of the main session
  track: string; // session|lane: one lane's work within one session, the unit a phase timeline covers
}
export interface Attribution {
  calls: Attributed[];
  timelines: Map<string, Step[]>; // by track
  markers: Map<string, Marker[]>; // main sessions' markers, by track
  orphans: number; // subagent files whose parent session is gone
}

const key = (s: SessionRec) => `${s.project}/${s.sid}`;

// Each call's lane is its own row's (rowLane), else its session's; the hub stays the hub wherever it cd's to. Phase
// timelines are per track (session × lane), since an older session could work on several lanes in turn.
export function attribute(l: Loaded, hub: string): Attribution {
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
  for (const s of mains.values())
    for (const m of l.markers.get(s.rel) ?? []) {
      const t = `${key(s)}|${resolve(s, m.lane).lane ?? ''}`;
      const list = markers.get(t) ?? [];
      list.push(m);
      markers.set(t, list);
    }
  const timelines = new Map([...markers].map(([t, ms]) => [t, timeline(ms)]));
  const byFile = new Map(l.sessions.map((s) => [s.rel, s]));
  const firstCall = new Map<string, number>();
  for (const c of l.calls) if (!firstCall.has(c.file)) firstCall.set(c.file, c.ts);
  const orphanFiles = new Set<string>();
  const calls = l.calls.map((c): Attributed => {
    const s = byFile.get(c.file)!;
    const k = key(s);
    if (!mains.has(k)) orphanFiles.add(c.file);
    const w = resolve(s, c.lane);
    const track = `${k}|${w.lane ?? ''}`;
    const steps = timelines.get(track);
    const at = s.kind === 'main' ? c.ts : (firstCall.get(c.file) ?? c.ts);
    const phase: Phase = w.role === 'lane' && steps ? phaseAt(steps, at) : 'unattributed';
    return {
      ts: c.ts,
      qu: c.qu,
      lane: w.lane,
      role: w.role,
      phase,
      kind: s.kind,
      file: c.file,
      session: k,
      track,
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
      const roundStarts = clusters(ms, ['review'], 10);
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
        localRuns: clusters(ms, ['local'], 5).length,
        devRuns: clusters(ms, ['devcheck'], 5).length,
        start: calls[0]?.ts ?? null,
        sessions,
      });
    });
  }
  return rows.sort((x, y) => x.mergedAt - y.mergedAt);
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
  // every branch with a merged PR, the lookback's included: none of them is "no merged PR"
  const merged = new Set([...rows.map((r) => r.branch), ...prs.map((p) => p.branch)]);
  const unmerged = new Map<string, number>();
  for (const c of a.calls) {
    if (!inWin(c.ts)) continue;
    if (c.role === 'hub') hubQU += c.qu;
    else if (c.role === 'adhoc') adhocQU += c.qu;
    else if (c.role === 'other') otherQU += c.qu;
    else if (c.lane && !merged.has(c.lane))
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
