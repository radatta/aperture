import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The freeze-exempt dev lane (docs/ops/CI-BOT.md → Dev deploys → Two lanes) is for merged code only. deploy-stage.yml
// refuses it at run time unless the run is a `main` push of its own commit; these pin who asks for it at all.
const DIR = new URL('../../.github/workflows/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, DIR), 'utf8');
const laneLines = (yml: string) => yml.split('\n').filter((l) => /^\s+lane:/.test(l));

describe('the devmain deploy lane', () => {
  it('is asked for only by deploy.yml, and only on a main push (one call per dev slot)', () => {
    expect(laneLines(read('deploy.yml')).map((l) => l.trim())).toEqual([
      "lane: ${{ github.ref == 'refs/heads/main' && 'devmain' || '' }}",
      "lane: ${{ github.ref == 'refs/heads/main' && 'devmain' || '' }}",
    ]);
    for (const f of readdirSync(DIR).filter(
      (x) => x.endsWith('.yml') && x !== 'deploy.yml' && x !== 'deploy-stage.yml',
    ))
      expect(laneLines(read(f)), f).toEqual([]);
  });

  it('pairs the lane with its own role variable', () => {
    const roles = read('deploy.yml')
      .split('\n')
      .filter((l) => /^\s+role_arn:/.test(l) && l.includes('DEV'))
      .map((l) => l.trim());
    expect(roles).toEqual([
      "role_arn: ${{ github.ref == 'refs/heads/main' && vars.AWS_DEPLOY_ROLE_DEV_MAIN || vars.AWS_DEPLOY_ROLE_DEV }}",
      "role_arn: ${{ github.ref == 'refs/heads/main' && vars.AWS_DEPLOY_ROLE_DEV_MAIN || vars.AWS_DEPLOY_ROLE_DEV }}",
    ]);
  });

  it('is refused by deploy-stage for anything but a main push of its own commit', () => {
    const stage = read('deploy-stage.yml');
    expect(stage).toContain(
      "environment: ${{ inputs.lane == 'devmain' && 'dev-main' || (contains(fromJSON('[\"dev\",\"devb\"]'), inputs.stage) && 'dev' || inputs.stage) }}",
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
      "if: failure() && steps.deploy.outcome == 'failure' && contains(fromJSON('[\"dev\",\"devb\"]'), inputs.stage) && inputs.lane == ''",
    );
  });

  it('rolls back through the same lane (no role of its own), skipping what the freeze refused', () => {
    const line = stage.split('\n').find((l) => l.includes('cdk rollback'))!;
    expect(line).toContain(
      'cdk rollback --app cdk.out ApertureData-${{ inputs.stage }} ApertureApp-${{ inputs.stage }} --force',
    );
    expect(line).not.toContain('--role-arn');
  });
});

// Two dev slots (INFRA §2): a dispatch names its slot, and only that slot's call job runs — both in the frozen lane,
// both with the dev role and `_DEV` secrets. The call jobs' names are a contract (bot/deploy-dev.ts → currentBase).
describe('the dispatched dev slots', () => {
  const dispatch = read('deploy-dev.yml');
  const callJob = (name: string) => {
    const lines = dispatch.split('\n');
    const start = lines.indexOf(`  ${name}:`);
    expect(start, name).toBeGreaterThan(-1);
    const end = lines.findIndex((l, i) => i > start && /^ {2}[a-z-]+:$/.test(l));
    return lines.slice(start, end).join('\n');
  };

  it('runs exactly one call job per slot, on its own stage, in the frozen lane', () => {
    expect(callJob('deploy')).toContain("if: inputs.slot == 'dev'");
    expect(callJob('deploy')).toContain('stage: dev\n');
    expect(callJob('deploy-b')).toContain("if: inputs.slot == 'devb'");
    expect(callJob('deploy-b')).toContain('stage: devb\n');
    for (const j of ['deploy', 'deploy-b']) {
      expect(callJob(j)).toContain('role_arn: ${{ vars.AWS_DEPLOY_ROLE_DEV }}');
      expect(callJob(j)).toContain('origin_secret: ${{ secrets.ORIGIN_SECRET_DEV }}');
      expect(callJob(j)).not.toContain('lane:');
    }
    expect(callJob('deploy-b')).toContain("device_user_id: ''");
  });

  it('refuses any other slot before the deploy role is assumed, and queues per slot', () => {
    expect(callJob('verify')).toContain(
      'case "$SLOT" in dev|devb) echo "Slot: $SLOT" ;; *) fail "slot must be dev or devb" ;; esac',
    );
    expect(dispatch).toContain('group: deploy-dev-dispatch-${{ inputs.slot }}');
  });

  it('deploy-stage refuses an unknown stage', () => {
    expect(read('deploy-stage.yml')).toContain(
      `*) echo "::error::invalid stage '\${{ inputs.stage }}'"; exit 1 ;;`,
    );
  });
});
