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

  it('ties each environment to its own output, all the way through', () => {
    const lines = job(deploy, 'changes')
      .split('\n')
      .map((l) => l.trim());
    for (const line of [
      'mode_dev=$(node scripts/src/deploy-base.ts dev-main "$GITHUB_SHA" --slot dev)',
      'mode_devb=$(node scripts/src/deploy-base.ts dev-main "$GITHUB_SHA" --slot devb)',
      'mode_prod=$(node scripts/src/deploy-base.ts prod "$GITHUB_SHA")',
      '{ echo "mode_dev=$mode_dev"; echo "mode_devb=$mode_devb"; echo "mode_prod=$mode_prod"; echo "check=$check"; } >> "$GITHUB_OUTPUT"',
      'mode_dev: ${{ steps.detect.outputs.mode_dev }}',
      'mode_devb: ${{ steps.detect.outputs.mode_devb }}',
      'mode_prod: ${{ steps.detect.outputs.mode_prod }}',
      'check=$(node scripts/src/checked-tree.ts "$GITHUB_SHA")',
      'check: ${{ steps.detect.outputs.check }}',
    ])
      expect(lines, line).toContain(line);
    expect(lines.filter((l) => !l.startsWith('#') && l.includes('deploy-base.ts'))).toHaveLength(3);
  });

  it('asks about the two environments deploy-stage runs main in', () => {
    expect(stage).toContain(
      "environment: ${{ inputs.lane == 'devmain' && 'dev-main' || (contains(fromJSON('[\"dev\",\"devb\"]'), inputs.stage) && 'dev' || inputs.stage) }}",
    );
    for (const j of ['deploy-dev', 'deploy-devb'])
      expect(job(deploy, j)).toContain(
        "lane: ${{ github.ref == 'refs/heads/main' && 'devmain' || '' }}",
      );
    expect(job(deploy, 'deploy-prod')).not.toContain('lane:');
  });

  it('feeds each stage its own mode, never the other', () => {
    expect(job(deploy, 'deploy-dev')).toContain('mode: ${{ needs.changes.outputs.mode_dev }}');
    expect(job(deploy, 'deploy-prod')).toContain('mode: ${{ needs.changes.outputs.mode_prod }}');
    expect(job(deploy, 'deploy-dev')).not.toContain('mode_prod');
    expect(job(deploy, 'deploy-prod')).not.toContain('mode_dev');
    // devb deploys only a shape change, and always in full; it never gates prod.
    expect(job(deploy, 'deploy-devb')).toContain(
      "github.ref == 'refs/heads/main' && needs.changes.outputs.mode_devb == 'full'",
    );
    expect(job(deploy, 'deploy-devb')).toContain('mode: full');
    expect(job(deploy, 'deploy-devb')).toContain('stage: devb');
    expect(job(deploy, 'deploy-prod')).not.toContain('deploy-devb');
    expect(deploy).not.toContain('outputs.mode }}');
  });

  it('assigns and validates the modes and the check plan before writing, so a crash fails the job instead of emptying an output', () => {
    const changes = job(deploy, 'changes');
    const lines = changes.split('\n').map((l) => l.trim());
    expect(lines).toContain('for mode in "$mode_dev" "$mode_devb" "$mode_prod"; do');
    expect(lines).toContain(
      'timeout-minutes: 5 # a checkout and a few API reads; a walk that stalls times out to `full`/`check` well inside this',
    );
    expect(lines).toContain(
      "fetch-depth: 0 # need history to diff from each stage's last deployment",
    );
    expect(lines).toContain(
      'case "$mode" in none|app|full) ;; *) echo "::error::classifier returned \'$mode\'"; exit 1 ;; esac',
    );
    expect(lines).toContain(
      'case "$check" in skip|fixtures|check) ;; *) echo "::error::checked-tree returned \'$check\'"; exit 1 ;; esac',
    );
    expect(changes.indexOf('mode_prod=$(')).toBeLessThan(changes.indexOf('for mode in'));
    expect(changes.indexOf('check=$(')).toBeLessThan(changes.indexOf('case "$check"'));
    expect(changes.indexOf('case "$check"')).toBeLessThan(changes.indexOf('>> "$GITHUB_OUTPUT"'));
    expect(changes.indexOf('for mode in')).toBeLessThan(changes.indexOf('>> "$GITHUB_OUTPUT"'));
    for (const unsafe of ['set +e', 'continue-on-error', '||'])
      expect(changes).not.toContain(unsafe);
  });

  it('grants the token what the lookup reads, and nothing to write', () => {
    expect(parseWorkflow(deploy).jobs.changes?.perms).toEqual({
      contents: 'read',
      deployments: 'read',
      actions: 'read',
      checks: 'read',
      'pull-requests': 'read',
    });
    expect(job(deploy, 'changes')).toContain('GITHUB_TOKEN: ${{ github.token }}');
  });
});

