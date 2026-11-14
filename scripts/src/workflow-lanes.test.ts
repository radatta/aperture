import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runScripts } from './workflow-run-scripts';

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
      'if [ "$APERTURE_DEPLOY_LANE" = devmain ] && { [ "$GITHUB_EVENT_NAME" != push ] || [ "$GITHUB_REF" != refs/heads/main ] || [ -n "$REF" ]; }; then',
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
      'cdk rollback --app cdk.out "ApertureData-$APERTURE_STAGE" "ApertureApp-$APERTURE_STAGE" --force',
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
      `*) echo "::error::invalid stage '$APERTURE_STAGE'"; exit 1 ;;`,
    );
  });
});

// PR checks never run deploy-stage's Validate mode and a dev dispatch proves one permutation, so run its script here, as
// GitHub runs a `run:` step with no `shell:` on ubuntu (`bash -e {0}`), with the variables the job and step set.
describe('deploy-stage Validate mode, run', () => {
  const stage = read('deploy-stage.yml');
  const from = stage.indexOf('- name: Validate mode');
  const script = runScripts(stage).find(
    (s) => s.line > stage.slice(0, from).split('\n').length,
  )!.script;
  const file = join(mkdtempSync(join(tmpdir(), 'validate-mode-')), 'validate.sh');
  writeFileSync(file, script.replace(/^ {10}/gm, ''));
  const DEV_ROLE = 'arn:aws:iam::111111111111:role/aperture-github-deploy-dev';
  const DEV_MAIN_ROLE = 'arn:aws:iam::111111111111:role/aperture-github-dev-main';
  const validate = (over: Record<string, string> = {}) => {
    const env = {
      MODE: 'full',
      APERTURE_STAGE: 'dev',
      APERTURE_DEPLOY_LANE: '',
      ROLE_ARN: DEV_ROLE,
      REF: '',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
      ...over,
    };
    const r = spawnSync('bash', ['-e', file], {
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
    });
    return { status: r.status, out: r.stdout };
  };
  const MAIN_PUSH = {
    APERTURE_DEPLOY_LANE: 'devmain',
    GITHUB_EVENT_NAME: 'push',
    ROLE_ARN: DEV_MAIN_ROLE,
  };

  it('is the step right after the fork guard, with every input as a variable', () => {
    expect(script).toContain('case "$MODE" in');
    expect(script).not.toContain('${{');
  });

  it.each([
    ['a dev dispatch', {}],
    ['devb, app mode', { APERTURE_STAGE: 'devb', MODE: 'app' }],
    [
      'prod, none',
      {
        APERTURE_STAGE: 'prod',
        MODE: 'none',
        ROLE_ARN: 'arn:aws:iam::222222222222:role/aperture-github-deploy-prod',
      },
    ],
    ['a dispatch with a ref', { REF: 'a'.repeat(40) }],
    ["main's devmain push", MAIN_PUSH],
    ["main's devb push", { ...MAIN_PUSH, APERTURE_STAGE: 'devb' }],
  ])('passes %s', (_, over) => {
    const r = validate(over);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/^mode=\w+ stage=\w+ lane=\w*$/m);
  });

  it.each([
    ['a bad mode', { MODE: 'everything' }],
    ['an empty mode', { MODE: '' }],
    ['a bad stage', { APERTURE_STAGE: 'staging' }],
    ['a bad lane', { APERTURE_DEPLOY_LANE: 'fast' }],
    ['devmain on prod', { ...MAIN_PUSH, APERTURE_STAGE: 'prod' }],
    ['devmain on a dispatch', { ...MAIN_PUSH, GITHUB_EVENT_NAME: 'workflow_dispatch' }],
    ['devmain on another ref', { ...MAIN_PUSH, GITHUB_REF: 'refs/heads/feature' }],
    ['devmain with a ref (a branch commit)', { ...MAIN_PUSH, REF: 'a'.repeat(40) }],
    ['devmain with the frozen role', { ...MAIN_PUSH, ROLE_ARN: DEV_ROLE }],
    ['devmain with no role (variable unset)', { ...MAIN_PUSH, ROLE_ARN: '' }],
    ['the dev-main role with no lane', { ROLE_ARN: DEV_MAIN_ROLE }],
  ])('refuses %s', (_, over) => {
    const r = validate(over);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/^::error::/m);
  });

  it.each([
    ['mode', { MODE: 'full"; echo pwned; "' }],
    ['mode, by substitution', { MODE: '$(echo pwned)' }],
    ['stage', { APERTURE_STAGE: "dev'; echo pwned; '" }],
    ['lane', { APERTURE_DEPLOY_LANE: '`echo pwned`' }],
    ['ref', { ...MAIN_PUSH, REF: '"; echo pwned; "' }],
  ])('a hostile %s is data, never code', (_, over) => {
    const r = validate(over);
    expect(r.status).toBe(1);
    expect(r.out).not.toMatch(/^pwned$/m);
  });
});
