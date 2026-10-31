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
  Condition?: Record<string, Record<string, string | string[]>>;
};
type Resource = { Type: string; Properties: Record<string, unknown> };

const DEV = '222222222222';
const MGMT = '111111111111';
const OU = 'ou-abcd-12345678';

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

  it('fit the SCP size limit (10,240 characters, minified)', () => {
    for (const p of [...Object.values(standing), killPolicy()])
      expect(JSON.stringify(p).length).toBeLessThan(10_240);
  });

  it('are deny-only, and every standing deny exempts the break-glass role so a hand step can never be locked out', () => {
    for (const p of Object.values(standing))
      for (const s of statements(p)) {
        expect(s.Effect).toBe('Deny');
        expect(exempted(s)).toContain(`arn:aws:iam::*:role/${BREAK_GLASS_ROLE}`);
      }
  });

  it('exempt only the break-glass role from the kill, so a kill also stops the forwarder and everything else', () => {
    const [s] = statements(killPolicy());
    expect(s).toMatchObject({ Effect: 'Deny', Action: '*', Resource: '*' });
    expect(exempted(s!)).toEqual([`arn:aws:iam::*:role/${BREAK_GLASS_ROLE}`]);
  });

  it('admit only the services the dev stacks and CI use', () => {
    const allowed = statements(standing.allowlist)[0]!.NotAction!;
    for (const svc of [
      'lambda',
      'dynamodb',
      's3',
      'cloudfront',
      'cognito-idp',
      'logs',
      'scheduler',
      'ssm',
      'kms',
      'iam',
      'sts',
      'cloudformation',
    ])
      expect(allowed).toContain(`${svc}:*`);
    for (const svc of [
      'ec2',
      'bedrock',
      'sagemaker',
      'sns',
      'events',
      'cloudwatch',
      'ecr',
      'ses',
      'states',
    ])
      expect(allowed).not.toContain(`${svc}:*`);
    // CloudWatch only for reads — alarms cost money and the kill alarms are the break-glass role's.
    expect(allowed.filter((a) => a.startsWith('cloudwatch:'))).toEqual([
      'cloudwatch:Describe*',
      'cloudwatch:Get*',
      'cloudwatch:List*',
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
      'cloudfront:CreateInvalidation*',
      'cloudfront:AssociateAlias',
      'iam:CreateUser',
      'iam:CreateAccessKey',
      'iam:*OpenIDConnectProvider*',
      'kms:CreateKey',
      'logs:PutSubscriptionFilter',
      's3:PutAccountPublicAccessBlock',
      's3:PutReplicationConfiguration',
    ])
      expect(denied).toContain(a);
  });

  it('keep the break-glass and kill roles out of reach of everything else in dev', () => {
    const s = statements(standing.guardrails).find((x) => x.Sid === 'NoGuardTampering')!;
    expect(s.Action).toEqual(['iam:*']);
    expect(JSON.stringify((s as { Resource?: unknown }).Resource)).toContain(BREAK_GLASS_ROLE);
    expect(JSON.stringify((s as { Resource?: unknown }).Resource)).toContain(
      'role/aperture-kill-*',
    );
  });

  it("freeze a function's shape, the table and the schedules", () => {
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
      'scheduler:CreateSchedule',
      'scheduler:UpdateSchedule',
    ])
      expect(frozen).toContain(a);
    // Code updates stay open — they are what a dev deploy is.
    expect(frozen).not.toContain('lambda:UpdateFunctionCode');
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

  it('gives the kill Lambda the kill SCP, the dev account and the URL functions, and only the grants it needs', () => {
    const [, fn] = only('AWS::Lambda::Function');
    const vars = (fn.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(vars).toMatchObject({
      DEV_ACCOUNT_ID: DEV,
      DEV_REGION: 'us-west-1',
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

  it('lets only the dev account put events on this bus, and fires the Lambda and the email on a dev kill alarm', () => {
    const [, busPolicy] = only('AWS::Events::EventBusPolicy');
    expect(JSON.stringify(busPolicy.Properties.Statement)).toContain(`arn:aws:iam::${DEV}:root`);
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
    const budget = b.Properties.Budget as { CostFilters: unknown; BudgetLimit: { Amount: number } };
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
