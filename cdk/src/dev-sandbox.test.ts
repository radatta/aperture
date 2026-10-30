import { readFileSync } from 'node:fs';
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

// cdk.json's feature flags (minimizePolicies merges statements), so the asserted policy shape is the deployed one.
const CDK_FLAGS = (
  JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8')) as {
    context: Record<string, unknown>;
  }
).context;

const t = Template.fromStack(
  new ApertureDevSandboxStack(new App({ context: CDK_FLAGS }), 'ApertureDevSandbox', {
    env: { account: ACCOUNT, region: 'us-west-1' },
    devUserPoolId: POOL,
    devDistributionId: DIST,
  }),
);
const resources = t.toJSON().Resources as Record<string, Res>;
const actionsOf = (s: Stmt) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const text = (v: unknown) => JSON.stringify(v);
const resourcesOf = (s: Stmt) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]);
const withAny = (stmts: Stmt[], actions: string[]) =>
  stmts.filter((s) => s.Effect === 'Allow' && actionsOf(s).some((a) => actions.includes(a)));

// A granted ARN as IAM sees it: Fn::Join flattened, the partition and account filled in, other refs kept as `<id>`.
function resolve(v: unknown): string {
  if (typeof v === 'string') return v;
  const o = v as Record<string, unknown>;
  if (o['Fn::Join']) {
    const [sep, parts] = o['Fn::Join'] as [string, unknown[]];
    return parts.map(resolve).join(sep);
  }
  if (o.Ref === 'AWS::Partition') return 'aws';
  if (o.Ref === 'AWS::AccountId') return ACCOUNT;
  return `<${text(v)}>`;
}
const globMatches = (pattern: string, name: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(name);

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
      for (const st of ['ApertureData-dev', 'ApertureApp-dev'])
        expect(res.some((r) => r.includes(`stack/${st}/*`))).toBe(true);
    }
    // Without RoleArn, UpdateStack reuses the stack's stored role — so every statement granting a mutating call
    // must name ours.
    const mutating = [
      'cloudformation:CreateStack',
      'cloudformation:UpdateStack',
      'cloudformation:RollbackStack',
      'cloudformation:ContinueUpdateRollback',
    ];
    const granting = withAny(stmts, mutating);
    expect(granting.flatMap(actionsOf)).toEqual(expect.arrayContaining(mutating));
    for (const s of granting)
      expect(text(s.Condition?.StringEquals?.['cloudformation:RoleArn'])).toContain('CfnExecRole');
    // No change sets (one left by a default-bootstrap run would execute with its admin role), no DeleteStack.
    const all = stmts.flatMap(actionsOf);
    expect(all.filter((a) => /ChangeSet/.test(a))).toEqual([]);
    expect(all).not.toContain('cloudformation:DeleteStack');
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

  it('creates, re-bounds or re-policies a role only while it carries the dev boundary, and never lifts it', () => {
    const stmts = roleStatements('cfn-exec');
    const bounded = [
      'iam:CreateRole',
      'iam:PutRolePermissionsBoundary',
      'iam:PutRolePolicy',
      'iam:DeleteRolePolicy',
      'iam:AttachRolePolicy',
      'iam:DetachRolePolicy',
    ];
    const granting = withAny(stmts, bounded);
    expect(granting.flatMap(actionsOf)).toEqual(expect.arrayContaining(bounded));
    for (const s of granting)
      expect(text(s.Condition?.StringEquals?.['iam:PermissionsBoundary'])).toContain(
        `policy/${DEV_BOUNDARY_NAME}`,
      );
    for (const s of withAny(stmts, ['iam:AttachRolePolicy', 'iam:DetachRolePolicy']))
      expect(text(s.Condition?.ArnEquals?.['iam:PolicyARN'])).toContain(
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
    // Moving a domain alias onto dev's distribution could pull prod's hostname onto branch code.
    for (const a of ['cloudfront:AssociateAlias', 'cloudfront:UpdateDomainAssociation'])
      expect(stmts.some((x) => x.Effect === 'Deny' && actionsOf(x).includes(a))).toBe(true);
    // No managed-policy actions at all: the boundary and this policy can't be rewritten from here.
    expect(
      stmts
        .flatMap(actionsOf)
        .some((a) => /^iam:.*Policy(Version)?$/.test(a) && !/RolePolicy$/.test(a)),
    ).toBe(false);
  });

  it('grants no pattern, in any role or the boundary, that matches a prod or default-bootstrap name', () => {
    const prod = [
      `arn:aws:lambda:us-west-1:${ACCOUNT}:function:aperture-bff-prod`,
      `arn:aws:lambda:us-west-1:${ACCOUNT}:function:ApertureApp-prod-LogRetentionX`,
      `arn:aws:logs:us-west-1:${ACCOUNT}:log-group:/aws/lambda/aperture-bff-prod`,
      `arn:aws:logs:us-west-1:${ACCOUNT}:log-group:/aws/lambda/aperture-bff-prod:*`,
      `arn:aws:logs:us-west-1:${ACCOUNT}:log-group:/aws/lambda/aperture-x-device-prod`,
      `arn:aws:dynamodb:us-west-1:${ACCOUNT}:table/aperture-prod`,
      `arn:aws:dynamodb:us-west-1:${ACCOUNT}:table/aperture-prod/index/GSI1`,
      `arn:aws:iam::${ACCOUNT}:role/ApertureApp-prod-BffServiceRoleX`,
      `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-cfn-exec-role-${ACCOUNT}-us-west-1`,
      'arn:aws:s3:::apertureapp-prod-sitex',
      'arn:aws:s3:::aperturedata-prod-filesx/u/a',
      `arn:aws:s3:::cdk-hnb659fds-assets-${ACCOUNT}-us-west-1/x`,
      `arn:aws:ssm:us-west-1:${ACCOUNT}:parameter/aperture/prod/plaid/secret`,
      `arn:aws:cloudformation:us-west-1:${ACCOUNT}:stack/ApertureApp-prod/abc`,
      `arn:aws:scheduler:us-west-1:${ACCOUNT}:schedule/aperture-finance-prod/x`,
      `arn:aws:cognito-idp:us-west-1:${ACCOUNT}:userpool/us-west-1_PRODPOOL`,
      `arn:aws:cloudfront::${ACCOUNT}:distribution/EPRODDIST`,
    ];
    const policies = Object.values(resources).filter((r) =>
      /AWS::IAM::(Managed)?Policy/.test(r.Type),
    );
    const allows = policies.flatMap((r) =>
      (r.Properties.PolicyDocument as { Statement: Stmt[] }).Statement.filter(
        (x) => x.Effect === 'Allow',
      ),
    );
    expect(allows.length).toBeGreaterThan(20);
    for (const s of allows)
      for (const pattern of resourcesOf(s).map(resolve)) {
        if (pattern === '*') continue; // the allowlisted unscopable actions, checked above
        for (const name of prod)
          expect(globMatches(pattern, name), `${pattern} matches ${name}`).toBe(false);
      }
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
