import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';
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
                // environment:dev — deploy-dev always runs in the `dev` GitHub environment (on both the
                // dev- and main-branch pushes), so that's the only trusted sub. The cutover ref subs were
                // pruned 2026-08.
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

  it('grants read-only DescribeStacks for the app-only deploy tier', () => {
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({ Action: 'cloudformation:DescribeStacks' })]),
      }),
    });
  });
});