describe('the dispatched lane exercises the same lookup', () => {
  const verify = job(dispatch, 'verify');

  it('runs the script for both environments, on the commit under test', () => {
    expect(
      [
        ...verify.matchAll(
          /=\$\(node scripts\/src\/deploy-base\.ts (\S+) "\$SHA"( --slot \S+)?\)/g,
        ),
      ].map((m) => `${m[1]}${m[2] ?? ''}`),
    ).toEqual(['dev-main --slot dev', 'dev-main --slot devb', 'prod']);
    expect(verify).toContain(
      'If merged now: dev-main=$merged_dev devb=$merged_devb prod=$merged_prod',
    );
    expect(verify).toContain('merged_check=$(node scripts/src/checked-tree.ts "$SHA")');
    expect(verify).toContain('If merged now: check=$merged_check');
  });

  it('has the history to diff, and classifies a dispatch by where a move came from too', () => {
    expect(verify).toContain('fetch-depth: 0');
    expect(verify).toContain('git diff --name-only --no-renames "$base" "$SHA"');
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
    expect(at('merged_check=$(')).toBeGreaterThan(at('echo "mode=$mode" >> "$GITHUB_OUTPUT"'));
    expect(verify.match(/GITHUB_OUTPUT/g)).toHaveLength(1);
  });
});

// A tree match skips main's check (checked-tree.ts); these pin that only `changes` saying `skip` can, that a failed
// lookup or check deploys nothing, and that a skip upstream never reads as a failure further down.
describe('deploy.yml skips the check only on a tree match', () => {
  const ok =
    "needs.changes.result == 'success' && (needs.check.result == 'success' || (needs.check.result == 'skipped' && needs.changes.outputs.check == 'skip'))";

  it('runs the check unless `changes` printed skip, and the fixture suite alone on `fixtures`', () => {
    const check = job(deploy, 'check');
    expect(check).toContain('needs: [changes]');
    expect(check).toContain("if: ${{ !cancelled() && needs.changes.outputs.check != 'skip' }}");
    expect(check).toContain('uses: ./.github/workflows/ci.yml');
    expect(check).toContain("fixtures_only: ${{ needs.changes.outputs.check == 'fixtures' }}");
  });

  it('deploys dev and devb only after a green check or a planned skip', () => {
    expect(job(deploy, 'deploy-dev')).toContain(`if: \${{ !cancelled() && ${ok} }}`);
    expect(job(deploy, 'deploy-devb')).toContain(
      `if: \${{ !cancelled() && github.ref == 'refs/heads/main' && needs.changes.outputs.mode_devb == 'full' && ${ok} }}`,
    );
  });

  it('deploys prod only after dev succeeded, with its results spelled out', () => {
    expect(job(deploy, 'deploy-prod')).toContain('needs: [deploy-dev, changes]');
    expect(job(deploy, 'deploy-prod')).toContain(
      "if: ${{ !cancelled() && github.ref == 'refs/heads/main' && needs.deploy-dev.result == 'success' && needs.changes.result == 'success' }}",
    );
  });

  it('turns a main push that silently deployed nothing red, and runs no notify job anywhere', () => {
    const noDeploy = job(deploy, 'no-deploy');
    expect(noDeploy).toContain('needs: [changes, check, deploy-dev]');
    expect(noDeploy).toContain(
      "if: ${{ !cancelled() && needs.changes.result == 'success' && needs.deploy-dev.result == 'skipped' && needs.check.result != 'failure' }}",
    );
    expect(noDeploy).toContain('exit 1');
    for (const yml of [deploy, dispatch]) {
      expect(yml).not.toMatch(/\n {2}notify:/);
      expect(yml.toLowerCase()).not.toContain('ntfy');
    }
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

  // A step that fails but reports success would make a failed deploy a base.
  it('never lets a failed step report success', () => {
    expect(stage).not.toContain('continue-on-error');
  });

  it('runs CDK only on full, under the step name deploy-base.ts reads', () => {
    expect(stepWith('Deploy stacks')).toContain("if: inputs.mode == 'full'");
  });

  it('publishes on anything but none, under the step name deploy-base.ts reads', () => {
    expect(stepWith('Publish frontend')).toContain("if: inputs.mode != 'none'");
  });
});
