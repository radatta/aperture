import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ApertureDevSandboxStack, DEV_BOOTSTRAP_VERSION } from './lib/dev-sandbox-stack';
import { DEV_BOUNDARY_NAME, DEV_EXEC_POLICY_NAME, DEV_QUALIFIER } from './lib/dev-stage';

interface Stmt {
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}
type Res = { Type: string; Properties: Record<string, unknown> };

const ACCOUNT = '111111111111';
const POOL = 'us-west-1_TESTPOOL';
const DIST = 'ETESTDIST';

const t = Template.fromStack(
  new ApertureDevSandboxStack(new App(), 'ApertureDevSandbox', {
    env: { account: ACCOUNT, region: 'us-west-1' },
    devUserPoolId: POOL,
    devDistributionId: DIST,
  }),
);
const resources = t.toJSON().Resources as Record<string, Res>;
const actionsOf = (s: Stmt) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const text = (v: unknown) => JSON.stringify(v);

// The role's own statements: its inline policies (CDK's DefaultPolicy, or the named exec policy).
function roleStatements(kind: string): Stmt[] {
  const [id] = Object.entries(resources).find(
    ([, r]) =>
      r.Type === 'AWS::IAM::Role' &&
      text(r.Properties.RoleName).includes(`cdk-${DEV_QUALIFIER}-${kind}-role-`),
  ) ?? [''];
  expect(id).not.toBe('');
  return Object.values(resources)
    .filter((r) => r.Type === 'AWS::IAM::Policy' && text(r.Properties.Roles).includes(`"${id}"`))
    .flatMap((r) => (r.Properties.PolicyDocument as { Statement: Stmt[] }).Statement);
}
const boundaryStatements = () =>
  (
    Object.values(resources).find(
      (r) =>
        r.Type === 'AWS::IAM::ManagedPolicy' &&
        r.Properties.ManagedPolicyName === DEV_BOUNDARY_NAME,
    )?.Properties.PolicyDocument as { Statement: Stmt[] }
  ).Statement;

