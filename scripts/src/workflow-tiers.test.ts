import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseWorkflow } from './workflow-permissions';

// A main push classifies each stage against what it serves (deploy-base.ts). The module's rule has its own tests; these
// pin the wiring only a real deploy would otherwise exercise, since PR checks never run deploy.yml.
const read = (f: string) =>
  readFileSync(new URL(`../../.github/workflows/${f}`, import.meta.url), 'utf8');
const deploy = read('deploy.yml');
const dispatch = read('deploy-dev.yml');
const stage = read('deploy-stage.yml');
// The text of one job: from its key to the next job key.
const job = (yml: string, name: string) => {
  const lines = yml.slice(yml.indexOf('\njobs:\n')).split('\n');
  const start = lines.indexOf(`  ${name}:`);
  expect(start, name).toBeGreaterThan(-1);
  const end = lines.findIndex((l, i) => i > start && /^ {2}[a-z-]+:$/.test(l));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
};

describe('deploy.yml classifies per stage', () => {
  it('never reads the previous push: main moved there, but no stage has to have', () => {
    // Comments may name it, to say why not; no expression may use it.
    expect(deploy).not.toContain('${{ github.event.before }}');
    expect(
      deploy
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n'),
    ).not.toContain('event.before');
  });

  it('asks the script about exactly the two environments deploy-stage runs main in', () => {
    const calls = [...job(deploy, 'changes').matchAll(/deploy-base\.ts (\S+) "\$GITHUB_SHA"/g)].map(
      (m) => m[1],
    );
    expect(calls).toEqual(['dev-main', 'prod']);
    expect(stage).toContain(
      "environment: ${{ inputs.lane == 'devmain' && 'dev-main' || inputs.stage }}",
    );
    expect(job(deploy, 'deploy-dev')).toContain(
      "lane: ${{ github.ref == 'refs/heads/main' && 'devmain' || '' }}",
    );
    expect(job(deploy, 'deploy-prod')).not.toContain('lane:');
  });

  it('feeds each stage its own mode, never the other', () => {
    expect(job(deploy, 'deploy-dev')).toContain('mode: ${{ needs.changes.outputs.mode_dev }}');
    expect(job(deploy, 'deploy-prod')).toContain('mode: ${{ needs.changes.outputs.mode_prod }}');
    expect(job(deploy, 'deploy-dev')).not.toContain('mode_prod');
    expect(job(deploy, 'deploy-prod')).not.toContain('mode_dev');
    expect(deploy).not.toContain('outputs.mode }}');
  });

  it('assigns each mode before writing it, so a crash fails the job instead of emptying an output', () => {
    const changes = job(deploy, 'changes');
    expect(changes).toContain('mode_dev=$(node scripts/src/deploy-base.ts');
    expect(changes).toContain('mode_prod=$(node scripts/src/deploy-base.ts');
    expect(changes).toContain('case "$mode" in none|app|full) ;; *)');
    expect(changes).not.toContain('|| true');
  });

  it('grants the token what the lookup reads, and nothing to write', () => {
    expect(parseWorkflow(deploy).jobs.changes?.perms).toEqual({
      contents: 'read',
      deployments: 'read',
      actions: 'read',
    });
    expect(job(deploy, 'changes')).toContain('GITHUB_TOKEN: ${{ github.token }}');
  });
});

describe('the dispatched lane exercises the same lookup', () => {
  const verify = job(dispatch, 'verify');

  it('runs the script for both environments, on the commit under test', () => {
    expect(
      [...verify.matchAll(/=\$\(node scripts\/src\/deploy-base\.ts (\S+) "\$SHA"\)/g)].map(
        (m) => m[1],
      ),
    ).toEqual(['dev-main', 'prod']);
    expect(verify).toContain('If merged now: dev-main=$merged_dev prod=$merged_prod');
  });

  it('with the same token grants as the main path', () => {
    expect(parseWorkflow(dispatch).jobs.verify?.perms).toEqual(
      parseWorkflow(deploy).jobs.changes?.perms,
    );
    expect(verify).toContain('GITHUB_TOKEN: ${{ github.token }}');
  });

  it('after its own checks and its own mode, which the preview never changes', () => {
    const at = (s: string) => verify.indexOf(s);
    expect(at('git merge-base --is-ancestor')).toBeGreaterThan(-1);
    expect(at('echo "mode=$mode" >> "$GITHUB_OUTPUT"')).toBeGreaterThan(
      at('git merge-base --is-ancestor'),
    );
    expect(at('merged_dev=$(')).toBeGreaterThan(at('echo "mode=$mode" >> "$GITHUB_OUTPUT"'));
    expect(verify.match(/GITHUB_OUTPUT/g)).toHaveLength(1);
  });
});

// deploy-base.ts reads a deployment's tier from these step names and gates.
describe('deploy-stage.yml keeps what the lookup reads', () => {
  const stepWith = (name: string) =>
    stage
      .slice(stage.indexOf(`- name: ${name}`))
      .split('\n')
      .slice(0, 3)
      .join('\n');

  it('runs CDK only on full, under the step name deploy-base.ts reads', () => {
    expect(stepWith('Deploy stacks')).toContain("if: inputs.mode == 'full'");
  });

  it('publishes on anything but none, under the step name deploy-base.ts reads', () => {
    expect(stepWith('Publish frontend')).toContain("if: inputs.mode != 'none'");
  });
});
