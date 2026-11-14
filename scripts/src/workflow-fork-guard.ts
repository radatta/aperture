// The public-repo posture of our workflows (INFRA §9 → Public repo). A fork's pull request must fail, not skip: a job
// skipped by `if:` reports Success, and a skipped required check passes. So every job that runs steps opens with the
// same `Fork guard` step, which fails anything but a push, a dispatch or a same-repo pull request.
//
// The guard is not the security boundary — a fork's `pull_request` run uses the fork's own copy of these files. The
// boundary is GitHub's (no secrets and a read-only token for a fork's run), the environments' branch policies and the
// roles' OIDC trust (cdk/src/cicd.test.ts). The guard turns an ordinary fork PR into an honest red X, and this checker
// pins the rest of the posture on our own files: who can trigger, what runs where, what a PR run can reach.
//
// Like workflow-permissions.ts, a narrow reader for our own 2-space layout, not a YAML parser: a shape it can't read
// throws rather than guess.

import { parseWorkflow } from './workflow-permissions';

// The step, byte for byte, as it sits under `    steps:` (6-space list indent).
export const GUARD_STEP = `      - name: Fork guard
        env:
          EVENT: \${{ github.event_name }}
          HEAD_REPO: \${{ github.event.pull_request.head.repo.full_name }}
        run: |
          case "$EVENT" in
            push | workflow_dispatch) exit 0 ;;
            pull_request) if [ "$HEAD_REPO" = "$GITHUB_REPOSITORY" ]; then exit 0; fi ;;
          esac
          echo "::error::this repo's workflows don't run for pull requests from forks (or for event '$EVENT')"
          exit 1`;

// The script GitHub runs: the `run: |` body, dedented.
export const guardScript = () =>
  GUARD_STEP.split('\n')
    .slice(GUARD_STEP.split('\n').findIndex((l) => l.trim() === 'run: |') + 1)
    .map((l) => l.slice(10))
    .join('\n');

// Events a workflow may start on. A called workflow (workflow_call) sees its caller's event.
export const EVENTS = ['push', 'pull_request', 'workflow_dispatch', 'workflow_call'];
// Third-party actions by owner/repo; the version is Dependabot's to bump. A new one is a deliberate edit here.
export const ACTIONS = [
  'actions/cache',
  'actions/checkout',
  'actions/setup-node',
  'actions/upload-artifact',
  'aws-actions/configure-aws-credentials',
  'gitleaks/gitleaks-action',
];