describe('ApertureDevSandboxStack (dev-only CDK bootstrap)', () => {
  it('names the version parameter, bucket and four roles the way the devsandbox synthesizer expects', () => {
    t.hasResourceProperties('AWS::SSM::Parameter', {
      Name: `/cdk-bootstrap/${DEV_QUALIFIER}/version`,
      Value: DEV_BOOTSTRAP_VERSION,
    });
    t.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: `cdk-${DEV_QUALIFIER}-assets-${ACCOUNT}-us-west-1`,
    });
    const names = Object.values(resources)
      .filter((r) => r.Type === 'AWS::IAM::Role')
      .map((r) => r.Properties.RoleName)
      .sort();
    expect(names).toEqual(
      ['cfn-exec', 'deploy', 'file-publishing', 'lookup'].map(
        (k) => `cdk-${DEV_QUALIFIER}-${k}-role-${ACCOUNT}-us-west-1`,
      ),
    );
  });

  it('attaches no managed policy to any role (no AdministratorAccess, ReadOnlyAccess or CloudFormation read-all)', () => {
    for (const r of Object.values(resources).filter((x) => x.Type === 'AWS::IAM::Role'))
      expect(r.Properties.ManagedPolicyArns).toBeUndefined();
  });

  it('grants nothing on prod or the default bootstrap, anywhere', () => {
    const all = text(t.toJSON());
    expect(all).not.toMatch(/prod/i);
    expect(all).not.toContain('hnb659fds');
  });

  it('lets the deploy role touch only the two dev stacks, and change them only with the sandbox execution role', () => {
    const stmts = roleStatements('deploy');
    const cfn = stmts.filter((s) => actionsOf(s).some((a) => a.startsWith('cloudformation:')));
    expect(cfn.length).toBeGreaterThan(0);
    for (const s of cfn) {
      const res = (Array.isArray(s.Resource) ? s.Resource : [s.Resource]).map(text);
      expect(res).toHaveLength(2);
      expect(res[0]).toContain('stack/ApertureData-dev/*');
      expect(res[1]).toContain('stack/ApertureApp-dev/*');
    }
    // Without RoleArn, UpdateStack reuses the stack's stored role — so every mutating call must name ours.
    const mutating = [
      'cloudformation:CreateStack',
      'cloudformation:UpdateStack',
      'cloudformation:CreateChangeSet',
    ];
    for (const a of mutating) {
      const s = cfn.find((x) => actionsOf(x).includes(a));
      expect(text(s?.Condition?.StringEquals?.['cloudformation:RoleArn'])).toContain('CfnExecRole');
    }
    expect(stmts.flatMap(actionsOf)).not.toContain('cloudformation:DeleteStack');
    const pass = stmts.find((s) => actionsOf(s).includes('iam:PassRole'));
    expect(text(pass?.Resource)).toContain('CfnExecRole');
  });

  it('gives the lookup role only the dev stacks’ templates and the version parameter', () => {
    const acts = roleStatements('lookup').flatMap(actionsOf).sort();
    expect(acts).toEqual([
      'cloudformation:DescribeStacks',
      'cloudformation:GetTemplate',
      'cloudformation:GetTemplateSummary',
      'ssm:GetParameter',
      'ssm:GetParameters',
    ]);
  });

  it('keeps the execution policy inside dev: dev-named, pinned, or an allowlisted unscopable action', () => {
    const stmts = roleStatements('cfn-exec');
    expect(
      Object.values(resources).some((r) => r.Properties.PolicyName === DEV_EXEC_POLICY_NAME),
    ).toBe(true);
    const actions = stmts.flatMap(actionsOf);
    expect(actions.some((a) => a.startsWith('sts:'))).toBe(false);
    expect(actions).not.toContain('*');
    expect(actions).not.toContain('iam:*');
    const starOk = [
      'logs:DescribeLogGroups',
      'cognito-idp:DescribeUserPoolDomain',
      'acm:DescribeCertificate',
      'acm:ListCertificates',
    ];
    for (const s of stmts.filter((x) => x.Effect === 'Allow')) {
      const res = (Array.isArray(s.Resource) ? s.Resource : [s.Resource]).map(text);
      for (const r of res) {
        if (r === '"*"') {
          for (const a of actionsOf(s)) expect(starOk).toContain(a);
          continue;
        }
        const scoped =
          r.includes('-dev') ||
          r.includes(DEV_QUALIFIER) ||
          r.includes('Assets') ||
          r.includes('Version') ||
          r.includes(POOL) ||
          r.includes(DIST) ||
          /origin-access-control\/\*|cache-policy\/\*|origin-request-policy\/\*/.test(r);
        expect(scoped, `${actionsOf(s).join(',')} on ${r}`).toBe(true);
      }
    }
  });

  it('creates or re-bounds a role only with the dev boundary, and never lifts it', () => {
    const stmts = roleStatements('cfn-exec');
    for (const a of ['iam:CreateRole', 'iam:PutRolePermissionsBoundary']) {
      const s = stmts.find((x) => x.Effect === 'Allow' && actionsOf(x).includes(a));
      expect(text(s?.Condition?.StringEquals?.['iam:PermissionsBoundary'])).toContain(
        `policy/${DEV_BOUNDARY_NAME}`,
      );
    }
    const attach = stmts.find((x) => actionsOf(x).includes('iam:AttachRolePolicy'));
    expect(text(attach?.Condition?.ArnEquals?.['iam:PolicyARN'])).toContain(
      'AWSLambdaBasicExecutionRole',
    );
    const pass = stmts.find((x) => actionsOf(x).includes('iam:PassRole'));
    expect(pass?.Condition?.StringEquals?.['iam:PassedToService']).toEqual([
      'lambda.amazonaws.com',
      'scheduler.amazonaws.com',
    ]);
    expect(
      stmts.some(
        (x) => x.Effect === 'Deny' && actionsOf(x).includes('iam:DeleteRolePermissionsBoundary'),
      ),
    ).toBe(true);
    // No managed-policy actions at all: the boundary and this policy can't be rewritten from here.
    expect(
      stmts
        .flatMap(actionsOf)
        .some((a) => /^iam:.*Policy(Version)?$/.test(a) && !/RolePolicy$/.test(a)),
    ).toBe(false);
  });

  it('bounds dev roles to dev data, with no sts, iam, Cognito or CloudFront', () => {
    const stmts = boundaryStatements();
    const actions = stmts.flatMap(actionsOf);
    for (const svc of ['sts:', 'iam:', 'cognito-idp:', 'cloudfront:'])
      expect(actions.some((a) => a.startsWith(svc))).toBe(false);
    for (const s of stmts) {
      if (s.Resource === '*') {
        expect(actionsOf(s).every((a) => a.startsWith('kms:'))).toBe(true);
        expect(s.Condition?.StringEquals?.['kms:ViaService']).toBe('ssm.us-west-1.amazonaws.com');
        continue;
      }
      for (const r of (Array.isArray(s.Resource) ? s.Resource : [s.Resource]).map(text))
        expect(r).toMatch(/-dev|aperture\/dev\//);
    }
  });
});
