import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// What can start a deploy (docs/ops/CI-BOT.md → Setup step 8). Since dev-cutover a branch reaches dev only through the
// bot's dispatch (deploy-dev.yml), and deploy.yml — the prod path — runs only on a main push.
const DIR = new URL('../../.github/workflows/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, DIR), 'utf8');
const workflows = readdirSync(DIR).filter((f) => f.endsWith('.yml'));

// The `on:` block: from `on:` to the next top-level key, comments and blank lines dropped.
function onBlock(yml: string): string[] {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => l === 'on:');
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && /^[A-Za-z]/.test(l));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .map((l) => l.replace(/\s+#.*$/, ''))
    .filter((l) => l.trim() && !l.trim().startsWith('#'));
}
const events = (yml: string) =>
  onBlock(yml)
    .filter((l) => /^ {2}\S/.test(l))
    .map((l) => l.trim());

describe('workflow triggers', () => {
  it('deploy.yml runs only on a push to main', () => {
    expect(onBlock(read('deploy.yml'))).toEqual(['  push:', '    branches: [main]']);
  });

  it('no workflow runs on a push to `dev`', () => {
    for (const f of workflows) {
      const branches = onBlock(read(f)).filter((l) => l.trim().startsWith('branches:'));
      for (const b of branches) expect(b, f).not.toMatch(/\bdev\b/);
    }
  });

  it('only the bot dispatch and the dev-logs fetch can be dispatched', () => {
    const dispatchable = workflows.filter((f) => events(read(f)).includes('workflow_dispatch:'));
    expect(dispatchable.sort()).toEqual(['deploy-dev.yml', 'fetch-dev-logs.yml']);
  });

  it('deploy-dev.yml keeps its pause switch and its up-to-date-with-main check', () => {
    const yml = read('deploy-dev.yml');
    expect(yml).toContain('[ "$DEV_DEPLOY_ISOLATED" = "true" ] || fail');
    expect(yml).toContain('git merge-base --is-ancestor origin/main "$SHA" || fail');
    expect(read('deploy.yml')).not.toContain('merge-base');
  });
});
