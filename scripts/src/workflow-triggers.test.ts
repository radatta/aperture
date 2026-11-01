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
// CRLF, a push with no inline `branches: [...]` filter, `branches-ignore` — throws, so a test can never pass vacuously.
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
    if (t.lines.some((l) => l.startsWith('branches-ignore')))
      throw new Error(`${file}: push uses branches-ignore`);
    if (!t.lines.some((l) => /^branches: \[[^\]]*\]$/.test(l)))
      throw new Error(`${file}: push needs an inline branches: [...] filter`);
  }
  return out;
}
const triggers = (file: string) => parseTriggers(file, read(file));
const pushBranches = (file: string) =>
  triggers(file)
    .filter((t) => t.event === 'push')
    .flatMap((t) =>
      /^branches: \[([^\]]*)\]$/
        .exec(t.lines.find((l) => l.startsWith('branches:'))!)![1]!
        .split(','),
    )
    .map((b) => b.trim().replace(/^['"]|['"]$/g, ''));

describe('workflow triggers', () => {
  it('every workflow has a trigger block this test can read', () => {
    expect(workflows.length).toBeGreaterThan(0);
    for (const f of workflows) expect(triggers(f).length, f).toBeGreaterThan(0);
  });

  it('deploy.yml runs only on a push to main', () => {
    expect(triggers('deploy.yml').map((t) => t.event)).toEqual(['push']);
    expect(pushBranches('deploy.yml')).toEqual(['main']);
  });

  it('no workflow runs on a push to `dev`', () => {
    for (const f of workflows) {
      const branches = pushBranches(f);
      expect(branches, f).not.toContain('dev');
      // A wildcard would match dev too.
      for (const b of branches) expect(b, f).not.toMatch(/\*/);
    }
  });

  it('only the bot dispatch and the dev-logs fetch can be dispatched', () => {
    const dispatchable = workflows.filter((f) =>
      triggers(f).some((t) => t.event === 'workflow_dispatch'),
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
    };
    for (const [why, yml] of Object.entries(bad))
      expect(() => parseTriggers(why, yml), why).toThrow();
    expect(parseTriggers('ok', 'on:\n  push:\n    branches: [main]\njobs:\n')).toEqual([
      { event: 'push', lines: ['branches: [main]'] },
    ]);
  });
});
