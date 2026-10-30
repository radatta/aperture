import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ApertureCicdStack } from './lib/cicd-stack';

function cicdTemplate() {
  const app = new App();
  const stack = new ApertureCicdStack(app, 'ApertureCicd', {
    env: { account: '111111111111', region: 'us-west-1' },
    githubRepo: 'acme/aperture',
  });
  return Template.fromStack(stack);
}

describe('ApertureCicdStack', () => {
  const t = cicdTemplate();

  it('creates the GitHub OIDC provider', () => {
    // CDK backs OpenIdConnectProvider with a custom resource; assert it's present (the two named deploy
    // roles are pinned by the trust-subject tests below).
    t.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 1);
  });

  it('trusts the dev role only from the dev environment', () => {
    t.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'aperture-github-deploy-dev',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: Match.objectLike({
              StringLike: {
                // environment:dev — every dev deploy runs in the `dev` GitHub environment, on main (a push or
                // a bot dispatch), so that's the only trusted sub. The cutover ref subs were pruned 2026-08.
                'token.actions.githubusercontent.com:sub': ['repo:acme/aperture:environment:dev'],
              },
            }),
          }),
        ]),
      }),
    });
  });

  it('binds the prod role to the prod GitHub environment (not a branch)', () => {
    t.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'aperture-github-deploy-prod',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              StringLike: {
                'token.actions.githubusercontent.com:sub': ['repo:acme/aperture:environment:prod'],
              },
            }),
          }),
        ]),
      }),
    });
  });

  it('grants deploy power only by assuming the CDK bootstrap roles', () => {
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({ Action: 'sts:AssumeRole' })]),
      }),
    });
  });

  it('trusts the logs role only from the main-only dev-logs environment', () => {
    t.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'aperture-github-logs-dev',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              StringLike: {
                'token.actions.githubusercontent.com:sub': [
                  'repo:acme/aperture:environment:dev-logs',
                ],
              },
            }),
          }),
        ]),
      }),
    });
  });

  it('lets the logs role read only the three dev Lambda groups, and nothing else', () => {
    const roles = t.findResources('AWS::IAM::Role', {
      Properties: { RoleName: 'aperture-github-logs-dev' },
    });
    const [logicalId = ''] = Object.keys(roles);
    expect(logicalId).not.toBe('');
    const policies = Object.values(t.findResources('AWS::IAM::Policy')).filter((p) =>
      JSON.stringify((p as { Properties: { Roles: unknown } }).Properties.Roles).includes(
        logicalId,
      ),
    );
    const stmts = policies.flatMap(
      (p) =>
        (
          p as {
            Properties: {
              PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown }[] };
            };
          }
        ).Properties.PolicyDocument.Statement,
    );
    const actions = stmts.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(actions.every((a) => a.startsWith('logs:'))).toBe(true); // no bootstrap assume, S3, CFN
    const resources = JSON.stringify(stmts.map((s) => s.Resource));
    for (const fn of ['bff', 'mcp', 'finance-sync'])
      expect(resources).toContain(`/aws/lambda/aperture-${fn}-dev:*`);
    expect(resources).not.toContain('-prod');
    // Only the three id-addressed query calls sit on `*`.
    const star = stmts
      .filter((s) => s.Resource === '*')
      .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(star.sort()).toEqual(['logs:DescribeQueries', 'logs:GetQueryResults', 'logs:StopQuery']);
  });

  it('grants read-only DescribeStacks for the app-only deploy tier', () => {
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({ Action: 'cloudformation:DescribeStacks' })]),
      }),
    });
  });
});
