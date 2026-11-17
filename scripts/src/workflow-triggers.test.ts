import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// What can start a deploy (docs/ops/CI-BOT.md → Setup step 8). Since dev-cutover a branch reaches dev only through the
// bot's dispatch (deploy-dev.yml), and deploy.yml — the prod path — runs only on a main push.
const DIR = new URL('../../.github/workflows/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, DIR), 'utf8');
const workflows = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));

interface Trigger {
  event: string;
  lines: string[]; // the event's own lines, indented under it
}

// The `on:` block, parsed fail-closed: any shape this can't read for certain — `on: push`, a flow list, a quoted key,
// CRLF, an inline mapping, a push with anything but one inline `branches: [...]` of literal names (plus inline `paths`
// filters) — throws, so a test can never pass vacuously. `tags` and globs are refused outright, and `branches-ignore`
// everywhere but the one file named in IGNORE_OK (branch.yml, every feature branch), where it is the only filter.
const IGNORE_OK = new Set(['branch.yml']);
const branchList = (line: string) =>
  /^branches(?:-ignore)?: \[([^\]]*)\]$/
    .exec(line)![1]!
    .split(',')
    .map((b) => b.trim().replace(/^['"]|['"]$/g, ''));

function parseTriggers(file: string, yml: string): Trigger[] {
  if (yml.includes('\r')) throw new Error(`${file}: CRLF line endings`);
  const lines = yml.split('\n').map((l) => l.replace(/\s+#.*$/, ''));
  const onLines = lines.filter((l) => /^['"]?on['"]?\s*:/.test(l));
  if (onLines.length !== 1 || onLines[0] !== 'on:')
    throw new Error(`${file}: on: must be a bare block`);
  const start = lines.indexOf('on:');
  const end = lines.findIndex((l, i) => i > start && /^\S/.test(l) && !l.startsWith('#'));
  const block = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .filter((l) => l.trim() && !l.trim().startsWith('#'));
  const out: Trigger[] = [];
  for (const l of block) {
    const ev = /^ {2}([a-z_]+):\s*$/.exec(l);
    if (ev) out.push({ event: ev[1]!, lines: [] });
    else if (/^ {4}/.test(l) && out.length) out.at(-1)!.lines.push(l.trim());
    else throw new Error(`${file}: unreadable trigger line ${JSON.stringify(l)}`);
  }
  for (const t of out.filter((x) => x.event === 'push')) {
    const ignore = IGNORE_OK.has(file);
    for (const l of t.lines)
      if (
        !(
          ignore ? /^branches-ignore: \[[^\]]*\]$/ : /^(branches|paths|paths-ignore): \[[^\]]*\]$/
        ).test(l)
      )
        throw new Error(
          `${file}: push line ${JSON.stringify(l)} — ${ignore ? 'only one inline branches-ignore filter' : 'only inline branches/paths filters'}`,
        );
    const key = ignore ? 'branches-ignore:' : 'branches:';
    const branches = t.lines.filter((l) => l.startsWith(key));
    if (branches.length !== 1)
      throw new Error(`${file}: push needs exactly one inline ${key} [...] filter`);
    for (const b of branchList(branches[0]!))
      if (!/^[\w./-]+$/.test(b))
        throw new Error(`${file}: push branch ${JSON.stringify(b)} is not a literal name`);
  }
  return out;
}
const triggers = (file: string) => parseTriggers(file, read(file));
// The branches a push runs on, or for an IGNORE_OK file the branches it skips.
const pushBranches = (file: string) =>
  triggers(file)
    .filter((t) => t.event === 'push')
    .flatMap((t) => branchList(t.lines.find((l) => l.startsWith('branches'))!));

// Every workflow's exact events: a new trigger — `repository_dispatch` (Contents: write can fire it), `workflow_run`,
// `pull_request_target`, a dispatch — needs a deliberate edit here.
const EVENTS: Record<string, string[]> = {
  'branch.yml': ['push'],
  'ci.yml': ['workflow_call'],
  'deploy-dev.yml': ['workflow_dispatch'],
  'deploy-stage.yml': ['workflow_call'],
  'deploy.yml': ['push'],
  'fetch-dev-logs.yml': ['workflow_dispatch'],
  'pr.yml': ['pull_request'],
};

describe('workflow triggers', () => {
  it('every workflow has exactly its pinned events', () => {
    expect(workflows.sort()).toEqual(Object.keys(EVENTS).sort());
    for (const f of workflows)
      expect(
        triggers(f).map((t) => t.event),
        f,
      ).toEqual(EVENTS[f]);
  });

  it('deploy.yml runs only on a push to main', () => {
    expect(triggers('deploy.yml').map((t) => t.event)).toEqual(['push']);
    expect(pushBranches('deploy.yml')).toEqual(['main']);
  });

  it('no workflow runs on a push to `dev`', () => {
    for (const f of workflows) {
      const branches = pushBranches(f);
      if (IGNORE_OK.has(f)) expect(branches, f).toContain('dev');
      else expect(branches, f).not.toContain('dev'); // the parser already refuses a glob, which could match it
    }
  });

  it('branch.yml runs the CI gate on every push but main and dev, and nothing else', () => {
    expect(pushBranches('branch.yml')).toEqual(['main', 'dev']);
    const yml = read('branch.yml');
    expect(
      yml
        .split('\n')
        .filter((l) => /^\s+uses:/.test(l))
        .map((l) => l.trim()),
    ).toEqual(['uses: ./.github/workflows/ci.yml']);
    expect(yml).toContain('cancel-in-progress: true');
    expect(yml).not.toMatch(/secrets|id-token|environment/);
  });

  it('only the bot dispatch and the dev-logs fetch can be dispatched', () => {
    const dispatchable = Object.keys(EVENTS).filter((f) =>
      EVENTS[f]!.includes('workflow_dispatch'),
    );
    expect(dispatchable.sort()).toEqual(['deploy-dev.yml', 'fetch-dev-logs.yml']);
  });

  it('deploy-dev.yml keeps its pause switch and its up-to-date-with-main check', () => {
    const yml = read('deploy-dev.yml');
    expect(yml).toContain('[ "$DEV_DEPLOY_ISOLATED" = "true" ] || fail');
    expect(yml).toContain('git merge-base --is-ancestor origin/main "$SHA" || fail');
    expect(read('deploy.yml')).not.toContain('Branch is up to date with main');
  });

  it('the parser fails closed', () => {
    const bad = {
      'scalar on': 'on: push\n',
      'flow list': 'on: [push, workflow_dispatch]\n',
      'quoted key': "'on':\n  push:\n    branches: [main]\n",
      crlf: 'on:\r\n  push:\r\n    branches: [main]\r\n',
      'push with no branch filter': 'on:\n  push:\njobs:\n',
      'block-list branches': 'on:\n  push:\n    branches:\n      - dev\njobs:\n',
      'branches-ignore': 'on:\n  push:\n    branches-ignore: [main]\njobs:\n',
      'branches beside branches-ignore':
        'on:\n  push:\n    branches-ignore: [main]\n    branches: [dev]\njobs:\n',
      tags: "on:\n  push:\n    branches: [main]\n    tags: ['*']\njobs:\n",
      'duplicate branches': 'on:\n  push:\n    branches: [main]\n    branches: [dev]\njobs:\n',
      'inline mapping': 'on:\n  push: {branches: [dev]}\njobs:\n',
      'branch glob': "on:\n  push:\n    branches: ['**']\njobs:\n",
    };
    for (const [why, yml] of Object.entries(bad))
      expect(() => parseTriggers(why, yml), why).toThrow();
    // branch.yml takes branches-ignore alone: no branches, paths or tags beside it, no glob, no block list
    const ignoreBad = {
      'branches filter': 'on:\n  push:\n    branches: [dev]\njobs:\n',
      'paths beside it': 'on:\n  push:\n    branches-ignore: [main]\n    paths: [app/**]\njobs:\n',
      'ignore glob': "on:\n  push:\n    branches-ignore: ['**']\njobs:\n",
      'block list': 'on:\n  push:\n    branches-ignore:\n      - main\njobs:\n',
      'no filter': 'on:\n  push:\njobs:\n',
    };
    for (const [why, yml] of Object.entries(ignoreBad))
      expect(() => parseTriggers('branch.yml', yml), why).toThrow();
    expect(parseTriggers('ok', 'on:\n  push:\n    branches: [main]\njobs:\n')).toEqual([
      { event: 'push', lines: ['branches: [main]'] },
    ]);
  });
});
