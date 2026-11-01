import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The freeze-exempt dev lane (docs/ops/CI-BOT.md → Dev deploys → Two lanes) is for merged code only. deploy-stage.yml
// refuses it at run time unless the run is a `main` push of its own commit; these pin who asks for it at all.
const DIR = new URL('../../.github/workflows/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, DIR), 'utf8');
const laneLines = (yml: string) => yml.split('\n').filter((l) => /^\s+lane:/.test(l));

describe('the devmain deploy lane', () => {
  it('is asked for only by deploy.yml, and only on a main push', () => {
    expect(laneLines(read('deploy.yml')).map((l) => l.trim())).toEqual([
      "lane: ${{ github.ref == 'refs/heads/main' && 'devmain' || '' }}",
    ]);
    for (const f of readdirSync(DIR).filter(
      (x) => x.endsWith('.yml') && x !== 'deploy.yml' && x !== 'deploy-stage.yml',
    ))
      expect(laneLines(read(f)), f).toEqual([]);
  });

  it('pairs the lane with its own role variable', () => {
    expect(read('deploy.yml')).toContain(
      "role_arn: ${{ github.ref == 'refs/heads/main' && vars.AWS_DEPLOY_ROLE_DEV_MAIN || vars.AWS_DEPLOY_ROLE_DEV }}",
    );
  });

  it('is refused by deploy-stage for anything but a main push of its own commit', () => {
    const stage = read('deploy-stage.yml');
    expect(stage).toContain(
      "environment: ${{ inputs.lane == 'devmain' && 'dev-main' || inputs.stage }}",
    );
    expect(stage).toContain(
      'if [ "${{ inputs.lane }}" = devmain ] && { [ "${{ github.event_name }}" != push ] || [ "${{ github.ref }}" != refs/heads/main ] || [ -n "${{ inputs.ref }}" ]; }; then',
    );
  });
});

// A freeze-refused deploy leaves its stack in UPDATE_ROLLBACK_FAILED, which would block both lanes.
describe('the refused-deploy unstick step', () => {
  const stage = read('deploy-stage.yml');
  const at = (needle: string) => stage.indexOf(needle);

  it('runs after the deploy step it reads, on a failed frozen-lane dev deploy only', () => {
    expect(at('id: deploy')).toBeGreaterThan(-1);
    expect(at('name: Unstick a refused dev deploy')).toBeGreaterThan(at('id: deploy'));
    expect(stage).toContain(
      "if: failure() && steps.deploy.outcome == 'failure' && inputs.stage == 'dev' && inputs.lane == ''",
    );
  });

  it('rolls back through the same lane (no role of its own), skipping what the freeze refused', () => {
    const line = stage.split('\n').find((l) => l.includes('cdk rollback'))!;
    expect(line).toContain('cdk rollback --app cdk.out ApertureData-dev ApertureApp-dev --force');
    expect(line).not.toContain('--role-arn');
  });
});
