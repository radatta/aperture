import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import {
  ApertureOrgStack,
  BREAK_GLASS_ROLE,
  DEV_BUDGET_EMAIL_USD,
  DEV_BUDGET_KILL_USD,
  allowlistPolicy,
  freezePolicy,
  guardrailsPolicy,
  killPolicy,
} from './lib/org-stack';
import { DEV_URL_FUNCTIONS } from './config/devAccount';

type Statement = {
  Sid: string;
  Effect: string;
  Action?: string | string[];
  NotAction?: string[];
  Resource?: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
};
type Resource = { Type: string; Properties: Record<string, unknown> };

const DEV = '222222222222';
const MGMT = '111111111111';
const OU = 'ou-abcd-12345678';
const BREAK_GLASS = `arn:aws:iam::*:role/${BREAK_GLASS_ROLE}`;
const KILL_ROLES = 'arn:aws:iam::*:role/aperture-kill-*';
const DEVMAIN_EXEC = 'arn:aws:iam::*:role/cdk-devmain-cfn-exec-role-*';
const DEVMAIN_DEPLOY = 'arn:aws:iam::*:role/cdk-devmain-deploy-role-*';
const DEV_MAIN_GITHUB = 'arn:aws:iam::*:role/aperture-github-dev-main';
const DEVMAIN_PUBLISH = 'arn:aws:iam::*:role/cdk-devmain-file-publishing-role-*';
// IAM's ArnLike, near enough for these patterns: `*` matches any run of characters (a pattern's own `*` included,
// and across `:`), everything else — `?` too — is literal. Looser than IAM, so only ever used to prove coverage.
const arnLike = (pattern: string, arn: string) =>
  new RegExp(`^${pattern.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`).test(arn);

function orgTemplate() {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  return Template.fromStack(
    new ApertureOrgStack(app, 'ApertureOrg', {
      env: { account: MGMT, region: 'us-east-1' },
      devAccountId: DEV,
      devOuId: OU,
    }),
  );
}

const statements = (p: { Statement: object[] }) => p.Statement as Statement[];
const actions = (p: { Statement: object[] }) =>
  statements(p).flatMap((s) => (Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : []));
const exempted = (s: Statement) => [s.Condition?.ArnNotLike?.['aws:PrincipalARN'] ?? []].flat();