const isContent = (l: string) => !!l.trim() && !l.trim().startsWith('#');
const code = (l: string) => l.replace(/(^|\s)#.*$/, '');
const WF = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const ACTION = /^\.github\/actions\/([^/]+)\/action\.ya?ml$/;

function triggers(file: string, text: string): string[] {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^['"]?on['"]?\s*:/.test(l));
  if (at < 0 || code(lines[at]!).trim() !== 'on:')
    throw new Error(`${file}: on: must be a bare block`);
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (!isContent(l)) continue;
    if (/^\S/.test(l)) break;
    const ev = /^ {2}([a-z_]+):\s*$/.exec(code(l));
    if (ev) out.push(ev[1]!);
    else if (!/^ {4}/.test(l)) throw new Error(`${file}: unreadable trigger line "${l.trim()}"`);
  }
  if (!out.length) throw new Error(`${file}: no events read under on:`);
  return out;
}

// Each job's own lines, from its key to the next job (or the end of jobs:).
function jobBlocks(text: string): Record<string, string[]> {
  const lines = text.split('\n');
  const out: Record<string, string[]> = {};
  let inJobs = false;
  let cur: string[] | undefined;
  for (const l of lines) {
    if (/^\S/.test(l) && isContent(l)) {
      inJobs = /^jobs:\s*$/.test(code(l));
      cur = undefined;
      continue;
    }
    const key = inJobs && /^ {2}([A-Za-z0-9_-]+):/.exec(l);
    if (key) cur = out[key[1]!] = [];
    else cur?.push(l);
  }
  return out;
}

// Lines of the steps list, from just after `    steps:` to the next 4-space job key.
function stepLines(job: string[]): string[] | undefined {
  const at = job.findIndex((l) => code(l).trimEnd() === '    steps:');
  if (at < 0) return undefined;
  const end = job.findIndex((l, i) => i > at && isContent(l) && /^ {4}\S/.test(l));
  return job.slice(at + 1, end < 0 ? undefined : end);
}

// `files` maps a repo-relative path (.github/workflows/ci.yml, .github/actions/setup/action.yml) to its text.
export function checkForkGuard(files: Record<string, string>): string[] {
  const problems: string[] = [];
  const workflows = Object.keys(files).filter((f) => WF.test(f));
  const actions = Object.keys(files).filter((f) => ACTION.test(f));
  for (const f of Object.keys(files))
    if (!WF.test(f) && !ACTION.test(f)) throw new Error(`${f}: not a workflow or an action`);
  if (!workflows.length) throw new Error('no workflows read');

  const localUses: Record<string, string[]> = {}; // file → the local workflows and actions it calls
  const allUses = new Map<string, string>(); // a third-party uses: → the first file that has it

  for (const f of [...workflows, ...actions]) {
    const text = files[f]!;
    if (text.includes('\r')) throw new Error(`${f}: CRLF line endings`);
    const lines = text.split('\n');
    localUses[f] = [];
    for (const [i, l] of lines.entries()) {
      if (!isContent(l)) continue;
      const c = code(l);
      const u = /^\s*(?:-\s+)?uses:\s*['"]?([^'"\s]+)/.exec(c)?.[1];
      if (u?.startsWith('./')) {
        const local = u.slice(2).replace(/\/$/, '');
        localUses[f]!.push(/\.ya?ml$/.test(local) ? local : `${local}/action.yml`);
      } else if (u) {
        const ownerRepo = /^([^/@]+\/[^/@]+)(?:\/[^@]*)?@[^@]+$/.exec(u)?.[1];
        if (!ownerRepo) problems.push(`${f}:${i + 1}: unreadable uses "${u}"`);
        else if (!ACTIONS.includes(ownerRepo))
          problems.push(`${f}:${i + 1}: action ${ownerRepo} isn't on the allowlist`);
        if (ownerRepo && !allUses.has(ownerRepo)) allUses.set(ownerRepo, f);
      }
      const runsOn = /^\s*runs-on:\s*(.*?)\s*$/.exec(c)?.[1];
      if (runsOn !== undefined && runsOn !== 'ubuntu-latest')
        problems.push(`${f}:${i + 1}: runs-on "${runsOn}" — only ubuntu-latest (GitHub-hosted)`);
      for (const ev of ['pull_request_target', 'workflow_run'])
        if (new RegExp(`\\b${ev}\\b`).test(l)) problems.push(`${f}:${i + 1}: mentions ${ev}`);
      // A container, service image or default shell would run around the allowlist, or the guard's own shell.
      const key = /^\s*(container|services|defaults):/.exec(c)?.[1];
      if (key) problems.push(`${f}:${i + 1}: ${key}: isn't allowed`);
    }
    for (const local of localUses[f]!)
      if (!(local in files)) problems.push(`${f} uses ./${local}, which doesn't exist`);
    // Event data only ever reaches a step through the guard's env line, never an expression elsewhere. Only whole-line
    // comments are dropped: `echo "#${{ … }}"` is code, and a trailing comment that trips this is a cheap false alarm.
    const rest = text.split(GUARD_STEP).join('').split('\n').filter(isContent).join('\n');
    if (/github\.event\b(?!_)|github\.head_ref|toJSON\(\s*github\s*\)|github\s*\[/.test(rest))
      problems.push(
        `${f}: reads event data (github.event, github.head_ref, the whole github context) outside the fork guard`,
      );
  }
  for (const a of ACTIONS)
    if (!allUses.has(a)) problems.push(`allowlisted action ${a} isn't used — drop it from ACTIONS`);

  const reachable = new Set<string>(); // what a pull_request run can execute
  const visit = (f: string) => {
    if (reachable.has(f) || !(f in files)) return;
    reachable.add(f);
    for (const u of localUses[f] ?? []) visit(u);
  };

  for (const f of workflows) {
    const text = files[f]!;
    const events = triggers(f, text);
    for (const ev of events)
      if (!EVENTS.includes(ev))
        problems.push(`${f}: triggers on ${ev} — allowed: ${EVENTS.join(', ')}`);
    if (events.includes('pull_request')) visit(f);

    const wf = parseWorkflow(text, f);
    const blocks = jobBlocks(text);
    const writes = (where: string, perms = {}) => {
      for (const [scope, level] of Object.entries(perms))
        if (level === 'write' && scope !== 'id-token') problems.push(`${where}: ${scope}: write`);
    };
    writes(`${f} (top level)`, wf.perms);
    for (const [name, job] of Object.entries(wf.jobs)) {
      const where = `${f} › ${name}`;
      writes(where, job.perms);
      const steps = stepLines(blocks[name] ?? []);
      if (job.uses && steps) problems.push(`${where}: both uses: and steps:`);
      else if (job.uses) {
        if (!/^\.\/\.github\/workflows\/[^/@]+\.ya?ml$/.test(job.uses))
          problems.push(
            `${where}: calls "${job.uses}" — only local workflows, which carry their own guard`,
          );
      } else if (!steps) problems.push(`${where}: neither steps: nor uses:`);
      else {
        if (!wf.perms && !job.perms) problems.push(`${where}: no permissions block`);
        const first = steps.findIndex(isContent);
        const end = first + GUARD_STEP.split('\n').length;
        const head = steps.slice(first, end).join('\n');
        // and nothing appended to it: an `if:`, `continue-on-error:` or `shell:` after `exit 1` is still its key
        const next = steps.slice(end).find(isContent);
        if (head !== GUARD_STEP || (next !== undefined && !/^ {6}- /.test(next)))
          problems.push(`${where}: the first step isn't the fork guard`);
      }
    }
  }

  // A pull_request run gets no secrets from GitHub; pin that our files never ask for any either.
  for (const f of reachable) {
    const text = files[f]!.split('\n').filter(isContent).join('\n');
    for (const [what, re] of [
      ['secrets', /\bsecrets\b/],
      ['id-token', /\bid-token\b/],
      ['environment:', /^\s*environment:/m],
    ] as const)
      if (re.test(text)) problems.push(`${f}: pull_request-reachable and mentions ${what}`);
  }
  return problems;
}
