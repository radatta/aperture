// Where a transcript file sits → whose work it is. Claude Code names a project dir after the session's cwd with `/`
// and `.` turned into `-`, so a lane's worktree `/workspace/.claude/worktrees/<branch>` is
// `-workspace--claude-worktrees-<branch>` and the main checkout is `-workspace`. Per session:
//   <project>/<sid>.jsonl                                          main
//   <project>/<sid>/subagents/agent-<id>.jsonl                     subagent (+ agent-<id>.meta.json)
//   <project>/<sid>/subagents/workflows/wf_<w>/agent-<id>.jsonl    workflow agent

export type Kind = 'main' | 'subagent' | 'workflow';
export type Role = 'lane' | 'hub' | 'adhoc' | 'other';

export interface FileRef {
  project: string;
  sid: string;
  agentId?: string;
  kind: Kind;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A path relative to the projects root → its ref, or null for anything that isn't a transcript.
export function fileRef(rel: string): FileRef | null {
  const parts = rel.split('/');
  const [project, a, b, c, d, e] = parts;
  if (!project || !a) return null;
  if (parts.length === 2) {
    const sid = a.replace(/\.jsonl$/, '');
    return a.endsWith('.jsonl') && UUID.test(sid) ? { project, sid, kind: 'main' } : null;
  }
  const agent = (f: string | undefined) => /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(f ?? '')?.[1];
  if (!UUID.test(a) || b !== 'subagents') return null;
  if (parts.length === 4 && agent(c))
    return { project, sid: a, agentId: agent(c), kind: 'subagent' };
  if (parts.length === 6 && c === 'workflows' && /^wf_[A-Za-z0-9-]+$/.test(d ?? '') && agent(e))
    return { project, sid: a, agentId: agent(e), kind: 'workflow' };
  return null;
}

const WORKTREE_DIR = '-workspace--claude-worktrees-';
const WORKTREE_CWD = /^\/workspace\/\.claude\/worktrees\/([a-z0-9][a-z0-9-]{0,62})(\/|$)/;
const BRANCH = /^[a-z0-9][a-z0-9-]{0,62}$/;
const NOT_LANES = new Set(['main', 'master', 'dev', 'HEAD']);

// The lane one transcript row was working in: its git branch (what a PR's headRefName matches), else its cwd's
// worktree. Older lanes ran from the main checkout and worked in a worktree by cd, so the session alone can't say.
// undefined in the main checkout (detached at main).
export function rowLane(cwd: unknown, gitBranch: unknown): string | undefined {
  if (typeof gitBranch === 'string' && BRANCH.test(gitBranch) && !NOT_LANES.has(gitBranch))
    return gitBranch;
  return typeof cwd === 'string' ? WORKTREE_CWD.exec(cwd)?.[1] : undefined;
}

// The lane and role of a session: a worktree session is that lane's; in the main checkout the hub (by its
// scripts/board/hub.json name) is the hub and anything else is ad hoc; a project outside /workspace is other.
// The first row's cwd wins over the project dir, which loses `.` vs `-`.
export function laneOf(
  project: string,
  cwd: string | undefined,
  name: string | undefined,
  hub: string,
): { lane: string | null; role: Role } {
  const fromCwd = cwd ? WORKTREE_CWD.exec(cwd)?.[1] : undefined;
  if (fromCwd) return { lane: fromCwd, role: 'lane' };
  if (project.startsWith(WORKTREE_DIR))
    return { lane: project.slice(WORKTREE_DIR.length), role: 'lane' };
  if (project === '-workspace')
    return name === hub ? { lane: null, role: 'hub' } : { lane: null, role: 'adhoc' };
  return { lane: null, role: 'other' };
}