describe('dev-account SCPs', () => {
  const standing = {
    allowlist: allowlistPolicy(),
    guardrails: guardrailsPolicy(),
    freeze: freezePolicy(),
  };

  // The SCP limit is 10,240 characters (the Organizations quota page); 7,680 leaves a quarter of it free.
  it('fit well inside the SCP size limit', () => {
    for (const p of [...Object.values(standing), killPolicy()])
      expect(JSON.stringify(p).length).toBeLessThan(7_680);
  });

  // Exactly these: one pattern too broad (say `role/cdk-*`) would switch an SCP off for the frozen deploy itself.
  it('are deny-only, and every standing deny exempts exactly its intended roles', () => {
    const lane: Record<string, string[]> = {
      OnlyMainAssumesItsLane: [BREAK_GLASS, DEV_MAIN_GITHUB],
      NoLaneTampering: [BREAK_GLASS, DEVMAIN_DEPLOY],
      DevMainBootstrapIntact: [BREAK_GLASS, DEVMAIN_PUBLISH],
    };
    for (const [name, p] of Object.entries(standing))
      for (const s of statements(p)) {
        expect(s.Effect).toBe('Deny');
        const want = lane[s.Sid] ?? (name === 'freeze' ? [BREAK_GLASS, KILL_ROLES, DEVMAIN_EXEC] : [BREAK_GLASS, KILL_ROLES]);
        expect(exempted(s), s.Sid).toEqual(want);
      }
  });

  it('put every exempted role out of reach — nothing else in dev may change, create or pass one', () => {
    const guards = statements(standing.guardrails).filter((x) => ['NoGuardTampering', 'NoLaneTampering'].includes(x.Sid));
    expect(guards.map((g) => g.Action)).toEqual([['iam:*'], ['iam:*']]);
    const covered = (arn: string) => guards.some((g) => [g.Resource].flat().some((r) => r !== undefined && arnLike(r, arn)));
    for (const p of Object.values(standing))
      for (const s of statements(p)) for (const r of exempted(s)) expect(covered(r), r).toBe(true);
  });

  // Main's own dev deploy (docs/ops/CI-BOT.md → Two lanes).
  describe("main's freeze-exempt lane", () => {
    const g = (sid: string) => statements(standing.guardrails).find((x) => x.Sid === sid)!;
    const freezeExempt = (arn: string) =>
      statements(standing.freeze).every((s) => exempted(s).some((e) => arnLike(e, arn)));

    it("exempts the devmain exec role from the freeze, and neither the stock exec role nor devmain's deploy role", () => {
      expect(freezeExempt(`arn:aws:iam::${DEV}:role/cdk-devmain-cfn-exec-role-${DEV}-us-west-1`)).toBe(true);
      expect(freezeExempt(`arn:aws:iam::${DEV}:role/cdk-hnb659fds-cfn-exec-role-${DEV}-us-west-1`)).toBe(false);
      expect(freezeExempt(`arn:aws:iam::${DEV}:role/cdk-devmain-deploy-role-${DEV}-us-west-1`)).toBe(false);
      expect(freezeExempt(`arn:aws:iam::${DEV}:role/aperture-github-dev-main`)).toBe(false);
    });

    it('lets only the dev-main role and break-glass assume a devmain bootstrap role, and nothing assume a GitHub role', () => {
      expect(g('OnlyMainAssumesItsLane')).toMatchObject({
        Action: ['sts:AssumeRole'],
        Resource: ['arn:aws:iam::*:role/cdk-devmain-*', 'arn:aws:iam::*:role/aperture-github-*'],
      });
    });

    // CloudFormation reuses a stack's stored role for a call that names none — after main's deploy, the exempt one.
    it('makes every stack call name its role, so none inherits the freeze-exempt one', () => {
      const s = g('NameTheStackRole');
      expect(s.Action).toEqual([
        'cloudformation:CreateStack',
        'cloudformation:UpdateStack',
        'cloudformation:CreateChangeSet',
        'cloudformation:DeleteStack',
        'cloudformation:RollbackStack',
        'cloudformation:ContinueUpdateRollback',
      ]);
      expect(s.Resource).toBe('*');
      expect(s.Condition?.Null).toEqual({ 'cloudformation:RoleArn': 'true' });
    });

    // An access point is a second address for a bucket that the bucket-ARN deny may not cover.
    it('denies creating an S3 access point anywhere in dev', () => {
      const sinks = statements(standing.guardrails).find((x) => x.Sid === 'NoCostSinks')!;
      expect(sinks.Action).toEqual(expect.arrayContaining(['s3:CreateAccessPoint*', 's3:CreateMultiRegionAccessPoint*']));
    });

    it("keeps everything but devmain's publishing role off its bucket, and everything but break-glass off its version and stack", () => {
      const s = g('DevMainBootstrapIntact');
      for (const a of ['s3:PutObject*', 's3:DeleteObject*', 's3:PutBucket*', 'ssm:PutParameter', 'ssm:DeleteParameter*', 'cloudformation:UpdateStack', 'cloudformation:DeleteStack'])
        expect(s.Action).toContain(a);
      expect(s.Resource).toEqual([
        'arn:aws:s3:::cdk-devmain-*',
        'arn:aws:s3:::cdk-devmain-*/*',
        'arn:aws:ssm:*:*:parameter/cdk-bootstrap/devmain/*',
        'arn:aws:cloudformation:*:*:stack/CDKToolkit-devmain/*',
      ]);
      expect(arnLike(DEVMAIN_PUBLISH, `arn:aws:iam::${DEV}:role/cdk-devmain-file-publishing-role-${DEV}-us-west-1`)).toBe(true);
      expect(arnLike(DEVMAIN_PUBLISH, `arn:aws:iam::${DEV}:role/cdk-hnb659fds-file-publishing-role-${DEV}-us-west-1`)).toBe(false);
    });

    it('lets nothing but break-glass change or pass a devmain or GitHub role, bar the deploy role passing its exec role', () => {
      expect(g('NoLaneTampering')).toMatchObject({
        Action: ['iam:*'],
        Resource: ['arn:aws:iam::*:role/cdk-devmain-*', 'arn:aws:iam::*:role/aperture-github-*'],
      });
      for (const r of ['aperture-github-deploy-dev', 'aperture-github-dev-main', 'aperture-github-logs-dev', `cdk-devmain-cfn-exec-role-${DEV}-us-west-1`])
        expect([g('NoLaneTampering').Resource].flat().some((p) => arnLike(p!, `arn:aws:iam::${DEV}:role/${r}`)), r).toBe(true);
    });

    it('still stops the lane on a kill: only break-glass is exempt', () => {
      expect(exempted(statements(killPolicy())[0]!)).toEqual([BREAK_GLASS]);
    });
  });

  it('exempt only the break-glass role from the kill, so a kill also stops the forwarder and everything else', () => {
    const [s] = statements(killPolicy());
    expect(s).toMatchObject({ Effect: 'Deny', Action: '*', Resource: '*' });
    expect(exempted(s!)).toEqual([BREAK_GLASS]);
  });

  it('admit only the services the dev stacks and CI use', () => {
    const allowed = statements(standing.allowlist)[0]!.NotAction!;
    for (const svc of ['lambda', 'dynamodb', 's3', 'cloudfront', 'cognito-idp', 'logs', 'scheduler', 'kms', 'iam', 'sts', 'cloudformation'])
      expect(allowed).toContain(`${svc}:*`);
    for (const svc of ['ec2', 'bedrock', 'sagemaker', 'sns', 'events', 'cloudwatch', 'ecr', 'ses', 'states', 'acm', 'ssm'])
      expect(allowed).not.toContain(`${svc}:*`);
    // CloudWatch only for reads — alarms cost money and the kill alarms are the break-glass role's; ACM only for
    // reads — the cert is requested by the break-glass role, and exportable public certs bill per name; SSM only
    // Parameter Store — OpsCenter and Automation bill per item or step.
    expect(allowed.filter((a) => a.startsWith('cloudwatch:'))).toEqual(['cloudwatch:Describe*', 'cloudwatch:Get*', 'cloudwatch:List*']);
    expect(allowed.filter((a) => a.startsWith('acm:'))).toEqual(['acm:Describe*', 'acm:Get*', 'acm:List*']);
    expect(allowed.filter((a) => a.startsWith('ssm:'))).toEqual([
      'ssm:*Parameter*',
      'ssm:AddTagsToResource',
      'ssm:RemoveTagsFromResource',
      'ssm:ListTagsForResource',
    ]);
  });

  it('pin dev to us-west-1, leaving the global services (ACM, CloudFront, IAM, STS) reachable', () => {
    const region = statements(standing.guardrails).find((s) => s.Sid === 'OnlyDevRegion')!;
    expect(region.Condition?.StringNotEquals).toEqual({ 'aws:RequestedRegion': 'us-west-1' });
    for (const g of ['iam:*', 'sts:*', 'cloudfront:*', 'acm:*'])
      expect(region.NotAction).toContain(g);
    expect(region.NotAction).not.toContain('lambda:*'); // Lambda@Edge replicates from us-east-1
  });

  it('deny every lever the cost analysis found that an SCP can name', () => {
    const denied = actions(standing.guardrails);
    for (const a of [
      'servicequotas:Request*',
      'support:*',
      'organizations:LeaveOrganization',
      'lambda:PutFunctionConcurrency',
      'lambda:PutProvisionedConcurrencyConfig',
      'lambda:PutFunctionRecursionConfig',
      'lambda:CreateEventSourceMapping',
      'dynamodb:RestoreTable*',
      'dynamodb:PurchaseReservedCapacityOfferings',
      'dynamodb:UpdateContributorInsights',
      'cloudfront:CreateInvalidation*',
      'cloudfront:AssociateAlias',
      'cloudfront:*PricingPlan*',
      'iam:CreateUser',
      'iam:CreateAccessKey',
      'iam:*OpenIDConnectProvider*',
      'kms:CreateKey',
      'logs:PutSubscriptionFilter',
      'logs:PutMetricFilter',
      'logs:PutResourcePolicy',
      's3:PutAccountPublicAccessBlock',
      's3:PutReplicationConfiguration',
      's3:PutMetricsConfiguration',
      's3:PutBucketObjectLockConfiguration',
    ])
      expect(denied).toContain(a);
  });

  it("freeze a function's shape, the table, the schedules, and every grant that would outlive a kill", () => {
    const frozen = actions(standing.freeze);
    for (const a of [
      'lambda:CreateFunction',
      'lambda:UpdateFunctionConfiguration',
      'lambda:CreateFunctionUrlConfig',
      'lambda:UpdateFunctionUrlConfig',
      'lambda:AddPermission',
      'lambda:PutFunctionEventInvokeConfig',
      'dynamodb:CreateTable',
      'dynamodb:UpdateTable',
      'dynamodb:PutResourcePolicy',
      'scheduler:CreateSchedule',
      'scheduler:UpdateSchedule',
      's3:CreateBucket',
      's3:PutBucketPolicy',
      's3:PutBucketAcl',
      's3:PutBucketOwnershipControls',
      'cloudfront:CreateDistribution*',
      'iam:CreateRole',
      'iam:UpdateAssumeRolePolicy',
    ])
      expect(frozen).toContain(a);
    for (const a of ['s3:PutLifecycleConfiguration', 'cloudfront:CopyDistribution', 'cognito-idp:UpdateUserPool*', 'cognito-idp:CreateUserPool*', 'cognito-idp:AdminCreateUser'])
      expect(frozen).toContain(a);
    // Code updates stay open for the app's own functions — they are what a dev deploy is — and closed only for CDK's
    // 15-minute provider functions, which CloudFormation names `Aperture…` (the app's are `aperture-…`).
    const code = statements(standing.freeze).filter((x) => [x.Action].flat().includes('lambda:UpdateFunctionCode'));
    expect(code.map((x) => x.Resource)).toEqual(['arn:aws:lambda:*:*:function:Aperture*']);
  });

  it('let only Standard-class uploads through — an upload with no class header is Standard', () => {
    const s = statements(standing.guardrails).find((x) => x.Sid === 'StandardStorageOnly')!;
    expect(s.Action).toEqual(['s3:PutObject']);
    expect(s.Condition?.StringNotEquals).toEqual({ 's3:x-amz-storage-class': 'STANDARD' });
    expect(s.Condition?.Null).toEqual({ 's3:x-amz-storage-class': 'false' }); // only when the header is present
  });
});

describe('ApertureOrgStack', () => {
  const t = orgTemplate();
  const res = t.toJSON().Resources as Record<string, Resource>;
  const of = (type: string) => Object.entries(res).filter(([, r]) => r.Type === type);
  // The one resource of a type (optionally by Name/TopicName), as [logicalId, resource].
  const only = (type: string, name?: string): [string, Resource] => {
    const m = of(type).filter(
      ([, r]) => !name || r.Properties.Name === name || r.Properties.TopicName === name,
    );
    expect(m).toHaveLength(1);
    return m[0]!;
  };

  it('attaches the three standing SCPs to the Dev OU and leaves the kill SCP unattached', () => {
    const scps = Object.fromEntries(
      of('AWS::Organizations::Policy').map(([, r]) => [r.Properties.Name, r.Properties.TargetIds]),
    );
    expect(scps).toEqual({
      'aperture-dev-allowlist': [OU],
      'aperture-dev-guardrails': [OU],
      'aperture-dev-freeze': [OU],
      'aperture-dev-kill': undefined,
    });
  });

  it('gives the kill Lambda the kill SCP, the dev account, its break-glass role and the URL functions, and only the grants it needs', () => {
    const [, fn] = only('AWS::Lambda::Function');
    const vars = (fn.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(vars).toMatchObject({
      DEV_ACCOUNT_ID: DEV,
      DEV_REGION: 'us-west-1',
      BREAK_GLASS_ROLE_ARN: `arn:aws:iam::${DEV}:role/${BREAK_GLASS_ROLE}`,
      URL_FUNCTIONS: DEV_URL_FUNCTIONS.join(','),
    });
    const [killId] = only('AWS::Organizations::Policy', 'aperture-dev-kill');
    expect(vars.KILL_POLICY_ID).toEqual({ 'Fn::GetAtt': [killId, 'Id'] });
    const grants = JSON.stringify(
      of('AWS::IAM::Policy').map(([, r]) => r.Properties.PolicyDocument),
    );
    expect(grants).toContain('organizations:AttachPolicy');
    expect(grants).toContain(`arn:aws:iam::${DEV}:role/${BREAK_GLASS_ROLE}`);
    expect(grants).not.toContain('organizations:DetachPolicy'); // only a human unkills
  });

  it("lets only dev's forwarder role put events on this bus, and fires the Lambda and the email on a dev kill alarm", () => {
    const [, busPolicy] = only('AWS::Events::EventBusPolicy');
    expect((busPolicy.Properties.Statement as { Principal: unknown }).Principal).toEqual({
      AWS: `arn:aws:iam::${DEV}:role/aperture-kill-forwarder`,
    });
    const [, rule] = only('AWS::Events::Rule');
    expect(rule.Properties.EventPattern).toMatchObject({
      source: ['aws.cloudwatch'],
      account: [DEV],
      detail: { alarmName: [{ prefix: 'aperture-kill-' }], state: { value: ['ALARM'] } },
    });
    const targetArns = JSON.stringify(
      (rule.Properties.Targets as { Arn: unknown }[]).map((x) => x.Arn),
    );
    const [fnId] = only('AWS::Lambda::Function');
    const [alertsId] = only('AWS::SNS::Topic', 'aperture-dev-kill-alerts');
    expect(targetArns).toContain(fnId);
    expect(targetArns).toContain(alertsId);
  });

  it("emails a failed kill, so a broken switch can't fail silently", () => {
    const [, cfg] = only('AWS::Lambda::EventInvokeConfig');
    const [alertsId] = only('AWS::SNS::Topic', 'aperture-dev-kill-alerts');
    expect(JSON.stringify(cfg.Properties.DestinationConfig)).toContain(alertsId);
  });

  it('budgets the dev account alone: email at the first threshold, kill at the second', () => {
    const [, b] = only('AWS::Budgets::Budget');
    const budget = b.Properties.Budget as { CostFilters: unknown };
    expect(budget.CostFilters).toEqual({ LinkedAccount: [DEV] });
    const notes = b.Properties.NotificationsWithSubscribers as {
      Notification: { Threshold: number };
      Subscribers: { SubscriptionType: string; Address: unknown }[];
    }[];
    expect(notes.map((n) => n.Notification.Threshold)).toEqual([
      DEV_BUDGET_EMAIL_USD,
      DEV_BUDGET_KILL_USD,
    ]);
    const [budgetTopicId] = only('AWS::SNS::Topic', 'aperture-dev-budget-kill');
    expect(JSON.stringify(notes[1]!.Subscribers)).toContain(budgetTopicId);
    expect(JSON.stringify(notes[0]!.Subscribers)).not.toContain('SNS');
    // …and that topic triggers the kill Lambda.
    const subs = of('AWS::SNS::Subscription').map(([, r]) => r.Properties);
    expect(
      subs.some(
        (s) => s.Protocol === 'lambda' && JSON.stringify(s.TopicArn).includes(budgetTopicId),
      ),
    ).toBe(true);
  });
});
